/** Depth below the water surface, metres, at which each seabed colour band ends. */
export const SEA_BANDS = { shelf: 10, slope: 35, abyss: 120 }

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Blend weights `[shelf, slope, abyss]` of the seabed colours `depth` metres below the water surface;
 * `jitter` (metres) shifts the band edges so they do not contour. Sums to at most 1: the remainder is
 * the dry ground colour, which also smooths the shoreline.
 */
export function seabedWeights(depth: number, jitter = 0): [number, number, number] {
  const d = depth + jitter
  const submerge = smooth(0, 1.5, d)
  const shelf = smooth(0, SEA_BANDS.shelf, d)
  const abyss = smooth(SEA_BANDS.slope, SEA_BANDS.abyss, d)
  return [(1 - shelf) * submerge, shelf * (1 - abyss) * submerge, abyss * submerge]
}
