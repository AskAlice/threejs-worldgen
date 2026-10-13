import type { RoadGraph } from './graph.ts'
import { clipPolygon, isSimplePolygon, orientedBox, pointInPolygon, polygonArea, polygonCentroid, segmentIntersection, type Vec2 } from './polygon.ts'

/** A parcel of land inside a block. */
export interface Lot {
  /** Index in the lot list. */
  id: number
  /** Block it belongs to (−1 for roadside lots outside any block). */
  block: number
  /** Outline, counter-clockwise. */
  polygon: Vec2[]
  /** Per edge (edge i = polygon[i]→polygon[i+1]): true if it faces a street. */
  street: boolean[]
  /** Index of the longest street-facing edge, or −1 for an interior lot (no street access). */
  front: number
  /** Area, m². */
  area: number
  /** Area centroid. */
  center: Vec2
}

/** Lot splitting targets (per district). */
export interface LotTarget {
  /** Target lot area, m². Pieces at most 1.5× this stop splitting. */
  area: number
  /** Narrowest acceptable lot, metres. Thinner pieces are dropped as slivers. */
  width: number
}

/**
 * Splits a block polygon into lots by recursive oriented-bounding-box subdivision (Vanegas et al.
 * 2012): cut across the long axis of each piece's minimum box near its middle, preferring cuts that
 * leave both halves with street frontage, until pieces reach the target area. Slivers (thinner than
 * half the target width, or tiny) are dropped, so lot areas always sum to at most the block area.
 * @param polygon Block outline, counter-clockwise; every edge is treated as street frontage.
 * @param target Lot size, fixed or looked up at each piece's centroid (so districts can change mid-block).
 * @param rand Random numbers in [0, 1) (for split jitter).
 * @param jitter 0 = always cut in the middle, 1 = anywhere between 25 % and 75 %.
 */
export function subdivideBlock(polygon: Vec2[], target: LotTarget | ((x: number, z: number) => LotTarget), rand: () => number, jitter = 0.35, block = 0, firstId = 0): Lot[] {
  const lots: Lot[] = []
  const stack: { polygon: Vec2[]; street: boolean[]; depth: number }[] = [{ polygon, street: polygon.map(() => true), depth: 0 }]
  while (stack.length) {
    const piece = stack.pop()!
    const area = polygonArea(piece.polygon)
    const center = polygonCentroid(piece.polygon)
    const t = typeof target === 'function' ? target(center[0], center[1]) : target
    if (area < Math.max(8, t.width * t.width * 0.35)) continue
    const box = orientedBox(piece.polygon)
    // Too thin to be useful, even before splitting: a sliver.
    if (box.halfWidth * 2 < t.width * 0.5) continue
    const done = area <= t.area * 1.5 || box.halfLength < t.width || piece.depth > 24
    if (done) {
      if (!isSimplePolygon(piece.polygon)) continue
      let front = -1, best = 0
      piece.polygon.forEach((p, i) => {
        if (!piece.street[i]) return
        const q = piece.polygon[(i + 1) % piece.polygon.length]
        const l = Math.hypot(q[0] - p[0], q[1] - p[1])
        if (l > best) { best = l; front = i }
      })
      lots.push({ id: firstId + lots.length, block, polygon: piece.polygon, street: piece.street, front, area, center })
      continue
    }
    const f = 0.5 + (rand() - 0.5) * jitter
    const split = (ax: number, az: number, half: number) => {
      const px = box.center[0] + ax * (f - 0.5) * 2 * half, pz = box.center[1] + az * (f - 0.5) * 2 * half
      const a = clipPolygon(piece.polygon, piece.street, px, pz, ax, az, false)
      const b = clipPolygon(piece.polygon, piece.street, px, pz, -ax, -az, false)
      return [a, b]
    }
    // Cut across the long axis; if that strands a half without street access, try the short axis,
    // and failing that keep a not-too-big piece whole (a deep lot beats one with no way in).
    let halves = split(box.axis[0], box.axis[1], box.halfLength)
    const hasStreet = piece.street.some(Boolean)
    if (hasStreet && halves.some((h) => !h.tags.some(Boolean))) {
      const alt = box.halfWidth >= t.width ? split(-box.axis[1], box.axis[0], box.halfWidth) : null
      if (alt && alt.every((h) => h.tags.some(Boolean))) halves = alt
      else if (area <= t.area * 3) halves = [{ polygon: piece.polygon, tags: piece.street }]
    }
    if (halves.length === 1) {
      stack.push({ polygon: piece.polygon, street: piece.street, depth: 99 })
      continue
    }
    for (const h of halves) if (h.polygon.length >= 3) stack.push({ polygon: h.polygon, street: h.tags, depth: piece.depth + 1 })
  }
  return lots
}

/** Rules for {@link roadsideLots}. */
export interface RoadsideOptions {
  /** Grow lots along roads whose sides aren't inside a block (villages, outskirts, farm roads). */
  enabled: boolean
  /** Lots keep this far from junctions and dead ends (not from bends), metres. */
  junctionClearance: number
  /** Gap between the sidewalk (or verge) and the lot, metres. */
  margin: number
  /** Lot depth as a multiple of its width. */
  depth: number
}

/** Default roadside lot rules. */
export const DEFAULT_ROADSIDE: RoadsideOptions = { enabled: true, junctionClearance: 10, margin: 0.5, depth: 2 }

/**
 * Rectangular lots lined up along both sides of every road where that side is open ground (not
 * inside a block): linear villages, ribbon development and farmsteads. Each candidate must stay
 * clear of blocks, other roads, water (`blocked`) and earlier roadside lots.
 * @param target Lot size at a point (by district); `null` = no lots there (e.g. parks).
 * @param blocked True where a lot may not go (in a block, crossing a road, under water, too far out).
 */
export function roadsideLots(graph: RoadGraph, target: (x: number, z: number) => LotTarget | null, blocked: (lot: Lot) => boolean, o: RoadsideOptions = DEFAULT_ROADSIDE): Lot[] {
  const lots: Lot[] = []
  if (!o.enabled) return lots
  const cell = 40
  const grid = new Map<string, number[]>()
  const cellsOf = (p: Vec2[]) => {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
    for (const [x, z] of p) { minX = Math.min(minX, x); minZ = Math.min(minZ, z); maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z) }
    const keys: string[] = []
    for (let i = Math.floor(minX / cell); i <= Math.floor(maxX / cell); i++) for (let j = Math.floor(minZ / cell); j <= Math.floor(maxZ / cell); j++) keys.push(i + ',' + j)
    return keys
  }
  const overlaps = (p: Vec2[]) => {
    for (const k of cellsOf(p)) for (const id of grid.get(k) ?? []) if (polygonsOverlap(p, lots[id].polygon)) return true
    return false
  }
  for (const e of graph.edges) {
    if (e.bridge) continue
    const a = graph.nodes[e.a], b = graph.nodes[e.b]
    const L = Math.hypot(b.x - a.x, b.z - a.z)
    const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L
    const nx = -uz, nz = ux
    const off = e.width / 2 + e.sidewalk + o.margin
    for (const s of [1, -1]) {
      const mx = (a.x + b.x) / 2 + nx * s * (off + 10), mz = (a.z + b.z) / 2 + nz * s * (off + 10)
      const t = target(mx, mz)
      if (!t) continue
      const w0 = Math.max(t.width, Math.sqrt(t.area / o.depth))
      const d = Math.min(t.area / w0, w0 * o.depth * 1.5)
      // Clearance only at real junctions and dead ends; bends (two roads) need none.
      const ca = a.edges.length === 2 ? 0 : o.junctionClearance, cb = b.edges.length === 2 ? 0 : o.junctionClearance
      const usable = L - ca - cb
      const n = Math.round(usable / w0)
      if (n < 1 || usable / n < t.width * 0.75) continue
      const w = usable / n
      const start = ca
      for (let i = 0; i < n; i++) {
        const s0 = start + i * w, s1 = s0 + w
        const p0: Vec2 = [a.x + ux * s0 + nx * s * off, a.z + uz * s0 + nz * s * off]
        const p1: Vec2 = [a.x + ux * s1 + nx * s * off, a.z + uz * s1 + nz * s * off]
        const p2: Vec2 = [p1[0] + nx * s * d, p1[1] + nz * s * d]
        const p3: Vec2 = [p0[0] + nx * s * d, p0[1] + nz * s * d]
        const polygon = s > 0 ? [p0, p1, p2, p3] : [p1, p0, p3, p2]
        const lot: Lot = { id: lots.length, block: -1, polygon, street: [true, false, false, false], front: 0, area: w * d, center: polygonCentroid(polygon) }
        if (blocked(lot) || overlaps(polygon)) continue
        for (const k of cellsOf(polygon)) {
          const list = grid.get(k)
          if (list) list.push(lot.id)
          else grid.set(k, [lot.id])
        }
        lots.push(lot)
      }
    }
  }
  return lots
}

/** True if two simple polygons overlap (an edge crosses, or one contains a vertex of the other). */
export function polygonsOverlap(p: Vec2[], q: Vec2[]): boolean {
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length]
    for (let j = 0; j < q.length; j++) {
      const c = q[j], d = q[(j + 1) % q.length]
      if (segmentIntersection(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1])) return true
    }
  }
  return pointInPolygon(p[0][0], p[0][1], q) || pointInPolygon(q[0][0], q[0][1], p)
}
