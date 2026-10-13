/**
 * Picks a level of detail for one instance.
 *
 * LOD `i` covers distances below `distances[i]` (nearest first, ascending); beyond the last distance the instance is
 * hidden (`-1`). With a `current` level, the instance keeps it until it is `hysteresis` (a fraction of the threshold)
 * past the boundary on either side, so instances sitting on a boundary don't flicker as the camera jitters.
 *
 * @param distance Distance from the camera, in metres.
 * @param distances Ascending end distance of each level.
 * @param current The level used last time, or `-1` / `undefined` for none (also "hidden").
 * @param hysteresis Fractional band around each threshold, e.g. `0.1` = ±10 %.
 */
export function selectLod(distance: number, distances: ArrayLike<number>, current = -1, hysteresis = 0): number {
  let lod = -1
  for (let i = 0; i < distances.length; i++) {
    if (distance < distances[i]) {
      lod = i
      break
    }
  }
  if (current === lod || hysteresis <= 0 || current < -1 || current >= distances.length) return lod
  // Stay on `current` while still inside its band widened by the hysteresis.
  const lo = current === -1 ? distances[distances.length - 1] : current > 0 ? distances[current - 1] : 0
  const hi = current === -1 ? Infinity : distances[current]
  if (distance >= lo * (1 - hysteresis) && distance < hi * (1 + hysteresis)) return current
  return lod
}
