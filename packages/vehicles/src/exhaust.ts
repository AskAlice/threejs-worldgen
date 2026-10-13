// Engine smoke and exhaust for a fleet, through one shared threejs-particles `ParticleSystem`: every
// vehicle's vents (tailpipes, stacks, chimneys) become weighted, moving particle sources each frame,
// nearest first and none beyond `maxDistance`. Steam engines plume and chuff in time with their wheels,
// diesel locomotives haze and spike on acceleration, truck and tractor stacks puff dark smoke when
// pulling away, and car tailpipes show mostly as condensation in cold or humid air. Electric vehicles
// have no vents, so they emit nothing.
import { Object3D, Vector3, type Camera, type Renderer } from 'three/webgpu'
import { MOTION_STRIDE, ParticleSystem, SOURCE_STRIDE, type ParticleInput } from 'threejs-particles'
import type { ExhaustVent } from './models.ts'
import type { FleetSim, DeepPartial } from './sim.ts'
import type { Fleet } from './fleet.ts'

/** Vent kinds. */
export type VentKind = ExhaustVent['kind']

/** How one kind of vent smokes. Plain JSON. */
export interface VentLook {
  /** Particles per second per vent at full output. */
  rate: number
  /** Puff size at the outlet, metres (puffs grow over their life). */
  size: number
  /** Opacity at full output, 0…1. */
  opacity: number
  /** 0 = clean white (steam, condensation) … 1 = dark soot. */
  tint: number
  /** Exhaust heat relative to a car's (drives how hard the smoke rises). */
  heat: number
  /** Gas exit speed out of the outlet, m/s. */
  speed: number
}

/** Settings of a {@link VehicleExhaust}. Plain JSON. */
export interface ExhaustSettings {
  /** Emit at all. */
  enabled: boolean
  /** Particle pool size (shared by every vehicle). Changing it (or `maxVents`) rebuilds the GPU buffers. */
  capacity: number
  /** No smoke from vehicles farther than this from the camera, metres; it fades out over the last 40 %. */
  maxDistance: number
  /** Most vents emitting at once (the nearest). */
  maxVents: number
  /** Air temperature, °C: cold air makes tailpipe condensation visible. */
  temperature: number
  /** Relative humidity, 0…1: humid air makes it linger. */
  humidity: number
  /** Wind, m/s (fleet-local). */
  wind: [number, number, number]
  /** Overall emission multiplier. */
  intensity: number
  /** Particle life range, seconds. */
  life: [number, number]
  /** Per vent kind. */
  kinds: Record<VentKind, VentLook>
}

/** Partial settings for {@link VehicleExhaust}. */
export type ExhaustInput = DeepPartial<ExhaustSettings>

/** Default exhaust: mild, cool and fairly dry air. */
export const DEFAULT_EXHAUST: ExhaustSettings = {
  enabled: true,
  capacity: 10000,
  maxDistance: 350,
  maxVents: 256,
  temperature: 12,
  humidity: 0.6,
  wind: [1.2, 0, 0.4],
  intensity: 1,
  life: [2.5, 6],
  kinds: {
    tailpipe: { rate: 60, size: 0.24, opacity: 0.14, tint: 0.1, heat: 0.6, speed: 2.2 },
    stack: { rate: 36, size: 0.9, opacity: 0.24, tint: 0.6, heat: 1, speed: 4 },
    steam: { rate: 80, size: 1.5, opacity: 0.85, tint: 0.08, heat: 1.6, speed: 7 },
    diesel: { rate: 30, size: 1.4, opacity: 0.22, tint: 0.85, heat: 1.2, speed: 5 },
  },
}

/** Per-vehicle state the emission reads between frames (acceleration from speed differences), and reused selection buffers. */
export interface ExhaustState {
  /** Speed last frame, m/s. */
  speed: Float32Array
  /** Smoothed acceleration, m/s². */
  accel: Float32Array
  /** Distance to the eye this frame (scratch). */
  dist: Float32Array
  /** Candidate vehicles, the nearest first after selection (scratch). */
  pick: Int32Array
}

/** A fresh {@link ExhaustState} for `count` vehicles. */
export function createExhaustState(count: number): ExhaustState {
  return { speed: new Float32Array(count).fill(NaN), accel: new Float32Array(count), dist: new Float32Array(count), pick: new Int32Array(count) }
}

/** Vehicle `a` comes before `b`: nearer, or as near with a lower index (deterministic). */
const nearer = (dist: Float32Array, a: number, b: number) => dist[a] < dist[b] || (dist[a] === dist[b] && a < b)

/**
 * Moves the `k` nearest of `pick[0…n)` (by distance, then index) to the front, nearest first, in place:
 * a quickselect, then an insertion sort of just those `k`.
 */
function nearestFirst(pick: Int32Array, dist: Float32Array, n: number, k: number): void {
  k = Math.min(k, n)
  let lo = 0, hi = n - 1
  while (k < n && lo < hi) {
    const pivot = pick[(lo + hi) >> 1]
    let i = lo, j = hi
    while (i <= j) {
      while (nearer(dist, pick[i], pivot)) i++
      while (nearer(dist, pivot, pick[j])) j--
      if (i <= j) { const t = pick[i]; pick[i] = pick[j]; pick[j] = t; i++; j-- }
    }
    if (k - 1 <= j) hi = j
    else if (k - 1 >= i) lo = i
    else break
  }
  for (let i = 1; i < k; i++) {
    const x = pick[i]
    let j = i - 1
    while (j >= 0 && nearer(dist, x, pick[j])) { pick[j + 1] = pick[j]; j-- }
    pick[j + 1] = x
  }
}

/** Where {@link exhaustSources} writes: `SOURCE_STRIDE` floats per source and `MOTION_STRIDE` per motion, as `ParticleSystem.setSources` takes them. */
export interface ExhaustBuffers {
  sources: Float32Array
  motion: Float32Array
  /** Vehicle index of each source (for tests and debugging). */
  vehicle: Int32Array
}

/** Buffers for up to `max` sources. */
export function createExhaustBuffers(max: number): ExhaustBuffers {
  return { sources: new Float32Array(max * SOURCE_STRIDE), motion: new Float32Array(max * MOTION_STRIDE), vehicle: new Int32Array(max) }
}

const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

/** How visible tailpipe condensation is in this air, 0…1 (cold and humid: clearly; warm and dry: hardly). */
export function condensation(temperature: number, humidity: number): number {
  const cold = smoothstep(18, -5, temperature)
  return Math.min(1, cold * (0.45 + 0.55 * humidity) + 0.25 * Math.max(0, humidity - 0.8) / 0.2)
}

/**
 * This frame's smoke sources for a fleet simulation, as fleet-local particle sources (pure, no GPU):
 * every vent of every vehicle within `maxDistance` of `eye`, nearest first up to `maxVents`, weighted
 * by what the engine is doing (idling, cruising, pulling away; steam chuffs with the wheels) and the
 * air, faded by distance. Particles inherit the vehicle's velocity plus the exit speed along the
 * vent. Advances `state` by `dt`. Returns the number of sources written.
 */
export function exhaustSources(sim: FleetSim, eye: { x: number; y: number; z: number }, settings: ExhaustSettings, state: ExhaustState, dt: number, out: ExhaustBuffers): number {
  const n = sim.count, p = sim.pose
  // Acceleration per vehicle, smoothed (a pulling-away truck smokes for a few seconds).
  for (let v = 0; v < n; v++) {
    const prev = state.speed[v], sp = sim.speed[v]
    const a = dt > 0 && prev === prev ? (sp - prev) / dt : 0
    state.accel[v] += (a - state.accel[v]) * Math.min(1, dt * 3)
    state.speed[v] = sp
  }
  if (!settings.enabled) return 0
  const max = Math.min(settings.maxVents, out.vehicle.length)
  const reach = settings.maxDistance
  if (state.pick.length < n) { state.pick = new Int32Array(n); state.dist = new Float32Array(n) }
  const { pick, dist } = state
  let candidates = 0
  for (let v = 0; v < n; v++) {
    if (!sim.models[sim.model[v]].vents.length) continue
    const d = Math.hypot(p[v * 8] - eye.x, p[v * 8 + 1] - eye.y, p[v * 8 + 2] - eye.z)
    if (d >= reach) continue
    dist[v] = d
    pick[candidates++] = v
  }
  // Only the nearest `max` vehicles can be used (each has at least one vent): select, don't sort all.
  nearestFirst(pick, dist, candidates, max)
  const vis = condensation(settings.temperature, settings.humidity)
  let k = 0
  for (let c0 = 0; c0 < candidates; c0++) {
    const v = pick[c0]
    if (k >= max) break
    const m = sim.models[sim.model[v]], o = v * 8
    const yaw = p[o + 3], c = Math.cos(yaw), s = Math.sin(yaw), speed = sim.speed[v]
    const throttle = p[o + 7], pull = Math.min(1.5, Math.max(0, state.accel[v]) / 2), idle = speed < 0.5
    const fade = 1 - smoothstep(reach * 0.6, reach, dist[v])
    for (const vent of m.vents) {
      if (k >= max) break
      const look = settings.kinds[vent.kind]
      let w = 0, alpha = look.opacity, tint = look.tint, size = look.size
      if (vent.kind === 'tailpipe') {
        w = (idle ? 0.55 : 0.35 + 0.2 * throttle) + pull * 1.2
        w *= 0.25 + 0.75 * vis
        alpha *= 0.1 + 0.9 * vis
      } else if (vent.kind === 'stack') {
        w = 0.25 + 0.35 * throttle + pull * 2.5
        alpha *= 0.35 + 0.65 * Math.min(1, pull * 1.4)
        tint = Math.min(1, tint + 0.2 * pull)
      } else if (vent.kind === 'steam') {
        // Beats: four per turn of the driving wheels; at speed they blur into a steady plume.
        const pulse = vent.pulse ?? 1.4, beat = speed / pulse
        const chuff = Math.max(0, Math.cos((2 * Math.PI * sim.travel[v]) / pulse)) ** 6
        const blur = smoothstep(3, 9, beat)
        w = idle ? 0.3 : 0.5 + (1 - blur) * chuff * 2.5 + blur * 0.9 + pull * 0.8
        size *= 1 + 0.25 * (1 - vis)
      } else {
        w = 0.25 + 0.3 * throttle + pull * 3
        alpha *= 0.4 + 0.6 * Math.min(1, pull * 1.5)
      }
      w *= look.rate * settings.intensity * fade
      if (w <= 0) continue
      const [x, y, z] = vent.position, [dx, dy, dz] = vent.direction
      const S = k * SOURCE_STRIDE, M = k * MOTION_STRIDE
      out.sources[S] = p[o] + c * x + s * z
      out.sources[S + 1] = p[o + 1] + y
      out.sources[S + 2] = p[o + 2] - s * x + c * z
      out.sources[S + 3] = w
      out.sources[S + 4] = size / Math.max(1e-3, settings.kinds.tailpipe.size) // size scale (the system's base size is the tailpipe's)
      out.sources[S + 5] = 0
      out.sources[S + 6] = tint
      out.sources[S + 7] = look.heat
      out.motion[M] = s * speed + (c * dx + s * dz) * look.speed
      out.motion[M + 1] = dy * look.speed
      out.motion[M + 2] = c * speed + (-s * dx + c * dz) * look.speed
      out.motion[M + 3] = alpha * (0.5 + 0.5 * fade)
      out.vehicle[k] = v
      k++
    }
  }
  return k
}

const _eye = new Vector3()

/**
 * Exhaust smoke and steam for a {@link Fleet}: one shared GPU particle system (soft, lit, view-facing
 * smoke puffs, depth-sorted) fed from every vehicle's vents each frame by {@link exhaustSources}.
 * Its object is parented to the fleet's, so particles live in fleet space.
 *
 * @example
 * ```ts
 * const exhaust = new VehicleExhaust(fleet, { temperature: -4, humidity: 0.8 })
 * renderer.setAnimationLoop(() => {
 *   fleet.update(dt)
 *   exhaust.update(renderer, dt, camera)
 *   renderer.render(scene, camera)
 * })
 * ```
 */
export class VehicleExhaust {
  /** Resolved settings. */
  settings: ExhaustSettings
  /** The particle system (its `object` is a child of the fleet's). */
  particles!: ParticleSystem
  /** Sources written last frame. */
  sourceCount = 0
  private readonly fleet: Fleet
  private state: ExhaustState
  private buffers: ExhaustBuffers
  private builtCapacity = -1
  private builtMaxVents = -1
  private sim: FleetSim | null = null

  constructor(fleet: Fleet, input: ExhaustInput = {}) {
    this.fleet = fleet
    this.settings = merge(structuredClone(DEFAULT_EXHAUST), input)
    this.state = createExhaustState(0)
    this.buffers = createExhaustBuffers(0)
    this.apply()
  }

  /** Merges `input` into the settings (capacity rebuilds the particle pool; the rest is live). */
  set(input: ExhaustInput): this {
    merge(this.settings, input)
    return this.apply()
  }

  /** Replaces the settings (anything not given goes back to {@link DEFAULT_EXHAUST}). */
  reset(input: ExhaustInput = {}): this {
    this.settings = merge(structuredClone(DEFAULT_EXHAUST), input)
    return this.apply()
  }

  /** The particle options for these settings. */
  particleOptions(): ParticleInput {
    const s = this.settings
    return {
      capacity: s.capacity, rate: 1, maxPerFrame: Math.min(s.capacity, 2048), life: s.life,
      emitter: { shape: 'sources', size: [0.06, 0.04, 0.06], velocity: [0, 0, 0], spread: 0.35, temperature: [360, 420] },
      forces: { gravity: 0, buoyancy: 0.6, ambientTemperature: 273.15 + s.temperature, cooling: 0.45, wind: s.wind, windShear: 0.2, drag: 1.4, turbulence: 0.9, turbulenceScale: 2.5, turbulenceSpeed: 0.35, gridLift: 0 },
      curves: { size: [0.35, 1, 1.9, 2.8, 3.6], opacity: [0, 0.75, 0.6, 0.35, 0.15, 0], color: ['#ffffff'] },
      render: {
        shading: 'smoke', blending: 'alpha', size: s.kinds.tailpipe.size, sizeRandom: [0.75, 1.3], aspect: 1, stretch: 0, intensity: 1, opacity: 1,
        softness: 0.6, sort: true, detail: 0.8, detailDistance: Math.min(120, s.maxDistance), shadowSteps: 1, lightSteps: 0, absorption: 1.8, anisotropy: 0.45,
        silverLining: 0.6, albedo: ['#ecebe7', '#4a4643'], glowStrength: 0, capHeight: 0,
      },
    }
  }

  private apply(): this {
    const s = this.settings
    s.capacity = Math.max(64, Math.round(s.capacity))
    const maxVents = Math.max(1, Math.round(s.maxVents))
    // The GPU source table is sized at construction: a new vent budget needs a new system (otherwise
    // extra sources would be dropped by weight instead of by distance).
    if (s.capacity !== this.builtCapacity || maxVents !== this.builtMaxVents) {
      this.particles?.dispose()
      this.particles = new ParticleSystem({ ...this.particleOptions(), maxSources: maxVents })
      this.particles.object.name = 'vehicle-exhaust'
      this.fleet.object.add(this.particles.object)
      this.builtCapacity = s.capacity
      this.builtMaxVents = maxVents
    } else this.particles.set(this.particleOptions())
    return this
  }

  /**
   * Advances the smoke by `dt` seconds: refreshes the sources from the fleet's vents (as seen from
   * `camera`) and runs the particle passes. Call after `fleet.update()`.
   */
  update(renderer: Renderer, dt: number, camera: Camera): this {
    const sim = this.fleet.sim
    if (sim !== this.sim || this.state.speed.length !== sim.count) {
      this.sim = sim
      this.state = createExhaustState(sim.count)
    }
    const max = Math.max(1, Math.round(this.settings.maxVents))
    if (this.buffers.vehicle.length !== max) this.buffers = createExhaustBuffers(max)
    camera.updateMatrixWorld()
    this.fleet.object.updateWorldMatrix(true, false)
    this.fleet.object.worldToLocal(_eye.setFromMatrixPosition(camera.matrixWorld))
    this.sourceCount = exhaustSources(sim, _eye, this.settings, this.state, dt, this.buffers)
    this.particles.setSources(this.buffers.sources, this.sourceCount, this.buffers.motion)
    let root: Object3D = this.fleet.object
    while (root.parent) root = root.parent
    this.particles.lighting.fromScene(root)
    this.particles.update(renderer, dt, camera)
    return this
  }

  /** Removes the particles and frees GPU resources. */
  dispose(): void {
    this.particles.dispose()
  }
}

function merge<T extends object>(target: T, input: object): T {
  const t = target as Record<string, unknown>
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue
    const plain = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x)
    t[k] = plain(v) && plain(t[k]) ? merge({ ...(t[k] as object) }, v as object) : structuredClone(v)
  }
  return target
}
