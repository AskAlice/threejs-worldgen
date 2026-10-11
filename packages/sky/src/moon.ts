/**
 * The moon disc drawn in the sky: a real sphere intersected per pixel, lit by the sun from the actual
 * sun direction (so phases and the terminator come from geometry), with Lommel–Seeliger reflectance,
 * procedural maria and craters fixed to the moon's body frame (so the same face keeps pointing at the
 * planet), and earthshine on the dark side.
 */
import { cross, dot, float, fwidth, length, max, mix, mx_fractal_noise_float, mx_worley_noise_float, normalize, smoothstep, sqrt, vec3 } from 'three/tsl'
import type { SkyUniforms } from './atmosphere.ts'

/** Procedural lunar albedo (≈0.07 maria … 0.18 bright highlands) at a unit body-frame normal. */
export function moonAlbedo(n: any): any {
  const maria = smoothstep(0.05, 0.25, mx_fractal_noise_float(n.mul(1.6).add(vec3(3.1, 7.7, 1.3)), 4, 2, 0.5))
  const craters = mx_worley_noise_float(n.mul(9)) // distance to the nearest feature point
  const rims = smoothstep(0.12, 0.2, craters).mul(smoothstep(0.32, 0.2, craters)).mul(0.035)
  const bowls = smoothstep(0.16, 0.0, craters).mul(-0.02)
  const grain = mx_fractal_noise_float(n.mul(24), 3, 2, 0.5).mul(0.03)
  return mix(float(0.165), float(0.075), maria).add(rims).add(bowls).add(grain)
}

/**
 * Coverage (0..1, anti-aliased) of the moon disc along view direction `d`. Uses derivatives, so call
 * it outside any per-pixel branch.
 */
export function moonCoverage(u: SkyUniforms, d: any) {
  const m = u.moonDirection
  const D = float(1).div(max(u.moonAngularRadius, 1e-6)) // distance to the centre in moon radii
  const sinT = length(cross(d, m)) // precise for tiny angles, unlike acos(dot)
  const h2 = float(1).sub(D.mul(D).mul(sinT).mul(sinT))
  const edge = max(fwidth(h2), 1e-5)
  const coverage = smoothstep(edge.negate(), edge, h2).mul(dot(d, m).greaterThan(0).select(1, 0)).mul(u.moonAngularRadius.greaterThan(0).select(1, 0))
  return { coverage, h2, D }
}

/** Radiance of the moon surface along `d` (assumes `d` is inside the disc; no derivatives). */
export function moonRadiance(u: SkyUniforms, d: any, h2: any, D: any): any {
  const m = u.moonDirection
  const t = D.mul(dot(d, m)).sub(sqrt(max(h2, 0)))
  const n = normalize(d.mul(t).sub(m.mul(D))) // outward surface normal, render space
  const nb = normalize(u.moonMatrix.mul(n)) // body frame: features stay put
  const albedo = moonAlbedo(nb).mul(u.moonAlbedoScale)
  const cosI = max(dot(n, u.sunDirection), 0)
  const cosE = max(dot(n, d.negate()), 1e-4)
  const lommel = cosI.div(cosI.add(cosE)).mul(2) // Lommel–Seeliger: flat-looking full moon, crisp terminator
  const sunlit = albedo.mul(lommel).mul(u.sunIntensity).mul(u.moonBrightness).div(Math.PI)
  const shine = albedo.mul(u.earthshine).mul(float(1).sub(u.moonIllumination)).mul(cosE.mul(0.5).add(0.5))
  return vec3(1.0, 0.98, 0.94).mul(sunlit.add(shine))
}
