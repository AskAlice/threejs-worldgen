/**
 * Small 2D polygon toolkit on the ground plane (x, z). Polygons are arrays of points; positive
 * {@link polygonArea} means counter-clockwise in (x, z) maths coordinates, which is the orientation
 * every block, lot and footprint in this package uses.
 */

/** A point on the ground plane: [x, z] in metres. */
export type Vec2 = [x: number, z: number]

/** Where two segments cross: parameters along each. */
export interface SegmentHit {
  /** Parameter along the first segment (0..1). */
  t: number
  /** Parameter along the second segment (0..1). */
  u: number
}

/** Closest point on a segment. */
export interface PointOnSegment {
  /** Distance to the segment. */
  distance: number
  /** Parameter of the closest point (0..1). */
  t: number
}

/** A polygon with one tag per edge (edge i = polygon[i] → polygon[i + 1]). */
export interface TaggedPolygon<T> {
  /** Outline. */
  polygon: Vec2[]
  /** One tag per edge. */
  tags: T[]
}

/** Signed area (shoelace). Positive = counter-clockwise in (x, z). */
export function polygonArea(p: readonly Vec2[]): number {
  let a = 0
  for (let i = 0, n = p.length; i < n; i++) {
    const [x0, z0] = p[i]
    const [x1, z1] = p[(i + 1) % n]
    a += x0 * z1 - x1 * z0
  }
  return a / 2
}

/** Area centroid (falls back to the vertex mean for degenerate polygons). */
export function polygonCentroid(p: readonly Vec2[]): Vec2 {
  let a = 0, cx = 0, cz = 0
  for (let i = 0, n = p.length; i < n; i++) {
    const [x0, z0] = p[i]
    const [x1, z1] = p[(i + 1) % n]
    const c = x0 * z1 - x1 * z0
    a += c; cx += (x0 + x1) * c; cz += (z0 + z1) * c
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sz = 0
    for (const [x, z] of p) { sx += x; sz += z }
    return [sx / p.length, sz / p.length]
  }
  return [cx / (3 * a), cz / (3 * a)]
}

/** Perimeter length. */
export function polygonPerimeter(p: readonly Vec2[]): number {
  let l = 0
  for (let i = 0, n = p.length; i < n; i++) l += Math.hypot(p[(i + 1) % n][0] - p[i][0], p[(i + 1) % n][1] - p[i][1])
  return l
}

/**
 * Intersection of segments a→b and c→d. Returns the parameters along each (`t` on a→b, `u` on c→d),
 * or `null` when they don't intersect (parallel segments never do here).
 */
export function segmentIntersection(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): SegmentHit | null {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz
  const den = rx * sz - rz * sx
  if (Math.abs(den) < 1e-12) return null
  const qx = cx - ax, qz = cz - az
  const t = (qx * sz - qz * sx) / den
  const u = (qx * rz - qz * rx) / den
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return { t, u }
}

/** Distance from point p to segment a→b, and the parameter `t` of the closest point. */
export function pointSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): PointOnSegment {
  const dx = bx - ax, dz = bz - az
  const len2 = dx * dx + dz * dz
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0
  return { distance: Math.hypot(px - (ax + dx * t), pz - (az + dz * t)), t }
}

/** True if segments a→b and c→d touch anywhere (crossing, overlap, or an endpoint within `eps` of the other). */
export function segmentsTouch(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number, eps = 1e-6): boolean {
  if (segmentIntersection(ax, az, bx, bz, cx, cz, dx, dz)) return true
  return pointSegment(cx, cz, ax, az, bx, bz).distance < eps || pointSegment(dx, dz, ax, az, bx, bz).distance < eps
    || pointSegment(ax, az, cx, cz, dx, dz).distance < eps || pointSegment(bx, bz, cx, cz, dx, dz).distance < eps
}

/** True if no two non-adjacent edges touch and no edge has zero length. */
export function isSimplePolygon(p: readonly Vec2[]): boolean {
  const n = p.length
  if (n < 3) return false
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n]
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) return false
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue
      const c = p[j], d = p[(j + 1) % n]
      if (segmentsTouch(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1])) return false
    }
  }
  return true
}

/** Even-odd point-in-polygon test. */
export function pointInPolygon(x: number, z: number, p: readonly Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, zi] = p[i], [xj, zj] = p[j]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

/**
 * Drops vertices where the outline barely turns (less than `angle` radians), and repeated points.
 * `tags` (one per edge, edge i = p[i]→p[i+1]) are kept in step; an edge merged into its predecessor
 * keeps the predecessor's tag, but only vertices between edges with equal tags are dropped.
 */
export function simplifyPolygon<T>(p: readonly Vec2[], tags: readonly T[], angle = 0.035): TaggedPolygon<T> {
  let pts = p.slice()
  let tg = tags.slice()
  for (let pass = 0; pass < 2; pass++) {
    const n = pts.length
    if (n <= 3) break
    const keep: boolean[] = []
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n]
      const d1x = b[0] - a[0], d1z = b[1] - a[1], d2x = c[0] - b[0], d2z = c[1] - b[1]
      const l1 = Math.hypot(d1x, d1z), l2 = Math.hypot(d2x, d2z)
      if (l1 < 1e-6) { keep.push(false); continue }
      const turn = l2 < 1e-6 ? 0 : Math.abs(Math.atan2(d1x * d2z - d1z * d2x, d1x * d2x + d1z * d2z))
      keep.push(!(turn < angle && tg[(i - 1 + n) % n] === tg[i]))
    }
    if (keep.filter(Boolean).length < 3) break
    const np: Vec2[] = [], nt: T[] = []
    for (let i = 0; i < n; i++) {
      if (!keep[i]) continue
      np.push(pts[i])
      nt.push(tg[i])
    }
    // An edge starting at a dropped vertex merged into the previous kept edge, which keeps its tag.
    pts = np; tg = nt
  }
  return { polygon: pts, tags: tg }
}

/**
 * Moves every edge of a counter-clockwise polygon inwards by its own distance (`d[i]` for edge
 * p[i]→p[i+1]) and joins the offset lines at their intersections. Edges that collapse (their offset
 * runs backwards) are removed and the neighbours re-joined, a cheap stand-in for a straight skeleton.
 * Returns `null` when nothing valid is left.
 * @param miterLimit Corners never move further than `miterLimit × distance` from the source corner.
 */
export function insetPolygon(p: readonly Vec2[], d: readonly number[] | number, miterLimit = 4): Vec2[] | null {
  if (p.length < 3) return null
  interface Line { px: number; pz: number; dx: number; dz: number; d: number; corner: Vec2; index: number }
  const lines: Line[] = []
  for (let i = 0, n = p.length; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n]
    const dx = b[0] - a[0], dz = b[1] - a[1]
    const l = Math.hypot(dx, dz)
    if (l < 1e-6) continue
    const ux = dx / l, uz = dz / l
    const di = typeof d === 'number' ? d : d[i]
    // Inward normal of a counter-clockwise polygon is (−uz, ux).
    lines.push({ px: a[0] - uz * di, pz: a[1] + ux * di, dx: ux, dz: uz, d: di, corner: a, index: i })
  }
  for (let guard = 0; guard < p.length && lines.length >= 3; guard++) {
    const n = lines.length
    const out: Vec2[] = []
    for (let i = 0; i < n; i++) {
      const l0 = lines[(i - 1 + n) % n], l1 = lines[i]
      const den = l0.dx * l1.dz - l0.dz * l1.dx
      const c = l1.corner
      let x: number, z: number
      if (Math.abs(den) < 1e-9) {
        x = l1.px; z = l1.pz
      } else {
        const t = ((l1.px - l0.px) * l1.dz - (l1.pz - l0.pz) * l1.dx) / den
        x = l0.px + l0.dx * t; z = l0.pz + l0.dz * t
      }
      const reach = Math.max(l0.d, l1.d, 1e-3) * miterLimit
      const dist = Math.hypot(x - c[0], z - c[1])
      if (dist > reach && Math.abs(den) >= 1e-9 && (l0.index + 1) % p.length === l1.index) {
        x = c[0] + ((x - c[0]) * reach) / dist
        z = c[1] + ((z - c[1]) * reach) / dist
      }
      out.push([x, z])
    }
    // An edge whose offset runs backwards has collapsed: drop it and join its neighbours instead.
    let worst = -1, worstDot = 0
    for (let i = 0; i < n; i++) {
      const a = out[i], b = out[(i + 1) % n]
      const dot = (b[0] - a[0]) * lines[i].dx + (b[1] - a[1]) * lines[i].dz
      if (dot < worstDot) { worstDot = dot; worst = i }
    }
    if (worst < 0) {
      if (polygonArea(out) <= 1e-6 || !isSimplePolygon(out)) return null
      return out
    }
    // The neighbours now meet where the dropped edge used to be.
    lines.splice(worst, 1)
  }
  return null
}

/** An oriented rectangle: centre, unit long axis, and half extents along the long and short axes. */
export interface OrientedBox {
  /** Centre. */
  center: Vec2
  /** Unit vector along the long side. */
  axis: Vec2
  /** Half length along `axis`. */
  halfLength: number
  /** Half width across `axis`. */
  halfWidth: number
}

/** Minimum-area oriented bounding box, trying each polygon edge direction (exact for convex hulls). */
export function orientedBox(p: readonly Vec2[]): OrientedBox {
  let best: OrientedBox | null = null
  let bestArea = Infinity
  for (let i = 0, n = p.length; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n]
    const l = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (l < 1e-6) continue
    const ux = (b[0] - a[0]) / l, uz = (b[1] - a[1]) / l
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
    for (const [x, z] of p) {
      const u = x * ux + z * uz, v = -x * uz + z * ux
      if (u < minU) minU = u
      if (u > maxU) maxU = u
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }
    const area = (maxU - minU) * (maxV - minV)
    if (area < bestArea - 1e-9) {
      bestArea = area
      const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2
      const center: Vec2 = [cu * ux - cv * uz, cu * uz + cv * ux]
      const hu = (maxU - minU) / 2, hv = (maxV - minV) / 2
      best = hu >= hv
        ? { center, axis: [ux, uz], halfLength: hu, halfWidth: hv }
        : { center, axis: [-uz, ux], halfLength: hv, halfWidth: hu }
    }
  }
  return best ?? { center: p[0] ?? [0, 0], axis: [1, 0], halfLength: 0, halfWidth: 0 }
}

/** The four corners of an oriented box, counter-clockwise, starting at (−length, −width). */
export function boxCorners(b: OrientedBox, scale = 1): Vec2[] {
  const [cx, cz] = b.center, [ux, uz] = b.axis
  const hl = b.halfLength * scale, hw = b.halfWidth * scale
  const vx = -uz, vz = ux
  return [
    [cx - ux * hl - vx * hw, cz - uz * hl - vz * hw],
    [cx + ux * hl - vx * hw, cz + uz * hl - vz * hw],
    [cx + ux * hl + vx * hw, cz + uz * hl + vz * hw],
    [cx - ux * hl + vx * hw, cz - uz * hl + vz * hw],
  ]
}

/**
 * Keeps the part of polygon `p` on the side of the line through `(px, pz)` that `(nx, nz)` points
 * away from (Sutherland–Hodgman). `tags` (one per edge) follow their edges; edges created along the
 * cut line get `cutTag`.
 */
export function clipPolygon<T>(p: readonly Vec2[], tags: readonly T[], px: number, pz: number, nx: number, nz: number, cutTag: T): TaggedPolygon<T> {
  const out: Vec2[] = [], outTags: T[] = []
  const n = p.length
  const side = (q: Vec2) => (q[0] - px) * nx + (q[1] - pz) * nz
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n]
    const sa = side(a), sb = side(b)
    const ina = sa <= 0, inb = sb <= 0
    if (ina) {
      out.push(a)
      if (inb) outTags.push(tags[i])
      else {
        // Leaving: the piece of edge i up to the cut, then a cut edge.
        outTags.push(tags[i])
        const t = sa / (sa - sb)
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
        outTags.push(cutTag)
      }
    } else if (inb) {
      // Entering: the crossing point starts the rest of edge i.
      const t = sa / (sa - sb)
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
      outTags.push(tags[i])
    }
  }
  // A vertex exactly on the cut line is emitted twice; drop the zero-length edges that leaves.
  for (let i = out.length - 1; i >= 0 && out.length > 0; i--) {
    const a = out[i], b = out[(i + 1) % out.length]
    if (out.length > 1 && Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) { out.splice(i, 1); outTags.splice(i, 1) }
  }
  return { polygon: out, tags: outTags }
}
