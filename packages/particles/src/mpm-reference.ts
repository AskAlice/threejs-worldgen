// Pure CPU side of the MLS-MPM solver: options, the stable time step, the fixed-point scheme, emission
// lattices, terrain baking and a reference solver that runs the same substep as the GPU on tiny particle
// sets. No three.js runtime here except through the material registry, so all of it runs in Node tests.
import { particleRandom } from './emitter.ts'
import { det3, identity3, mpmMaterial, mul3, type Mat3 } from './mpm-materials.ts'
import { merge, seedOf, type DeepPartial } from './options.ts'

/** A `(x, z) => y` terrain height, world metres (e.g. threejs-heightfield's `HeightFn` or `world.height`). */
export type MPMHeightFn = (x: number, z: number) => number

/** Every setting of an {@link MPMSolver}. Plain JSON. */
export interface MPMOptions {
  /** Seed for the emission jitter. */
  seed: number | string
  /** Most particles. Fixed at construction. */
  capacity: number
  /** Grid nodes along x, y, z (8…160 each). Fixed at construction. */
  resolution: [number, number, number]
  /** Grid spacing Δx, metres. Particles are emitted 2 per cell per axis (8 per cell). Fixed at construction. */
  cellSize: number
  /**
   * World position of the domain's minimum corner, metres. Moving it shifts the domain by whole cells (the
   * particles keep their world positions; those left outside freeze). Floating-origin safe: the GPU only
   * sees positions relative to it.
   */
  origin: [number, number, number]
  /** Substeps per frame at least. More are added when the frame is longer than the stable step allows. */
  substeps: number
  /** Most substeps per frame; past it the simulation runs slower than real time instead of going unstable. */
  maxSubsteps: number
  /** Courant number C of the stable step `dt ≤ C·Δx / (maxSpeed + sound speed)` (see {@link mpmStableStep}). */
  cfl: number
  /** Particle speed limit, m/s: the "max particle speed" of the stable step, enforced in G2P. */
  maxSpeed: number
  /** Gravity, m/s². */
  gravity: [number, number, number]
  /** Domain sides act as slip walls (else particles that leave the domain freeze). */
  walls: boolean
  /** Terrain friction coefficient (Coulomb): 0 slips, large values stick. */
  friction: number
  /** Materials compiled in (keys, fixed at construction) and their parameters (live). */
  materials: Record<string, Record<string, number>>
  /** Drawing through the particle pool's unlit shading. */
  render: {
    /** Sprite width, in particle spacings (Δx / 2). */
    size: number
    /** Colour ramp by volume change J: first key squashed, middle at rest, last stretched (1 to 8 `#rrggbb`). */
    colors: string[]
    /** How much volume change spans the colour ramp: key = 0.5 + (J − 1) × strainScale. */
    strainScale: number
    /** Opacity. */
    opacity: number
  }
}

/** Partial settings for {@link MPMSolver}. */
export type MPMInput = DeepPartial<MPMOptions>

/** Default solver: a 64³ grid of 0.25 m cells (16 m across) with the jelly material. */
export const DEFAULT_MPM: MPMOptions = {
  seed: 1,
  capacity: 65536,
  resolution: [64, 64, 64],
  cellSize: 0.25,
  origin: [-8, 0, -8],
  substeps: 2,
  maxSubsteps: 8,
  cfl: 0.8,
  maxSpeed: 10,
  gravity: [0, -9.81, 0],
  walls: true,
  friction: 0.5,
  materials: { jelly: { density: 1000, youngs: 100000, poisson: 0.3, viscosity: 1000 } },
  render: { size: 1.8, colors: ['#5a0f1e', '#b3243a', '#f06a78'], strainScale: 4, opacity: 1 },
}

/**
 * Fixed-point scale of the P2G atomics. WebGPU has no float atomics, so P2G adds `round(value × 2^20)` as
 * i32 (order-independent, hence deterministic). Values are in normalised units: mass in "full cells of
 * 1000 kg/m³" (a particle of density ρ weighs ρ/8000), momentum in that mass × m/s. Resolution: 2⁻²⁰ ≈ 1e-6
 * of a cell's mass. Any node with mass gets velocity p/m: a node with little mass has a noisy velocity, but
 * G2P weighs it by at most its mass share, so each particle's velocity error stays below ~0.5·27/(2²⁰·m_p)
 * ≈ 1e-4 m/s (no mass threshold, which would leak momentum). Overflow bound: a node channel must stay below 2³¹/2²⁰ = 2048 units, i.e. a node's
 * mass × speed < 2048 (with speeds capped at `maxSpeed` = 10 m/s, a cell may hold up to ~200× water).
 * Conversions saturate (WGSL `i32(f32)` clamps; the CPU reference clamps too) and sums wrap like i32.
 */
export const MPM_FIXED = 2 ** 20
/** Reference density of the normalised mass unit, kg/m³. */
export const MPM_DENSITY_UNIT = 1000
/**
 * Particles closer than this many cells above the ground also get Coulomb friction (before they move; the
 * normal velocity is kept, so they still settle onto the ground).
 * The grid boundary alone acts on nodes inside the ground, which a resting particle's stencil only partly
 * reaches, so bodies would creep down any slope whatever the friction.
 */
export const MPM_CONTACT_SKIN = 1
/** Particles per cell along each axis. */
export const MPM_PPC_AXIS = 2

/** A value in normalised units to its i32 fixed-point count (round half up, saturating). */
export function toFixed(v: number): number {
  return Math.max(-2147483648, Math.min(2147483647, Math.floor(v * MPM_FIXED + 0.5)))
}

/** Fixes anything out of range in place (counts become integers, enums and booleans fall back) and returns it. */
export function sanitizeMPMOptions(o: MPMOptions): MPMOptions {
  const d = DEFAULT_MPM
  const num = (v: unknown, def: number, lo = -Infinity, hi = Infinity) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def)
  const vec = (v: unknown, def: number[], lo = -Infinity, hi = Infinity) => def.map((x, i) => num(Array.isArray(v) ? v[i] : undefined, x, lo, hi))
  if (typeof o.seed !== 'number' && typeof o.seed !== 'string') o.seed = d.seed
  o.capacity = Math.round(num(o.capacity, d.capacity, 1, 1 << 22))
  o.resolution = vec(o.resolution, d.resolution, 8, 160).map(Math.round) as [number, number, number]
  o.cellSize = num(o.cellSize, d.cellSize, 1e-3)
  o.origin = vec(o.origin, d.origin) as [number, number, number]
  o.substeps = Math.round(num(o.substeps, d.substeps, 1, 64))
  o.maxSubsteps = Math.round(num(o.maxSubsteps, d.maxSubsteps, o.substeps, 64))
  o.cfl = num(o.cfl, d.cfl, 0.01, 1)
  o.maxSpeed = num(o.maxSpeed, d.maxSpeed, 0.01)
  o.gravity = vec(o.gravity, d.gravity) as [number, number, number]
  o.walls = typeof o.walls === 'boolean' ? o.walls : d.walls
  o.friction = num(o.friction, d.friction, 0)
  const mats: Record<string, Record<string, number>> = {}
  for (const [name, params] of Object.entries(o.materials && typeof o.materials === 'object' ? o.materials : {})) {
    const m = mpmMaterial(name)
    if (!m) continue
    mats[name] = Object.fromEntries(Object.entries(m.defaults).map(([k, def]) => [k, num((params as Record<string, unknown>)?.[k], def, k === 'density' ? 1e-3 : -Infinity)]))
  }
  o.materials = Object.keys(mats).length ? mats : structuredClone(d.materials)
  const r = (o.render ??= structuredClone(d.render))
  r.size = num(r.size, d.render.size, 0)
  const colors = Array.isArray(r.colors) ? r.colors.filter((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)).slice(0, 8) : []
  r.colors = colors.length ? colors : [...d.render.colors]
  r.strainScale = num(r.strainScale, d.render.strainScale, 0)
  r.opacity = num(r.opacity, d.render.opacity, 0, 1)
  return o
}

/** `structuredClone(DEFAULT_MPM)` merged with `input`, sanitized. A `materials` input replaces the default list. */
export function resolveMPMOptions(input: unknown, defaults: MPMOptions = DEFAULT_MPM): MPMOptions {
  const base = structuredClone(defaults)
  const mats = (input as MPMInput | undefined)?.materials
  if (mats && defaults === DEFAULT_MPM) base.materials = {}
  return sanitizeMPMOptions(merge(base, input))
}

/**
 * Longest stable substep for the solver's materials: `cfl·Δx / (maxSpeed + c)` with c the fastest sound speed,
 * and `Δx² / (6ν)` for the most viscous one.
 */
export function mpmStableStep(o: MPMOptions): number {
  let c = 0, nu = 0
  for (const [name, p] of Object.entries(o.materials)) {
    const m = mpmMaterial(name)
    c = Math.max(c, m?.soundSpeed(p) ?? 0)
    nu = Math.max(nu, m?.viscosity?.(p) ?? 0)
  }
  return Math.min((o.cfl * o.cellSize) / (o.maxSpeed + c), nu > 0 ? (o.cellSize * o.cellSize) / (6 * nu) : Infinity)
}

/**
 * Substeps and substep length for a frame of `frameDt` seconds (capped at 0.1 s): at least `substeps`, as many
 * more as {@link mpmStableStep} needs, at most `maxSubsteps` (then `dt` is the stable step and the frame runs slow).
 */
export function mpmTimeStep(o: MPMOptions, frameDt: number): { substeps: number; dt: number } {
  const frame = Math.min(0.1, Math.max(0, frameDt))
  const dtMax = mpmStableStep(o)
  const substeps = Math.min(o.maxSubsteps, Math.max(o.substeps, Math.ceil(frame / dtMax)))
  return { substeps, dt: Math.min(frame / substeps, dtMax) }
}

/** One block of particles for {@link MPMSolver.emit}. */
export interface MPMEmit {
  /** `box` (half extents `size`), `sphere` (radius `size[0]`), or explicit `positions`. Default `box`. */
  shape?: 'box' | 'sphere'
  /** Centre, world metres. */
  center?: [number, number, number]
  /** Box half extents, or sphere radius in `[0]`, metres. */
  size?: [number, number, number]
  /** Explicit world positions (x, y, z each), spaced about Δx/2 apart (each particle gets a (Δx/2)³ volume). */
  positions?: ArrayLike<number>
  /** Initial velocity, m/s. */
  velocity?: [number, number, number]
  /** Material name (one of the solver's `materials`; default the first). */
  material?: string
  /** Initial temperature, kelvin. */
  temperature?: number
  /** Seeded jitter of the lattice, 0…1 of the spacing (default 0.5). */
  jitter?: number
}

/**
 * World positions of an {@link MPMEmit} block: a lattice of `Δx/2` spacing (8 particles per cell) clipped
 * to the shape, jittered from `seed` and the particle serials starting at `firstSerial`.
 */
export function mpmEmitPositions(spec: MPMEmit, cellSize: number, seed: number | string, firstSerial = 0, max = Infinity): Float32Array {
  if (spec.positions) return Float32Array.from(spec.positions).subarray(0, Math.min(spec.positions.length - (spec.positions.length % 3), max * 3))
  const h = cellSize / MPM_PPC_AXIS
  const c = spec.center ?? [0, 0, 0]
  const sphere = spec.shape === 'sphere'
  const half = sphere ? [spec.size?.[0] ?? 1, spec.size?.[0] ?? 1, spec.size?.[0] ?? 1] : (spec.size ?? [1, 1, 1])
  const n = half.map((v) => (Number.isFinite(v) ? Math.max(1, Math.round((2 * Math.abs(v)) / h)) : 0))
  const jitter = Math.min(1, Math.max(0, spec.jitter ?? 0.5))
  const s = seedOf(seed)
  const out: number[] = []
  let serial = firstSerial
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    if (out.length >= max * 3) break
    const lx = (i + 0.5) * h - n[0] * h / 2, ly = (j + 0.5) * h - n[1] * h / 2, lz = (k + 0.5) * h - n[2] * h / 2
    if (sphere && lx * lx + ly * ly + lz * lz > half[0] * half[0]) continue
    const r = (q: number) => (particleRandom(serial, q, s) - 0.5) * jitter * h
    out.push(c[0] + lx + r(0), c[1] + ly + r(1), c[2] + lz + r(2))
    serial++
  }
  return Float32Array.from(out)
}

/**
 * Terrain heights at the grid's node columns, relative to `origin[1]` (what the GPU and the reference collide
 * with). `-1e30` everywhere without a height function; non-finite heights count as no ground.
 */
export function bakeMPMHeights(height: MPMHeightFn | null, o: Pick<MPMOptions, 'resolution' | 'cellSize' | 'origin'>, out: Float32Array = new Float32Array(o.resolution[0] * o.resolution[2])): Float32Array {
  const [nx, , nz] = o.resolution
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const y = height ? height(o.origin[0] + i * o.cellSize, o.origin[2] + k * o.cellSize) : NaN
    out[k * nx + i] = Number.isFinite(y) ? y - o.origin[1] : -1e30
  }
  return out
}

/**
 * Ground height and slope under a local position, bilinear between the baked node heights (the same surface
 * the GPU keeps particles above). Returns [height, dh/dx, dh/dz].
 */
export function groundAt(heights: ArrayLike<number>, nx: number, nz: number, dx: number, x: number, z: number): [number, number, number] {
  const gx = Math.min(Math.max(x / dx, 0), nx - 1), gz = Math.min(Math.max(z / dx, 0), nz - 1)
  const i = Math.min(Math.floor(gx), nx - 2), k = Math.min(Math.floor(gz), nz - 2)
  const fx = gx - i, fz = gz - k
  const h00 = heights[k * nx + i], h10 = heights[k * nx + i + 1], h01 = heights[(k + 1) * nx + i], h11 = heights[(k + 1) * nx + i + 1]
  const h = (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz
  return [h, ((h10 - h00) * (1 - fz) + (h11 - h01) * fz) / dx, ((h01 - h00) * (1 - fx) + (h11 - h10) * fx) / dx]
}

/**
 * Coulomb friction projection of `v` against a surface with unit normal `n`, only when moving into it: the
 * inward part is removed (unless `keepNormal`) and the tangential part slowed by `friction × inward speed`.
 */
export function projectFriction(v: number[], n: number[], friction: number, keepNormal = false): number[] {
  const vn = v[0] * n[0] + v[1] * n[1] + v[2] * n[2]
  if (vn >= 0) return v
  const t = [v[0] - vn * n[0], v[1] - vn * n[1], v[2] - vn * n[2]]
  const lt = Math.hypot(t[0], t[1], t[2])
  const s = lt <= -friction * vn ? 0 : 1 + (friction * vn) / lt
  const k = keepNormal ? vn : 0
  return [t[0] * s + k * n[0], t[1] * s + k * n[1], t[2] * s + k * n[2]]
}

/** Particle state arrays (the reference's own, and what {@link MPMSolver.read} returns from the GPU). */
export interface MPMParticleData {
  /** Live particles (the first `count` slots until the ring wraps). */
  count: number
  /** x, y, z per particle, local to `origin`, metres. */
  position: Float32Array | Float64Array
  /** x, y, z per particle, m/s. */
  velocity: Float32Array | Float64Array
  /** C per particle, 9 floats column-major. */
  affine: Float32Array | Float64Array
  /** F per particle, 9 floats column-major. */
  deformation: Float32Array | Float64Array
  /** Plastic volume ratio per particle. */
  Jp: Float32Array | Float64Array
  /** Temperature per particle, kelvin. */
  temperature: Float32Array | Float64Array
  /** Material index (into the solver's `materials` keys) per particle. */
  material: Int32Array
}

/**
 * The MLS-MPM substep in plain TypeScript, for tiny particle sets: the same weights, fixed-point P2G,
 * grid update, terrain boundary and G2P as the GPU solver, in float64. Used by the tests to check the GPU
 * (within float tolerance) and the physics (momentum, resting on terrain).
 */
export class MPMReference {
  /** Resolved settings. */
  readonly options: MPMOptions
  /** Particles. */
  readonly data: MPMParticleData
  /** Material names by index. */
  readonly materials: string[]
  /** Baked node-column heights (local). */
  readonly heights: Float32Array
  /** Last grid: x, y, z velocity and mass per node. */
  readonly grid: Float64Array
  /** Simulated seconds. */
  time = 0
  private serial = 0
  private acc: Int32Array | null = null

  /** A reference solver with `capacity` particle slots; `height` is the terrain (none by default). */
  constructor(input: MPMInput = {}, height: MPMHeightFn | null = null) {
    this.options = resolveMPMOptions(input)
    const n = this.options.capacity
    const [nx, ny, nz] = this.options.resolution
    this.materials = Object.keys(this.options.materials)
    this.data = {
      count: 0, position: new Float64Array(n * 3), velocity: new Float64Array(n * 3), affine: new Float64Array(n * 9),
      deformation: new Float64Array(n * 9), Jp: new Float64Array(n), temperature: new Float64Array(n), material: new Int32Array(n),
    }
    this.heights = bakeMPMHeights(height, this.options)
    this.grid = new Float64Array(nx * ny * nz * 4)
  }

  /** Adds a block of particles (see {@link MPMEmit}); returns how many (stops at capacity). */
  emit(spec: MPMEmit): number {
    const o = this.options
    const pos = mpmEmitPositions(spec, o.cellSize, o.seed, this.serial, o.capacity - this.data.count)
    const d = this.data
    const k = Math.min(pos.length / 3, o.capacity - d.count)
    const id = Math.max(0, this.materials.indexOf(spec.material ?? this.materials[0]))
    for (let p = 0; p < k; p++) {
      const s = d.count + p
      for (let a = 0; a < 3; a++) {
        d.position[s * 3 + a] = pos[p * 3 + a] - o.origin[a]
        d.velocity[s * 3 + a] = spec.velocity?.[a] ?? 0
      }
      d.affine.fill(0, s * 9, s * 9 + 9)
      d.deformation.set(identity3(), s * 9)
      d.Jp[s] = 1
      d.temperature[s] = spec.temperature ?? 293
      d.material[s] = id
    }
    d.count += k
    this.serial += pos.length / 3
    return k
  }

  /** Advances a frame of `frameDt` seconds in substeps (see {@link mpmTimeStep}); returns the substeps. */
  step(frameDt: number): number {
    const { substeps, dt } = mpmTimeStep(this.options, frameDt)
    for (let s = 0; s < substeps; s++) this.substep(dt)
    return substeps
  }

  /** One P2G → grid → G2P substep of `dt` seconds. */
  substep(dt: number): void {
    const o = this.options, d = this.data
    const [nx, ny, nz] = o.resolution
    const dx = o.cellSize, inv = 1 / dx
    const acc = (this.acc ??= new Int32Array(nx * ny * nz * 4)).fill(0)
    const params = this.materials.map((m) => o.materials[m])
    const base = [0, 0, 0], fx = [0, 0, 0], w = new Float64Array(9) // w[i * 3 + axis]
    // Quadratic B-spline weights of particle p; false when its 3×3×3 stencil leaves the grid (frozen).
    const kernel = (p: number) => {
      for (let a = 0; a < 3; a++) {
        const xg = d.position[p * 3 + a] * inv
        base[a] = Math.floor(xg - 0.5)
        const f = (fx[a] = xg - base[a])
        w[a] = 0.5 * (1.5 - f) ** 2
        w[3 + a] = 0.75 - (f - 1) ** 2
        w[6 + a] = 0.5 * (f - 0.5) ** 2
      }
      return base[0] >= 0 && base[1] >= 0 && base[2] >= 0 && base[0] <= nx - 3 && base[1] <= ny - 3 && base[2] <= nz - 3
    }

    // P2G: mass and momentum (with the stress and APIC terms) into the grid, fixed point.
    const scale = -dt / ((MPM_DENSITY_UNIT * MPM_PPC_AXIS ** 3 / 4) * dx * dx) // −dt·Vp·(4/Δx²) / (1000·Δx³), Vp = Δx³/8
    for (let p = 0; p < d.count; p++) {
      if (!kernel(p)) continue
      const id = d.material[p]
      const F = Array.from(d.deformation.subarray(p * 9, p * 9 + 9))
      const C = Array.from(d.affine.subarray(p * 9, p * 9 + 9))
      const tau = mpmMaterial(this.materials[id])!.cpu.stress({ F, J: det3(F), Jp: d.Jp[p], C, temperature: d.temperature[p], dt, params: params[id] })
      const mass = params[id].density / (MPM_DENSITY_UNIT * MPM_PPC_AXIS ** 3)
      const A = tau.map((t, k) => t * scale + C[k] * mass)
      const vx = d.velocity[p * 3] * mass, vy = d.velocity[p * 3 + 1] * mass, vz = d.velocity[p * 3 + 2] * mass
      for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
        const weight = w[i * 3] * w[j * 3 + 1] * w[k * 3 + 2]
        const px = (i - fx[0]) * dx, py = (j - fx[1]) * dx, pz = (k - fx[2]) * dx
        const n = (((base[2] + k) * ny + base[1] + j) * nx + base[0] + i) * 4
        acc[n] = (acc[n] + toFixed((vx + A[0] * px + A[3] * py + A[6] * pz) * weight)) | 0
        acc[n + 1] = (acc[n + 1] + toFixed((vy + A[1] * px + A[4] * py + A[7] * pz) * weight)) | 0
        acc[n + 2] = (acc[n + 2] + toFixed((vz + A[2] * px + A[5] * py + A[8] * pz) * weight)) | 0
        acc[n + 3] = (acc[n + 3] + toFixed(weight * mass)) | 0
      }
    }

    // Grid update: momentum / mass, gravity, walls and terrain.
    const g = this.grid
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const n = ((z * ny + y) * nx + x) * 4
      const m = acc[n + 3]
      let v = [0, 0, 0]
      if (m > 0) v = this.boundary([acc[n] / m + dt * o.gravity[0], acc[n + 1] / m + dt * o.gravity[1], acc[n + 2] / m + dt * o.gravity[2]], x, y, z)
      g[n] = v[0]; g[n + 1] = v[1]; g[n + 2] = v[2]; g[n + 3] = m / MPM_FIXED
    }

    // G2P: velocity and C = (4/Δx²)·Σ w·v·dposᵀ, F ← (I + dt·C)·F, plasticity, advection.
    const v = [0, 0, 0], C = new Array<number>(9)
    for (let p = 0; p < d.count; p++) {
      if (!kernel(p)) continue
      v[0] = v[1] = v[2] = 0
      C.fill(0)
      for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
        const weight = w[i * 3] * w[j * 3 + 1] * w[k * 3 + 2]
        const px = (i - fx[0]) * dx, py = (j - fx[1]) * dx, pz = (k - fx[2]) * dx
        const n = (((base[2] + k) * ny + base[1] + j) * nx + base[0] + i) * 4
        for (let r = 0; r < 3; r++) {
          const gv = g[n + r] * weight
          v[r] += gv
          C[r] += gv * px
          C[3 + r] += gv * py
          C[6 + r] += gv * pz
        }
      }
      for (let k = 0; k < 9; k++) C[k] *= 4 * inv * inv
      const id = d.material[p]
      const mat = mpmMaterial(this.materials[id])!
      let F = mul3(identity3().map((e, k) => e + dt * C[k]), Array.from(d.deformation.subarray(p * 9, p * 9 + 9)))
      if (mat.cpu.plasticity) {
        const r = mat.cpu.plasticity({ F, J: det3(F), Jp: d.Jp[p], C, temperature: d.temperature[p], dt, params: params[id] })
        if (r.F) F = r.F
        if (r.Jp !== undefined) d.Jp[p] = r.Jp
        if (r.temperature !== undefined) d.temperature[p] = r.temperature
      }
      const speed = Math.hypot(v[0], v[1], v[2])
      if (speed > o.maxSpeed) for (let a = 0; a < 3; a++) v[a] *= o.maxSpeed / speed
      // Particle contact on top of the grid boundary: friction within the skin, and never below the (bilinear) ground.
      const x = [d.position[p * 3], d.position[p * 3 + 1], d.position[p * 3 + 2]]
      let [h, hx, hz] = groundAt(this.heights, nx, nz, dx, x[0], x[2])
      if (x[1] < h + MPM_CONTACT_SKIN * dx) {
        const len = Math.hypot(hx, 1, hz)
        const vf = projectFriction(v, [-hx / len, 1 / len, -hz / len], o.friction, true)
        v[0] = vf[0]; v[1] = vf[1]; v[2] = vf[2]
      }
      for (let a = 0; a < 3; a++) x[a] += dt * v[a]
      ;[h, hx, hz] = groundAt(this.heights, nx, nz, dx, x[0], x[2])
      if (x[1] < h) {
        // Out along the ground normal (exact for a plane), not straight up, which would also slide it along a slope.
        const l2 = hx * hx + 1 + hz * hz, depth = (h - x[1]) / l2, n = [-hx, 1, -hz]
        for (let a = 0; a < 3; a++) x[a] += n[a] * depth
        const len = Math.sqrt(l2)
        const vf = projectFriction(v, [-hx / len, 1 / len, -hz / len], o.friction)
        v[0] = vf[0]; v[1] = vf[1]; v[2] = vf[2]
      }
      d.position.set(x, p * 3)
      d.velocity.set(v, p * 3)
      d.affine.set(C, p * 9)
      d.deformation.set(F, p * 9)
    }
    this.time += dt
  }

  /** Total particle momentum, kg·m/s. */
  momentum(): [number, number, number] {
    const d = this.data, out: [number, number, number] = [0, 0, 0]
    for (let p = 0; p < d.count; p++) {
      const m = this.particleMass(p)
      for (let a = 0; a < 3; a++) out[a] += m * d.velocity[p * 3 + a]
    }
    return out
  }

  /** Total particle mass, kg. */
  mass(): number {
    let m = 0
    for (let p = 0; p < this.data.count; p++) m += this.particleMass(p)
    return m
  }

  private particleMass(p: number): number {
    const dx = this.options.cellSize
    return this.options.materials[this.materials[this.data.material[p]]].density * (dx / MPM_PPC_AXIS) ** 3
  }

  // Domain walls (slip) and the terrain (Coulomb friction against the ground normal) for node (x, y, z), as on the GPU.
  private boundary(v: number[], x: number, y: number, z: number): number[] {
    const o = this.options
    const [nx, ny, nz] = o.resolution
    if (o.walls) {
      const idx = [x, y, z], n = [nx, ny, nz]
      for (let a = 0; a < 3; a++) {
        if (idx[a] < 2 && v[a] < 0) v[a] = 0
        if (idx[a] > n[a] - 3 && v[a] > 0) v[a] = 0
      }
    }
    const H = this.heights, dx = o.cellSize
    const h = H[z * nx + x]
    if (y * dx <= h) {
      const x0 = Math.max(x - 1, 0), x1 = Math.min(x + 1, nx - 1), z0 = Math.max(z - 1, 0), z1 = Math.min(z + 1, nz - 1)
      const hx = (H[z * nx + x1] - H[z * nx + x0]) / ((x1 - x0) * dx), hz = (H[z1 * nx + x] - H[z0 * nx + x]) / ((z1 - z0) * dx)
      const len = Math.hypot(hx, 1, hz)
      v = projectFriction(v, [-hx / len, 1 / len, -hz / len], o.friction)
    }
    return v
  }
}
