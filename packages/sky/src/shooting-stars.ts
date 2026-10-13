/**
 * Shooting stars: occasional meteors streaking across the night sky with fading trails. The schedule
 * is a seeded Poisson process over elapsed (unscaled, unpaused) seconds, so the same seed shows the
 * same meteors at the same moments. Sporadic meteors come from random directions; a shower radiates
 * from one point.
 */
import { AdditiveBlending, Color, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, NodeMaterial, PlaneGeometry, Sphere, Vector3 } from 'three/webgpu'
import { attribute, cross, float, max, mix, normalize, pow, positionLocal, smoothstep, uniform, varying, vec4 } from 'three/tsl'
import { farDomePosition } from './atmosphere.ts'
import { defaultSkyState, type SkyState } from './observer.ts'
import { DEG, clamp, hash3, hexToLinear, mulberry32, seedOf, type Vec3 } from './util.ts'

/** Meteor settings. Plain JSON. */
export interface ShootingStarsOptions {
  /** Show meteors. */
  enabled: boolean
  /** Seed for the schedule and paths. */
  seed: number | string
  /** Sporadic meteors per hour of elapsed time (real seconds, not sky time). */
  rate: number
  /** Extra meteors per hour from the shower radiant (0 = no shower; thousands = a meteor storm). */
  shower: number
  /** Shower radiant as [azimuth, elevation] in degrees, or `null` for a seeded one. */
  radiant: [number, number] | null
  /** Lowest elevation a meteor's midpoint appears at, degrees. */
  minElevation: number
  /** Shortest and longest flight, seconds. */
  duration: [number, number]
  /** Shortest and longest path across the sky, degrees. */
  length: [number, number]
  /** Fraction of the path the glowing trail covers behind the head, 0..1. */
  trail: number
  /** Streak width at the head, degrees. */
  width: number
  /** Brightness multiplier. */
  brightness: number
  /** Streak colour (`#rrggbb`). */
  color: string
}

/** Defaults: a dozen sporadic meteors an hour. */
export const DEFAULT_SHOOTING_STARS: ShootingStarsOptions = {
  enabled: true,
  seed: 1,
  rate: 12,
  shower: 0,
  radiant: null,
  minElevation: 15,
  duration: [0.35, 1.3],
  length: [6, 28],
  trail: 0.45,
  width: 0.09,
  brightness: 1,
  color: '#dfe8ff',
}

/** One scheduled meteor. Directions are unit vectors in the horizon frame (x east, y up, z south). */
export interface Meteor {
  /** Start time, elapsed seconds. */
  start: number
  /** Flight time, seconds. */
  duration: number
  /** Where the path starts. */
  from: Vec3
  /** Where the path ends. */
  to: Vec3
  /** Peak brightness, 0.3..1.5 (an occasional fireball is brighter). */
  brightness: number
  /** Whether it belongs to the shower. */
  shower: boolean
}

const SLOT = 60 // seconds per schedule slot
const DEFAULT_STATE = defaultSkyState()

/** Unit horizon-frame vector from azimuth (from north through east) and elevation, degrees. */
export function horizonVector(azimuth: number, elevation: number): Vec3 {
  const a = azimuth * DEG, e = elevation * DEG
  return [Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)]
}

/** Seeded shower radiant used when `radiant` is null. */
export function seededRadiant(seed: number | string): [number, number] {
  const r = mulberry32(hash3(seedOf(seed), 0x7ad1a7))
  return [r() * 360, 25 + r() * 45]
}

const rotate = (p: Vec3, t: Vec3, a: number): Vec3 => {
  const c = Math.cos(a), s = Math.sin(a)
  return [p[0] * c + t[0] * s, p[1] * c + t[1] * s, p[2] * c + t[2] * s]
}
const unit = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l] }

/** The meteors of one schedule slot (deterministic). */
function slot(o: ShootingStarsOptions, seed: number, k: number): Meteor[] {
  const rand = mulberry32(hash3(seed, k, 0x5ee7))
  const total = Math.max(0, o.rate) + Math.max(0, o.shower)
  const lambda = (total * SLOT) / 3600
  // Poisson sample of how many meteors start in this slot.
  let n = 0
  for (let p = Math.exp(-lambda), F = p, u = rand(); u > F && n < 200; ) { n++; p *= lambda / n; F += p }
  const radiant = horizonVector(...(o.radiant ?? seededRadiant(o.seed)))
  const out: Meteor[] = []
  for (let i = 0; i < n; i++) {
    const shower = rand() * total < o.shower
    const sinMin = Math.sin(clamp(o.minElevation, 0, 85) * DEG)
    let P: Vec3 = [0, 1, 0], t: Vec3 = [1, 0, 0]
    for (let tries = 0; tries < 6; tries++) {
      if (shower) {
        // 8–60° from the radiant, in a random direction around it.
        const d = (8 + rand() * 52) * DEG, spin = rand() * 2 * Math.PI
        const ref: Vec3 = Math.abs(radiant[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]
        const e1 = unit([radiant[1] * ref[2] - radiant[2] * ref[1], radiant[2] * ref[0] - radiant[0] * ref[2], radiant[0] * ref[1] - radiant[1] * ref[0]])
        const e2: Vec3 = [radiant[1] * e1[2] - radiant[2] * e1[1], radiant[2] * e1[0] - radiant[0] * e1[2], radiant[0] * e1[1] - radiant[1] * e1[0]]
        const side: Vec3 = [e1[0] * Math.cos(spin) + e2[0] * Math.sin(spin), e1[1] * Math.cos(spin) + e2[1] * Math.sin(spin), e1[2] * Math.cos(spin) + e2[2] * Math.sin(spin)]
        P = rotate(radiant, side, d)
        t = rotate(side, [-radiant[0], -radiant[1], -radiant[2]], d) // away from the radiant along the great circle
      } else {
        // Uniform over the sky above minElevation.
        const y = sinMin + rand() * (0.97 - sinMin), az = rand() * 2 * Math.PI, c = Math.sqrt(1 - y * y)
        P = [c * Math.sin(az), y, -c * Math.cos(az)]
        // Random heading in the tangent plane, mostly downwards (meteors fall into the atmosphere).
        const east: Vec3 = [Math.cos(az), 0, Math.sin(az)], rise: Vec3 = [-y * Math.sin(az), c, y * Math.cos(az)]
        const h = rand() * 2 * Math.PI, down = rand() < 0.8 ? -Math.abs(Math.sin(h)) : Math.sin(h)
        t = unit([east[0] * Math.cos(h) + rise[0] * down, east[1] * Math.cos(h) + rise[1] * down, east[2] * Math.cos(h) + rise[2] * down])
      }
      if (P[1] >= sinMin) break
    }
    const len = (o.length[0] + rand() * (o.length[1] - o.length[0])) * DEG * (shower ? 0.8 : 1)
    out.push({
      start: k * SLOT + rand() * SLOT,
      duration: o.duration[0] + rand() * (o.duration[1] - o.duration[0]),
      from: rotate(P, t, -len / 2),
      to: rotate(P, t, len / 2),
      brightness: rand() < 0.04 ? 1.5 : 0.3 + rand() * 0.7,
      shower,
    })
  }
  return out
}

/** Meteors in flight at elapsed time `time` (seconds). Pure and deterministic. */
export function meteorsAt(options: ShootingStarsOptions, time: number, out: Meteor[] = []): Meteor[] {
  out.length = 0
  if (!options.enabled || options.rate + options.shower <= 0) return out
  const seed = seedOf(options.seed)
  const maxDur = Math.max(options.duration[0], options.duration[1])
  for (let k = Math.floor((time - maxDur) / SLOT); k <= Math.floor(time / SLOT); k++) {
    for (const m of slot(options, seed, k)) if (time >= m.start && time < m.start + m.duration) out.push(m)
  }
  return out
}

/** Most meteors drawn at once. */
export const MAX_METEORS = 32

/** Input for {@link ShootingStars}: any subset of {@link ShootingStarsOptions}. */
export type ShootingStarsInput = Partial<ShootingStarsOptions>

/**
 * Meteors drawn as tapered, fading streaks on the far dome. Created by `Sky`; use it on its own by
 * calling `update(dt, state)` every frame.
 */
export class ShootingStars {
  /** The streak mesh. Add it to your scene. */
  readonly object: Mesh<InstancedBufferGeometry, NodeMaterial>
  /** Resolved settings. Change them with {@link ShootingStars.set} / {@link ShootingStars.reset}. */
  settings: ShootingStarsOptions = structuredClone(DEFAULT_SHOOTING_STARS)
  /** Elapsed seconds driving the schedule. Advanced by {@link ShootingStars.update}; set it to scrub. */
  elapsed = 0
  /** Meteors in flight after the last update. */
  readonly active: Meteor[] = []
  private readonly head = new Float32Array(MAX_METEORS * 3)
  private readonly tail = new Float32Array(MAX_METEORS * 3)
  private readonly params = new Float32Array(MAX_METEORS * 2)
  private readonly color = uniform(new Color(1, 1, 1))
  private readonly brightness = uniform(1)

  /** Creates the meteor layer; anything not given uses {@link DEFAULT_SHOOTING_STARS}. */
  constructor(input: ShootingStarsInput = {}) {
    const g = new InstancedBufferGeometry()
    const quad = new PlaneGeometry(1, 1, 12, 1)
    g.index = quad.index
    g.setAttribute('position', quad.getAttribute('position'))
    g.setAttribute('aHead', new InstancedBufferAttribute(this.head, 3))
    g.setAttribute('aTail', new InstancedBufferAttribute(this.tail, 3))
    g.setAttribute('aParams', new InstancedBufferAttribute(this.params, 2))
    g.instanceCount = 0
    g.boundingSphere = new Sphere(new Vector3(), Infinity) // drawn on the far dome around any camera

    const head = attribute('aHead', 'vec3'), tail = attribute('aTail', 'vec3'), params = attribute('aParams', 'vec2')
    const s = positionLocal.x.add(0.5) // 0 at the tail, 1 at the head
    const dir = normalize(mix(tail, head, s))
    const side = normalize(cross(dir, head.sub(tail)))
    const halfWidth = params.y.mul(DEG).mul(s.mul(0.75).add(0.25))
    const material = new NodeMaterial()
    material.transparent = true
    material.blending = AdditiveBlending
    material.depthWrite = false
    material.fog = false
    material.vertexNode = farDomePosition(dir.add(side.mul(positionLocal.y.mul(2)).mul(halfWidth)))
    const vIntensity = varying(params.x)
    const across = float(1).sub(positionLocal.y.abs().mul(2))
    const glow = pow(max(s, 0), 2.2).mul(across.mul(across)).add(smoothstep(0.93, 1, s).mul(across).mul(2))
    material.colorNode = vec4(this.color.mul(glow).mul(vIntensity).mul(this.brightness), 1)
    this.object = new Mesh(g, material)
    this.object.name = 'ShootingStars'
    this.object.frustumCulled = false
    this.object.renderOrder = -998
    this.set(input)
  }

  /** Merges settings. */
  set(input: ShootingStarsInput): this {
    for (const [k, v] of Object.entries(input)) if (v !== undefined) (this.settings as any)[k] = v
    return this.apply()
  }

  /** Replaces all settings; anything not given goes back to {@link DEFAULT_SHOOTING_STARS}. */
  reset(input: ShootingStarsInput = {}): this {
    this.settings = structuredClone(DEFAULT_SHOOTING_STARS)
    return this.set(input)
  }

  private apply(): this {
    this.color.value.setRGB(...hexToLinear(this.settings.color))
    this.brightness.value = this.settings.brightness * 6
    this.object.visible = this.settings.enabled
    return this
  }

  /**
   * Advances the schedule and refreshes the streaks.
   * @param dt Real seconds since the last frame (0 while paused).
   * @param state Sky state: provides the horizon frame and `night` (meteors fade out by day).
   */
  update(dt: number, state: SkyState = DEFAULT_STATE): void {
    this.elapsed += dt
    meteorsAt(this.settings, this.elapsed, this.active)
    const visible = state.night * (1 - clamp(state.altitude / 80_000, 0, 1))
    const { east: e, up: u, north: n } = state
    const toRender = (v: Vec3, arr: Float32Array, i: number) => {
      arr[i * 3] = e[0] * v[0] + u[0] * v[1] - n[0] * v[2]
      arr[i * 3 + 1] = e[1] * v[0] + u[1] * v[1] - n[1] * v[2]
      arr[i * 3 + 2] = e[2] * v[0] + u[2] * v[1] - n[2] * v[2]
    }
    let count = 0
    for (const m of this.active) {
      if (count >= MAX_METEORS || visible <= 0) break
      const p = (this.elapsed - m.start) / m.duration
      const along = (q: number): Vec3 => {
        // Slerp from→to.
        const c = clamp(m.from[0] * m.to[0] + m.from[1] * m.to[1] + m.from[2] * m.to[2], -1, 1)
        const w = Math.acos(c), sw = Math.sin(w) || 1
        const a = Math.sin((1 - q) * w) / sw, b = Math.sin(q * w) / sw
        return [m.from[0] * a + m.to[0] * b, m.from[1] * a + m.to[1] * b, m.from[2] * a + m.to[2] * b]
      }
      toRender(along(p), this.head, count)
      toRender(along(Math.max(0, p - this.settings.trail) - 1e-4), this.tail, count)
      this.params[count * 2] = m.brightness * Math.pow(Math.sin(Math.PI * p), 0.6) * visible
      this.params[count * 2 + 1] = this.settings.width
      count++
    }
    const g = this.object.geometry
    g.instanceCount = count
    for (const name of ['aHead', 'aTail', 'aParams']) (g.getAttribute(name) as InstancedBufferAttribute).needsUpdate = true
  }

  /** Frees GPU resources. */
  dispose(): void {
    this.object.removeFromParent()
    this.object.geometry.dispose()
    this.object.material.dispose()
  }
}

