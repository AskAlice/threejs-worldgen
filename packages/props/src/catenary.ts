/**
 * Hanging cables. A cable of uniform weight hangs in a catenary `y = a·cosh(x / a)`; for a span of
 * horizontal length `L` its midspan sag is `s = a·(cosh(L / 2a) − 1)`. Given the sag we solve for `a`
 * and lay the curve under the chord between the two attachment points (exact for level spans, the
 * usual engineering approximation for inclined ones).
 */

/** Catenary parameter `a` (metres) of a level span `span` with midspan sag `sag` (both > 0). */
export function catenaryParameter(span: number, sag: number): number {
  if (!(span > 0) || !(sag > 0)) return Infinity
  // s(a) falls monotonically from ∞ (a → 0) to 0 (a → ∞): bisect in log space.
  let lo = Math.log(span * 1e-4), hi = Math.log(span * 1e7)
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2, a = Math.exp(mid)
    const s = a * (Math.cosh(span / (2 * a)) - 1)
    if (s > sag) lo = mid
    else hi = mid
  }
  return Math.exp((lo + hi) / 2)
}

/** How far below the chord the cable hangs at horizontal fraction `u` (0…1) of the span. */
export function catenaryDip(span: number, a: number, u: number): number {
  if (!Number.isFinite(a)) return 0
  return a * (Math.cosh(span / (2 * a)) - Math.cosh(((u - 0.5) * span) / a))
}

/**
 * `segments + 1` points (xyz) of a cable from `a` to `b` sagging `sag` metres below the chord at
 * midspan. Endpoints are exact.
 */
export function catenaryPoints(a: readonly number[], b: readonly number[], sag: number, segments: number, out = new Float32Array((segments + 1) * 3)): Float32Array {
  const L = Math.hypot(b[0] - a[0], b[2] - a[2])
  const k = catenaryParameter(L, sag)
  for (let i = 0; i <= segments; i++) {
    const u = i / segments
    out[i * 3] = a[0] + (b[0] - a[0]) * u
    out[i * 3 + 1] = a[1] + (b[1] - a[1]) * u - catenaryDip(L, k, u)
    out[i * 3 + 2] = a[2] + (b[2] - a[2]) * u
  }
  return out
}
