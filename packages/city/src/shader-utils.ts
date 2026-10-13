import { abs, float, floor, fract, fwidth, hash, max, smoothstep, step } from 'three/tsl'

/** TSL node graphs are dynamically typed; this alias keeps the shader code readable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type N = any

/** Antialiased stripe mask: 1 inside `|x| < half`, softened over the pixel footprint. */
export function band(x: N, half: N): N {
  const aa = fwidth(x).add(1e-4)
  return float(1).sub(smoothstep(half.sub(aa), half.add(aa), abs(x)))
}

/** Grout lines of a running-bond pattern (bricks, stone, slates): returns (joint mask, cell hash, fade). */
export function bond(u: N, v: N, w: N, h: N, joint: N): { joint: N; cell: N; fade: N } {
  const row = floor(v.div(h))
  const x = u.div(w).add(row.mod(2).mul(0.5))
  const col = floor(x)
  const fu = fract(x).sub(0.5).mul(w), fv = fract(v.div(h)).sub(0.5).mul(h)
  const j = max(float(1).sub(band(fu, w.mul(0.5).sub(joint))), float(1).sub(band(fv, h.mul(0.5).sub(joint))))
  // Fade the pattern out when its cells shrink below a few pixels.
  const fade = float(1).sub(smoothstep(0.15, 0.5, fwidth(v).div(h)))
  return { joint: j.mul(fade), cell: hash(col.add(16384).add(row.add(16384).mul(911))), fade }
}

/** 1 where `a` equals the integer code `b`, else 0. */
export const eq = (a: N, b: number) => float(1).sub(step(0.5, abs(a.sub(b))))

