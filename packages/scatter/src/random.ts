/**
 * Small deterministic random helpers. Everything in threejs-scatter derives its randomness from these, so the same
 * seed and world position always give the same result on every machine.
 */

/** Hashes up to three integers into a well-mixed unsigned 32-bit integer. */
export function hash(a: number, b: number, c = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/** Hashes a string (FNV-1a) into an unsigned 32-bit integer, e.g. to derive a seed from a layer name. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/** A fast seeded generator (mulberry32). Returns a function yielding floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Smooth seeded 2D value noise in [-1, 1]. */
export function valueNoise2(x: number, z: number, seed = 0): number {
  const xi = Math.floor(x)
  const zi = Math.floor(z)
  const tx = x - xi
  const tz = z - zi
  const sx = tx * tx * (3 - 2 * tx)
  const sz = tz * tz * (3 - 2 * tz)
  const h = (a: number, b: number) => (hash(a, b, seed) / 4294967296) * 2 - 1
  const h00 = h(xi, zi)
  const h10 = h(xi + 1, zi)
  const h01 = h(xi, zi + 1)
  const h11 = h(xi + 1, zi + 1)
  const top = h00 + (h10 - h00) * sx
  return top + (h01 + (h11 - h01) * sx - top) * sz
}

/** Fractal (fBm) value noise remapped to roughly [0, 1]. `octaves` layers, each at double frequency and half weight. */
export function fbm2(x: number, z: number, seed = 0, octaves = 3): number {
  let sum = 0
  let amp = 0.5
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise2(x, z, seed + o * 1013) * amp
    norm += amp
    x = x * 2.03 + 17.1
    z = z * 2.03 - 5.3
    amp *= 0.5
  }
  return 0.5 + 0.5 * (sum / norm)
}
