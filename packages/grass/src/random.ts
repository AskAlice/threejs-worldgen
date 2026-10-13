// Deterministic hashing and noise shared by the grass and corn layouts (no three.js, so tests and workers can use it).

/** Smooth 2D value noise in [-1, 1]. */
export function valueNoise(x: number, z: number) {
  const xi = Math.floor(x)
  const zi = Math.floor(z)
  const tx = x - xi
  const tz = z - zi
  const sx = tx * tx * (3 - 2 * tx)
  const sz = tz * tz * (3 - 2 * tz)
  const h = (a: number, b: number) => (hash2(a, b) / 4294967296) * 2 - 1
  const top = h(xi, zi) + (h(xi + 1, zi) - h(xi, zi)) * sx
  const bottom = h(xi, zi + 1) + (h(xi + 1, zi + 1) - h(xi, zi + 1)) * sx
  return top + (bottom - top) * sz
}

export function hash2(x: number, z: number) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  return (h ^ (h >>> 13)) >>> 0
}

export function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
