import { mulberry32 } from 'threejs-scatter'
import type { LeafShape } from './species.ts'

/** RGBA8 pixels of a procedurally drawn leaf card; row 0 is the bottom (v = 0, where the card attaches). */
export interface LeafImage {
  /** RGBA, 4 bytes per pixel. RGB is a grey detail value (multiplied by the leaf colour), A is coverage. */
  data: Uint8Array
  /** Width and height in pixels. */
  size: number
}

/** Signed distance (negative inside) from p to a capsule a→b of radius r. */
function capsule(px: number, py: number, ax: number, ay: number, bx: number, by: number, r: number) {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(px - ax - dx * t, py - ay - dy * t) - r
}

interface Leaf { ox: number; oy: number; ax: number; ay: number; length: number; width: number; shade: number }

/**
 * Draws a leaf card for `shape` into an RGBA buffer, with no image files: shapes are evaluated as distance fields.
 * Alpha is a narrow ramp across each edge rather than a hard step, so mipmaps keep the 0.5 iso-line where the edge
 * is and alpha-tested foliage doesn't thin out with distance.
 */
export function drawLeafImage(shape: LeafShape, size = 256): LeafImage {
  const data = new Uint8Array(size * size * 4)
  const rand = mulberry32(0x1eaf + shape.length)
  const px = 1 / size
  const ramp = 1.5 * px
  const leaves: Leaf[] = []
  const strokes: { ax: number; ay: number; bx: number; by: number; r: number; shade: number }[] = []

  if (shape === 'broad') {
    strokes.push({ ax: 0.5, ay: 0, bx: 0.5, by: 0.74, r: 0.011, shade: 0.55 })
    for (let k = 0; k < 7; k++) {
      const side = k % 2 ? 1 : -1
      const angle = side * (0.95 - k * 0.06) + (rand() - 0.5) * 0.2
      const length = 0.36 - k * 0.018
      leaves.push({ ox: 0.5, oy: 0.07 + k * 0.095, ax: Math.sin(angle), ay: Math.cos(angle), length, width: length * 0.46, shade: 0.85 + rand() * 0.2 })
    }
    leaves.push({ ox: 0.5, oy: 0.72, ax: 0, ay: 1, length: 0.26, width: 0.12, shade: 1 })
  } else if (shape === 'needle') {
    // A dense spray: needles must stay several texels wide or mipmapping erases them.
    strokes.push({ ax: 0.5, ay: 0, bx: 0.5, by: 0.98, r: 0.014, shade: 0.5 })
    for (let k = 0; k < 34; k++) {
      const y = 0.02 + k * 0.028
      for (const side of [-1, 1]) {
        const angle = side * (0.55 + rand() * 0.45)
        const length = 0.42 * (1 - 0.5 * y) * (0.8 + rand() * 0.35)
        strokes.push({ ax: 0.5, ay: y, bx: 0.5 + Math.sin(angle) * length, by: y + Math.cos(angle) * length, r: 0.014, shade: 0.75 + rand() * 0.3 })
      }
    }
  } else if (shape === 'palm' || shape === 'fern') {
    const fern = shape === 'fern'
    strokes.push({ ax: 0.5, ay: 0, bx: 0.5, by: 1, r: 0.012, shade: 0.6 })
    const count = fern ? 26 : 36
    for (let k = 0; k < count; k++) {
      const y = 0.03 + (k / count) * 0.95
      const env = Math.pow(Math.sin(Math.PI * Math.min(1, y * (fern ? 1 : 0.92) + (fern ? 0 : 0.06))), fern ? 0.9 : 0.55)
      for (const side of [-1, 1]) {
        const reach = 0.47 * env * (0.9 + rand() * 0.1)
        if (reach < 0.03) continue
        const rise = fern ? 0.03 : 0.07
        if (fern) {
          leaves.push({ ox: 0.5, oy: y, ax: side * Math.cos(0.25), ay: Math.sin(0.25), length: reach, width: 0.045, shade: 0.85 + rand() * 0.2 })
        } else {
          strokes.push({ ax: 0.5, ay: y, bx: 0.5 + side * reach, by: y + rise, r: 0.011, shade: 0.8 + rand() * 0.25 })
        }
      }
    }
  }

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = (i + 0.5) * px
      const v = (j + 0.5) * px
      let d = Infinity
      let shade = 0.7
      if (shape === 'blade') {
        const half = 0.46 * Math.sqrt(Math.max(0, 1 - v * v)) * Math.pow(1 - v, 0.25)
        d = Math.max(Math.abs(u - 0.5) - half, -v)
        shade = 0.8 + 0.2 * (1 - Math.abs(u - 0.5) / Math.max(half, 1e-3)) - (Math.abs(u - 0.5) < 0.03 ? 0.1 : 0)
      }
      for (const s of strokes) {
        const sd = capsule(u, v, s.ax, s.ay, s.bx, s.by, s.r)
        if (sd < d) {
          d = sd
          const along = Math.hypot(u - s.ax, v - s.ay) / (Math.hypot(s.bx - s.ax, s.by - s.ay) || 1)
          shade = s.shade * (0.8 + 0.25 * Math.min(1, along))
        }
      }
      for (const l of leaves) {
        const rx = u - l.ox
        const ry = v - l.oy
        const y = rx * l.ax + ry * l.ay
        const x = rx * l.ay - ry * l.ax
        const t = y / l.length
        if (t < -0.1 || t > 1.1) continue
        const w = (l.width / 2) * Math.pow(Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, t)))), 0.7)
        // Fern pinnae get lobed edges.
        const lobes = shape === 'fern' ? 0.65 + 0.35 * Math.abs(Math.sin(t * 22)) : 1
        const ld = Math.max(Math.abs(x) - w * lobes, -y, y - l.length)
        if (ld < d) {
          d = ld
          const edge = Math.abs(x) / Math.max(w, 1e-4)
          // Lighter midrib, a little darker towards the edges, faint side veins.
          const midrib = Math.abs(x) < 0.006 ? 0.12 : 0
          const veins = shape === 'broad' ? 0.05 * Math.max(0, Math.cos((y - Math.abs(x) * 1.2) * 90)) : 0
          shade = l.shade * (0.78 + 0.22 * (1 - edge)) + midrib + veins
        }
      }
      const a = Math.max(0, Math.min(1, 0.5 - d / ramp))
      const o = (j * size + i) * 4
      const g = Math.max(0, Math.min(1, shade))
      data[o] = Math.round(g * 255)
      data[o + 1] = Math.round(g * 255)
      data[o + 2] = Math.round(g * 255)
      data[o + 3] = Math.round(a * 255)
    }
  }
  return { data, size }
}
