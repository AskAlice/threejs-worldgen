import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshBasicNodeMaterial, PointLight, Sphere, Vector3, type Camera, type Node } from 'three/webgpu'
import { attribute, cameraPosition, cross, int, modelWorldMatrix, normalize, positionGeometry, uniform, uniformArray, vec4 } from 'three/tsl'
import { mulberry32 } from 'threejs-biomes'
import type { Strike, Weather } from './weather.ts'
import { merge, resolve } from './util.ts'

/** Every lightning setting. Plain JSON. */
export interface LightningOptions {
  /** Strikes within this distance of the camera are drawn, metres. */
  radius: number
  /** Height of the cloud base above the strike point, metres. */
  cloudHeight: number
  /** How long a strike stays visible (with its return strokes), seconds. */
  duration: number
  /** Main channel width, metres. */
  width: number
  /** Midpoint-displacement levels of the main channel (2^detail segments). */
  detail: number
  /** Side branches per bolt. */
  branches: number
  /** Branch length as a share of `cloudHeight`. */
  branchLength: number
  /** Sideways kinks as a share of segment length. */
  jaggedness: number
  /** Bolt colour (`#rrggbb`). */
  color: string
  /** Bolt brightness (unlit, additive; > 1 blooms). */
  intensity: number
  /** Scene light flash. */
  flash: {
    /** Peak light intensity. */
    intensity: number
    /** Light colour (`#rrggbb`). */
    color: string
  }
  /** Most bolts drawn at once. */
  maxBolts: number
}

/** Default lightning. */
export const DEFAULT_LIGHTNING: LightningOptions = {
  radius: 6000, cloudHeight: 1400, duration: 0.7, width: 2.5, detail: 7, branches: 6, branchLength: 0.3, jaggedness: 0.22,
  color: '#dfe7ff', intensity: 30, flash: { intensity: 6, color: '#cfd9ff' }, maxBolts: 8,
}

/** Partial settings for {@link Lightning}. */
export type LightningInput = Partial<Omit<LightningOptions, 'flash'>> & {
  /** Flash settings to change. */
  flash?: Partial<LightningOptions['flash']>
}

/** Construction options for {@link Lightning}. */
export interface LightningConfig extends LightningInput {
  /** Weather whose thunderstorms make the strikes. */
  weather: Weather
  /** Camera strikes are shown around. */
  camera: Camera
  /** Ground height `(x, z) => y`, frame coordinates. Default: the weather's world (or 0). */
  ground?: ((x: number, z: number) => number) | null
}

/**
 * Lightning bolts and flashes from a {@link Weather}'s thunderstorms. The strikes come from
 * `weather.strikes`, so they are deterministic in time; each bolt's shape (a jagged channel with
 * branches) is seeded by its strike, flickers through a few return strokes and lights the scene with
 * a flash. All visible bolts are one merged geometry and one draw call. Subscribe with
 * {@link Lightning.onStrike} to ignite wildfires or play thunder.
 *
 * @example
 * ```ts
 * const lightning = new Lightning({ weather, camera })
 * scene.add(lightning.object)
 * lightning.onStrike((s) => wildfire.ignite(s.x, s.z))
 * // each frame: lightning.update(time)
 * ```
 */
export class Lightning {
  /** Add this to your scene (bolts and the flash light). */
  readonly object = new Group()
  /** The flash light. */
  readonly light = new PointLight('#ffffff', 0, 0, 0)
  /** Current flash brightness 0…1 (drive sky or cloud brightness with it). */
  flash = 0
  /** Strikes visible on the last update. */
  active: Strike[] = []
  /** Resolved settings. */
  options!: LightningOptions
  /** Weather read for strikes. */
  weather: Weather
  /** Camera strikes are shown around. */
  camera: Camera
  /** Ground height (frame coordinates). */
  ground: ((x: number, z: number) => number) | null
  /** Shader uniforms. */
  readonly uniforms = {
    /** Bolt colour × intensity. */ color: uniform(new Color()),
    /** Per-bolt brightness. */ brightness: uniformArray(new Array(16).fill(0), 'float'),
  }

  private origin: [number, number, number] = [0, 0, 0]
  private mesh: Mesh<BufferGeometry, MeshBasicNodeMaterial>
  private slots: number[] = []
  private lastTime: number | null = null
  private listeners = new Set<(strike: Strike) => void>()

  /** Creates lightning; settings not given use {@link DEFAULT_LIGHTNING}. */
  constructor({ weather, camera, ground, ...input }: LightningConfig) {
    this.weather = weather
    this.camera = camera
    this.ground = ground !== undefined ? ground : weather.frame ? weather.frame.height : null
    this.object.name = 'Lightning'
    this.mesh = new Mesh(new BufferGeometry(), this.createMaterial())
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    this.object.add(this.mesh, this.light)
    this.reset(input)
  }

  /** Merges `input` into the settings. */
  set(input: LightningInput): this {
    this.options = merge(this.options ?? structuredClone(DEFAULT_LIGHTNING), input)
    return this.apply()
  }

  /** Replaces all settings (anything not given goes back to defaults). */
  reset(input: LightningInput = {}): this {
    this.options = resolve(DEFAULT_LIGHTNING, input)
    return this.apply()
  }

  private apply(): this {
    this.uniforms.color.value.set(this.options.color).multiplyScalar(this.options.intensity)
    this.light.color.set(this.options.flash.color)
    this.slots = [] // rebuild bolts with the new shape settings
    return this
  }

  /** Sets the frame position at render-space zero (floating origin), `[x, y, z]`. */
  setOrigin(origin: readonly number[]): this {
    this.origin = [origin[0], origin[1] ?? 0, origin[2] ?? 0]
    this.slots = []
    return this
  }

  /** Calls `listener` once for each strike as time passes it. Returns an unsubscribe function. */
  onStrike(listener: (strike: Strike) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Shows the strikes around the camera at `time` seconds and fires `onStrike` for new ones. */
  update(time: number): void {
    const o = this.options
    const cam = this.camera.getWorldPosition(_v)
    const fx = cam.x + this.origin[0], fz = cam.z + this.origin[2]
    const R = o.radius
    const last = this.lastTime
    this.lastTime = time
    // New strikes since the last update (not on big jumps or when scrubbing back).
    if (this.listeners.size && last !== null && time > last && time - last < 5) {
      for (const s of this.weather.strikes(fx - R, fz - R, fx + R, fz + R, last, time)) for (const l of this.listeners) l(s)
    }

    const visible = this.weather.strikes(fx - R, fz - R, fx + R, fz + R, time - o.duration, time + 1e-6).slice(-Math.min(o.maxBolts, 16))
    this.active = visible
    const seeds = visible.map((s) => s.seed)
    if (seeds.length !== this.slots.length || seeds.some((s, i) => s !== this.slots[i])) this.rebuild(visible)

    let peak = 0, top: Strike | null = null
    const brightness = this.uniforms.brightness.array as number[]
    brightness.fill(0)
    visible.forEach((s, i) => {
      const b = flicker(s, time - s.time, o.duration)
      brightness[i] = b
      if (b > peak) { peak = b; top = s }
    })
    this.flash = Math.min(1, peak)
    this.light.intensity = o.flash.intensity * peak
    if (top) {
      const s = top as Strike
      this.light.position.set(s.x - this.origin[0], this.groundAt(s.x, s.z) + o.cloudHeight * 0.6 - this.origin[1], s.z - this.origin[2])
    }
    this.mesh.visible = visible.length > 0
  }

  private groundAt(x: number, z: number) {
    return this.ground ? this.ground(x, z) : 0
  }

  // All visible bolts into one geometry: each segment is a camera-facing ribbon (4 vertices).
  private rebuild(strikes: Strike[]) {
    const o = this.options
    this.slots = strikes.map((s) => s.seed)
    const segments: number[] = [] // ax, ay, az, bx, by, bz, width, slot
    strikes.forEach((s, slot) => {
      const rand = mulberry32(s.seed)
      const gx = s.x - this.origin[0], gy = this.groundAt(s.x, s.z) - this.origin[1], gz = s.z - this.origin[2]
      const main = channel([gx + (rand() - 0.5) * o.cloudHeight * 0.3, gy + o.cloudHeight, gz + (rand() - 0.5) * o.cloudHeight * 0.3], [gx, gy, gz], o.detail, o.jaggedness, rand)
      pushChannel(segments, main, o.width, slot)
      for (let b = 0; b < o.branches; b++) {
        const start = main[Math.floor((0.1 + rand() * 0.6) * (main.length - 1))]
        const len = o.cloudHeight * o.branchLength * (0.4 + rand() * 0.6)
        const a = rand() * Math.PI * 2
        const end: [number, number, number] = [start[0] + Math.cos(a) * len * 0.7, start[1] - len * (0.5 + rand() * 0.5), start[2] + Math.sin(a) * len * 0.7]
        pushChannel(segments, channel(start, end, Math.max(2, o.detail - 2), o.jaggedness, rand), o.width * 0.4, slot)
      }
    })
    const count = segments.length / 8
    const pos = new Float32Array(count * 12), other = new Float32Array(count * 12), extra = new Float32Array(count * 8)
    const index = new Uint32Array(count * 6)
    for (let k = 0; k < count; k++) {
      const s = k * 8
      for (let v = 0; v < 4; v++) {
        const [p, q] = v < 2 ? [s, s + 3] : [s + 3, s]
        pos.set([segments[p], segments[p + 1], segments[p + 2]], (k * 4 + v) * 3)
        other.set([segments[q], segments[q + 1], segments[q + 2]], (k * 4 + v) * 3)
        extra[(k * 4 + v) * 2] = (v % 2 ? 1 : -1) * (segments[s + 7] + 1) // side sign × (slot + 1)
        extra[(k * 4 + v) * 2 + 1] = segments[s + 6] // width
      }
      index.set([k * 4, k * 4 + 1, k * 4 + 3, k * 4, k * 4 + 3, k * 4 + 2], k * 6)
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(pos, 3))
    g.setAttribute('aOther', new BufferAttribute(other, 3))
    g.setAttribute('aExtra', new BufferAttribute(extra, 2))
    g.setIndex(new BufferAttribute(index, 1))
    g.boundingSphere = new Sphere(new Vector3(), 1e9)
    this.mesh.geometry.dispose()
    this.mesh.geometry = g
  }

  private createMaterial() {
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending })
    m.name = 'Lightning'
    const other = attribute<'vec3'>('aOther', 'vec3')
    const extra = attribute<'vec2'>('aExtra', 'vec2')
    const world = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz
    const dir = normalize(other.sub(positionGeometry))
    const side = normalize(cross(dir, normalize(cameraPosition.sub(world))))
    const width = extra.y
    // aExtra.x packs side (±1) and slot: side = sign, slot = |x| − 1.
    const sideSign = extra.x.sign()
    const slot = int(extra.x.abs().sub(1))
    m.positionNode = positionGeometry.add(side.mul(sideSign.mul(width).mul(0.5)))
    m.colorNode = this.uniforms.color.mul(this.uniforms.brightness.element(slot) as unknown as Node<"float">)
    return m
  }

  /** Removes the bolts and light and frees GPU resources. */
  dispose(): void {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.object.removeFromParent()
  }
}

const _v = new Vector3()

/** Brightness of a strike `age` seconds old: a few return strokes, then a fading glow. */
function flicker(s: Strike, age: number, duration: number): number {
  if (age < 0 || age > duration) return 0
  const r = mulberry32(s.seed ^ 0x51ed)
  const strokes = 2 + Math.floor(r() * 3)
  let b = 0
  for (let k = 0; k < strokes; k++) {
    const at = duration * (k / strokes) * (0.6 + 0.4 * r())
    b = Math.max(b, Math.exp(-(((age - at) / 0.03) ** 2)))
  }
  return (b + 0.2 * (1 - age / duration)) * (0.5 + 0.5 * s.intensity)
}

/** A jagged path from `a` to `b` by midpoint displacement. */
function channel(a: [number, number, number], b: [number, number, number], levels: number, jag: number, rand: () => number): [number, number, number][] {
  let pts = [a, b]
  for (let l = 0; l < levels; l++) {
    const next: [number, number, number][] = [pts[0]]
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i]
      const len = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])
      const off = len * jag
      next.push([(p[0] + q[0]) / 2 + (rand() - 0.5) * off * 2, (p[1] + q[1]) / 2 + (rand() - 0.5) * off * 0.5, (p[2] + q[2]) / 2 + (rand() - 0.5) * off * 2], q)
    }
    pts = next
  }
  return pts
}

function pushChannel(out: number[], pts: [number, number, number][], width: number, slot: number) {
  for (let i = 1; i < pts.length; i++) {
    const taper = 1 - (0.6 * i) / pts.length
    out.push(...pts[i - 1], ...pts[i], width * taper, slot)
  }
}
