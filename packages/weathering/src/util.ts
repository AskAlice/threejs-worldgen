// Internal helpers shared by the weathering classes (not part of the public API).

/** Positive modulo (result in [0, m)). */
export function mod(x: number, m: number): number {
  return ((x % m) + m) % m
}
