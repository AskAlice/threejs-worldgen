// One deep-merge for the option objects of every package (city, particles, weathering, …).
//
// It lives here because threejs-heightfield is the monorepo's foundation package: it has no dependencies
// of its own, and city and weathering already depend on it, so no package can gain a dependency cycle by
// importing it. A separate `threejs-util` package would work too, but would add a published package, a
// lander and a docs entry for fifteen lines.

/** Keys that would reach `Object.prototype` if merged; skipped like `undefined`. */
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Deep-merges plain-JSON `input` into `target` in place: objects merge recursively, arrays and scalars
 * replace wholesale, `undefined` is skipped and `null` replaces. Arrays are cloned, so the result never
 * aliases the input.
 */
export function merge<T>(target: T, input: unknown): T {
  if (!input || typeof input !== 'object') return target
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === undefined || UNSAFE.has(k)) continue
    const t = target as Record<string, unknown>
    const cur = t[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur))
      t[k] = merge({ ...(cur as object) }, v)
    else t[k] = Array.isArray(v) ? structuredClone(v) : v
  }
  return target
}

/** `structuredClone(defaults)` deep-merged with each input in turn. */
export function resolve<T>(defaults: T, ...inputs: unknown[]): T {
  let out = structuredClone(defaults)
  for (const input of inputs) out = merge(out, input)
  return out
}
