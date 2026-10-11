/**
 * Octahedral mapping between view directions and impostor atlas frames. Pure math, mirrored in TSL by the impostor
 * material; unit-tested on the CPU.
 *
 * Directions are object-space unit vectors pointing from the object towards the viewer, with +Y up. The full mapping
 * covers the sphere; the hemi-octahedral one covers only the upper hemisphere (views from below are clamped to the
 * horizon), which spends the whole atlas on the views that trees and rocks are actually seen from.
 */

/** A 3D direction as a tuple. */
export type Vec3Tuple = [x: number, y: number, z: number]

const sign = (v: number) => (v < 0 ? -1 : 1)

/** Maps a direction to octahedral coordinates in [0, 1]². */
export function octEncode(x: number, y: number, z: number, hemisphere: boolean): [u: number, v: number] {
  if (hemisphere) {
    y = Math.max(y, 0)
    const s = Math.abs(x) + y + Math.abs(z) || 1
    const px = x / s
    const pz = z / s
    // Rotate the diamond by 45° so it fills the square.
    return [(px + pz + 1) / 2, (px - pz + 1) / 2]
  }
  const s = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1
  let px = x / s
  let pz = z / s
  if (y < 0) {
    const fx = (1 - Math.abs(pz)) * sign(px)
    const fz = (1 - Math.abs(px)) * sign(pz)
    px = fx
    pz = fz
  }
  return [(px + 1) / 2, (pz + 1) / 2]
}

/** Inverse of {@link octEncode}: octahedral coordinates in [0, 1]² back to a unit direction. */
export function octDecode(u: number, v: number, hemisphere: boolean): Vec3Tuple {
  let px: number
  let pz: number
  let y: number
  if (hemisphere) {
    const a = u * 2 - 1
    const b = v * 2 - 1
    px = (a + b) / 2
    pz = (a - b) / 2
    y = 1 - Math.abs(px) - Math.abs(pz)
  } else {
    px = u * 2 - 1
    pz = v * 2 - 1
    y = 1 - Math.abs(px) - Math.abs(pz)
    if (y < 0) {
      const fx = (1 - Math.abs(pz)) * sign(px)
      const fz = (1 - Math.abs(px)) * sign(pz)
      px = fx
      pz = fz
    }
  }
  const l = Math.hypot(px, y, pz) || 1
  return [px / l, y / l, pz / l]
}

/**
 * The view direction baked into frame `(i, j)` of a `frames × frames` atlas. Frames sit on grid points
 * `i / (frames - 1)`, so the outermost frames lie exactly on the horizon (hemisphere) or the bottom pole (sphere).
 */
export function frameDirection(i: number, j: number, frames: number, hemisphere: boolean): Vec3Tuple {
  const n = Math.max(2, frames) - 1
  return octDecode(i / n, j / n, hemisphere)
}

/** The frame `(i, j)` whose baked direction is closest to `(x, y, z)` in octahedral space. */
export function directionToFrame(x: number, y: number, z: number, frames: number, hemisphere: boolean): [i: number, j: number] {
  const n = Math.max(2, frames) - 1
  const [u, v] = octEncode(x, y, z, hemisphere)
  const clamp = (t: number) => Math.min(n, Math.max(0, Math.round(t * n)))
  return [clamp(u), clamp(v)]
}
