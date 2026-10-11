import { ClampToEdgeWrapping, DataTexture, LinearFilter, RGBAFormat, UnsignedByteType, Vector4, type Node } from 'three/webgpu'
import { positionWorld, step, texture, uniform, vec2 } from 'three/tsl'
import { STATE_CHANNELS, type MaterialStates, type StateChannel } from './states.ts'
import type { ClimatePoint, SurfaceSample, Weather } from './weather.ts'
import { merge, resolve } from './util.ts'

/** Where a {@link StateField} lies and how fine it is. Plain JSON. */
export interface StateFieldOptions {
  /** Centre `[x, z]` in frame coordinates, metres. Snapped to whole texels so moving it never smears data. */
  center: [number, number]
  /** Edge length of the square region, metres. */
  size: number
  /** Texels per side. */
  resolution: number
}

/** Default field: 512 m around the origin at 4 m per texel. */
export const DEFAULT_STATE_FIELD: StateFieldOptions = { center: [0, 0], size: 512, resolution: 128 }

/** How {@link StateField.paint} combines a brush with what is already there. */
export type PaintMode = 'max' | 'add' | 'set' | 'min'

/** The four states as TSL nodes read from a field (or {@link InstanceStates}), each 0…1. */
export type StateNodes = Record<StateChannel, Node<'float'>>

/**
 * A low-resolution world-space map of the four material states over a square region: accumulated
 * wetness and snow cover from the weather, burn scars from wildfires, damage from storms and impacts.
 * Terrain, grass and trees sample it in their shaders ({@link StateField.node}) and on the CPU
 * ({@link StateField.sample}). Stored as float on the CPU and uploaded as an RGBA8 texture
 * (R = wetness, G = snow, B = burn, A = damage).
 *
 * Coordinates are local frame coordinates. With a floating origin, call {@link StateField.setOrigin}
 * with the frame position of render-space zero; the GPU lookup stays exact at any distance.
 *
 * @example
 * ```ts
 * const field = new StateField({ size: 1024, resolution: 128 })
 * field.paint(10, -4, 6, { burn: 1 })                  // a scorch mark
 * field.updateFromWeather(weather, time)                // wetness + snow from the weather (budgeted)
 * field.update()                                        // upload changes (once per frame)
 * applyMaterialStatesTo(terrainMaterial, field.node())
 * ```
 */
export class StateField {
  /** Resolved settings. Change them with {@link StateField.set}. */
  options: StateFieldOptions
  /** Float states, 4 per texel (RGBA = wetness, snow, burn, damage), row-major from (minX, minZ). */
  data: Float32Array
  /** The GPU copy (RGBA8, linear filtering). */
  readonly texture: DataTexture
  /** Bumped on every write. */
  version = 0
  /** `xy` = field minimum relative to render-space zero, `zw` = size. */
  readonly bounds = uniform(new Vector4())

  private origin: [number, number] = [0, 0]
  private dirty = true
  private climate: Float32Array | null = null
  private climateVersion = -1
  private weatherRow = 0
  private weatherTime = 0
  private readonly surface: SurfaceSample = { wetness: 0, snow: 0, snowDepth: 0, water: 0 }
  private readonly point: ClimatePoint = { temperature: 0, moisture: 0, elevation: 0, water: false }

  /** Creates a field; anything not given uses {@link DEFAULT_STATE_FIELD}. */
  constructor(input: Partial<StateFieldOptions> = {}) {
    this.options = resolve(DEFAULT_STATE_FIELD, input)
    this.snapCenter()
    const n = this.options.resolution
    this.data = new Float32Array(n * n * 4)
    this.texture = new DataTexture(new Uint8Array(n * n * 4), n, n, RGBAFormat, UnsignedByteType)
    this.configureTexture()
    this.updateBounds()
  }

  /**
   * Changes the region. Moving `center` shifts the data by whole texels (what scrolls out is lost, what
   * scrolls in is zero); changing `size` or `resolution` resamples it.
   */
  set(input: Partial<StateFieldOptions>): this {
    const before = this.options
    const next = merge(structuredClone(before), input)
    if (JSON.stringify(next) === JSON.stringify(before)) return this
    const oldMinX = this.minX, oldMinZ = this.minZ, oldTexel = this.texel, oldN = before.resolution, old = this.data
    this.options = next
    this.snapCenter()
    const n = next.resolution
    if (n !== oldN || next.size !== before.size || this.minX !== oldMinX || this.minZ !== oldMinZ) {
      const data = new Float32Array(n * n * 4)
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const x = this.minX + (i + 0.5) * this.texel, z = this.minZ + (j + 0.5) * this.texel
        const fi = (x - oldMinX) / oldTexel - 0.5, fj = (z - oldMinZ) / oldTexel - 0.5
        if (fi < -0.5 || fj < -0.5 || fi > oldN - 0.5 || fj > oldN - 0.5) continue
        for (let c = 0; c < 4; c++) data[(j * n + i) * 4 + c] = bilinear(old, oldN, fi, fj, c)
      }
      this.data = data
      this.climate = null
      this.weatherRow = 0
      if (n !== oldN) {
        this.texture.image = { data: new Uint8Array(n * n * 4), width: n, height: n }
        this.texture.dispose() // re-allocate at the new size
      }
      this.changed()
    }
    this.updateBounds()
    return this
  }

  /** Replaces all settings: anything not in `input` goes back to the defaults. */
  reset(input: Partial<StateFieldOptions> = {}): this {
    return this.set(resolve(DEFAULT_STATE_FIELD, input))
  }

  /** Minimum x of the region (frame coordinates). */
  get minX(): number {
    return this.options.center[0] - this.options.size / 2
  }

  /** Minimum z of the region (frame coordinates). */
  get minZ(): number {
    return this.options.center[1] - this.options.size / 2
  }

  /** Texel size, metres. */
  get texel(): number {
    return this.options.size / this.options.resolution
  }

  /** Sets the frame position at render-space zero (floating origin). `[x, y, z]` or `[x, z]`. */
  setOrigin(origin: readonly number[]): this {
    this.origin = origin.length >= 3 ? [origin[0], origin[2]] : [origin[0], origin[1]]
    this.updateBounds()
    return this
  }

  /** All four states at (x, z), bilinear. Zero outside the region. */
  sample(x: number, z: number, out: MaterialStates = { wetness: 0, snow: 0, burn: 0, damage: 0 }): MaterialStates {
    for (let c = 0; c < 4; c++) out[STATE_CHANNELS[c]] = this.value(STATE_CHANNELS[c], x, z)
    return out
  }

  /** One state at (x, z), bilinear. Zero outside the region. */
  value(channel: StateChannel, x: number, z: number): number {
    const n = this.options.resolution
    const fi = (x - this.minX) / this.texel - 0.5, fj = (z - this.minZ) / this.texel - 0.5
    if (fi < -0.5 || fj < -0.5 || fi > n - 0.5 || fj > n - 0.5) return 0
    return bilinear(this.data, n, fi, fj, STATE_CHANNELS.indexOf(channel))
  }

  /**
   * Paints a round brush of `radius` metres at (x, z). `falloff` (0…1) is the soft share of the radius.
   * Values are clamped to 0…1. Returns the number of texels touched.
   */
  paint(x: number, z: number, radius: number, values: Partial<MaterialStates>, mode: PaintMode = 'max', falloff = 0.5): number {
    const n = this.options.resolution, t = this.texel
    const i0 = Math.max(0, Math.floor((x - radius - this.minX) / t)), i1 = Math.min(n - 1, Math.floor((x + radius - this.minX) / t))
    const j0 = Math.max(0, Math.floor((z - radius - this.minZ) / t)), j1 = Math.min(n - 1, Math.floor((z + radius - this.minZ) / t))
    const inner = radius * (1 - Math.min(1, Math.max(0, falloff)))
    let touched = 0
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(this.minX + (i + 0.5) * t - x, this.minZ + (j + 0.5) * t - z)
      if (d > radius) continue
      const w = d <= inner ? 1 : 1 - (d - inner) / Math.max(1e-6, radius - inner)
      const k = (j * n + i) * 4
      for (let c = 0; c < 4; c++) {
        const v = values[STATE_CHANNELS[c]]
        if (v === undefined) continue
        const cur = this.data[k + c]
        const next = mode === 'add' ? cur + v * w : mode === 'set' ? cur + (v - cur) * w : mode === 'min' ? Math.min(cur, cur + (v - cur) * w) : Math.max(cur, v * w)
        this.data[k + c] = Math.min(1, Math.max(0, next))
      }
      touched++
    }
    if (touched) this.changed()
    return touched
  }

  /** Writes one texel directly (clamped to 0…1). `i`, `j` are texel column and row. */
  write(i: number, j: number, channel: StateChannel, value: number): void {
    const n = this.options.resolution
    if (i < 0 || j < 0 || i >= n || j >= n) return
    this.data[(j * n + i) * 4 + STATE_CHANNELS.indexOf(channel)] = Math.min(1, Math.max(0, value))
    this.changed()
  }

  /** Marks the field changed after writing to {@link StateField.data} directly (uploads on the next `update`). */
  touch(): this {
    return this.changed()
  }

  /** Sets every texel of the given channels. */
  fill(values: Partial<MaterialStates>): this {
    for (let c = 0; c < 4; c++) {
      const v = values[STATE_CHANNELS[c]]
      if (v === undefined) continue
      for (let k = c; k < this.data.length; k += 4) this.data[k] = v
    }
    return this.changed()
  }

  /** Relaxes states towards 0 at `rates` per second (e.g. `{ damage: 0 }`, `{ burn: 1 / 86400 }`). */
  decay(dt: number, rates: Partial<MaterialStates>): this {
    for (let c = 0; c < 4; c++) {
      const r = rates[STATE_CHANNELS[c]]
      if (!r) continue
      const step = r * dt
      for (let k = c; k < this.data.length; k += 4) this.data[k] = Math.max(0, this.data[k] - step)
    }
    return this.changed()
  }

  /** Calls `fn(x, z, i, j)` for every texel centre (frame coordinates). */
  forEachTexel(fn: (x: number, z: number, i: number, j: number) => void): void {
    const n = this.options.resolution, t = this.texel
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) fn(this.minX + (i + 0.5) * t, this.minZ + (j + 0.5) * t, i, j)
  }

  /**
   * Writes `wetness` and `snow` from {@link Weather.surfaceAt} at `time`. The work is spread over
   * calls: each call processes rows until `budget` milliseconds have passed, and a full pass uses the
   * time it started with, so the whole field is consistent. Returns true when a pass completes.
   */
  updateFromWeather(weather: Weather, time: number, budget = 2): boolean {
    const n = this.options.resolution, t = this.texel
    if (!this.climate || this.climateVersion !== weatherKey(weather)) {
      this.climate = new Float32Array(n * n * 4).fill(NaN)
      this.climateVersion = weatherKey(weather)
      this.weatherRow = 0
    }
    if (this.weatherRow === 0) this.weatherTime = time
    const start = now()
    const c = this.point
    while (this.weatherRow < n) {
      const j = this.weatherRow++
      for (let i = 0; i < n; i++) {
        const k = (j * n + i) * 4
        const x = this.minX + (i + 0.5) * t, z = this.minZ + (j + 0.5) * t
        if (Number.isNaN(this.climate[k])) {
          weather.climateAt(x, z, c)
          this.climate[k] = c.temperature; this.climate[k + 1] = c.moisture; this.climate[k + 2] = c.elevation; this.climate[k + 3] = c.water ? 1 : 0
        } else {
          c.temperature = this.climate[k]; c.moisture = this.climate[k + 1]; c.elevation = this.climate[k + 2]; c.water = this.climate[k + 3] > 0
        }
        weather.surfaceAt(x, z, this.weatherTime, this.surface, c)
        this.data[k] = c.water ? 1 : this.surface.wetness
        this.data[k + 1] = c.water ? 0 : this.surface.snow
      }
      if (now() - start > budget) break
    }
    this.changed()
    if (this.weatherRow < n) return false
    this.weatherRow = 0
    return true
  }

  /** Uploads changed data to the texture. Call once per frame (cheap when nothing changed). */
  update(): void {
    if (!this.dirty) return
    this.dirty = false
    const bytes = this.texture.image.data as Uint8Array
    for (let k = 0; k < this.data.length; k++) bytes[k] = Math.round(Math.min(1, Math.max(0, this.data[k])) * 255)
    this.texture.needsUpdate = true
  }

  /**
   * The four states as TSL nodes at a render-space XZ position (default `positionWorld.xz`). Zero
   * outside the region. Pass the result straight to `applyMaterialStates`.
   */
  node(xz: Node<'vec2'> = positionWorld.xz): StateNodes {
    const uv = xz.sub(this.bounds.xy).div(this.bounds.zw)
    const inside = step(0, uv.x).mul(step(uv.x, 1)).mul(step(0, uv.y)).mul(step(uv.y, 1))
    const s = texture(this.texture, vec2(uv.x, uv.y)).mul(inside)
    return { wetness: s.x, snow: s.y, burn: s.z, damage: s.w }
  }

  /** Frees the texture. */
  dispose(): void {
    this.texture.dispose()
  }

  private changed(): this {
    this.dirty = true
    this.version++
    return this
  }

  private snapCenter() {
    const o = this.options
    o.resolution = Math.max(2, Math.round(o.resolution))
    const t = o.size / o.resolution
    o.center = [Math.round(o.center[0] / t) * t, Math.round(o.center[1] / t) * t]
  }

  private configureTexture() {
    const tex = this.texture
    tex.magFilter = LinearFilter
    tex.minFilter = LinearFilter
    tex.wrapS = tex.wrapT = ClampToEdgeWrapping
    tex.generateMipmaps = false
    tex.needsUpdate = true
  }

  private updateBounds() {
    this.bounds.value.set(this.minX - this.origin[0], this.minZ - this.origin[1], this.options.size, this.options.size)
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

// Cached climate is valid until the world changes.
function weatherKey(w: Weather): number {
  return w.world?.version ?? 0
}

function bilinear(data: Float32Array, n: number, fi: number, fj: number, c: number): number {
  const ci = Math.min(n - 1, Math.max(0, fi)), cj = Math.min(n - 1, Math.max(0, fj))
  const i0 = Math.floor(ci), j0 = Math.floor(cj)
  const i1 = Math.min(n - 1, i0 + 1), j1 = Math.min(n - 1, j0 + 1)
  const tx = ci - i0, tz = cj - j0
  const a = data[(j0 * n + i0) * 4 + c], b = data[(j0 * n + i1) * 4 + c]
  const d = data[(j1 * n + i0) * 4 + c], e = data[(j1 * n + i1) * 4 + c]
  return (a + (b - a) * tx) * (1 - tz) + (d + (e - d) * tx) * tz
}
