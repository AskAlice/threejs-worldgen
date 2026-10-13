/**
 * Single-scattering atmosphere maths on the CPU (Rayleigh + Mie + ozone absorption over a spherical
 * planet). It mirrors the TSL sky shader in `atmosphere.ts` so lighting, fog colour and exposure
 * computed here match what is drawn. Pure, no three.js.
 */
import { DEFAULT_LAYERS, type AtmosphereLayers } from './layers.ts'
import { clamp, type Vec3 } from './util.ts'

/** Physical atmosphere parameters. Plain JSON. Coefficients are per metre at sea level. */
export interface AtmosphereOptions {
  /** Draw the atmosphere at all. Off = black sky with stars (airless worlds, space scenes). */
  enabled: boolean
  /** Thickness of the atmosphere shell above the planet radius, metres. */
  height: number
  /** Rayleigh (air molecules) density scale height, metres. */
  rayleighScaleHeight: number
  /** Mie (haze, aerosols) density scale height, metres. */
  mieScaleHeight: number
  /** Rayleigh scattering coefficients for red, green, blue, 1/m. Blue skies come from blue being largest. */
  rayleigh: [number, number, number]
  /** Mie scattering coefficient, 1/m. More = hazier, whiter sky and bigger glow around the sun. */
  mie: number
  /** Mie absorption coefficient, 1/m. */
  mieAbsorption: number
  /** Mie phase anisotropy, −1..1. Near 1 = tight forward glow around the sun. */
  mieG: number
  /** Ozone absorption coefficients, 1/m (at peak density). Gives twilight its blue. Zero to disable. */
  ozone: [number, number, number]
  /** Altitude of peak ozone density, metres. */
  ozoneCenter: number
  /** Half-width of the ozone layer (tent profile), metres. */
  ozoneWidth: number
  /** Multiplier on all densities: 0.5 = thin air, 3 = soupy. */
  density: number
  /** Sun radiance scale in renderer units (what the sky is multiplied by). */
  sunIntensity: number
  /** Ground albedo seen through the atmosphere where no terrain is drawn (`#rrggbb`, e.g. from orbit). */
  groundColor: string
  /** Faint glow of the night sky itself (linear RGB radiance), so moonless nights aren't pitch black. */
  airglow: [number, number, number]
  /** Brightness of the thin green airglow shell at the mesopause (seen as a glowing line at the limb at night). */
  airglowBand: number
  /** Airglow shell colour (linear RGB). */
  airglowBandColor: [number, number, number]
  /** Altitudes of the atmosphere's layers (troposphere … exosphere, and the Kármán line). */
  layers: AtmosphereLayers
  /**
   * Scale every altitude (shell, scale heights, ozone, layers, cloud bands) by planet radius / Earth radius,
   * with scattering coefficients scaled inversely so colours stay Earth-like on small planets.
   */
  scaleWithRadius: boolean
  /** Ray-march samples along each view ray. */
  steps: number
  /** Ray-march samples towards the sun for each view sample. */
  lightSteps: number
}

/** Earth-like defaults (Bruneton/Hillaire coefficients). */
export const DEFAULT_ATMOSPHERE: AtmosphereOptions = {
  enabled: true,
  height: 100_000,
  rayleighScaleHeight: 8000,
  mieScaleHeight: 1200,
  rayleigh: [5.802e-6, 13.558e-6, 33.1e-6],
  mie: 3.996e-6,
  mieAbsorption: 4.4e-7,
  mieG: 0.8,
  ozone: [0.65e-6, 1.881e-6, 0.085e-6],
  ozoneCenter: 25_000,
  ozoneWidth: 15_000,
  density: 1,
  sunIntensity: 20,
  groundColor: '#2c3b2e',
  airglow: [0.00025, 0.0004, 0.0009],
  airglowBand: 1,
  airglowBandColor: [0.3, 1, 0.45],
  layers: DEFAULT_LAYERS,
  scaleWithRadius: true,
  steps: 16,
  lightSteps: 6,
}

/**
 * Ray–sphere intersection (sphere at the origin). Uses the closest-approach form, which stays accurate
 * when the ray starts very far away.
 * @returns `[near, far]` distances along the ray, or `null` on a miss.
 */
export function raySphere(o: Vec3, d: Vec3, r: number): [number, number] | null {
  const b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2]
  const px = o[0] - d[0] * b, py = o[1] - d[1] * b, pz = o[2] - d[2] * b
  const h2 = r * r - (px * px + py * py + pz * pz)
  if (h2 < 0) return null
  const h = Math.sqrt(h2)
  return [-b - h, -b + h]
}

/** Rayleigh phase function. */
export const phaseRayleigh = (mu: number) => (3 / (16 * Math.PI)) * (1 + mu * mu)
/** Cornette–Shanks Mie phase function. */
export function phaseMie(mu: number, g: number): number {
  const g2 = g * g
  return ((3 / (8 * Math.PI)) * ((1 - g2) * (1 + mu * mu))) / ((2 + g2) * Math.pow(Math.max(1e-6, 1 + g2 - 2 * g * mu), 1.5))
}

/** Rayleigh, Mie and ozone densities (relative to sea level) at a height. */
function densities(a: AtmosphereOptions, h: number, out: Vec3): Vec3 {
  out[0] = Math.exp(-h / a.rayleighScaleHeight) * a.density
  out[1] = Math.exp(-h / a.mieScaleHeight) * a.density
  out[2] = Math.max(0, 1 - Math.abs(h - a.ozoneCenter) / a.ozoneWidth) * a.density
  return out
}

const _d: Vec3 = [0, 0, 0]

/**
 * Optical depths (Rayleigh, Mie, ozone; density × metres) from `p` along `d` to the top of the
 * atmosphere. Returns `null` if the ray hits the planet.
 */
export function opticalDepth(a: AtmosphereOptions, planetRadius: number, p: Vec3, d: Vec3, steps = a.lightSteps): Vec3 | null {
  const top = raySphere(p, d, planetRadius + a.height)
  if (!top || top[1] <= 0) return [0, 0, 0]
  const ground = raySphere(p, d, planetRadius)
  if (ground && ground[0] > 0) return null
  const t0 = Math.max(0, top[0]), ds = (top[1] - t0) / steps
  const od: Vec3 = [0, 0, 0]
  for (let i = 0; i < steps; i++) {
    const t = t0 + (i + 0.5) * ds
    const x = p[0] + d[0] * t, y = p[1] + d[1] * t, z = p[2] + d[2] * t
    densities(a, Math.hypot(x, y, z) - planetRadius, _d)
    od[0] += _d[0] * ds; od[1] += _d[1] * ds; od[2] += _d[2] * ds
  }
  return od
}

/** exp(−τ) for optical depths, per channel. */
export function extinction(a: AtmosphereOptions, od: Vec3): Vec3 {
  const m = (a.mie + a.mieAbsorption) * od[1]
  return [0, 1, 2].map((c) => Math.exp(-(a.rayleigh[c] * od[0] + m + a.ozone[c] * od[2]))) as Vec3
}

/** Fraction of light (per channel) surviving from `p` along `d` out to space; zeros if the planet blocks it. */
export function transmittance(a: AtmosphereOptions, planetRadius: number, p: Vec3, d: Vec3): Vec3 {
  if (!a.enabled) {
    const ground = raySphere(p, d, planetRadius)
    return ground && ground[0] > 0 ? [0, 0, 0] : [1, 1, 1]
  }
  const od = opticalDepth(a, planetRadius, p, d)
  return od ? extinction(a, od) : [0, 0, 0]
}

/**
 * Light scattered towards a camera at `o` (relative to the planet centre) looking along `d`, lit by a
 * sun in direction `sun` with radiance scale `intensity`. Same model as the sky shader (no discs).
 */
export function skyRadiance(a: AtmosphereOptions, planetRadius: number, o: Vec3, d: Vec3, sun: Vec3, intensity = a.sunIntensity): Vec3 {
  if (!a.enabled) return [0, 0, 0]
  const top = raySphere(o, d, planetRadius + a.height)
  if (!top || top[1] <= 0) return [0, 0, 0]
  let t1 = top[1]
  const ground = raySphere(o, d, planetRadius)
  if (ground && ground[0] > 0) t1 = ground[0]
  const t0 = Math.max(0, top[0]), ds = (t1 - t0) / a.steps
  const mu = d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2]
  const pr = phaseRayleigh(mu), pm = phaseMie(mu, a.mieG)
  const view: Vec3 = [0, 0, 0], sumR: Vec3 = [0, 0, 0], sumM: Vec3 = [0, 0, 0], p: Vec3 = [0, 0, 0]
  for (let i = 0; i < a.steps; i++) {
    const t = t0 + (i + 0.5) * ds
    p[0] = o[0] + d[0] * t; p[1] = o[1] + d[1] * t; p[2] = o[2] + d[2] * t
    densities(a, Math.hypot(p[0], p[1], p[2]) - planetRadius, _d)
    const dr = _d[0] * ds, dm = _d[1] * ds, dz = _d[2] * ds
    view[0] += dr * 0.5; view[1] += dm * 0.5; view[2] += dz * 0.5 // optical depth to the sample's centre
    const light = opticalDepth(a, planetRadius, p, sun)
    if (light) {
      const T = extinction(a, [view[0] + light[0], view[1] + light[1], view[2] + light[2]])
      for (let c = 0; c < 3; c++) { sumR[c] += T[c] * dr; sumM[c] += T[c] * dm }
    }
    view[0] += dr * 0.5; view[1] += dm * 0.5; view[2] += dz * 0.5
  }
  return [0, 1, 2].map((c) => intensity * (sumR[c] * a.rayleigh[c] * pr + sumM[c] * a.mie * pm)) as Vec3
}

/** Relative luminance (Rec. 709) of linear RGB. */
export const luminance = (c: Vec3) => clamp(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], 0, Infinity)
