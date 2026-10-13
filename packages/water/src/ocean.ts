import { BufferGeometry, Float32BufferAttribute, Matrix4, Mesh, Sphere, Vector3, type Camera, type MeshBasicNodeMaterial, type Object3D, type PerspectiveCamera } from 'three/webgpu'
import type { World } from 'threejs-biomes'
import { Clock, hookScene, mergeInput, prepareRenderer, type WaterRenderer } from './common.ts'
import { DEFAULT_APPEARANCE, applyAppearance, applyWaves, createWaterMaterial, createWaterUniforms, setWavePhases, updateSun, type WaterAppearance, type WaterUniforms } from './material.ts'
import { MAX_WAVES, createWaves, sampleWaves, type Wave, type WaveOptions, type WaveSample } from './waves.ts'

/** Every setting of an {@link Ocean}. All optional on input; see {@link OceanInput}. */
export interface OceanSettings extends WaterAppearance {
  /** Sea level, metres, when no `world` is given (a world's `seaLevel` wins). */
  seaLevel: number
  /** Planet radius, metres, when no `world` is given; 0 = flat world. */
  radius: number
  /** World position (planet-centred, metres) that is (0, 0, 0) in render space. Keep it near the camera for float32 precision. */
  origin: [x: number, y: number, z: number]
  /** The wind sea. */
  waves: WaveOptions
  /** 0 … 1 foam on the sharpest crests. */
  whitecaps: number
  /** Vertices around each ring. Vertex spacing ≈ distance × 2π / segments, so the grid looks the same at every scale. */
  segments: number
  /** Outer radius ÷ inner radius of the ring grid. Sets the ring count (≈ 330 at 1e7 and 128 segments). */
  range: number
  /** Smallest inner ring radius, metres (the finest vertex spacing, right under the camera). */
  innerRadius: number
  /** Inner ring radius as a fraction of the camera's height above the sea (rounded down to a power of two). */
  altitudeFactor: number
  /** Planets: distance (metres) the camera travels before the wave frame is re-anchored. Phases stay continuous. */
  reanchorDistance: number
}

/** Partial settings accepted by {@link Ocean.create}, {@link Ocean.set} and `<Ocean>`. `waves` merges field by field. */
export type OceanInput = Partial<Omit<OceanSettings, 'waves'>> & {
  /** Wave settings to change. */
  waves?: Partial<WaveOptions>
}

/** Options for {@link Ocean.create}. */
export interface OceanOptions extends OceanInput {
  /** Camera the ring grid follows. */
  camera: Camera
  /** World whose `seaLevel`, `surface` and `radius` to use (read every frame, so world edits apply live). */
  world?: World | null
  /** If given, the ocean is added to it and updates itself whenever it renders. */
  scene?: Object3D
  /** A WebGPURenderer; initialised if needed. */
  renderer?: WaterRenderer
}

/** Live counters of an {@link Ocean}. */
export interface OceanStats {
  /** Camera height above the undisturbed sea, metres. */
  altitude: number
  /** Current inner ring radius, metres. */
  innerRadius: number
  /** Distance to the edge of the drawn sea (the horizon on planets), metres. */
  extent: number
  /** Vertices in the ring grid. */
  vertices: number
}

/** The sea surface at a point, from {@link Ocean.waterAt}. */
export interface OceanSample {
  /** How far the point is below the wavy surface, metres (negative = above it). */
  depth: number
  /** Wave height above the undisturbed sea there, metres. */
  height: number
  /** Surface point above/below the query, render space. */
  surface: [x: number, y: number, z: number]
  /** Surface normal, render space. */
  normal: [x: number, y: number, z: number]
}

/** Default ocean: a moderate breeze over open water. */
export const DEFAULT_OCEAN: OceanSettings = {
  ...DEFAULT_APPEARANCE,
  seaLevel: 0,
  radius: 0,
  origin: [0, 0, 0],
  waves: { count: 12, seed: 1, amplitude: 0.45, wavelength: [0.6, 42], direction: [1, 0.35], spread: 0.55, choppiness: 0.75, speed: 1 },
  whitecaps: 0.3,
  segments: 128,
  range: 1e7,
  innerRadius: 0.01,
  altitudeFactor: 0.02,
  reanchorDistance: 10_000,
}

/**
 * A sea-level water surface for flat worlds and planets, at every scale from an ant on the beach to
 * orbit, in one draw call.
 *
 * The surface is a camera-centred grid of concentric rings whose radii grow geometrically, so vertices
 * are dense under the camera and sparse at the horizon, and the grid scales with the camera's height.
 * It is built in the local tangent plane under the camera and, on planets, bent onto the sea sphere in
 * the vertex shader (with float32-exact series), clamped at the horizon — so the same mesh covers a
 * beach and a whole hemisphere seen from orbit. Waves are a sum of Gerstner waves whose phases are
 * computed on the CPU in float64, so they stay smooth and stable millions of metres from the origin.
 *
 * @example
 * ```ts
 * const ocean = await Ocean.create({ camera, scene, renderer, world, sun, waves: { amplitude: 0.8 } })
 * ocean.set({ deepColor: '#06283a', whitecaps: 0.6 })   // live
 * floating.onRebase((origin) => ocean.setOrigin(origin)) // floating origin (threejs-biomes FloatingOrigin)
 * ```
 */
export class Ocean {
  /** The ocean mesh. Added to `scene` for you when one is passed to {@link Ocean.create}. */
  readonly object: Mesh<BufferGeometry, MeshBasicNodeMaterial>
  /** Shader uniforms (for advanced tweaks). */
  readonly uniforms: WaterUniforms = createWaterUniforms()
  /** Live counters, refreshed by {@link Ocean.update}. */
  readonly stats: OceanStats = { altitude: 0, innerRadius: 0, extent: 0, vertices: 0 }
  /** Camera the grid follows. Can be swapped at any time. */
  camera: Camera
  /** World providing sea level and planet radius, or `null` to use the `seaLevel`/`radius` settings. */
  world: World | null
  /** Resolved settings. Change them with {@link Ocean.set} / {@link Ocean.reset}. */
  settings!: OceanSettings
  /** Seconds of wave time. Advanced by {@link Ocean.update}; set it to sync clients. */
  time = 0

  private input: OceanInput = {}
  private waves: Wave[] = []
  private waveKey = ''
  private geometryKey = ''
  private environment: unknown = undefined
  private clock = new Clock()
  private sunCache = { light: null, searched: false } as Parameters<typeof updateSun>[3]
  private unhook = () => {}
  /** Wave-phase frame on planets: a tangent plane re-anchored as the camera travels. */
  private anchor = { valid: false, radius: 0, point: [0, 0, 0], east: [1, 0, 0], south: [0, 0, 1], phase: new Float64Array(MAX_WAVES) }
  private phases = new Float64Array(MAX_WAVES)
  private grid = { u: 0, v: 0, sphere: false, rs: 0, sea: 0, east: [1, 0, 0], up: [0, 1, 0], south: [0, 0, 1] }

  /** Creates an ocean (validating/initialising `renderer` if given) and positions it for the first frame. */
  static async create(options: OceanOptions): Promise<Ocean> {
    await prepareRenderer(options.renderer, 'Ocean')
    const ocean = new Ocean(options)
    ocean.update(0)
    return ocean
  }

  /** Prefer {@link Ocean.create}. */
  constructor({ camera, world = null, scene, renderer: _renderer, ...input }: OceanOptions) {
    this.camera = camera
    this.world = world
    this.object = new Mesh(new BufferGeometry(), undefined as unknown as MeshBasicNodeMaterial)
    this.object.name = 'Ocean'
    this.object.frustumCulled = false // vertices move in the shader; the grid always surrounds the camera
    this.object.matrixAutoUpdate = false
    this.set(input)
    if (scene) {
      scene.add(this.object)
      this.unhook = hookScene(scene, () => this.update())
    }
  }

  /** Changes settings, merging into earlier ones (`waves` field by field). Colours and most numbers apply instantly; `segments`/`range` rebuild the grid. */
  set(input: OceanInput): this {
    mergeInput(this.input, input)
    return this.apply()
  }

  /** Replaces all settings: anything not in `input` goes back to the defaults. */
  reset(input: OceanInput = {}): this {
    this.input = {}
    return this.set(input)
  }

  /** Moves the floating origin: render-space (0, 0, 0) becomes this world position (e.g. from `FloatingOrigin.onRebase`). Same as `set({ origin })`. */
  setOrigin(origin: readonly number[]): this {
    return this.set({ origin: [origin[0], origin[1], origin[2]] })
  }

  private apply(): this {
    const s = mergeInput(structuredClone({ ...DEFAULT_OCEAN, sun: null, environment: null }), this.input) as OceanSettings
    this.settings = s
    const u = this.uniforms
    applyAppearance(u, s)
    u.whitecaps.value = s.whitecaps

    const waveKey = JSON.stringify(s.waves)
    if (waveKey !== this.waveKey) {
      this.waveKey = waveKey
      this.waves = createWaves(s.waves)
      applyWaves(u, this.waves, s.waves.direction[0], s.waves.direction[1])
    }
    const geometryKey = JSON.stringify([s.segments, s.range])
    if (geometryKey !== this.geometryKey) {
      this.geometryKey = geometryKey
      this.object.geometry.dispose()
      this.object.geometry = createRingGeometry(s.segments, s.range)
      this.stats.vertices = this.object.geometry.attributes.position.count
    }
    if (s.environment !== this.environment) {
      this.environment = s.environment
      this.object.material?.dispose()
      this.object.material = createWaterMaterial(u, 'waves', s.environment)
    }
    return this
  }

  /**
   * Follows the camera, advances the waves and reads the sun. Called automatically when a `scene` was
   * given (and by `<Ocean>`); otherwise call it once per frame.
   * @param delta Seconds since the last frame; measured if omitted.
   */
  update(delta: number = this.clock.tick()): void {
    const s = this.settings
    const u = this.uniforms
    this.time += delta
    u.time.value = this.time

    const w = this.world?.options
    const sphere = w ? w.surface === 'sphere' : s.radius > 0
    const sea = w ? w.seaLevel : s.seaLevel
    const rs = sphere ? (w ? w.radius : s.radius) + sea : 0
    const [ox, oy, oz] = s.origin
    const cam = this.camera.getWorldPosition(_v)
    const px = cam.x + ox, py = cam.y + oy, pz = cam.z + oz
    const g = this.grid
    g.sphere = sphere; g.rs = rs; g.sea = sea

    let altitude: number
    const a = this.anchor
    if (sphere) {
      const len = Math.hypot(px, py, pz) || 1
      altitude = len - rs
      const up = [px / len, py / len, pz / len]
      if (!a.valid || a.radius !== rs) this.reanchor(up, rs, false)
      // The sub-camera point in the anchor's tangent plane.
      let du = dot3(up, a.east) * rs - dot3(a.point, a.east), dv = dot3(up, a.south) * rs - dot3(a.point, a.south)
      if (Math.hypot(du, dv) > s.reanchorDistance) {
        this.reanchor(up, rs, true, du, dv)
        du = 0; dv = 0
      }
      g.u = du; g.v = dv
      // Grid axes: the anchor's east carried onto this tangent plane, so wave directions stay put.
      const e = sub3(a.east, scale3(up, dot3(a.east, up)))
      const el = Math.hypot(e[0], e[1], e[2]) || 1
      g.east = [e[0] / el, e[1] / el, e[2] / el]
      g.up = up
      g.south = cross3(g.east, up)
      this.object.position.set(up[0] * rs - ox, up[1] * rs - oy, up[2] * rs - oz)
      _m.makeBasis(_x.fromArray(g.east), _y.fromArray(up), _z.fromArray(g.south))
      this.object.quaternion.setFromRotationMatrix(_m)
    } else {
      if (a.valid) { a.valid = false; a.phase.fill(0) }
      altitude = py - sea
      g.u = px; g.v = pz
      g.east = [1, 0, 0]; g.up = [0, 1, 0]; g.south = [0, 0, 1]
      this.object.position.set(px - ox, sea - oy, pz - oz)
      this.object.quaternion.identity()
    }
    this.object.updateMatrix()

    // Ring scale: a power of two, so rings map onto rings when it changes (no popping).
    const inner = Math.pow(2, Math.floor(Math.log2(Math.max(s.innerRadius, Math.abs(altitude) * s.altitudeFactor, 1e-6))))
    const angle = (2 * Math.PI) / Math.max(3, Math.floor(s.segments))
    u.gridScale.value = inner
    u.gridAngle.value = angle
    u.gridMinSpacing.value = inner
    u.radius.value = sphere ? rs : 1e15
    let extent = inner * s.range
    if (sphere) {
      // Clamp at the horizon (with room for waves and a margin): the sea beyond it is hidden by the sea itself.
      const waveRoom = this.waves.reduce((sum, wv) => sum + wv.amplitude, 0) * 2 + 1
      const h = Math.max(altitude, waveRoom)
      const horizon = rs * Math.atan(Math.sqrt(h * (2 * rs + h)) / rs)
      extent = Math.min(extent, horizon * 1.25 + inner * 8, rs * Math.PI * 0.5)
    }
    u.maxArc.value = extent
    const persp = this.camera as PerspectiveCamera
    u.tanHalfFov.value = persp.isPerspectiveCamera ? Math.tan((persp.fov * Math.PI) / 360) / (persp.zoom || 1) : 0.5

    // Phases in float64: k·(grid origin) + accumulated re-anchor offsets − ωt, reduced to ±π.
    const ph = this.phases
    for (let i = 0; i < this.waves.length; i++) {
      const wv = this.waves[i]
      ph[i] = wrap(wv.k * (wv.dirX * g.u + wv.dirZ * g.v) + a.phase[i] - wv.omega * this.time)
    }
    setWavePhases(u, ph)
    updateSun(u, s.sun, this.object, this.sunCache)

    this.stats.altitude = altitude
    this.stats.innerRadius = inner
    this.stats.extent = extent
  }

  private reanchor(up: number[], rs: number, keepPhase: boolean, du = 0, dv = 0) {
    const a = this.anchor
    if (keepPhase) {
      // Carry the phase at the new anchor point over, so waves don't jump.
      for (let i = 0; i < this.waves.length; i++) a.phase[i] = wrap(a.phase[i] + this.waves[i].k * (this.waves[i].dirX * du + this.waves[i].dirZ * dv))
      const e = sub3(a.east, scale3(up, dot3(a.east, up)))
      const l = Math.hypot(e[0], e[1], e[2]) || 1
      a.east = [e[0] / l, e[1] / l, e[2] / l]
    } else {
      a.phase.fill(0)
      const e = [up[2], 0, -up[0]] // local east (Y × up), as threejs-biomes frames use
      const l = Math.hypot(e[0], e[2])
      a.east = l > 1e-6 ? [e[0] / l, 0, e[2] / l] : [1, 0, 0]
    }
    a.point = scale3(up, rs)
    a.south = cross3(a.east, up)
    a.radius = rs
    a.valid = true
  }

  /**
   * The wavy sea surface at a render-space point, for buoyancy and gameplay: how deep the point is
   * under the surface, the surface point and its normal. Uses every wave (no distance fade), at the
   * current {@link Ocean.time}.
   */
  waterAt(x: number, y: number, z: number, out: OceanSample = { depth: 0, height: 0, surface: [0, 0, 0], normal: [0, 1, 0] }): OceanSample {
    const g = this.grid
    const a = this.anchor
    const [ox, oy, oz] = this.settings.origin
    const px = x + ox, py = y + oy, pz = z + oz
    const extra = _extra
    for (let i = 0; i < this.waves.length; i++) extra[i] = a.phase[i] - this.waves[i].omega * this.time
    if (!g.sphere) {
      const ws = sampleWaves(this.waves, px, pz, 0, _ws, extra)
      out.height = ws.height
      out.depth = g.sea + ws.height - py
      out.surface = [x, g.sea + ws.height - oy, z]
      out.normal = [ws.nx, ws.ny, ws.nz]
      return out
    }
    const len = Math.hypot(px, py, pz) || 1
    const up = [px / len, py / len, pz / len]
    const u = dot3(up, a.east) * g.rs - dot3(a.point, a.east), v = dot3(up, a.south) * g.rs - dot3(a.point, a.south)
    const ws = sampleWaves(this.waves, u, v, 0, _ws, extra)
    const e = sub3(a.east, scale3(up, dot3(a.east, up)))
    const el = Math.hypot(e[0], e[1], e[2]) || 1
    const east = [e[0] / el, e[1] / el, e[2] / el]
    const south = cross3(east, up)
    const r = g.rs + ws.height
    out.height = ws.height
    out.depth = r - len
    out.surface = [up[0] * r - ox, up[1] * r - oy, up[2] * r - oz]
    out.normal = [0, 1, 2].map((k) => east[k] * ws.nx + up[k] * ws.ny + south[k] * ws.nz) as [number, number, number]
    return out
  }

  /** Removes the ocean from its parent and frees its GPU resources. */
  dispose(): void {
    this.unhook()
    this.object.removeFromParent()
    this.object.geometry.dispose()
    this.object.material.dispose()
  }
}

/**
 * The ocean's ring grid in unit radii: a centre vertex, then rings at radius `g^i` (i = 0 …) with
 * `g = 2^(1/m)` chosen so cells are roughly square. Scaling it by a power of two maps rings onto rings.
 */
export function createRingGeometry(segments: number, range: number): BufferGeometry {
  const seg = Math.max(3, Math.floor(segments))
  const m = Math.max(1, Math.round((seg * Math.LN2) / (2 * Math.PI)))
  const growth = Math.pow(2, 1 / m)
  const rings = Math.max(1, Math.ceil(Math.log(Math.max(range, 1.0001)) / Math.log(growth)) + 1)
  const pos = new Float32Array((1 + rings * seg) * 3)
  for (let i = 0; i < rings; i++) {
    const r = Math.pow(growth, i)
    for (let j = 0; j < seg; j++) {
      const t = (j / seg) * Math.PI * 2
      const k = (1 + i * seg + j) * 3
      pos[k] = Math.cos(t) * r
      pos[k + 2] = Math.sin(t) * r
    }
  }
  const index: number[] = []
  for (let j = 0; j < seg; j++) index.push(0, 1 + ((j + 1) % seg), 1 + j)
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = 1 + i * seg + j, b = 1 + i * seg + ((j + 1) % seg)
      const c = a + seg, d = b + seg
      index.push(a, b, c, b, d, c)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3))
  geometry.setIndex(index)
  geometry.boundingSphere = new Sphere(new Vector3(), Infinity)
  return geometry
}

function wrap(a: number): number {
  return a - Math.PI * 2 * Math.round(a / (Math.PI * 2))
}
const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub3 = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const scale3 = (a: number[], k: number) => [a[0] * k, a[1] * k, a[2] * k]
const cross3 = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

const _v = new Vector3()
const _x = new Vector3()
const _y = new Vector3()
const _z = new Vector3()
const _m = new Matrix4()
const _ws: WaveSample = { height: 0, nx: 0, ny: 1, nz: 0 }
const _extra = new Float64Array(MAX_WAVES)
