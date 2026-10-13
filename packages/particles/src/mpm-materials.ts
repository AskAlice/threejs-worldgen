import { float, log, mat3, max, transpose, vec3 } from 'three/tsl'

/**
 * A 3×3 matrix on the CPU: 9 numbers, column-major (`m[col * 3 + row]`), the same layout as a TSL `mat3`
 * built from three column vectors.
 */
export type Mat3 = number[]

/**
 * What a material's GPU hooks see of one particle (TSL nodes). Matrices are `mat3` nodes. Note TSL's
 * matrix–scalar operators: `M.mul(s)` and `M.add(N)` are fine, but `M.sub(s)` and `M.div(s)` are not (write
 * `M.mul(s.reciprocal())`, build `mpmIdentity()` for `I`).
 */
export interface MPMMaterialContext {
  /** Elastic deformation gradient F (mat3). */
  F: any
  /** det F (float). */
  J: any
  /** Plastic volume ratio Jp (float; 1 for materials without plasticity). */
  Jp: any
  /** APIC affine matrix C ≈ ∇v, the velocity gradient (mat3; for viscosity). */
  C: any
  /** Per-particle temperature, kelvin (float; the particle pool's `props.x`). */
  temperature: any
  /** Substep, seconds (float). */
  dt: any
  /** The material's parameters as float uniforms, by name (live through `MPMSolver.set`). */
  params: Record<string, any>
}

/** The CPU twin of {@link MPMMaterialContext}, for the reference solver and tests. */
export interface MPMMaterialCPUContext {
  F: Mat3
  J: number
  Jp: number
  C: Mat3
  temperature: number
  dt: number
  params: Record<string, number>
}

/**
 * A constitutive model for {@link MPMSolver}: Kirchhoff stress (and optionally a plasticity return mapping)
 * as TSL functions, the same in plain TypeScript for the CPU reference, and JSON parameters. Register it
 * with {@link registerMPMMaterial}; a solver compiles in the materials named in its `materials` option.
 *
 * The solver owns the transfers: per substep it runs P2G (mass, momentum and `-dt·V·(4/Δx²)·τ` into the
 * grid), the grid update and G2P (velocity, C, `F ← (I + dt·C)·F`, then {@link MPMMaterial.plasticity}).
 */
export interface MPMMaterial<P extends Record<string, number> = Record<string, number>> {
  /** Registry key. */
  name: string
  /** Default parameters (plain JSON numbers). `density` (kg/m³) is required: it sets the particle mass. */
  defaults: P & { density: number }
  /** Kirchhoff stress τ = P(F)·Fᵀ, pascals (a TSL `mat3` node). Runs in P2G. */
  stress: (c: MPMMaterialContext) => any
  /**
   * Optional per-particle hook after F is advanced in G2P: plasticity (project F, update Jp), and anything
   * else a material tracks per particle, such as temperature (e.g. lava cooling). Returns TSL nodes; anything
   * left out stays as it was.
   */
  plasticity?: (c: MPMMaterialContext) => { F?: any; Jp?: any; temperature?: any }
  /** CPU versions of the hooks above (same maths, plain numbers). */
  cpu: {
    stress: (c: MPMMaterialCPUContext) => Mat3
    plasticity?: (c: MPMMaterialCPUContext) => { F?: Mat3; Jp?: number; temperature?: number }
  }
  /** Fastest elastic wave speed for these parameters, m/s (the time step keeps `dt ≤ cfl·Δx / (maxSpeed + c)`). */
  soundSpeed: (p: P) => number
  /** Optional kinematic viscosity ν, m²/s (the time step also keeps `dt ≤ Δx² / (6ν)`). */
  viscosity?: (p: P) => number
}

const registry = new Map<string, MPMMaterial<any>>()

/** Adds (or replaces) a material by its `name`. Materials must be registered before a solver that uses them is built. */
export function registerMPMMaterial<P extends Record<string, number>>(material: MPMMaterial<P>): MPMMaterial<P> {
  registry.set(material.name, material)
  return material
}

/** A registered material, or `undefined`. */
export function mpmMaterial(name: string): MPMMaterial | undefined {
  return registry.get(name)
}

/** Names of every registered material. */
export function mpmMaterialNames(): string[] {
  return [...registry.keys()]
}

/** The TSL `mat3` identity. */
export function mpmIdentity(): any {
  return mat3(vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1))
}

/** Lamé parameters (μ, λ) from Young's modulus and Poisson's ratio (plain numbers or TSL nodes). */
export function lame(youngs: any, poisson: any): { mu: any; lambda: any } {
  if (typeof youngs === 'number' && typeof poisson === 'number') {
    return { mu: youngs / (2 * (1 + poisson)), lambda: (youngs * poisson) / ((1 + poisson) * (1 - 2 * poisson)) }
  }
  const E = float(youngs), nu = float(poisson)
  return { mu: E.div(nu.add(1).mul(2)), lambda: E.mul(nu).div(nu.add(1).mul(float(1).sub(nu.mul(2)))) }
}

// ---- CPU 3×3 helpers (column-major) ----

/** 3×3 identity. */
export const identity3 = (): Mat3 => [1, 0, 0, 0, 1, 0, 0, 0, 1]
/** A·B. */
export function mul3(a: Mat3, b: Mat3): Mat3 {
  const o = new Array<number>(9)
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2]
  return o
}
/** Aᵀ. */
export const transpose3 = (a: Mat3): Mat3 => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]]
/** det A. */
export const det3 = (a: Mat3): number =>
  a[0] * (a[4] * a[8] - a[7] * a[5]) - a[3] * (a[1] * a[8] - a[7] * a[2]) + a[6] * (a[1] * a[5] - a[4] * a[2])

/** Smallest J the jelly's log term sees: a crushed particle pushes back hard instead of producing NaN. */
const MIN_J = 0.05

/**
 * The core's test material: a compressible neo-Hookean "jelly", τ = μ(F·Fᵀ − I) + λ·ln(J)·I, plus a
 * Kelvin–Voigt viscosity τ += η·J·(C + Cᵀ) so it wobbles and settles like gelatine instead of bouncing like
 * a rubber ball. No plasticity. Sag under its own weight is about g·L/c² for a block of height L, so the
 * default (c ≈ 11.6 m/s) holds its shape at a few metres.
 */
export const JELLY = registerMPMMaterial({
  name: 'jelly',
  defaults: { density: 1000, youngs: 100000, poisson: 0.3, viscosity: 1000 },
  stress: ({ F, J, C, params: p }) => {
    const { mu, lambda } = lame(p.youngs, p.poisson)
    const lnJ = log(max(J, MIN_J))
    return F.mul(transpose(F)).mul(mu).add(mpmIdentity().mul(lambda.mul(lnJ).sub(mu))).add(C.add(transpose(C)).mul(p.viscosity.mul(J)))
  },
  cpu: {
    stress: ({ F, J, C, params: p }) => {
      const { mu, lambda } = lame(p.youngs, p.poisson)
      const FFt = mul3(F, transpose3(F))
      const iso = lambda * Math.log(Math.max(J, MIN_J)) - mu
      const eta = p.viscosity * J
      return FFt.map((v, k) => mu * v + (k % 4 === 0 ? iso : 0) + eta * (C[k] + C[(k % 3) * 3 + Math.floor(k / 3)]))
    },
  },
  soundSpeed: (p) => {
    const { mu, lambda } = lame(p.youngs, p.poisson)
    return Math.sqrt((lambda + 2 * mu) / p.density)
  },
  viscosity: (p) => p.viscosity / p.density,
})
