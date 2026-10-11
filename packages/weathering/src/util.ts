// Internal helpers shared by the weathering classes (not part of the public API).

/** Deep-merges plain-JSON `input` into `target` (objects merge, arrays and everything else replace). */
export function merge<T>(target: T, input: unknown): T {
  if (!input || typeof input !== 'object') return target
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === undefined) continue
    const cur = (target as Record<string, unknown>)[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      ;(target as Record<string, unknown>)[k] = merge({ ...(cur as object) }, v)
    } else {
      ;(target as Record<string, unknown>)[k] = Array.isArray(v) ? structuredClone(v) : v
    }
  }
  return target
}

/** `structuredClone(defaults)` deep-merged with `input`. */
export function resolve<T>(defaults: T, input: unknown): T {
  return merge(structuredClone(defaults), input)
}

/** Positive modulo (result in [0, m)). */
export function mod(x: number, m: number): number {
  return ((x % m) + m) % m
}
