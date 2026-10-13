import { Fn, float, max, vec3 } from 'three/tsl'

// Planckian locus in CIE 1960 UCS (Krystek 1985), then xyY → XYZ → linear sRGB. Accurate to a few
// thousandths over 1000–15000 K; extrapolates smoothly to deep reds down to ~700 K.

/** Linear-sRGB chromaticity of a blackbody at `kelvin`, scaled so the largest channel is 1. */
export function blackbodyColor(kelvin: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const t = Math.min(40000, Math.max(500, kelvin))
  const u = (0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t * t) / (1 + 8.42420235e-4 * t + 7.08145163e-7 * t * t)
  const v = (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t * t) / (1 - 2.89741816e-5 * t + 1.61456053e-7 * t * t)
  const d = 2 * u - 8 * v + 4
  const x = (3 * u) / d, y = (2 * v) / d
  const X = x / y, Z = (1 - x - y) / y
  const r = Math.max(0, 3.2406 * X - 1.5372 - 0.4986 * Z)
  const g = Math.max(0, -0.9689 * X + 1.8758 + 0.0415 * Z)
  const b = Math.max(0, 0.0557 * X - 0.204 + 1.057 * Z)
  const m = Math.max(r, g, b, 1e-6)
  out[0] = r / m; out[1] = g / m; out[2] = b / m
  return out
}

/** Relative radiance of a blackbody (Stefan-Boltzmann, ∝ T⁴), 1 at `reference` kelvin. */
export function blackbodyRadiance(kelvin: number, reference = 1400): number {
  return (Math.max(0, kelvin) / reference) ** 4
}

/** TSL {@link blackbodyColor}: chromaticity (max channel 1) of a blackbody at `kelvin`. */
export const blackbodyNode = /*@__PURE__*/ Fn(([kelvin]: [any]) => {
  const t = kelvin.clamp(500, 40000)
  const t2 = t.mul(t)
  const u = float(0.860117757).add(t.mul(1.54118254e-4)).add(t2.mul(1.28641212e-7)).div(float(1).add(t.mul(8.42420235e-4)).add(t2.mul(7.08145163e-7)))
  const v = float(0.317398726).add(t.mul(4.22806245e-5)).add(t2.mul(4.20481691e-8)).div(float(1).sub(t.mul(2.89741816e-5)).add(t2.mul(1.61456053e-7)))
  const d = u.mul(2).sub(v.mul(8)).add(4)
  const x = u.mul(3).div(d), y = v.mul(2).div(d)
  const X = x.div(y), Z = float(1).sub(x).sub(y).div(y)
  const rgb = max(vec3(
    X.mul(3.2406).sub(1.5372).sub(Z.mul(0.4986)),
    X.mul(-0.9689).add(1.8758).add(Z.mul(0.0415)),
    X.mul(0.0557).sub(0.204).add(Z.mul(1.057)),
  ), vec3(0))
  return rgb.div(max(max(rgb.x, rgb.y), max(rgb.z, 1e-6)))
})
