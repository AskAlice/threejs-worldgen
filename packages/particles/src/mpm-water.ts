// Water for the MPM core: a weakly compressible fluid material (equation-of-state pressure on J, viscosity, no
// shear stiffness) with clear and muddy presets, a CPU puddle height field, and a splash emitter that turns rain
// impacts into MPM splashes and feeds the puddles.
import type { ComputeNode } from 'three/webgpu'
import { Fn, If, clamp, float, floor, instanceIndex, ivec2, ivec3, min, pow, transpose, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { particleRandom } from './emitter.ts'
import type { FluidSurfaceInput } from './fluid-surface.ts'
import { mpmIdentity, registerMPMMaterial, type Mat3 } from './mpm-materials.ts'
import type { MPMSolver } from './mpm.ts'
import { merge, seedOf, type DeepPartial } from './options.ts'
import type { MPMEmit, MPMHeightFn } from './mpm-reference.ts'

export * from './fluid-surface.ts'

/** Parameters of the `water` material (plain JSON, live through `MPMSolver.set`). */
export interface WaterParams extends Record<string, number> {
  /** Rest density, kg/m³. */
  density: number
  /** Bulk modulus K of the equation of state, Pa. Sound speed is √(K·γ/ρ); real water's 2.2 GPa is far too stiff to step in real time. */
  bulk: number
  /** Tait exponent γ: p = K·(J^−γ − 1). 7 for water; 1 is the linear law. */
  gamma: number
  /** Dynamic viscosity μ, Pa·s (τ += μ·J·(C + Cᵀ)). Real water is 0.001; a little more damps sloshing on a coarse grid. */
  viscosity: number
}

/** Least volume ratio J a water particle keeps: the pressure is already ~35·K there, and a crushed particle stays finite. */
export const WATER_MIN_J = 0.6

/**
 * Equation-of-state pressure of water at volume ratio J (Tait): `p = K·(J^−γ − 1)` with J clamped to
 * [{@link WATER_MIN_J}, 1]. Compression pushes back; expansion is free (no tension, so spray separates cleanly).
 */
export function waterPressure(J: number, p: Pick<WaterParams, 'bulk' | 'gamma'>): number {
  return p.bulk * (Math.min(1, Math.max(WATER_MIN_J, J)) ** -p.gamma - 1)
}

/**
 * The `water` MPM material: Kirchhoff stress τ = −J·p(J)·I + μ·J·(C + Cᵀ), an equation-of-state pressure on J
 * (see {@link waterPressure}), viscosity from the velocity gradient C, and no shear stiffness. Its plasticity hook
 * resets F to J^(1/3)·I every substep (a fluid forgets its shape, only its volume matters) with J clamped to
 * [{@link WATER_MIN_J}, 1]: a particle never stores expansion, so separated spray lands again at rest volume and
 * the fluid cannot creep into a denser state the pressure no longer sees.
 */
export const WATER = registerMPMMaterial<WaterParams>({
  name: 'water',
  defaults: { density: 1000, bulk: 20000, gamma: 7, viscosity: 0.05 },
  stress: ({ J, C, params: p }) => {
    const pressure = p.bulk.mul(pow(clamp(J, WATER_MIN_J, 1), p.gamma.negate()).sub(1))
    return mpmIdentity().mul(J.mul(pressure).negate()).add(C.add(transpose(C)).mul(p.viscosity.mul(J)))
  },
  plasticity: ({ J }) => ({ F: mpmIdentity().mul(pow(clamp(J, WATER_MIN_J, 1), float(1 / 3))) }),
  cpu: {
    stress: ({ J, C, params: p }) => {
      const iso = -J * waterPressure(J, p as WaterParams)
      const eta = p.viscosity * J
      return C.map((_, k) => (k % 4 === 0 ? iso : 0) + eta * (C[k] + C[(k % 3) * 3 + Math.floor(k / 3)]))
    },
    plasticity: ({ J }) => {
      const s = Math.cbrt(Math.min(1, Math.max(WATER_MIN_J, J)))
      return { F: [s, 0, 0, 0, s, 0, 0, 0, s] as Mat3 }
    },
  },
  soundSpeed: (p) => Math.sqrt((Math.max(0, p.bulk) * Math.max(1, p.gamma)) / p.density),
  viscosity: (p) => Math.max(0, p.viscosity) / p.density,
})

/** A water preset: `water` material parameters plus the matching {@link FluidSurface} look. */
export interface WaterPreset {
  /** For `MPMSolver`'s `materials.water`. */
  material: WaterParams
  /** For `new FluidSurface(mpm, preset.surface)`. */
  surface: FluidSurfaceInput
}

/**
 * Clear and muddy water. Clear: water's density, sound speed ≈ 12 m/s (fine for splashes and falls up to a few
 * metres, ~3 % compression per metre of depth) and Beer–Lambert absorption of pure water (red goes first). Muddy:
 * suspended silt, heavier and more viscous, and a strong brown in-scattering that hides the bottom within a few
 * centimetres.
 */
export const WATER_PRESETS: Record<'clear' | 'muddy', WaterPreset> = {
  clear: {
    material: { density: 1000, bulk: 20000, gamma: 7, viscosity: 0.05 },
    surface: { absorption: [0.45, 0.07, 0.03], turbidity: 0.4, scatterColor: '#9fc4c8', foamColor: '#f4f7f8' },
  },
  muddy: {
    material: { density: 1150, bulk: 23000, gamma: 7, viscosity: 0.6 },
    surface: { absorption: [2.2, 3.2, 5.5], turbidity: 45, scatterColor: '#8a6a44', foamColor: '#d9ccb4' },
  },
}

// ---- puddles ----

/** Settings of a {@link PuddleField}. Plain JSON. */
export interface PuddleOptions {
  /** Cells along x and z. Fixed at construction. */
  resolution: [number, number]
  /** Cell size, metres. Fixed at construction. */
  cellSize: number
  /** World x, z of the field's minimum corner (cell (i, k) is centred at origin + (i + ½, k + ½)·cellSize). */
  origin: [number, number]
  /** How fast water runs off and levels out, m/s (a sheet-flow speed: one cell per cellSize / flowSpeed seconds). */
  flowSpeed: number
  /** Water soaking into the ground, mm/h. */
  infiltration: number
  /** Evaporation, mm/h. */
  evaporation: number
  /** Seconds for a dry surface to get wet under rain (e-folding). */
  wetTime: number
  /** Seconds for a wet surface without standing water to dry (e-folding). */
  dryTime: number
}

/** Partial {@link PuddleOptions}. */
export type PuddleInput = DeepPartial<PuddleOptions>

/** Default puddles: 64 × 64 cells of 10 cm, rain-time drying (an hour), a few cm/s of sheet flow. */
export const DEFAULT_PUDDLES: PuddleOptions = {
  resolution: [64, 64], cellSize: 0.1, origin: [-3.2, -3.2], flowSpeed: 0.05, infiltration: 2, evaporation: 0.5, wetTime: 60, dryTime: 3600,
}

/** Most flow steps one {@link PuddleField.update} runs (a longer `dt` takes longer steps). */
const PUDDLE_MAX_STEPS = 64
/** Fraction of a surface-height difference that flows to a neighbour per step (≤ 1/4 keeps the explicit scheme stable). */
const PUDDLE_RELAX = 0.2
/** Standing water deeper than this keeps a cell fully wet, metres. */
const PUDDLE_WET = 5e-4

/**
 * Rain water on terrain as a CPU height field: rain adds depth everywhere, water runs downhill and levels out
 * (an explicit, mass-conserving relaxation of the water surface between neighbouring cells), soaks in and
 * evaporates, so it gathers in low spots as puddles that grow while it rains and drain or dry when it stops. It
 * also keeps a surface `wetness` 0…1. Both are plain row-major arrays from (minX, minZ), the layout of
 * threejs-weathering's state field, for weathering and rendering to read. Deterministic (fixed internal step).
 */
export class PuddleField {
  /** Resolved settings. */
  options: PuddleOptions
  /** Cells along x and z. */
  readonly nx: number
  readonly nz: number
  /** Standing water per cell, metres (row-major, x fastest). */
  readonly depth: Float32Array
  /** Surface wetness per cell, 0…1. */
  readonly wetness: Float32Array
  /** Terrain height at the cell centres, world metres. */
  readonly ground: Float32Array
  /** Simulated seconds. */
  time = 0
  private readonly next: Float32Array
  private height: MPMHeightFn | null = null
  private carry = 0
  private raining = false

  /** A dry field over `height` (none: flat at 0). */
  constructor(input: PuddleInput = {}, height: MPMHeightFn | null = null) {
    this.options = resolvePuddleOptions(input)
    ;[this.nx, this.nz] = this.options.resolution
    const n = this.nx * this.nz
    this.depth = new Float32Array(n)
    this.wetness = new Float32Array(n)
    this.ground = new Float32Array(n)
    this.next = new Float32Array(n)
    this.setHeight(height)
  }

  /** Merges `input` into the settings (`resolution` and `cellSize` stay; moving `origin` re-bakes the ground and keeps the water per cell). */
  set(input: PuddleInput, height?: MPMHeightFn | null): this {
    const prev = this.options
    this.options = resolvePuddleOptions(merge(structuredClone(prev), input))
    this.options.resolution = [...prev.resolution]
    this.options.cellSize = prev.cellSize
    if (height !== undefined || String(prev.origin) !== String(this.options.origin)) this.setHeight(height === undefined ? this.height : height)
    return this
  }

  /** Re-bakes the terrain at the cell centres. */
  setHeight(height: MPMHeightFn | null): this {
    this.height = height
    const { cellSize: c, origin } = this.options
    for (let k = 0; k < this.nz; k++) for (let i = 0; i < this.nx; i++) {
      const h = height ? height(origin[0] + (i + 0.5) * c, origin[1] + (k + 0.5) * c) : 0
      this.ground[k * this.nx + i] = Number.isFinite(h) ? h : 0
    }
    return this
  }

  /** Length of one internal step, seconds. */
  get stepTime(): number {
    return (PUDDLE_RELAX * this.options.cellSize) / Math.max(1e-6, this.options.flowSpeed)
  }

  /**
   * Advances `dt` seconds with rain falling at `rain` mm/h (0: dry weather) in fixed internal steps. Past
   * 64 steps (fast-forward) the steps lengthen instead: water and time stay exact, levelling lags.
   */
  update(dt: number, rain = 0): this {
    const step = this.stepTime, total = this.carry + Math.max(0, dt)
    const n = Math.floor(total / step)
    this.raining = rain > 0
    if (n > PUDDLE_MAX_STEPS) {
      for (let s = 0; s < PUDDLE_MAX_STEPS; s++) this.step(total / PUDDLE_MAX_STEPS, rain)
      this.carry = 0
    } else {
      for (let s = 0; s < n; s++) this.step(step, rain)
      this.carry = total - n * step
    }
    return this
  }

  /** One internal step of `dt` seconds: rain, flow, losses, wetness. */
  step(dt: number, rain = 0): void {
    const { nx, nz, depth: d, ground: g, next } = this
    const o = this.options
    const add = (Math.max(0, rain) / 3.6e6) * dt, loss = ((o.infiltration + o.evaporation) / 3.6e6) * dt
    for (let i = 0; i < d.length; i++) d[i] += add
    next.set(d)
    // Each cell sends a share of its surface-height lead to each lower neighbour, scaled so it never sends more than it has.
    // Out of the field the ground is extrapolated linearly and dry: water leaves where the terrain falls away.
    const out = [0, 0, 0, 0]
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      const c = k * nx + i
      if (d[c] <= 0) continue
      const s = g[c] + d[c]
      let total = 0
      for (let e = 0; e < 4; e++) {
        const ii = i + (e === 0 ? 1 : e === 1 ? -1 : 0), kk = k + (e === 2 ? 1 : e === 3 ? -1 : 0)
        let sn: number
        if (ii >= 0 && ii < nx && kk >= 0 && kk < nz) sn = g[kk * nx + ii] + d[kk * nx + ii]
        else {
          const ib = Math.min(nx - 1, Math.max(0, 2 * i - ii)), kb = Math.min(nz - 1, Math.max(0, 2 * k - kk))
          sn = 2 * g[c] - g[kb * nx + ib]
        }
        out[e] = Math.max(0, s - sn) * PUDDLE_RELAX
        total += out[e]
      }
      const scale = total > d[c] ? d[c] / total : 1
      for (let e = 0; e < 4; e++) {
        const q = out[e] * scale
        if (!q) continue
        next[c] -= q
        const ii = i + (e === 0 ? 1 : e === 1 ? -1 : 0), kk = k + (e === 2 ? 1 : e === 3 ? -1 : 0)
        if (ii >= 0 && ii < nx && kk >= 0 && kk < nz) next[kk * nx + ii] += q
      }
    }
    const wet = 1 - Math.exp(-dt / Math.max(1e-6, o.wetTime)), dry = Math.exp(-dt / Math.max(1e-6, o.dryTime))
    for (let i = 0; i < d.length; i++) {
      d[i] = Math.max(0, next[i] - loss)
      const w = this.wetness[i]
      this.wetness[i] = d[i] > PUDDLE_WET ? 1 : rain > 0 ? w + (1 - w) * wet : w * dry
    }
    this.time += dt
  }

  /** Whether the last update had rain. */
  get isRaining(): boolean {
    return this.raining
  }

  /** Standing water and wetness at world (x, z), bilinear between cell centres (0 outside the field). */
  sample(x: number, z: number, out = { depth: 0, wetness: 0 }): { depth: number; wetness: number } {
    const { cellSize: c, origin } = this.options
    const gx = (x - origin[0]) / c - 0.5, gz = (z - origin[1]) / c - 0.5
    out.depth = out.wetness = 0
    if (!(gx > -1 && gz > -1 && gx < this.nx && gz < this.nz)) return out
    const i = Math.floor(gx), k = Math.floor(gz), fx = gx - i, fz = gz - k
    for (const [di, dk, w] of [[0, 0, (1 - fx) * (1 - fz)], [1, 0, fx * (1 - fz)], [0, 1, (1 - fx) * fz], [1, 1, fx * fz]] as const) {
      const ii = i + di, kk = k + dk
      if (ii < 0 || kk < 0 || ii >= this.nx || kk >= this.nz) continue
      out.depth += this.depth[kk * this.nx + ii] * w
      out.wetness += this.wetness[kk * this.nx + ii] * w
    }
    return out
  }

  /** Total standing water, m³. */
  volume(): number {
    let v = 0
    for (let i = 0; i < this.depth.length; i++) v += this.depth[i]
    return v * this.options.cellSize ** 2
  }

  /** Empties the field and dries it. */
  clear(): this {
    this.depth.fill(0)
    this.wetness.fill(0)
    this.carry = 0
    return this
  }
}

/** `structuredClone(DEFAULT_PUDDLES)` merged with `input`, sanitized. */
export function resolvePuddleOptions(input: unknown): PuddleOptions {
  const o = merge(structuredClone(DEFAULT_PUDDLES), input)
  const d = DEFAULT_PUDDLES
  const num = (v: unknown, def: number, lo = -Infinity, hi = Infinity) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def)
  o.resolution = [0, 1].map((a) => Math.round(num(o.resolution?.[a], d.resolution[a], 2, 2048))) as [number, number]
  o.cellSize = num(o.cellSize, d.cellSize, 1e-3)
  o.origin = [0, 1].map((a) => num(o.origin?.[a], d.origin[a])) as [number, number]
  o.flowSpeed = num(o.flowSpeed, d.flowSpeed, 1e-4)
  o.infiltration = num(o.infiltration, d.infiltration, 0)
  o.evaporation = num(o.evaporation, d.evaporation, 0)
  o.wetTime = num(o.wetTime, d.wetTime, 1e-3)
  o.dryTime = num(o.dryTime, d.dryTime, 1e-3)
  return o
}

// ---- splashes ----

/** Settings of a {@link SplashEmitter}. Plain JSON. */
export interface SplashOptions {
  /** Seed of the impact positions and splash shapes. */
  seed: number | string
  /** Rain rate, mm/h (0: no rain; puddles drain and dry). */
  rain: number
  /** MPM splashes per m² per second per mm/h of rain: the few visible splashes among the real drop impacts (~70 per m²·s per mm/h). */
  splashes: number
  /** Splashes land within this radius of `center`, metres (e.g. the near field around the camera). */
  radius: number
  /** Centre of the splash area, world x and z. */
  center: [number, number]
  /** Particles per splash: on dry ground (a low scatter of droplets) and on a puddle (a crown plus a central jet). */
  particles: [number, number]
  /** Launch speed of the splash droplets, m/s (a crown on water; dry-ground droplets fly lower and wider). */
  speed: number
  /** Puddle depth from which a drop splashes as onto water, metres. */
  puddleDepth: number
  /** Most splashes per update (the rest of that frame's are dropped). */
  maxPerFrame: number
  /** Material of the splash particles (one of the solver's). */
  material: string
  /** Also remove any particle that leaves the solver's domain (a stream running off its side), instead of freezing it. */
  retireOutside: boolean
  /**
   * Also remove stray water: a particle on its own (grid mass at its node below this many full cells of 1000 kg/m³)
   * resting on the ground soaks in, instead of lying there as a 15 mL bead. 0: off.
   */
  soak: number
}

/** Partial {@link SplashOptions}. */
export type SplashInput = DeepPartial<SplashOptions>

/** Default splashes: moderate rain (8 mm/h), 3 visible splashes per m²·s per mm/h within 3 m. */
export const DEFAULT_SPLASHES: SplashOptions = {
  seed: 1, rain: 8, splashes: 3, radius: 3, center: [0, 0], particles: [3, 4], speed: 1.2, puddleDepth: 0.002, maxPerFrame: 64, material: 'water', retireOutside: true,
  soak: 0.1,
}

/** `buffers.state.z` of splash particles: the retire pass removes them when they land on the ground. */
export const SPLASH_TAG = 1

/** Anything particles can be emitted into: an {@link MPMSolver} or an `MPMReference`. */
export interface SplashTarget {
  emit(spec: MPMEmit): number
  options: { cellSize: number; seed: number | string }
}

/** One rain-drop impact: where, and whether onto a puddle. */
export interface SplashImpact {
  x: number
  z: number
  /** Ground (plus puddle) height, world metres. */
  y: number
  /** Landed in a puddle (crown and jet) rather than on dry ground. */
  wet: boolean
}

/**
 * Rain on the ground near the camera as MPM splashes: each update a seeded number of drops (`rain` ×
 * `splashes` × area × dt, fractions carried over) hit the terrain within `radius` of `center`, and each spawns a
 * few water particles in the solver: on a puddle a crown and a jet, on dry ground a low scatter. Those
 * particles are tagged ({@link SPLASH_TAG}); the retire pass from {@link SplashEmitter.prepare} removes them when they
 * land again (their water is already counted in the puddles). With a {@link PuddleField}, the rain also feeds it.
 * Far from the camera, keep drawing rain as streaks; this is the near field.
 *
 * @example
 * ```ts
 * const puddles = new PuddleField({ resolution: [96, 96], cellSize: 0.05, origin: [-2.4, -2.4] }, height)
 * const rain = new SplashEmitter(mpm, { rain: 12, radius: 2 }, { height, puddles })
 * // each frame:
 * rain.set({ center: [camera.position.x, camera.position.z] }).update(dt)
 * renderer.compute([...mpm.prepare(dt), ...rain.prepare()])
 * ```
 */
export class SplashEmitter {
  /** Resolved settings. */
  options: SplashOptions
  /** The puddles the rain feeds (if any). */
  readonly puddles: PuddleField | null
  /** Splashes spawned so far (the serial of the next one: seeds its random numbers). */
  spawned = 0
  /** The last update's impacts. */
  readonly impacts: SplashImpact[] = []
  private readonly target: SplashTarget
  private height: MPMHeightFn | null
  private carry = 0
  private retireNode: ComputeNode | null = null
  private readonly retireOutside = uniform(1)
  private readonly soak = uniform(0.1)

  /** An emitter into `target` (an {@link MPMSolver}, or an `MPMReference` for tests) over `height`. */
  constructor(target: SplashTarget, input: SplashInput = {}, { height = null, puddles = null }: { height?: MPMHeightFn | null; puddles?: PuddleField | null } = {}) {
    this.target = target
    this.height = height
    this.puddles = puddles
    this.options = resolveSplashOptions(input)
  }

  /** Merges `input` into the settings. */
  set(input: SplashInput): this {
    this.options = resolveSplashOptions(merge(structuredClone(this.options), input))
    return this
  }

  /** Replaces the terrain height function. */
  setHeight(height: MPMHeightFn | null): this {
    this.height = height
    this.puddles?.setHeight(height)
    return this
  }

  /** Spawns this frame's splashes into the target and advances the puddles. Returns how many splashes. */
  update(dt: number): number {
    const o = this.options
    this.puddles?.update(dt, o.rain)
    const area = Math.PI * o.radius * o.radius
    const want = this.carry + Math.max(0, o.rain) * o.splashes * area * Math.max(0, dt)
    const count = Math.min(Math.floor(want), o.maxPerFrame)
    this.carry = count < Math.floor(want) ? 0 : want - count
    this.impacts.length = 0
    if (!count) return 0
    const seed = seedOf(o.seed)
    const h = this.target.options.cellSize / 2 // particle spacing
    const pos: number[] = [], vel: number[] = []
    const sample = { depth: 0, wetness: 0 }
    for (let s = 0; s < count; s++) {
      const serial = this.spawned + s
      const r = (k: number) => particleRandom(serial, k, seed)
      // Uniform in the disc.
      const rho = o.radius * Math.sqrt(r(0)), phi = r(1) * Math.PI * 2
      const x = o.center[0] + rho * Math.cos(phi), z = o.center[1] + rho * Math.sin(phi)
      const g = this.height ? this.height(x, z) : 0
      const depth = this.puddles ? this.puddles.sample(x, z, sample).depth : 0
      const wet = depth >= o.puddleDepth
      const y = g + depth
      this.impacts.push({ x, z, y, wet })
      const n = Math.max(1, Math.round(wet ? o.particles[1] : o.particles[0]))
      const spin = r(2) * Math.PI * 2, energy = 0.75 + 0.5 * r(3)
      const ring = wet ? n - 1 : n
      for (let k = 0; k < ring; k++) {
        const a = spin + (k / ring) * Math.PI * 2 + (r(4 + k) - 0.5) * 0.6
        const ca = Math.cos(a), sa = Math.sin(a)
        // On water a crown: steep and tall; on dry ground the drop shatters into a low, wide scatter.
        const out = o.speed * energy * (wet ? 0.45 : 0.8) * (0.8 + 0.4 * r(12 + k)), up = o.speed * energy * (wet ? 0.85 : 0.4) * (0.8 + 0.4 * r(20 + k))
        // Droplets start a particle spacing apart: closer, they would share grid nodes and move as one blob.
        pos.push(x + ca * h, y + h * 0.5, z + sa * h)
        vel.push(ca * out, up, sa * out)
      }
      if (wet) {
        pos.push(x, y + h * 0.5, z) // the Worthington jet
        vel.push(0, o.speed * energy * 1.3, 0)
      }
    }
    this.target.emit({ positions: pos, velocities: vel, material: o.material, tag: SPLASH_TAG })
    this.spawned += count
    return count
  }

  /**
   * The retire pass (GPU solvers only): removes splash particles that have landed (moving down within half a
   * cell of the ground), stray water soaking in (`soak`) and, with `retireOutside`, any particle outside the domain. Batch it after the solver's
   * passes: `renderer.compute([...mpm.prepare(dt), ...rain.prepare()])`.
   */
  prepare(): ComputeNode[] {
    const solver = this.target as MPMSolver
    if (!solver.buffers?.heights) return []
    this.retireOutside.value = this.options.retireOutside ? 1 : 0
    this.soak.value = this.options.soak
    return [(this.retireNode ??= this.buildRetire(solver))]
  }

  /** Frees the GPU pass. */
  dispose(): void {
    this.retireNode?.dispose()
    this.retireNode = null
  }

  private buildRetire(solver: MPMSolver): ComputeNode {
    const b = solver.buffers, u = solver.uniforms
    const [nx, ny, nz] = solver.resolution
    return Fn(() => {
      const i = instanceIndex
      const V = b.velocity.element(i).toVar()
      If(V.w.greaterThan(0), () => {
        const P = b.position.element(i).toVar()
        const base: any = floor(P.xyz.mul(u.invDx).sub(0.5)).toVar()
        const outside = base.x.lessThan(0).or(base.y.lessThan(0)).or(base.z.lessThan(0))
          .or(base.x.greaterThan(nx - 3)).or(base.y.greaterThan(ny - 3)).or(base.z.greaterThan(nz - 3))
        // Bilinear ground under the particle, as the solver collides with it.
        const gp: any = clamp(P.xz.mul(u.invDx), vec2(0), vec2(nx - 1, nz - 1)).toVar()
        const i0: any = (min as any)(ivec2(floor(gp) as any), ivec2(nx - 2, nz - 2)).toVar()
        const f: any = gp.sub(vec2(i0)).toVar()
        const at = (di: number, dk: number) => b.heights.element(i0.y.add(dk).mul(nx).add(i0.x.add(di)))
        const ground = at(0, 0).mul(f.x.oneMinus()).add(at(1, 0).mul(f.x)).mul(f.y.oneMinus()).add(at(0, 1).mul(f.x.oneMinus()).add(at(1, 1).mul(f.x)).mul(f.y))
        const onGround = P.y.lessThan(ground.add(u.dx.mul(0.5)))
        const landed = b.state.element(i).z.equal(SPLASH_TAG).and(V.y.lessThanEqual(0)).and(onGround)
        // Stray water at rest on the ground, alone at its grid node: soaks in.
        const node: any = (ivec3 as any)(clamp(floor(P.xyz.mul(u.invDx).add(0.5)), vec3(0), vec3(nx - 1, ny - 1, nz - 1))).toVar()
        const mass = b.grid.element(node.z.mul(nx * ny).add(node.y.mul(nx)).add(node.x)).w
        const stray = onGround.and(mass.lessThan(this.soak)).and(V.xyz.length().lessThan(0.3))
        If(landed.or(stray).or(outside.and(this.retireOutside.greaterThan(0))), () => {
          b.velocity.element(i).assign(vec4(0))
        })
      })
    })().compute(solver.capacity, [64])
  }
}

/** `structuredClone(DEFAULT_SPLASHES)` merged with `input`, sanitized. */
export function resolveSplashOptions(input: unknown): SplashOptions {
  const o = merge(structuredClone(DEFAULT_SPLASHES), input)
  const d = DEFAULT_SPLASHES
  const num = (v: unknown, def: number, lo = -Infinity, hi = Infinity) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def)
  if (typeof o.seed !== 'number' && typeof o.seed !== 'string') o.seed = d.seed
  o.rain = num(o.rain, d.rain, 0)
  o.splashes = num(o.splashes, d.splashes, 0)
  o.radius = num(o.radius, d.radius, 0)
  o.center = [0, 1].map((a) => num(o.center?.[a], d.center[a])) as [number, number]
  o.particles = [0, 1].map((a) => Math.round(num(o.particles?.[a], d.particles[a], 1, 32))) as [number, number]
  o.speed = num(o.speed, d.speed, 0)
  o.puddleDepth = num(o.puddleDepth, d.puddleDepth, 0)
  o.maxPerFrame = Math.round(num(o.maxPerFrame, d.maxPerFrame, 0))
  if (typeof o.material !== 'string') o.material = d.material
  o.retireOutside = typeof o.retireOutside === 'boolean' ? o.retireOutside : d.retireOutside
  o.soak = num(o.soak, d.soak, 0)
  return o
}
