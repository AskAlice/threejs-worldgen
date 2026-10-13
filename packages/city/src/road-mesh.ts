import { ROAD_SURFACES, type RoadGraph, type RoadType } from './graph.ts'
import { MeshBuilder, type MeshData } from './mesh-builder.ts'
import type { Vec2 } from './polygon.ts'
import type { RoadProfile } from './terrain.ts'

/** Vertex attributes of road geometry. `road` = (half carriageway width, class, surface, part). */
export const ROAD_VERTEX = {
  /** Position relative to the settlement centre. */
  position: 3,
  /** Normal. */
  normal: 3,
  /** Metres across from the centreline (or up a vertical face), metres along the road. */
  uv: 2,
  /** Half carriageway width, class 0..2, surface 0..3, part. */
  road: 4,
} as const

/** Road part codes (`road.w`). */
export const ROAD_PARTS = {
  /** Driving surface (markings on asphalt). */
  carriageway: 0,
  /** Sidewalk top (paving slabs). */
  sidewalk: 1,
  /** Kerb faces and verges. */
  kerb: 2,
  /** Bridge decks, parapets and piers. */
  concrete: 3,
  /** Junction discs (no markings). */
  junction: 4,
} as const

const TYPE_INDEX: Record<RoadType, number> = { primary: 0, secondary: 1, minor: 2 }

/** Road geometry proportions. */
export interface RoadGeometryOptions {
  /** Kerb height (sidewalk above carriageway), metres. */
  kerbHeight: number
  /** Surface height above the graded centreline, metres. */
  offset: number
  /** Bridge deck thickness, metres. */
  deckThickness: number
  /** Distance between bridge piers, metres. */
  pierSpacing: number
}

type P3 = [number, number, number]

/**
 * Builds every road surface of a graph as one mesh, relative to `origin`: carriageways following
 * their graded profiles, raised sidewalks with kerbs where a road has them, a disc at each junction
 * and bend, and bridges as decks with parapets standing on piers down to `ground`.
 * `uv` = (metres across from the centreline, metres along the road), for markings and wear.
 */
export function roadGeometry(graph: RoadGraph, profiles: RoadProfile[], origin: Vec2, ground: (x: number, z: number) => number, o: RoadGeometryOptions): MeshData {
  const m = new MeshBuilder(ROAD_VERTEX)
  const [ox, oz] = origin
  const { nodes, edges } = graph
  const up: P3 = [0, 1, 0]

  // Junction radius per node: needed where roads meet at an angle or change size.
  const radius = new Float64Array(nodes.length)
  for (const n of nodes) {
    if (n.edges.length < 2) continue
    let r = 0, straight = n.edges.length === 2
    for (const e of n.edges) r = Math.max(r, edges[e].width / 2 + edges[e].sidewalk)
    if (straight) {
      const [e1, e2] = n.edges.map((e) => edges[e])
      const a = nodes[graph.other(e1.id, n.id)], b = nodes[graph.other(e2.id, n.id)]
      const d1x = a.x - n.x, d1z = a.z - n.z, d2x = b.x - n.x, d2z = b.z - n.z
      const cos = (d1x * d2x + d1z * d2z) / (Math.hypot(d1x, d1z) * Math.hypot(d2x, d2z) || 1)
      straight = cos < -0.985 && e1.width === e2.width && e1.sidewalk === e2.sidewalk && e1.surface === e2.surface && !e1.bridge && !e2.bridge
    }
    if (!straight) radius[n.id] = r
  }

  for (const e of edges) {
    const pts = profiles[e.id].points
    const a = nodes[e.a], b = nodes[e.b]
    const len = graph.length(e.id)
    const ta = radius[e.a] * 0.92, tb = radius[e.b] * 0.92
    if (ta + tb > len * 0.95) continue
    const ux = (b.x - a.x) / len, uz = (b.z - a.z) / len
    const lx = -uz, lz = ux // left
    // Stations along the edge between the trims.
    const st: { s: number; y: number }[] = []
    const yAt = (s: number) => {
      const f = (s / len) * (pts.length - 1)
      const i = Math.min(pts.length - 2, Math.floor(f))
      return pts[i][1] + (pts[i + 1][1] - pts[i][1]) * (f - i)
    }
    st.push({ s: ta, y: yAt(ta) })
    for (let i = 1; i < pts.length - 1; i++) {
      const s = (i / (pts.length - 1)) * len
      if (s > ta + 0.5 && s < len - tb - 0.5) st.push({ s, y: pts[i][1] })
    }
    st.push({ s: len - tb, y: yAt(len - tb) })

    const hw = e.width / 2, sw = e.sidewalk
    const kerb = sw > 0 ? o.kerbHeight : 0
    const ti = TYPE_INDEX[e.type], si = ROAD_SURFACES.indexOf(e.surface)
    // Cross-section faces: [lat0, dy0, lat1, dy1, normal side (0 = up, ±1 = facing ±left, 2 = down), part, surface].
    const faces: [number, number, number, number, number, number, number][] = [[-hw, 0, hw, 0, 0, ROAD_PARTS.carriageway, si]]
    const W = hw + sw
    for (const side of [-1, 1]) {
      if (sw > 0) {
        faces.push([side * hw, 0, side * hw, kerb, -side, ROAD_PARTS.kerb, 0])
        faces.push([side * hw, kerb, side * W, kerb, 0, ROAD_PARTS.sidewalk, 0])
      }
      const drop = e.bridge ? o.deckThickness : 0.4
      faces.push([side * W, kerb - drop, side * W, kerb, side, e.bridge ? ROAD_PARTS.concrete : ROAD_PARTS.kerb, 0])
      if (e.bridge) {
        const inner = side * (W - 0.3)
        faces.push([side * W, kerb, side * W, kerb + 1, side, ROAD_PARTS.concrete, 0])
        faces.push([inner, kerb, inner, kerb + 1, -side, ROAD_PARTS.concrete, 0])
        faces.push([inner, kerb + 1, side * W, kerb + 1, 0, ROAD_PARTS.concrete, 0])
      }
    }
    if (e.bridge) faces.push([-W, -o.deckThickness, W, -o.deckThickness, 2, ROAD_PARTS.concrete, 0])
    // One row of vertices per face per station, shared by the strips on both sides of it.
    for (const [l0, d0, l1, d1, facing, part, surf] of faces) {
      m.set('road', hw, ti, surf, part)
      const vertical = facing === 1 || facing === -1
      const rows: number[] = []
      for (let i = 0; i < st.length; i++) {
        const { s: sa, y } = st[i]
        const yy = y + o.offset
        // Horizontal faces tilt with the grade; vertical faces face sideways.
        if (vertical) m.set('normal', lx * facing, 0, lz * facing)
        else {
          const j = Math.min(st.length - 1, i + 1), k = Math.max(0, i - 1)
          const g = (st[j].y - st[k].y) / Math.max(1e-3, st[j].s - st[k].s)
          const sg = facing === 2 ? -1 : 1
          const l = Math.hypot(g, 1)
          m.set('normal', (-ux * g * sg) / l, sg / l, (-uz * g * sg) / l)
        }
        const u0 = vertical ? d0 : l0, u1 = vertical ? d1 : l1
        rows.push(m.vertex(a.x + ux * sa + lx * l0 - ox, yy + d0, a.z + uz * sa + lz * l0 - oz, u0, sa))
        m.vertex(a.x + ux * sa + lx * l1 - ox, yy + d1, a.z + uz * sa + lz * l1 - oz, u1, sa)
      }
      // Winding: (p0 at station i, p1 at station i, p0 at station i+1) must face the face's normal.
      const want: P3 = vertical ? [lx * facing, 0, lz * facing] : facing === 2 ? [0, -1, 0] : up
      const e1: P3 = [lx * (l1 - l0), d1 - d0, lz * (l1 - l0)], e2: P3 = [ux, 0, uz]
      const n: P3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
      const flip = n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0
      for (let i = 0; i < rows.length - 1; i++) {
        const p0 = rows[i], p1 = rows[i] + 1, q0 = rows[i + 1], q1 = rows[i + 1] + 1
        if (flip) m.triangle(p0, q0, p1).triangle(p1, q0, q1)
        else m.triangle(p0, p1, q0).triangle(p1, q1, q0)
      }
    }
    if (e.bridge) {
      // Piers between the banks.
      const n = Math.floor(len / o.pierSpacing)
      for (let i = 1; i <= n; i++) {
        const s = (i / (n + 1)) * len
        const y = yAt(s) + o.offset - o.deckThickness
        const cx = a.x + ux * s, cz = a.z + uz * s
        const g = ground(cx, cz) - 1
        if (y - g < 1) continue
        m.set('road', hw, TYPE_INDEX[e.type], 0, ROAD_PARTS.concrete)
        pier(m, cx - ox, cz - oz, ux, uz, 1.4, (hw + sw) * 1.2, g, y)
      }
    }
  }

  // Junction discs.
  for (const n of nodes) {
    const r = radius[n.id]
    if (r <= 0) continue
    let best = ROAD_SURFACES.length - 1, hw = 0, type = 2
    for (const e of n.edges) {
      best = Math.min(best, ROAD_SURFACES.indexOf(edges[e].surface))
      hw = Math.max(hw, edges[e].width / 2)
      type = Math.min(type, TYPE_INDEX[edges[e].type])
    }
    m.set('road', hw, type, best, ROAD_PARTS.junction)
    const y = n.y + o.offset + 0.01
    const k = 20
    m.set('normal', 0, 1, 0)
    const c = m.vertex(n.x - ox, y, n.z - oz, 0, 0)
    const ring: number[] = []
    for (let i = 0; i < k; i++) {
      const ang = (-i / k) * Math.PI * 2
      ring.push(m.vertex(n.x - ox + Math.cos(ang) * r, y, n.z - oz + Math.sin(ang) * r, Math.cos(ang) * r, Math.sin(ang) * r))
    }
    for (let i = 0; i < k; i++) m.triangle(c, ring[i], ring[(i + 1) % k])
  }
  return m.build()
}

function quad(m: MeshBuilder, p: P3[], uvs: number[], hint: P3) {
  const [a, b, , d] = p
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]]
  const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
  if (n[0] * hint[0] + n[1] * hint[1] + n[2] * hint[2] < 0) {
    m.quad([p[3], p[2], p[1], p[0]], [uvs[6], uvs[7], uvs[4], uvs[5], uvs[2], uvs[3], uvs[0], uvs[1]])
  } else m.quad(p, uvs)
}

function pier(m: MeshBuilder, cx: number, cz: number, ux: number, uz: number, along: number, across: number, y0: number, y1: number) {
  const lx = -uz, lz = ux
  const c = (s: number, t: number, y: number): P3 => [cx + ux * s * along / 2 + lx * t * across / 2, y, cz + uz * s * along / 2 + lz * t * across / 2]
  const sides: [number, number, number, number][] = [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]
  for (const [s0, t0, s1, t1] of sides) {
    const out: P3 = [ux * (s0 + s1) + lx * (t0 + t1), 0, uz * (s0 + s1) + lz * (t0 + t1)]
    quad(m, [c(s0, t0, y0), c(s1, t1, y0), c(s1, t1, y1), c(s0, t0, y1)], [0, 0, along, 0, along, y1 - y0, 0, y1 - y0], out)
  }
}
