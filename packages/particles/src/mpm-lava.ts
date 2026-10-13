import {
  BufferAttribute, ClampToEdgeWrapping, Color, FloatType, HalfFloatType, InstancedBufferGeometry, LinearFilter, Mesh, MeshBasicNodeMaterial, NearestFilter, PlaneGeometry,
  QuadMesh, RGBAFormat, RedFormat, RenderTarget, Scene, Sphere, Storage3DTexture, StorageBufferAttribute, Vector2, Vector3,
  type Camera, type ComputeNode, type PerspectiveCamera, type Renderer, type Texture,
} from 'three/webgpu'
import {
  Discard, Fn, If, Loop, abs, atomicAdd, atomicLoad, atomicStore, cameraFar, cameraNear, cameraPosition, cameraViewMatrix, cameraWorldMatrix, clamp, cross,
  determinant, dot, exp, float, floor, fwidth, instanceIndex, instancedArray, int, ivec3, length, log, mat3, max, min, mix, normalize,
  perspectiveDepthToViewZ, pmremTexture, positionGeometry, positionView, pow, reflect, screenUV, select, smoothstep, sqrt, storage, texture, texture3D,
  textureStore, transpose, uniform, varying, vec2, vec3, vec4, viewZToPerspectiveDepth, viewportDepthTexture, hash,
} from 'three/tsl'
import { blackbodyNode } from './blackbody.ts'
import { det3, lame, mpmIdentity, mul3, registerMPMMaterial, transpose3, type Mat3 } from './mpm-materials.ts'
import { MPM_DENSITY_UNIT, MPM_FIXED, MPM_PPC_AXIS, groundAt, toFixed, type MPMEmit, type MPMParticleData, type MPMReference } from './mpm-reference.ts'
import { merge, type DeepPartial } from './options.ts'
import { ParticleLighting } from './system.ts'
import type { MPMSolver } from './mpm.ts'

// Lava for the MPM core (#74): a temperature-dependent material (Arrhenius viscosity, an elastoplastic crust below the
// solidus that cracks in tension) plus a once-per-frame thermal pass (radiative and convective loss to air, conduction
// to the ground and between particles through a grid) and its own drawing (lit splats with blackbody glow).

/** Parameters of the `lava` material (all live through `MPMSolver.set({ materials: { lava: {...} } })`). */
export interface LavaParams {
  [key: string]: number
  /** Bulk density, kg/m³ (vesicular pāhoehoe ~2200, dense ʻaʻā ~2600). Sets the particle mass. */
  density: number
  /** Young's modulus, Pa: the volume response of the melt and the stiffness of the crust (softened for real time). */
  youngs: number
  /** Poisson's ratio. */
  poisson: number
  /** Dynamic viscosity at the `eruption` temperature, Pa·s. */
  viscosity: number
  /** Viscosity cap, Pa·s: the stiffest melt the explicit solver resolves (it sets the time step, Δx²·ρ/(6·cap)). */
  viscosityMax: number
  /** Arrhenius slope E/R, kelvin: viscosity × e^(activation·(1/T − 1/eruption)). */
  activation: number
  /** Eruption (vent) temperature, kelvin. */
  eruption: number
  /** Solidus, kelvin: fully crust at and below it. */
  solidus: number
  /** Crust forms over this band above the solidus, kelvin. */
  crustRange: number
  /** Crust shear strength (von Mises), Pa. */
  yieldStress: number
  /**
   * Melt yield strength, Pa (Bingham). Lab melts show 10²–10³ Pa, flow margins (levees) 10³–10⁴ Pa: it stands in for
   * the skin a real flow grows within seconds at its margins, which a particle Δx/2 thick cannot. It keeps lobes whole and
   * thick instead of spreading into sheets thinner than the solver resolves (they would tear into particle rows).
   */
  meltYield: number
  /** Crust tensile strain at which it cracks open (melt is cohesive up to 20 %). */
  crackStrain: number
  /** Thermal emissivity of the surface. */
  emissivity: number
  /** Convective heat transfer to the air, W/(m²·K). */
  convection: number
  /** Conductance of the contact with the ground, W/(m²·K). */
  groundConductance: number
  /** Air temperature, kelvin. */
  airTemperature: number
  /** Ground temperature, kelvin. */
  groundTemperature: number
  /** Specific heat, J/(kg·K). */
  heatCapacity: number
  /**
   * Thermal skin, metres: how thick a layer of an exposed particle the surface loss cools. A particle is Δx/2 across, far
   * thicker than the centimetres a real crust grows in the first minutes, so the surface particles cool as this skin.
   */
  skin: number
  /** Effective thermal diffusivity between particles, m²/s (rock ~5e-7; larger stands in for sub-grid mixing). */
  diffusivity: number
}

/** Default `lava` parameters: a Hawaiian tholeiitic basalt, between the two presets. */
export const LAVA_DEFAULTS: LavaParams = {
  density: 2400, youngs: 1e6, poisson: 0.3,
  viscosity: 600, viscosityMax: 5000, activation: 40000, eruption: 1420, solidus: 1270, crustRange: 40,
  yieldStress: 10000, meltYield: 2000, crackStrain: 0.01,
  emissivity: 0.95, convection: 50, groundConductance: 300, airTemperature: 300, groundTemperature: 330, heatCapacity: 1200,
  skin: 0.004, diffusivity: 1e-4,
}

/** Drawing options of {@link MPMLava}. Plain JSON. */
export interface LavaOptions {
  /** Name of the solver material that is lava (compiled into the solver). */
  material: string
  /** The screen-space surface: particle spheres → depth → bilateral smoothing → normals, shaded with the lava field. */
  render: {
    /** Sphere radius of a particle, in particle spacings (Δx / 2). About 1.3 makes neighbours overlap into one surface. */
    radius: number
    /** Depth smoothing radius, in sphere radii: large for smooth pāhoehoe skin, small to keep ʻaʻā clinker lumpy. */
    smoothing: number
    /** Smoothing passes (each a horizontal and a vertical blur), 0…4. */
    iterations: number
    /** Resolution of the offscreen passes relative to the drawing buffer (0.25…1). */
    resolution: number
    /** Emission scale (1: against a noon sun of intensity 3, 1400 K lava has radiance {@link LAVA_GLOW_1400}). */
    intensity: number
    /** Basalt albedo, `#rrggbb` (sRGB; ~0.05 linear). */
    crust: string
    /** Crust roughness: glassy pāhoehoe skin ~0.5, clinkery ʻaʻā ~0.9. */
    roughness: number
    /** Ropy folds of the cooled skin (pāhoehoe), 0…1: ridges across the surface flow, where the skin has gone dark. */
    ropes: number
    /** Rope spacing, metres. */
    ropeLength: number
    /**
     * Glow of the crust's crack network, 0…1: cooling-joint cells of `crackSize` whose edges, `crackWidth` wide, glow at the
     * melt temperature under the crust (dark where the lava below has cooled too), and of crust cracks opening in the flow.
     */
    cracks: number
    /** Crack cell size, metres (pāhoehoe crust plates ~0.3 m, ʻaʻā clinker ~0.1 m). */
    crackSize: number
    /** Crack width, metres. */
    crackWidth: number
    /** Clinker: each crack cell is a clast tilted at random up to this much (0 a continuous skin, 1 rubble). */
    clasts: number
  }
}

/** Partial {@link LavaOptions}. */
export type LavaInput = DeepPartial<LavaOptions>

/** Default drawing. */
export const DEFAULT_LAVA: LavaOptions = {
  material: 'lava',
  render: {
    radius: 1.4, smoothing: 2, iterations: 2, resolution: 1, intensity: 1, crust: '#3e3b39', roughness: 0.5, ropes: 0.4, ropeLength: 0.07,
    cracks: 1, crackSize: 0.25, crackWidth: 0.006, clasts: 0.2,
  },
}

/**
 * Pāhoehoe and ʻaʻā: material parameters for `materials.lava` and drawing options for {@link MPMLava}. Pāhoehoe is hotter,
 * runnier and gassier, with a thin ductile glassy crust that stretches and folds into ropes; ʻaʻā is cooler, more viscous
 * and crystal-rich, and its thicker brittle crust tears into dark clinker.
 */
export const LAVA_PRESETS: Record<'pahoehoe' | 'aa', { material: Partial<LavaParams>; lava: LavaInput }> = {
  pahoehoe: {
    material: { density: 2200, viscosity: 150, eruption: 1430, solidus: 1270, yieldStress: 8000, meltYield: 800, crackStrain: 0.03, skin: 0.002 },
    lava: { render: { smoothing: 2.5, crust: '#585653', roughness: 0.35, ropes: 0.8, ropeLength: 0.07, cracks: 1, crackSize: 0.3, crackWidth: 0.005, clasts: 0 } },
  },
  aa: {
    material: { density: 2600, viscosity: 1200, eruption: 1405, solidus: 1300, yieldStress: 20000, meltYield: 2500, crackStrain: 0.003, skin: 0.003 },
    lava: { render: { smoothing: 1, crust: '#332e2b', roughness: 0.9, ropes: 0, cracks: 1, crackSize: 0.09, crackWidth: 0.008, clasts: 0.9 } },
  },
}

/** Stefan–Boltzmann constant, W/(m²·K⁴). */
const SIGMA = 5.670374e-8
/** Lowest temperature the viscosity law sees (keeps 1/T finite). */
const MIN_T = 200
/** Smallest J the pressure's log term sees. */
const MIN_J = 0.05
/**
 * Most volumetric stretch melt holds (beyond it, it tears without pulling back). Viscous melt is cohesive: with no
 * tension at all, a spreading sheet separates into the particle rows it was emitted in.
 */
const MELT_STRETCH = 0.2
/** Wien's c₂/λ at 600 nm, kelvin: the visible glow scales as e^(−c₂/λT) (much steeper than T⁴ below ~1400 K). */
const WIEN = 23980
const SKIN_AGE = 312, SKIN_EXPONENT = 0.35
/**
 * Emitted radiance of 1400 K lava at `intensity` 1, scene units against a noon sun of intensity 3: ~6× sunlit rock of
 * albedo 0.2. Physically about 2–4× (luminous efficacy of a 1400 K blackbody ~0.1–0.3 lm/W); a little more, as
 * photographs expose for the incandescence, but kept where AgX leaves it orange rather than pastel (bloom adds the glare).
 */
export const LAVA_GLOW_1400 = 1.1
/**
 * Skin temperature of a surface exposed for `age` seconds, as a fraction of (T − T_air): 1/(1 + (age/312 s)^0.35), a fit to
 * pāhoehoe surfaces measured by Keszthelyi & Denlinger (1996): ~900 °C after 10 s, ~750 °C after a minute, ~600 °C
 * after five, from 1150 °C. A particle is far thicker than that skin, so its own temperature drives the flow while the
 * drawing glows at the skin's.
 */
export function lavaSkin(age: number): number {
  return 1 / (1 + (Math.max(0, age) / SKIN_AGE) ** SKIN_EXPONENT)
}

// ---- CPU curves (the tests check these; the TSL below is the same maths) ----

/** Melt viscosity at `T` kelvin, Pa·s: Arrhenius from `viscosity` at `eruption`, capped at `viscosityMax`. */
export function lavaViscosity(T: number, p: LavaParams): number {
  return Math.min(p.viscosityMax, p.viscosity * Math.exp(p.activation * (1 / Math.max(T, MIN_T) - 1 / p.eruption)))
}

/** Crust fraction at `T` kelvin: 0 molten above `solidus + crustRange`, 1 crust at and below `solidus` (smoothstep). */
export function lavaCrust(T: number, p: LavaParams): number {
  const t = Math.min(1, Math.max(0, (p.solidus + p.crustRange - T) / Math.max(p.crustRange, 1e-6)))
  return t * t * (3 - 2 * t)
}

/**
 * Surface cooling rate, K/s: radiation and convection to the air over the `exposure` fraction (0…1) of a particle's
 * skin, and conduction to the ground over its `contact` fraction, spread over the thermal skin (ρ·c·skin per m²).
 */
export function lavaCoolingRate(T: number, exposure: number, contact: number, p: LavaParams): number {
  const Ta = p.airTemperature
  const air = p.emissivity * SIGMA * (T ** 4 - Ta ** 4) + p.convection * (T - Ta)
  const ground = p.groundConductance * (T - p.groundTemperature)
  return (exposure * air + contact * ground) / (p.density * p.heatCapacity * p.skin)
}

/** Relative visible glow at `T` kelvin (Wien), 1 at 1400 K. */
export function lavaGlow(T: number): number {
  return T > 0 ? Math.exp(-WIEN * (1 / T - 1 / 1400)) : 0
}

/**
 * Kirchhoff stress (CPU): neo-Hookean μ(F·Fᵀ − I) + λ·ln J pressure + η(T)·J·(C + Cᵀ). The plastic return keeps the elastic
 * shear below the yield stress of the phase (none left in a melt without yield strength).
 */
function cpuStress(F: Mat3, J: number, C: Mat3, T: number, p: LavaParams): Mat3 {
  const { mu, lambda } = lame(p.youngs, p.poisson)
  const FFt = mul3(F, transpose3(F))
  const iso = lambda * Math.log(Math.max(J, MIN_J)) - mu
  const eta = lavaViscosity(T, p) * J
  return FFt.map((v, k) => mu * v + (k % 4 === 0 ? iso : 0) + eta * (C[k] + C[(k % 3) * 3 + Math.floor(k / 3)]))
}

/** Yield stress at `T` kelvin, Pa: from `meltYield` to the crust's `yieldStress` with the crust fraction. */
export function lavaYield(T: number, p: LavaParams): number {
  return p.meltYield + (p.yieldStress - p.meltYield) * lavaCrust(T, p)
}

/**
 * Plastic return (CPU) on the elastic left Cauchy–Green tensor b = F·Fᵀ: volume capped at 1 + stretch, from
 * {@link MELT_STRETCH} molten to `crackStrain` for crust (the crust cracks open past it), the deviatoric part of b̄ = J^(−2/3)·b scaled back to the yield
 * stress (`meltYield` molten, `yieldStress` crust; with none, F is J^(1/3)·I), and F rebuilt as the Cholesky factor of b. The stress only
 * depends on b, and the core's `F ← (I + dt·C)·F` advances b correctly from any factor.
 */
function cpuPlasticity(F: Mat3, T: number, p: LavaParams): Mat3 {
  const { mu } = lame(p.youngs, p.poisson)
  const s = lavaCrust(T, p)
  const J = det3(F)
  const Jc = Math.max(MIN_J, Math.min(J, 1 + MELT_STRETCH + (p.crackStrain - MELT_STRETCH) * s))
  const j23 = Math.cbrt(Jc) ** 2
  const g = Math.cbrt(Jc / Math.max(J, 1e-12)) ** 2 / j23 // b̄ = (Jc/J)^(2/3)·b / Jc^(2/3)
  const b = mul3(F, transpose3(F)).map((v) => v * g)
  const tr = (b[0] + b[4] + b[8]) / 3
  const dev = b.map((v, k) => v - (k % 4 === 0 ? tr : 0))
  const norm = Math.sqrt(dev.reduce((a, v) => a + v * v, 0))
  const k = Math.min(1, lavaYield(T, p) / (mu * j23 * norm + 1e-12))
  const bb = dev.map((v, i) => tr * (i % 4 === 0 ? 1 : 0) + k * v)
  const scale = j23 / Math.cbrt(Math.max(det3(bb), 1e-12))
  return cholesky(bb.map((v) => v * scale))
}

/** Lower-triangular L with L·Lᵀ = b (b symmetric positive definite, column-major). */
function cholesky(b: Mat3): Mat3 {
  const e = 1e-12
  const l11 = Math.sqrt(Math.max(b[0], e))
  const l21 = b[1] / l11, l31 = b[2] / l11
  const l22 = Math.sqrt(Math.max(b[4] - l21 * l21, e))
  const l32 = (b[5] - l31 * l21) / l22
  const l33 = Math.sqrt(Math.max(b[8] - l31 * l31 - l32 * l32, e))
  return [l11, l21, l31, 0, l22, l32, 0, 0, l33]
}

// ---- TSL (the same maths on the GPU) ----

const crustNode = (T: any, p: any): any => {
  const t = clamp(p.solidus.add(p.crustRange).sub(T).div(max(p.crustRange, 1e-6)), 0, 1)
  return t.mul(t).mul(float(3).sub(t.mul(2)))
}
const viscosityNode = (T: any, p: any): any =>
  min(p.viscosityMax, p.viscosity.mul(exp(p.activation.mul(float(1).div(max(T, MIN_T)).sub(float(1).div(p.eruption))))))

/** The `lava` MPM material: see {@link LavaParams}. Compile it in with `materials: { lava: {} }` (or a preset's `material`). */
export const LAVA = registerMPMMaterial<LavaParams>({
  name: 'lava',
  defaults: LAVA_DEFAULTS,
  stress: ({ F, J, C, temperature: T, params: p }) => {
    const { mu, lambda } = lame(p.youngs, p.poisson)
    const lnJ = log(max(J, MIN_J))
    return F.mul(transpose(F)).mul(mu).add(mpmIdentity().mul(lambda.mul(lnJ).sub(mu))).add(C.add(transpose(C)).mul(viscosityNode(T, p).mul(J)))
  },
  plasticity: ({ F, J, temperature: T, params: p }) => {
    const { mu } = lame(p.youngs, p.poisson)
    const s = crustNode(T, p).toVar()
    const Jc = clamp(J, MIN_J, float(1 + MELT_STRETCH).add(p.crackStrain.sub(MELT_STRETCH).mul(s))).toVar()
    const j23 = pow(Jc, 2 / 3).toVar()
    const b: any = F.mul(transpose(F)).mul(pow(Jc.div(max(J, 1e-12)), 2 / 3).div(j23)).toVar()
    const tr = b.element(0).x.add(b.element(1).y).add(b.element(2).z).div(3).toVar()
    const dev: any = b.add(mpmIdentity().mul(tr.negate())).toVar()
    const d0 = dev.element(0), d1 = dev.element(1), d2 = dev.element(2)
    const norm = sqrt(dot(d0, d0).add(dot(d1, d1)).add(dot(d2, d2)))
    const yieldT = p.meltYield.add(p.yieldStress.sub(p.meltYield).mul(s))
    const k = min(float(1), yieldT.div(mu.mul(j23).mul(norm).add(1e-12)))
    const bb: any = mpmIdentity().mul(tr).add(dev.mul(k)).toVar()
    const scaled: any = bb.mul(j23.div(pow(max(determinant(bb), 1e-12), 1 / 3))).toVar()
    return { F: choleskyNode(scaled) }
  },
  cpu: {
    stress: ({ F, J, C, temperature, params }) => cpuStress(F, J, C, temperature, params as LavaParams),
    plasticity: ({ F, temperature, params }) => ({ F: cpuPlasticity(F, temperature, params as LavaParams) }),
  },
  soundSpeed: (p) => {
    const { mu, lambda } = lame(p.youngs, p.poisson)
    return Math.sqrt((lambda + 2 * mu) / p.density)
  },
  viscosity: (p) => p.viscosityMax / p.density,
})

function choleskyNode(b: any): any {
  const c0 = b.element(0), c1 = b.element(1), c2 = b.element(2)
  const l11 = sqrt(max(c0.x, 1e-12)).toVar()
  const l21 = c0.y.div(l11).toVar(), l31 = c0.z.div(l11).toVar()
  const l22 = sqrt(max(c1.y.sub(l21.mul(l21)), 1e-12)).toVar()
  const l32 = c1.z.sub(l31.mul(l21)).div(l22).toVar()
  const l33 = sqrt(max(c2.z.sub(l31.mul(l31)).sub(l32.mul(l32)), 1e-12))
  return (mat3 as any)(vec3(l11, l21, l31), vec3(0, l22, l32), vec3(0, 0, l33))
}

// ---- thermal step ----

/**
 * How much of a particle's skin is open (to air or ground), from the lava fill φ around it (Σ w·m over its 27 nodes / a
 * full node's mass): 0.94…1 inside, ≈0.8 one layer down, 0.59…0.62 on a flat face (by lattice phase), less on edges. 0 at φ ≥ FILL_INSIDE,
 * 1 at φ ≤ FILL_SURFACE, so only the outer layer of particles exchanges heat with the surroundings.
 */
const FILL_INSIDE = 0.84, FILL_SURFACE = 0.63
const exposureOf = (fill: number) => Math.min(1, Math.max(0, (FILL_INSIDE - fill) / (FILL_INSIDE - FILL_SURFACE)))
/** Ground contact from the height above the (bilinear) ground: 1 for the bottom layer (≤ half a spacing up), 0 a spacing higher. */
const contactOf = (above: number, dx: number) => Math.min(1, Math.max(0, 1.5 - above / (dx / MPM_PPC_AXIS)))
/** Scale of the fixed-point m·T channel: T in kilokelvin keeps a full node below ~4 units. */
const HEAT_UNIT = 1000

/** Per-particle results of a thermal step besides the temperature. */
export interface LavaThermalState {
  /** Lava fill φ around each particle (≈1 inside the flow, ≈0.6 on its surface). */
  fill: Float64Array
}

/**
 * The thermal step on the CPU reference (the GPU runs the same in {@link MPMLava}): lava particles scatter mass and
 * m·T into the grid (fixed point, as P2G), then each cools by
 * {@link lavaCoolingRate} with its exposure (from the fill) and ground contact, and relaxes towards the grid's
 * mass-weighted temperature at rate 4κ/Δx² (exact exponential, so any `dt` is stable). Writes `ref.data.temperature`.
 */
export function lavaThermalStep(ref: MPMReference, dt: number, material = 'lava'): LavaThermalState {
  const o = ref.options, d = ref.data
  const [nx, ny, nz] = o.resolution
  const dx = o.cellSize, inv = 1 / dx
  const id = ref.materials.indexOf(material)
  const p = o.materials[material] as LavaParams
  const n = d.count
  const out: LavaThermalState = { fill: new Float64Array(n) }
  if (id < 0) return out
  const mass = p.density / (MPM_DENSITY_UNIT * MPM_PPC_AXIS ** 3), full = p.density / MPM_DENSITY_UNIT
  const acc = new Int32Array(nx * ny * nz * 2)
  const base = [0, 0, 0], fx = [0, 0, 0], w = new Float64Array(9)
  const kernel = (q: number) => {
    for (let a = 0; a < 3; a++) {
      const xg = d.position[q * 3 + a] * inv
      base[a] = Math.floor(xg - 0.5)
      const f = (fx[a] = xg - base[a])
      w[a] = 0.5 * (1.5 - f) ** 2; w[3 + a] = 0.75 - (f - 1) ** 2; w[6 + a] = 0.5 * (f - 0.5) ** 2
    }
    return base[0] >= 0 && base[1] >= 0 && base[2] >= 0 && base[0] <= nx - 3 && base[1] <= ny - 3 && base[2] <= nz - 3
  }
  const node = (i: number, j: number, k: number) => (((base[2] + k) * ny + base[1] + j) * nx + base[0] + i) * 2
  for (let q = 0; q < n; q++) {
    if (d.material[q] !== id || !kernel(q)) continue
    const T = d.temperature[q]
    for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      const wm = w[i * 3] * w[j * 3 + 1] * w[k * 3 + 2] * mass, c = node(i, j, k)
      acc[c] = (acc[c] + toFixed(wm)) | 0
      acc[c + 1] = (acc[c + 1] + toFixed((wm * T) / HEAT_UNIT)) | 0
    }
  }
  const relax = 1 - Math.exp((-4 * p.diffusivity * dt) / (dx * dx))
  for (let q = 0; q < n; q++) {
    if (d.material[q] !== id || !kernel(q)) continue
    let m = 0, mT = 0
    for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      const c = node(i, j, k)
      const mi = acc[c] / MPM_FIXED
      if (acc[c] <= 0) continue
      const wt = w[i * 3] * w[j * 3 + 1] * w[k * 3 + 2]
      m += wt * mi
      mT += wt * mi * ((acc[c + 1] / acc[c]) * HEAT_UNIT)
    }
    const fill = m / full
    const x = d.position[q * 3], y = d.position[q * 3 + 1], z = d.position[q * 3 + 2]
    const above = y - groundAt(ref.heights, nx, nz, dx, x, z)[0]
    const T0 = d.temperature[q]
    const floor = Math.min(p.airTemperature, p.groundTemperature)
    const open = exposureOf(fill), contact = contactOf(above, dx) // the open side of a bottom particle is the ground
    let T = Math.max(floor, T0 - dt * lavaCoolingRate(T0, open * (1 - contact), open * contact, p))
    if (m > 0) T += (mT / m - T) * relax
    d.temperature[q] = T
    out.fill[q] = fill
  }
  return out
}

// ---- GPU: thermal passes and drawing ----

/**
 * Lava on an {@link MPMSolver} whose `materials` include `lava`: the thermal step once per frame after the solver's
 * substeps (three compute passes: scatter mass, heat and the surface glow into a grid; per node, which also writes the
 * {@link MPMLava.field} texture; gather, cool and conduct), and the drawing, a screen-space surface (as for fluids): the
 * particles near the surface are splatted as spheres into a depth buffer, which a bilateral blur smooths into one
 * surface; a full-screen pass over the scene reconstructs its normals and shades it as basalt (sun GGX, sky or
 * environment light) with a blackbody glow from the field's skin temperature (from how long the surface has been open,
 * {@link lavaSkin}; Wien-scaled, so skin below ~1000 K is black by day and dull red at night), cracks glowing at the
 * melt's bulk temperature, and ropy folds across the surface flow where the skin is dark. Hide the solver's own `object`,
 * add this one, and call {@link MPMLava.render} before rendering.
 *
 * @example
 * ```ts
 * const mpm = new MPMSolver(renderer, { materials: { lava: LAVA_PRESETS.pahoehoe.material }, height })
 * const lava = new MPMLava(mpm, LAVA_PRESETS.pahoehoe.lava)
 * mpm.object.visible = false
 * scene.add(lava.object)
 * lava.emit({ center: vent, size: [0.4, 0.2, 0.4], velocity: [1, 0, 0] })
 * renderer.setAnimationLoop(() => {
 *   renderer.compute(lava.prepare(1 / 60))
 *   lava.lighting.fromScene(scene)
 *   lava.render(renderer, camera)
 *   renderer.render(scene, camera)
 * })
 * ```
 */
export class MPMLava {
  /** Resolved drawing options. */
  options: LavaOptions
  /** The solver it runs on. */
  readonly solver: MPMSolver
  /** Add this to your scene: the full-screen surface pass (drawn after the opaque scene, it reads its depth). */
  readonly object: Mesh
  /** Sun and sky light for the surface (fill it with `lighting.fromScene(scene)`). */
  readonly lighting: ParticleLighting
  /** Index of the lava material in the solver. */
  readonly materialIndex: number
  /**
   * Per grid node (texel), written by the thermal step: x lava fill φ, y mean temperature (K), and the glow of the surface
   * particles (skin, or bulk where a crust crack opens) premultiplied: z Σ fill·T_glow (K), w their fill. The drawing
   * divides z/w after trilinear filtering, so the glow is as continuous as the surface.
   */
  readonly field: Storage3DTexture
  /** Shader uniforms. */
  readonly uniforms = {
    /** Simulated seconds since the last thermal step. */ dt: uniform(0),
    /** Sphere radius, metres. */ radius: uniform(0.1),
    /** Smoothing radius, metres. */ smoothing: uniform(0.1),
    /** Emission scale. */ intensity: uniform(1),
    /** Crust albedo (linear). */ crust: uniform(new Color()),
    /** Crust roughness. */ roughness: uniform(0.5),
    /** Rope amplitude. */ ropes: uniform(0),
    /** Rope spacing, metres. */ ropeLength: uniform(0.07),
    /** Crack glow. */ cracks: uniform(1),
    /** Crack cell size, metres. */ crackSize: uniform(0.25),
    /** Crack width, metres. */ crackWidth: uniform(0.006),
    /** Clast tilt. */ clasts: uniform(0),
    /** Environment light scale (the scene's `environmentIntensity`). */ environmentIntensity: uniform(1),
    /** Solver origin, world. */ origin: uniform(new Vector3()),
    /** Camera right, world. */ right: uniform(new Vector3(1, 0, 0)),
    /** Camera up, world. */ up: uniform(new Vector3(0, 1, 0)),
    /** Projection [0][0] and [1][1]. */ projection: uniform(new Vector2(1, 1)),
    /** One texel of the offscreen passes. */ texel: uniform(new Vector2(1, 1)),
    /** Blur direction. */ direction: uniform(new Vector2(1, 0)),
    /** First ring slot of the particles {@link MPMLava.emit} added since the last step. */ gateFirst: uniform(0, 'int'),
    /** How many. */ gateCount: uniform(0, 'int'),
    /** Most lava fill a new particle may land in. */ gateFill: uniform(0.7),
  }

  private readonly acc: any
  private readonly nodeHeat: any
  private readonly scatterNode: ComputeNode
  private readonly nodeNode: ComputeNode
  private readonly gatherNode: ComputeNode
  private readonly gateNode: ComputeNode
  private lastTime: number
  private gated = false
  private readonly splat: Mesh
  private readonly splatScene = new Scene()
  private readonly depthRT: RenderTarget
  private readonly tempRT: RenderTarget
  private readonly smoothRT: RenderTarget
  private readonly blurInput: any
  private readonly blur: QuadMesh
  private env: Texture | null
  private readonly size = new Vector2()
  private readonly clearColor = new Color()

  /**
   * Lava on `solver` (whose `materials` must include `options.material`, default `lava`). `lighting` is shared with other
   * systems if given; `envMap` (e.g. `scene.environment`) lights the surface instead of the sky colour of `lighting`.
   */
  constructor(solver: MPMSolver, { lighting, envMap = null, ...input }: LavaInput & { lighting?: ParticleLighting; envMap?: Texture | null } = {}) {
    this.solver = solver
    this.lighting = lighting ?? new ParticleLighting()
    this.env = envMap
    this.options = resolveLavaOptions(input)
    this.materialIndex = solver.materials.indexOf(this.options.material)
    if (this.materialIndex < 0) throw new Error(`threejs-particles: MPMLava needs the '${this.options.material}' material compiled into the solver`)
    const [nx, ny, nz] = solver.resolution
    const cells = nx * ny * nz
    this.acc = storage(new StorageBufferAttribute(new Int32Array(cells * 4), 1), 'int', cells * 4).toAtomic()
    this.nodeHeat = instancedArray(cells, 'vec4')
    this.field = Object.assign(new Storage3DTexture(nx, ny, nz), {
      type: HalfFloatType, format: RGBAFormat, magFilter: LinearFilter, minFilter: LinearFilter, generateMipmaps: false,
      wrapS: ClampToEdgeWrapping, wrapT: ClampToEdgeWrapping, wrapR: ClampToEdgeWrapping,
    })
    this.scatterNode = this.buildScatter()
    this.nodeNode = this.buildNodes()
    this.gatherNode = this.buildGather()
    this.gateNode = this.buildGate()
    this.lastTime = solver.time

    const target = (filter: typeof NearestFilter, depth = false) =>
      new RenderTarget(1, 1, { type: FloatType, format: RedFormat, depthBuffer: depth, magFilter: filter, minFilter: filter, generateMipmaps: false })
    this.depthRT = target(NearestFilter, true)
    this.tempRT = target(NearestFilter)
    this.smoothRT = target(NearestFilter)
    const g = new InstancedBufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3))
    g.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1))
    g.instanceCount = solver.capacity
    g.boundingSphere = new Sphere(new Vector3(), 1e9) // placed in the shader
    this.splat = new Mesh(g, this.splatMaterial())
    this.splat.frustumCulled = false
    this.splat.matrixAutoUpdate = false
    this.splatScene.add(this.splat)
    this.blurInput = texture(this.depthRT.texture)
    this.blur = new QuadMesh(this.blurMaterial())
    this.object = new Mesh(new PlaneGeometry(2, 2), this.compositeMaterial())
    this.object.frustumCulled = false
    this.object.renderOrder = 1000
    this.object.name = 'MPM lava'
    this.applyOptions()
  }

  /** Merges `input` into the drawing options (`material` is fixed at construction). */
  set(input: LavaInput): this {
    const material = this.options.material
    this.options = resolveLavaOptions(merge(structuredClone(this.options), input))
    this.options.material = material
    return this.applyOptions()
  }

  /**
   * Adds lava (an {@link MPMEmit} block, by default this material at its `eruption` temperature) through a vent that only
   * fills free space: before the next step, new particles that land where the lava fill φ (from the last thermal step) is
   * above `maxFill` are removed. MPM reads density from each particle's own deformation, so a particle born inside lava
   * would add mass without pressure, and a vent pouring faster than the flow carries lava away would pack it ever denser.
   * Returns how many were added (before the gate).
   */
  emit(spec: MPMEmit, maxFill = 0.7): number {
    const s = this.solver, u = this.uniforms
    this.closeGate()
    const head = (s as unknown as { head: number }).head // ring slot of the first new particle (MPMSolver's own field)
    const p = s.options.materials[this.options.material]
    const k = s.emit({ material: this.options.material, temperature: p.eruption, ...spec })
    if (!k) return 0
    const pending = u.gateCount.value > 0
    if (pending && (u.gateFirst.value + u.gateCount.value) % s.capacity === head) u.gateCount.value = Math.min(s.capacity, u.gateCount.value + k)
    else { u.gateFirst.value = head; u.gateCount.value = k }
    u.gateFill.value = maxFill
    return k
  }

  /** The solver's passes for `dt` and then the thermal step, for one `renderer.compute(...)`. */
  prepare(dt: number): ComputeNode[] {
    this.closeGate()
    const gate = this.uniforms.gateCount.value > 0 ? [this.gateNode] : []
    this.gated = gate.length > 0 // uniforms are read when the passes run: clear the range on the next emit or prepare
    const nodes = [...gate, ...this.solver.prepare(dt)]
    this.object.position.copy(this.solver.object.position)
    const step = this.solver.time - this.lastTime
    this.lastTime = this.solver.time
    if (step <= 0 || !this.solver.count) return nodes
    this.uniforms.dt.value = step
    return [...nodes, this.scatterNode, this.nodeNode, this.gatherNode]
  }

  private closeGate(): void {
    if (this.gated) this.uniforms.gateCount.value = 0
    this.gated = false
  }

  /** Replaces the environment that lights the surface (`null`: the sky colour of `lighting`). Rebuilds the surface pass. */
  setEnvironment(envMap: Texture | null): this {
    if (envMap === this.env) return this
    this.env = envMap
    ;(this.object.material as MeshBasicNodeMaterial).dispose()
    this.object.material = this.compositeMaterial()
    return this
  }

  /** Draws the offscreen surface passes for `camera` (each frame, before rendering the scene that holds `object`). */
  render(renderer: Renderer, camera: Camera): this {
    const o = this.options.render, u = this.uniforms
    renderer.getDrawingBufferSize(this.size)
    const w = Math.max(1, Math.round(this.size.x * o.resolution)), h = Math.max(1, Math.round(this.size.y * o.resolution))
    for (const rt of [this.depthRT, this.tempRT, this.smoothRT]) if (rt.width !== w || rt.height !== h) rt.setSize(w, h)
    u.texel.value.set(1 / w, 1 / h)
    const p = (camera as PerspectiveCamera).projectionMatrix.elements
    u.projection.value.set(p[0], p[5])
    camera.updateMatrixWorld()
    const m = camera.matrixWorld.elements
    u.right.value.set(m[0], m[1], m[2]).normalize()
    u.up.value.set(m[4], m[5], m[6]).normalize()
    this.solver.object.updateMatrixWorld()
    u.origin.value.setFromMatrixPosition(this.solver.object.matrixWorld)
    this.splat.matrix.copy(this.solver.object.matrixWorld)
    this.splat.matrixWorld.copy(this.splat.matrix)
    const prevTarget = renderer.getRenderTarget(), prevAlpha = renderer.getClearAlpha(), prevAuto = renderer.autoClear
    renderer.getClearColor(this.clearColor)
    renderer.autoClear = false
    renderer.setClearColor(0x000000, 0)
    renderer.setRenderTarget(this.depthRT)
    renderer.clear()
    renderer.render(this.splatScene, camera)
    let src = this.depthRT
    const passes = o.iterations ? o.iterations : 0
    for (let i = 0; i < passes; i++) {
      for (const [dir, dst] of [[[1, 0], this.tempRT], [[0, 1], this.smoothRT]] as const) {
        this.blurInput.value = src.texture
        u.direction.value.set(dir[0], dir[1])
        renderer.setRenderTarget(dst)
        this.blur.render(renderer)
        src = dst
      }
    }
    if (!passes) {
      this.blurInput.value = this.depthRT.texture
      u.direction.value.set(0, 0)
      renderer.setRenderTarget(this.smoothRT)
      this.blur.render(renderer)
    }
    renderer.setRenderTarget(prevTarget)
    renderer.setClearColor(this.clearColor, prevAlpha)
    renderer.autoClear = prevAuto
    return this
  }

  /** Frees the GPU passes, targets and meshes (not the solver). */
  dispose(): void {
    this.object.removeFromParent()
    this.object.geometry.dispose()
    for (const mesh of [this.object, this.splat]) (mesh.material as MeshBasicNodeMaterial).dispose()
    this.splat.geometry.dispose()
    ;(this.blur.material as MeshBasicNodeMaterial).dispose()
    for (const rt of [this.depthRT, this.tempRT, this.smoothRT]) rt.dispose()
    this.field.dispose()
    for (const n of [this.scatterNode, this.nodeNode, this.gatherNode, this.gateNode]) n.dispose()
  }

  private applyOptions(): this {
    const r = this.options.render, u = this.uniforms
    const spacing = this.solver.options.cellSize / MPM_PPC_AXIS
    u.radius.value = r.radius * spacing
    u.smoothing.value = r.smoothing * r.radius * spacing
    u.intensity.value = r.intensity
    u.crust.value.set(r.crust)
    u.roughness.value = r.roughness
    u.ropes.value = r.ropes
    u.ropeLength.value = r.ropeLength
    u.cracks.value = r.cracks
    u.crackSize.value = r.crackSize
    u.crackWidth.value = r.crackWidth
    u.clasts.value = r.clasts
    return this
  }

  private get params(): Record<string, any> {
    return this.solver.params[this.materialIndex].values
  }

  // Quadratic B-spline stencil, as the solver's (and the CPU kernel above).
  private kernel(x: any) {
    const [nx, ny, nz] = this.solver.resolution
    const su = this.solver.uniforms
    const xg: any = x.mul(su.invDx).toVar()
    const base: any = floor(xg.sub(0.5)).toVar()
    const fx: any = xg.sub(base).toVar()
    const w = [fx.sub(1.5).mul(fx.sub(1.5)).mul(0.5).toVar(), float(0.75).sub(fx.sub(1).mul(fx.sub(1))).toVar(), fx.sub(0.5).mul(fx.sub(0.5)).mul(0.5).toVar()]
    const active = base.x.greaterThanEqual(0).and(base.y.greaterThanEqual(0)).and(base.z.greaterThanEqual(0))
      .and(base.x.lessThanEqual(nx - 3)).and(base.y.lessThanEqual(ny - 3)).and(base.z.lessThanEqual(nz - 3))
    const ib: any = ivec3(base).toVar()
    const node = (i: number, j: number, k: number) => ib.z.add(k).mul(nx * ny).add(ib.y.add(j).mul(nx)).add(ib.x.add(i))
    return { active, node, w }
  }

  private isLava(i: any): any {
    const b = this.solver.buffers
    return b.velocity.element(i).w.greaterThan(0).and(int(b.state.element(i).x).equal(this.materialIndex))
  }

  // The temperature particle i glows at (TSL): its skin, Ta + (T − Ta)·skin(age) from its surface age (state.w), or its
  // bulk temperature where its crust is cracking open (J towards 1 + crackStrain).
  private glowTemperature(i: any): any {
    const b = this.solver.buffers, p = this.params
    const T = b.props.element(i).x
    const col = (c: number) => b.deformation.element(int(i).mul(3).add(c)).xyz
    const J = determinant((mat3 as any)(col(0), col(1), col(2)))
    const opening = clamp(J.sub(1).div(max(p.crackStrain, 1e-4)).sub(0.5).mul(2), 0, 1).mul(crustNode(T, p)).mul(this.uniforms.cracks)
    const skin = float(1).div(pow(b.state.element(i).w.div(SKIN_AGE), SKIN_EXPONENT).add(1))
    const Ta = p.airTemperature
    return mix(Ta.add(T.sub(Ta).mul(skin)), T, opening)
  }

  private buildScatter(): ComputeNode {
    const b = this.solver.buffers, acc = this.acc, p = this.params
    const fixed = (v: any) => int(floor(v.mul(MPM_FIXED).add(0.5)))
    return Fn(() => {
      const i = instanceIndex
      If(this.isLava(i), () => {
        const k = this.kernel(b.position.element(i).xyz)
        If(k.active, () => {
          const T = b.props.element(i).x.toVar()
          const mass = p.density.div(MPM_DENSITY_UNIT * MPM_PPC_AXIS ** 3)
          // Surface particles (age > 0: open to the air last step) carry the glow.
          const surface = select(b.state.element(i).w.greaterThan(0), float(1), float(0))
          const glow = this.glowTemperature(i).toVar()
          for (let z = 0; z < 3; z++) for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
            const wm = k.w[x].x.mul(k.w[y].y).mul(k.w[z].z).mul(mass).toVar()
            const n = k.node(x, y, z).mul(4).toVar()
            atomicAdd(acc.element(n), fixed(wm))
            atomicAdd(acc.element(n.add(1)), fixed(wm.mul(T).div(HEAT_UNIT)))
            atomicAdd(acc.element(n.add(2)), fixed(wm.mul(surface)))
            atomicAdd(acc.element(n.add(3)), fixed(wm.mul(surface).mul(glow).div(HEAT_UNIT)))
          }
        })
      })
    })().compute(this.solver.capacity, [64])
  }

  private buildNodes(): ComputeNode {
    const acc = this.acc, p = this.params
    const [nx, ny, nz] = this.solver.resolution
    return Fn(() => {
      const n: any = int(instanceIndex).toVar()
      const x: any = n.mod(nx), y: any = n.div(nx).mod(ny), z: any = n.div(nx * ny)
      const load = (c: number): any => float(atomicLoad(acc.element(n.mul(4).add(c))) as any)
      const m: any = int(atomicLoad(acc.element(n.mul(4))) as any).toVar()
      const mT = load(1), ms = load(2), msT = load(3)
      for (let c = 0; c < 4; c++) atomicStore(acc.element(n.mul(4).add(c)), int(0))
      const has = m.greaterThan(0)
      const heat = vec4(select(has, float(m).div(MPM_FIXED), float(0)), select(has, mT.div(float(m)).mul(HEAT_UNIT), float(0)), 0, 0).toVar()
      this.nodeHeat.element(n).assign(heat)
      const full = p.density.div(MPM_DENSITY_UNIT)
      textureStore(this.field, ivec3(x, y, z), vec4(heat.x.div(full), heat.y, msT.mul(HEAT_UNIT / MPM_FIXED).div(full), ms.div(MPM_FIXED).div(full)))
    })().compute(nx * ny * nz, [64])
  }

  private buildGather(): ComputeNode {
    const s = this.solver, b = s.buffers, H = b.heights, p = this.params, u = this.uniforms, su = s.uniforms
    const [nx, , nz] = s.resolution
    return Fn(() => {
      const i = instanceIndex
      If(this.isLava(i), () => {
        const P = b.position.element(i).toVar()
        const k = this.kernel(P.xyz)
        If(k.active, () => {
          const m = float(0).toVar(), mT = float(0).toVar()
          for (let z = 0; z < 3; z++) for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
            const h = this.nodeHeat.element(k.node(x, y, z)).toVar()
            const wt = k.w[x].x.mul(k.w[y].y).mul(k.w[z].z)
            m.addAssign(wt.mul(h.x))
            mT.addAssign(wt.mul(h.x).mul(h.y))
          }
          const fill = m.div(p.density.div(MPM_DENSITY_UNIT)).toVar()
          // Ground under the particle, bilinear between the node columns (as `groundAt`).
          const gxz: any = clamp(P.xz.mul(su.invDx), vec2(0), vec2(nx - 1, nz - 1)).toVar()
          const i0: any = min(floor(gxz), vec2(nx - 2, nz - 2)).toVar()
          const f: any = gxz.sub(i0).toVar()
          const at = (di: number, dk: number) => H.element(int(i0.y).add(dk).mul(nx).add(int(i0.x).add(di)))
          const ground = at(0, 0).mul(f.x.oneMinus()).add(at(1, 0).mul(f.x)).mul(f.y.oneMinus()).add(at(0, 1).mul(f.x.oneMinus()).add(at(1, 1).mul(f.x)).mul(f.y))
          const exposure = clamp(float(FILL_INSIDE).sub(fill).div(FILL_INSIDE - FILL_SURFACE), 0, 1)
          const contact = clamp(float(1.5).sub(P.y.sub(ground).div(su.dx.div(MPM_PPC_AXIS))), 0, 1).mul(exposure).toVar()
          const Q = b.props.element(i).toVar()
          const T0 = Q.x
          const Ta = p.airTemperature
          const air = p.emissivity.mul(SIGMA).mul(pow(T0, 4).sub(pow(Ta, 4))).add(p.convection.mul(T0.sub(Ta)))
          const rate = exposure.sub(contact).mul(air).add(contact.mul(p.groundConductance.mul(T0.sub(p.groundTemperature)))).div(p.density.mul(p.heatCapacity).mul(p.skin))
          const T = max(min(Ta, p.groundTemperature), T0.sub(u.dt.mul(rate))).toVar()
          const relax = float(1).sub(exp(p.diffusivity.mul(-4).mul(u.dt).mul(su.invDx).mul(su.invDx)))
          If(m.greaterThan(0), () => { T.addAssign(mT.div(m).sub(T).mul(relax)) })
          b.props.element(i).assign(vec4(T, Q.y, Q.z, Q.w))
          // Surface age (state.w, for the skin glow): grows while the particle is at the surface, 0 once it is inside.
          const S = b.state.element(i).toVar()
          b.state.element(i).assign(vec4(S.x, S.y, S.z, select(exposure.greaterThan(0), S.w.add(u.dt), float(0))))
        })
      })
    })().compute(s.capacity, [64])
  }

  private buildGate(): ComputeNode {
    const s = this.solver, b = s.buffers, p = this.params, u = this.uniforms, cap = s.capacity
    return Fn(() => {
      const i = instanceIndex
      const rel = int(i).sub(u.gateFirst).add(cap).mod(cap)
      If(rel.lessThan(u.gateCount).and(this.isLava(i)), () => {
        const k = this.kernel(b.position.element(i).xyz)
        If(k.active, () => {
          const m = float(0).toVar()
          for (let z = 0; z < 3; z++) for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
            m.addAssign(k.w[x].x.mul(k.w[y].y).mul(k.w[z].z).mul(this.nodeHeat.element(k.node(x, y, z)).x))
          }
          If(m.div(p.density.div(MPM_DENSITY_UNIT)).greaterThan(u.gateFill), () => { b.velocity.element(i).assign(vec4(0)) })
        })
      })
    })().compute(cap, [64])
  }

  // The field at a local position (node i at texel centre i), trilinear.
  private fieldAt(local: any): any {
    const [nx, ny, nz] = this.solver.resolution
    return texture3D(this.field, local.mul(this.solver.uniforms.invDx).add(0.5).div(vec3(nx, ny, nz)), float(0))
  }

  // Camera-facing quads around the lava particles near the surface (field fill at the centre < 0.9: the top two layers;
  // deeper ones are hidden, and come back as a crack exposes them): sphere-impostor depth, linear, front surface.
  private splatMaterial(): MeshBasicNodeMaterial {
    const u = this.uniforms, b = this.solver.buffers, i = instanceIndex
    const m = new MeshBasicNodeMaterial()
    m.fog = false
    m.toneMapped = false
    const P = b.position.element(i)
    const keep = select(this.isLava(i).and(this.fieldAt(P.xyz).x.lessThan(0.9)), float(1), float(0))
    const corner = positionGeometry.xy
    m.positionNode = P.xyz.add(u.right.mul(corner.x).add(u.up.mul(corner.y)).mul(u.radius.mul(keep)))
    const q = varying(corner)
    const r2 = dot(q, q)
    const nz = sqrt(max(float(1).sub(r2), 0))
    m.colorNode = Fn(() => {
      If(r2.greaterThan(1), () => { Discard() })
      return vec4(positionView.z.add(nz.mul(u.radius)).negate(), 0, 0, 1)
    })()
    m.depthNode = viewZToPerspectiveDepth(positionView.z.add(nz.mul(u.radius)), cameraNear, cameraFar)
    return m
  }

  // Separable bilateral blur of the linear depth: Gaussian with a radius of `smoothing` metres at that depth, across the
  // local depth slope (a slanted surface keeps its plane), weighted down across depth jumps; empty pixels never count.
  // It is also a morphological closing of the silhouette: a pixel is surface when most of its kernel is (filling the
  // notches between particle spheres and rounding off single beads), so outlines are smooth toes, not strings of beads.
  private blurMaterial(): MeshBasicNodeMaterial {
    const u = this.uniforms
    const m = new MeshBasicNodeMaterial()
    m.toneMapped = false
    m.colorNode = Fn(() => {
      const c = screenUV
      const d0 = this.blurInput.sample(c).x.toVar()
      const out = d0.toVar()
      If(u.direction.x.add(u.direction.y).greaterThan(0), () => {
        // Kernel size from the depth here, or from the nearest surface for an empty pixel (probed 4 texels out).
        const step = u.direction.mul(u.texel)
        const near = max(max(this.blurInput.sample(c.add(step.mul(4))).x, this.blurInput.sample(c.sub(step.mul(4))).x), d0)
        If(near.greaterThan(0), () => {
          const dref = select(d0.greaterThan(0), d0, near).toVar()
          const px = min(u.smoothing.mul(u.projection.x).div(dref).mul(0.5).div(u.texel.x), 14)
          const sigma = max(px.mul(0.5), 0.5)
          const range = u.radius.mul(3)
          const k = clamp(px.mul(0.5).floor(), 2, 7)
          const dp = this.blurInput.sample(c.add(step.mul(k))).x, dm = this.blurInput.sample(c.sub(step.mul(k))).x
          const slope = select(dp.greaterThan(0).and(dm.greaterThan(0)), dp.sub(dm).div(k.mul(2)), float(0)).toVar()
          If(abs(slope.mul(k)).greaterThan(range.mul(2)), () => { slope.assign(0) })
          const sum = float(0).toVar(), wsum = float(0).toVar(), occ = float(0).toVar(), all = float(0).toVar()
          Loop({ start: -14, end: 15, type: 'int', condition: '<' }, ({ i }: { i: any }) => {
            const t = float(i)
            const d = this.blurInput.sample(c.add(step.mul(t))).x
            const g = exp(t.mul(t).div(sigma.mul(sigma).mul(-2)))
            const valid = select(d.greaterThan(0), float(1), float(0))
            const rr = d.sub(slope.mul(t))
            const dz = rr.sub(dref).div(range)
            const w = g.mul(exp(dz.mul(dz).negate())).mul(valid)
            sum.addAssign(rr.mul(w))
            wsum.addAssign(w)
            occ.addAssign(g.mul(valid))
            all.addAssign(g)
          })
          out.assign(select(occ.div(all).greaterThan(0.45).and(wsum.greaterThan(1e-4)), sum.div(max(wsum, 1e-6)), float(0)))
        })
      })
      return vec4(out, 0, 0, 1)
    })()
    return m
  }

  // Ground height under local (x, z), bilinear between the node columns (as `groundAt` and the solver's collider).
  private groundHeight(xz: any): any {
    const s = this.solver, H = s.buffers.heights
    const [nx, , nz] = s.resolution
    const g: any = clamp(xz.mul(s.uniforms.invDx), vec2(0), vec2(nx - 1, nz - 1)).toVar()
    const i0: any = min(floor(g), vec2(nx - 2, nz - 2)).toVar()
    const f: any = g.sub(i0).toVar()
    const at = (di: number, dk: number) => H.element(int(i0.y).add(dk).mul(nx).add(int(i0.x).add(di)))
    return at(0, 0).mul(f.x.oneMinus()).add(at(1, 0).mul(f.x)).mul(f.y.oneMinus()).add(at(0, 1).mul(f.x.oneMinus()).add(at(1, 1).mul(f.x)).mul(f.y))
  }

  // Crack cells (Voronoi in local x–z, cell units): x the distance to the nearest cell edge, y a random 0…1 per cell.
  private cells(p: any): any {
    const i: any = floor(p).toVar(), f: any = p.sub(i).toVar()
    const d1 = float(8).toVar(), d2 = float(8).toVar(), id = float(0).toVar()
    const rnd = (cell: any, k: number) => hash(cell.x.add(512).mul(1031).add(cell.y.add(512)).mul(4).add(k))
    for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
      const cell: any = i.add(vec2(j, k)).toVar()
      const r: any = vec2(j, k).add(vec2(rnd(cell, 0), rnd(cell, 1))).sub(f)
      const dd = dot(r, r).toVar()
      d2.assign(select(dd.lessThan(d1), d1, min(d2, dd)))
      id.assign(select(dd.lessThan(d1), rnd(cell, 2), id))
      d1.assign(min(d1, dd))
    }
    return vec2(sqrt(d2).sub(sqrt(d1)).mul(0.5), id)
  }

  // The lava surface over the scene: normals from the smoothed depth (with ropes, clasts), basalt lit by the sun (GGX)
  // and the sky or environment, contact darkening at the ground, the field's glow and the glowing crack network; around
  // it, a contact shadow on the ground.
  private compositeMaterial(): MeshBasicNodeMaterial {
    const u: any = this.uniforms, L: any = this.lighting.uniforms, p = this.params
    const m = new MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false })
    m.fog = false
    m.vertexNode = vec4(positionGeometry.xy, 0, 1)
    const depthTex = texture(this.smoothRT.texture), rawTex = texture(this.depthRT.texture)
    const view = (c: any, d: any): any => (vec3 as any)(c.x.mul(2).sub(1).mul(d).div(u.projection.x), float(1).sub(c.y.mul(2)).mul(d).div(u.projection.y), d.negate())
    const env = this.env
    const color = Fn(() => {
      const c = screenUV
      const out = vec4(0).toVar()
      const d = depthTex.sample(c).x.toVar()
      const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture().x, cameraNear, cameraFar).negate().toVar()
      const tx = u.texel.x, ty = u.texel.y
      If(d.lessThanEqual(0), () => {
        // Ground next to the lava: occluded by it (a soft contact shadow ~20 cm wide), counting only lava in front of
        // this ground pixel and near its depth (not lava far in front of a distant slope).
        const rpx = u.radius.mul(2.5).mul(u.projection.x).div(sceneZ).mul(0.5).div(tx)
        const occl = float(0).toVar()
        for (let a = 0; a < 12; a++) {
          const o = vec2(Math.cos((a * Math.PI) / 6), Math.sin((a * Math.PI) / 6))
          for (const sc of [0.2, 0.45, 0.7, 1]) {
            const dd = depthTex.sample(c.add(o.mul(rpx.mul(sc)).mul(vec2(tx, ty)))).x
            occl.addAssign(select(dd.greaterThan(0).and(dd.lessThan(sceneZ.add(u.radius))).and(sceneZ.sub(dd).lessThan(u.radius.mul(10))), float((1.2 - sc) / 12), float(0)))
          }
        }
        If(occl.lessThanEqual(0.002), () => { Discard() })
        out.assign(vec4(0, 0, 0, smoothstep(0, 1.6, occl).mul(0.45)))
      }).Else(() => {
        // Behind the opaque scene (raw spheres, or the smoothed surface where the closing grew it over the ground): hidden.
        If(rawTex.sample(c).x.greaterThan(sceneZ.add(u.radius)).or(d.greaterThan(sceneZ.add(u.radius.mul(1.5)))), () => { Discard() })
        const P: any = view(c, d).toVar()
        // Normal: of the two one-sided differences per axis, the smaller (no smearing across silhouettes).
        const side = (dc: any): any => {
          const dd = depthTex.sample(c.add(dc)).x
          return select(dd.greaterThan(0), view(c.add(dc), dd), P.add(P.sub(view(c.sub(dc), depthTex.sample(c.sub(dc)).x))))
        }
        const xr = side(vec2(tx, 0)).sub(P), xl = P.sub(side(vec2(tx, 0).negate()))
        const yu = side(vec2(0, ty)).sub(P), yd = P.sub(side(vec2(0, ty).negate()))
        const ddx: any = select(abs(xr.z).lessThan(abs(xl.z)), xr, xl)
        const ddy: any = select(abs(yu.z).lessThan(abs(yd.z)), yu, yd)
        const nv: any = normalize(cross(ddy, ddx)).toVar()
        const Vv: any = normalize(P.negate()).toVar()
        If(dot(nv, Vv).lessThan(0), () => { nv.assign(nv.negate()) })
        // At the silhouette the surface turns edge-on: keep the normal facing the camera a little (an edge-on or flipped
        // normal there is what draws a black outline).
        nv.assign(normalize(nv.add(Vv.mul(max(float(0.25).sub(dot(nv, Vv)), 0)))))
        const N: any = normalize(cameraWorldMatrix.mul(vec4(nv, 0)).xyz).toVar()
        const W: any = cameraWorldMatrix.mul(vec4(P, 1)).xyz.toVar()
        const local = W.sub(u.origin).toVar()
        const Vw: any = normalize(cameraPosition.sub(W)).toVar()
        // Glow temperature from the field: the surface particles' (skin, or bulk at opening cracks), else the mean.
        const f: any = this.fieldAt(local).toVar()
        const Te: any = select(f.w.greaterThan(0.02), f.z.div(max(f.w, 0.02)), f.y).toVar()
        const crusted = smoothstep(1300, 1120, Te).toVar() // the skin has gone dark (cooled)
        // Tangent frame and detail fade: a pattern finer than ~2 px fades out (fwidth), so nothing aliases.
        const tX: any = normalize(vec3(1, 0, 0).sub(N.mul(N.x))).toVar(), tZ: any = normalize(cross(tX, N)).toVar()
        // Ropy folds across the surface flow (the solver grid's velocity, else downhill once it has stopped), on dark skin.
        const v: any = this.gridVelocity(local).toVar()
        const down: any = vec3(N.x, 0, N.z).mul(0.004)
        const vt: any = v.add(down).sub(N.mul(dot(v.add(down), N))).toVar()
        const dir: any = vt.div(max(length(vt), 1e-6)).toVar()
        const phase: any = dot(local, dir).mul(Math.PI * 2).div(u.ropeLength).toVar()
        const ropeFade = clamp(float(1.5).sub(fwidth(phase).div(Math.PI)), 0, 1)
        const wrinkle: any = phase.mul(2.7).add(dot(local, tZ).mul(11)).toVar()
        const wrinkleFade = clamp(float(1.5).sub(fwidth(wrinkle).div(Math.PI)), 0, 1)
        const tilt = phase.sin().mul(ropeFade).add(wrinkle.sin().mul(0.35).mul(wrinkleFade)).mul(u.ropes).mul(crusted)
        N.assign(normalize(N.sub(dir.mul(tilt))))
        // Crack cells: cooling joints in the crust (pāhoehoe plates, ʻaʻā clasts), each clast tilted (rubble).
        const q: any = vec2(local.x, local.z).div(u.crackSize).toVar()
        const cell: any = this.cells(q).toVar()
        const cellFade = clamp(float(2).sub(fwidth(q.x).mul(8)), 0, 1).toVar()
        const ta = cell.y.mul(Math.PI * 2)
        N.assign(normalize(N.add(tX.mul(ta.cos()).add(tZ.mul(ta.sin())).mul(hash(cell.y.mul(7919)).mul(u.clasts).mul(0.9).mul(cellFade)))))
        const edge = cell.x.mul(u.crackSize) // metres to the nearest crack
        const fe = max(fwidth(edge), 1e-5)
        const crack = float(1).sub(smoothstep(u.crackWidth.sub(fe), u.crackWidth.add(fe), edge)).mul(cellFade).toVar()
        // Contact with the ground: the lava's own underside and toe base are shaded (no sky, little sun).
        const above = W.y.sub(u.origin.y).sub(this.groundHeight(vec2(local.x, local.z)))
        const contact = smoothstep(0, u.radius.mul(1.5), above).mul(0.5).add(0.5)
        // Basalt: Lambert + GGX sun, sky or environment ambient and reflection (the glassy sheen of pāhoehoe skin).
        const NdV = clamp(dot(N, Vw), 0, 1)
        const F = float(0.04).add(float(0.96).mul(pow(float(1).sub(NdV), 5)))
        const rough: any = mix(u.roughness, float(0.3), smoothstep(1150, 1350, Te)).toVar()
        const Ls = L.sunDirection
        const H = normalize(Ls.add(Vw))
        const a2 = rough.mul(rough).mul(rough).mul(rough)
        const NdH = clamp(dot(N, H), 0, 1), NdL = clamp(dot(N, Ls), 0, 1)
        const D = a2.div(NdH.mul(NdH).mul(a2.sub(1)).add(1).pow(2).mul(Math.PI))
        const G = float(0.5).div(max(NdV.add(NdL).mul(rough.mul(0.5).add(0.5)), 0.1))
        const spec = L.sunColor.mul(min(D.mul(F).mul(G).mul(NdL), 2))
        const ambient: any = env ? pmremTexture(env, N, float(1)).rgb.mul(u.environmentIntensity) : L.ambient.mul(N.y.mul(0.3).add(0.7))
        const sheen: any = env ? pmremTexture(env, reflect(Vw.negate(), N), rough).rgb.mul(u.environmentIntensity) : L.ambient
        const albedo = u.crust.mul(float(1).sub(crack.mul(crusted).mul(0.6)))
        const diffuse = albedo.mul(L.sunColor.mul(NdL).add(ambient)).div(Math.PI)
        const lit = diffuse.mul(float(1).sub(F)).add(spec).add(sheen.mul(F)).mul(contact)
        // Glow: the skin, and the cracks at the melt temperature beneath (the field's mean; dark once that has cooled).
        const Tc = max(Te, f.y.mul(0.97))
        // Molten surface: a skin film of plates, each a little cooler than the seams between them (older plates cooler).
        const film = float(1).sub(crusted).mul(float(1).sub(crack)).mul(cell.y.mul(50).add(30)).mul(cellFade)
        const T: any = mix(Te.sub(film), Tc, crack.mul(u.cracks)).toVar()
        const glow = blackbodyNode(T).mul(exp(float(-WIEN).mul(float(1).div(max(T, MIN_T)).sub(1 / 1400)))).mul(u.intensity.mul(LAVA_GLOW_1400))
        // Coverage: a soft edge from the neighbourhood (no stair-stepped silhouette).
        let cover: any = float(0)
        for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) cover = cover.add(select(depthTex.sample(c.add(vec2(tx.mul(ox), ty.mul(oy)))).x.greaterThan(0), float(0.25), float(0)))
        out.assign(vec4(lit.add(glow), cover.mul(0.5).add(0.5)))
        void p
      })
      return out
    })()
    m.colorNode = color
    m.opacityNode = color.w
    return m
  }

  // The solver grid's velocity at a local position (trilinear over the 8 nodes around it; the grid after the last substep).
  private gridVelocity(local: any): any {
    const s = this.solver, G = s.buffers.grid
    const [nx, ny, nz] = s.resolution
    const g: any = clamp(local.mul(s.uniforms.invDx), vec3(0), vec3(nx - 2, ny - 2, nz - 2)).toVar()
    const i0: any = (ivec3 as any)(floor(g)).toVar()
    const f: any = g.sub(floor(g)).toVar()
    let v: any = vec3(0)
    for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const w = (i ? f.x : f.x.oneMinus()).mul(j ? f.y : f.y.oneMinus()).mul(k ? f.z : f.z.oneMinus())
      v = v.add(G.element(i0.z.add(k).mul(nx * ny).add(i0.y.add(j).mul(nx)).add(i0.x.add(i))).xyz.mul(w))
    }
    return v
  }
}

/** `structuredClone(DEFAULT_LAVA)` merged with `input`, with out-of-range values fixed. */
export function resolveLavaOptions(input: unknown): LavaOptions {
  const o = merge(structuredClone(DEFAULT_LAVA), input)
  const d = DEFAULT_LAVA.render, r = o.render
  const num = (v: unknown, def: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def)
  if (typeof o.material !== 'string' || !o.material) o.material = DEFAULT_LAVA.material
  r.radius = num(r.radius, d.radius, 0.5, 4)
  r.smoothing = num(r.smoothing, d.smoothing, 0, 8)
  r.iterations = Math.round(num(r.iterations, d.iterations, 0, 4))
  r.resolution = num(r.resolution, d.resolution, 0.25, 1)
  r.intensity = num(r.intensity, d.intensity, 0, 1000)
  r.crust = typeof r.crust === 'string' && /^#[0-9a-f]{6}$/i.test(r.crust) ? r.crust : d.crust
  r.roughness = num(r.roughness, d.roughness, 0.02, 1)
  r.ropes = num(r.ropes, d.ropes, 0, 1)
  r.ropeLength = num(r.ropeLength, d.ropeLength, 0.01, 1)
  r.cracks = num(r.cracks, d.cracks, 0, 1)
  r.crackSize = num(r.crackSize, d.crackSize, 0.01, 5)
  r.crackWidth = num(r.crackWidth, d.crackWidth, 0, 0.1)
  r.clasts = num(r.clasts, d.clasts, 0, 1)
  return o
}

/**
 * Emission sources for heat haze or sparks (`ParticleSystem` with `emitter.shape: 'sources'`) from a read-back of the
 * solver ({@link MPMSolver.read}): lava particles glowing hotter than `minTemperature`, weighted by their visible glow
 * ({@link lavaGlow}), in the `SOURCE_STRIDE` layout (x, y, z world, weight, size, lift, tint, temperature scale). With
 * `ages` (each particle's surface age, `buffers.state` w, read back), only surface particles count, at their skin
 * temperature ({@link lavaSkin}); without, every particle at its bulk temperature. At most `max` sources, evenly thinned.
 */
export function lavaHeatSources(
  data: MPMParticleData, origin: readonly number[],
  { material = 0, minTemperature = 1150, max = 2048, lift = 0.3, ages, airTemperature = 300 }: { material?: number; minTemperature?: number; max?: number; lift?: number; ages?: ArrayLike<number>; airTemperature?: number } = {},
): Float32Array {
  const hot: number[] = [], temps: number[] = []
  for (let q = 0; q < data.count; q++) {
    if (data.material[q] !== material || (ages && !(ages[q] > 0))) continue
    const T = ages ? airTemperature + (data.temperature[q] - airTemperature) * lavaSkin(ages[q]) : data.temperature[q]
    if (T > minTemperature) { hot.push(q); temps.push(T) }
  }
  const k = Math.min(max, hot.length), stride = hot.length / Math.max(k, 1)
  const out = new Float32Array(k * 8)
  for (let s = 0; s < k; s++) {
    const j = Math.floor(s * stride), q = hot[j], T = temps[j]
    out.set([data.position[q * 3] + origin[0], data.position[q * 3 + 1] + origin[1], data.position[q * 3 + 2] + origin[2], lavaGlow(T) * stride, 1, lift, 0, T / 1400], s * 8)
  }
  return out
}
