import type { Crop, Farm } from './farm.ts'
import { MeshBuilder, type MeshData } from './mesh-builder.ts'
import { clipPolygon, pointInPolygon, pointSegment, type Vec2 } from './polygon.ts'

/** Vertex attributes of field geometry. */
export const FIELD_VERTEX = {
  /** Position relative to the settlement centre. */
  position: 3,
  /** Ground normal. */
  normal: 3,
  /** Field colour (linear RGB). */
  tint: 3,
  /** Row direction x, z; row spacing (m); row stripe contrast (−1 = the gravel yard). */
  field: 4,
  /** Tramline spacing, metres (0 = none). */
  tram: 1,
  /** Distance to the field's edge, metres (headlands). */
  edge: 1,
} as const

/** How fields are drawn (from `FarmOptions`). */
export interface FieldLook {
  /** Row stripe contrast per crop. */
  rowContrast: Record<Crop, number>
  /** Tramline spacing per crop (0 = none). */
  tramlines: Record<Crop, number>
  /** Farmyard colour (`#rrggbb`). */
  yardColor: string
  /** Height above the ground, metres. */
  offset: number
  /** Grid step, metres. */
  step: number
}

/** `#rrggbb` → linear RGB. */
function linear(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  const c = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return [c(((n >> 16) & 255) / 255), c(((n >> 8) & 255) / 255), c((n & 255) / 255)]
}

/**
 * Ground-hugging geometry for a farm's fields and yard apron, relative to `origin`: each (convex) outline is cut by a
 * world-aligned grid of `step` metres, so the mesh follows the terrain (`ground`, in frame-local metres) and cells
 * of one field share their edges exactly. Rows, tramlines and colours go into vertex attributes for the field shader.
 */
export function fieldGeometry(farm: Farm, origin: Vec2, ground: (x: number, z: number) => number, look: FieldLook): MeshData {
  const m = new MeshBuilder(FIELD_VERTEX)
  const [ox, oz] = origin
  const g = Math.max(1, look.step)
  const add = (poly: Vec2[]) => {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
    for (const [x, z] of poly) { minX = Math.min(minX, x); minZ = Math.min(minZ, z); maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z) }
    for (let i = Math.floor(minX / g); i * g < maxX; i++) for (let j = Math.floor(minZ / g); j * g < maxZ; j++) {
      let piece: Vec2[] = [[i * g, j * g], [(i + 1) * g, j * g], [(i + 1) * g, (j + 1) * g], [i * g, (j + 1) * g]]
      if (!piece.every(([x, z]) => pointInPolygon(x, z, poly))) {
        // Clip the cell by each outline edge (outward normal: right of a counter-clockwise edge).
        for (let k = 0; k < poly.length && piece.length >= 3; k++) {
          const [ax, az] = poly[k], [bx, bz] = poly[(k + 1) % poly.length]
          piece = clipPolygon(piece, piece.map(() => 0), ax, az, bz - az, -(bx - ax), 0).polygon
        }
        if (piece.length < 3) continue
      }
      const first = m.count
      for (const [x, z] of piece) {
        const h = ground(x, z)
        const nx = (ground(x - 1, z) - ground(x + 1, z)) / 2, nz = (ground(x, z - 1) - ground(x, z + 1)) / 2, l = Math.hypot(nx, 1, nz)
        let edge = Infinity
        for (let k = 0; k < poly.length; k++) edge = Math.min(edge, pointSegment(x, z, ...poly[k], ...poly[(k + 1) % poly.length]).distance)
        m.set('normal', nx / l, 1 / l, nz / l).set('edge', edge)
        m.vertex(x - ox, h + look.offset, z - oz)
      }
      // Counter-clockwise in (x, z) is clockwise seen from above: fan the other way round so it faces up.
      for (let k = 1; k + 1 < piece.length; k++) m.triangle(first, first + k + 1, first + k)
    }
  }
  for (const f of farm.fields) {
    m.set('tint', ...linear(f.color)).set('field', f.rows[0], f.rows[1], f.rowSpacing, look.rowContrast[f.crop]).set('tram', look.tramlines[f.crop])
    add(f.polygon)
  }
  m.set('tint', ...linear(look.yardColor)).set('field', 1, 0, 0, -1).set('tram', 0) // contrast −1: gravel
  add(farm.apron)
  return m.build()
}
