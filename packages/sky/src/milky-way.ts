/**
 * The Milky Way: a glowing band along the galactic plane with a bright bulge towards the galactic
 * centre, clumpy star clouds and dark dust lanes, all from seeded 3D noise in TSL (no textures). It is
 * fixed to the stars, so it rises and sets with them.
 */
import { Vector3, Matrix3, Color } from 'three/webgpu'
import { asin, atan, clamp, exp, float, mix, mx_fractal_noise_float, smoothstep, uniform, vec3 } from 'three/tsl'
import { DEG, cross, fromColumns, hexToLinear, normalize, transpose, type Mat3, type Vec3 } from './util.ts'

/** Milky Way settings. Plain JSON. */
export interface MilkyWayOptions {
  /** Draw it. */
  enabled: boolean
  /** Overall brightness. */
  intensity: number
  /** Galactic north pole as [ecliptic longitude, latitude], degrees. The default is the real one. */
  pole: [number, number]
  /** Direction of the galactic centre as [ecliptic longitude, latitude], degrees (made perpendicular to `pole`). */
  center: [number, number]
  /** Angular half-width of the band, degrees. */
  width: number
  /** Brightness of the central bulge, 0..3. */
  bulge: number
  /** Strength of the dark dust lanes, 0..1. */
  dust: number
  /** Scale of the clouds and lanes: larger = finer structure. */
  detail: number
  /** Colour of the disc (`#rrggbb`). */
  color: string
  /** Colour of the bulge (`#rrggbb`). */
  bulgeColor: string
}

/** Our galaxy, seen from Earth. */
export const DEFAULT_MILKY_WAY: MilkyWayOptions = {
  enabled: true,
  intensity: 1,
  pole: [180.02, 29.81],
  center: [266.84, -5.54],
  width: 9,
  bulge: 1,
  dust: 0.8,
  detail: 1,
  color: '#b9c8ff',
  bulgeColor: '#ffd9a8',
}

/** Unit y-up star-frame vector of an ecliptic longitude/latitude (degrees). */
export function eclipticToVector(longitude: number, latitude: number): Vec3 {
  const l = longitude * DEG, b = latitude * DEG
  return [Math.cos(b) * Math.cos(l), Math.sin(b), -Math.cos(b) * Math.sin(l)]
}

/** Rotation from the star frame into galactic coordinates (x → centre, y → north pole). */
export function galacticMatrix(o: Pick<MilkyWayOptions, 'pole' | 'center'>): Mat3 {
  const pole = eclipticToVector(...o.pole)
  const c = eclipticToVector(...o.center)
  const k = c[0] * pole[0] + c[1] * pole[1] + c[2] * pole[2]
  const centre = normalize([c[0] - pole[0] * k, c[1] - pole[1] * k, c[2] - pole[2] * k])
  return transpose(fromColumns(centre, pole, cross(centre, pole)))
}

/** Creates the Milky Way uniforms. */
export function createMilkyWayUniforms() {
  return {
    /** Star frame → galactic frame. */
    galactic: uniform(new Matrix3()),
    /** Brightness (0 = off). */
    intensity: uniform(1),
    /** Band half-width, radians. */
    width: uniform(9 * DEG),
    /** Bulge brightness. */
    bulge: uniform(1),
    /** Dust lane strength. */
    dust: uniform(0.8),
    /** Noise frequency multiplier. */
    detail: uniform(1),
    /** Seeded noise offset. */
    offset: uniform(new Vector3()),
    /** Disc colour (linear). */
    color: uniform(new Color()),
    /** Bulge colour (linear). */
    bulgeColor: uniform(new Color()),
  }
}

/** Milky Way uniforms (`stars.milkyWay`). */
export type MilkyWayUniforms = ReturnType<typeof createMilkyWayUniforms>

/** Copies options into the uniforms. */
export function applyMilkyWay(u: MilkyWayUniforms, o: MilkyWayOptions, seed: number) {
  u.galactic.value.fromArray(galacticMatrix(o))
  u.intensity.value = o.enabled ? o.intensity : 0
  u.width.value = Math.max(0.1, o.width) * DEG
  u.bulge.value = o.bulge
  u.dust.value = o.dust
  u.detail.value = o.detail
  u.offset.value.set(((seed * 0.000123) % 97) + 11.3, ((seed * 0.000457) % 89) + 5.1, ((seed * 0.000791) % 83) + 2.7)
  u.color.value.setRGB(...hexToLinear(o.color))
  u.bulgeColor.value.setRGB(...hexToLinear(o.bulgeColor))
}

/**
 * Milky Way radiance along a unit star-frame direction `cel`, plus `band` (0..1 closeness to the
 * galactic plane, used to crowd faint stars into it).
 */
export function milkyWayNode(u: MilkyWayUniforms, cel: any): { color: any; band: any } {
  const g: any = u.galactic.mul(cel)
  const b = asin(clamp(g.y, -1, 1)) // galactic latitude
  const l = atan(g.z, g.x) // galactic longitude, 0 at the centre
  const bulge = exp(l.mul(l).div(-0.35)).mul(exp(b.mul(b).div(-0.045))).mul(u.bulge)
  const w = u.width.mul(float(1).add(exp(l.mul(l).div(-0.6)).mul(0.8)))
  const band = exp(b.mul(b).div(w.mul(w)).negate())
  const p = cel.mul(u.detail).add(u.offset)
  const clouds = mx_fractal_noise_float(p.mul(3.5), 5, 2.1, 0.55).mul(0.9).add(0.75).clamp(0.15, 2)
  const lanes = smoothstep(-0.05, 0.35, mx_fractal_noise_float(p.mul(7).add(vec3(5.2, 1.3, 9.1)), 4, 2.2, 0.5))
  const laneMask = exp(b.mul(b).div(w.mul(w).mul(0.18)).negate())
  const dust = float(1).sub(lanes.mul(laneMask).mul(u.dust))
  const glow = band.mul(clouds).mul(0.022).add(bulge.mul(0.03)).mul(dust)
  const tint = mix(u.color, u.bulgeColor, bulge.clamp(0, 1))
  return { color: tint.mul(glow).mul(u.intensity), band }
}
