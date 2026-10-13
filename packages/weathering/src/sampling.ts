// Internal: smooth lookups of coarse world-space data textures (state fields, fire cells), so their
// texel grid never shows as stair steps or diamonds, even when a material thresholds the value.
import type { Texture } from 'three/webgpu'
import { float, mx_noise_float, texture, vec2 } from 'three/tsl'

/**
 * Samples `tex` at `uv` with a 2×2 tent of bilinear taps (a smooth quadratic B-spline-like filter, C1
 * across texel borders) after warping the lookup by up to ~0.6 texel with low-frequency, slightly
 * anisotropic noise of world position `xz`: square cells come out with soft, organic edges.
 * `size` is the texture's world extent (vec2), `texelMetres` one texel's size in metres.
 */
export function smoothSample(tex: Texture, uv: any, size: any, xz: any, texelMetres: number): any {
  const texel = vec2(texelMetres).div(size)
  const q = xz.div(texelMetres)
  const wx = mx_noise_float(q.mul(vec2(0.21, 0.13)).add(17.3)).add(mx_noise_float(q.mul(vec2(0.53, 0.37)).add(5.1)).mul(0.35))
  const wz = mx_noise_float(q.mul(vec2(0.13, 0.21)).add(41.7)).add(mx_noise_float(q.mul(vec2(0.37, 0.53)).add(9.9)).mul(0.35))
  const p = uv.add(vec2(wx, wz).mul(texel).mul(0.6))
  const h = texel.mul(0.5)
  const a = texture(tex, p.add(vec2(h.x.negate(), h.y.negate())))
  const b = texture(tex, p.add(vec2(h.x, h.y.negate())))
  const c = texture(tex, p.add(vec2(h.x.negate(), h.y)))
  const d = texture(tex, p.add(h))
  return a.add(b).add(c).add(d).mul(float(0.25))
}
