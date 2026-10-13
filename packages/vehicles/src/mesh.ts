/**
 * A small typed-array mesh builder for vehicles: flat-shaded primitives for hard-edged parts, and smooth
 * (shared-normal) lofted surfaces, lathes and rounded boxes for bodywork. Every face carries a colour
 * and a style: `paint` (1 = takes the per-instance tint, 0 = keeps its own colour), `glow` (lit at night:
 * headlights, windows) and a `finish` (plain, glass, chrome, brushed steel, rubber). Faces are oriented
 * away from a given inside point, so winding never needs care.
 */

/** A 3D point or vector. */
export type Vec3 = [x: number, y: number, z: number]
/** Linear RGB, 0…1. */
export type RGB = [r: number, g: number, b: number]

/** What a face looks like. */
export interface Paint {
  /** Linear RGB. */
  color: RGB
  /** 1 = replaced by the instance tint (body paint), 0 = own colour (glass, tyres, trim). */
  paint: number
  /** Night glow 0…1 (headlights 1, lit windows ~0.3). */
  glow: number
  /** Surface finish (see {@link FINISH}); default plain. */
  finish?: number
}

/**
 * Surface finishes the vehicle material knows: `plain` (painted surfaces get clear coat), `glass`
 * (smooth, reflective), `chrome` (polished metal), `brushed` (anisotropic stainless steel, brushed
 * along the vehicle's length) and `rubber` (matte).
 */
export const FINISH = { plain: 0, glass: 1, chrome: 2, brushed: 3, rubber: 4 } as const

/** Plain mesh data: everything a `BufferGeometry` needs, as typed arrays. */
export interface MeshData {
  /** xyz per vertex. */
  position: Float32Array
  /** Unit normal per vertex (flat shaded). */
  normal: Float32Array
  /** Linear RGB per vertex. */
  color: Float32Array
  /** (paint, glow, finish) per vertex. */
  style: Float32Array
  /** Triangle indices. */
  index: Uint32Array
  /** [minX, minY, minZ, maxX, maxY, maxZ]. */
  bounds: [number, number, number, number, number, number]
}

/** sRGB `#rrggbb` → linear RGB. */
export function rgb(hex: string): RGB {
  const v = parseInt(hex.replace('#', ''), 16)
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return [lin(((v >> 16) & 255) / 255), lin(((v >> 8) & 255) / 255), lin((v & 255) / 255)]
}

/** A {@link Paint} from a hex colour. */
export function paint(hex: string, paintAmount = 0, glow = 0, finish = 0): Paint {
  return { color: rgb(hex), paint: paintAmount, glow, finish }
}

/** `sign(v) · |v|^p`: superellipse coordinates. */
export const sgnpow = (v: number, p: number): number => Math.sign(v) * Math.abs(v) ** p

/** One cross-section of a {@link MeshBuilder.loft}. */
export interface Section {
  /** Position along the hull (z), metres. */
  z: number
  /** Half width. */
  w: number
  /** Top height. */
  top: number
  /** Bottom height. */
  bottom: number
  /** 0 = boxy … 1 = elliptical. */
  round: number
  /** 0 = flat bottom … 1 = V-shaped keel. */
  keel?: number
}

type Axis = 'x' | 'y' | 'z'

// Maps local (a, b, c) with c along the axis to world, keeping handedness (cyclic permutations).
function axisPoint(axis: Axis, a: number, b: number, c: number, o: Vec3): Vec3 {
  if (axis === 'x') return [o[0] + c, o[1] + a, o[2] + b]
  if (axis === 'y') return [o[0] + b, o[1] + c, o[2] + a]
  return [o[0] + a, o[1] + b, o[2] + c]
}

/** Builds flat-shaded low-poly meshes into typed arrays. */
export class MeshBuilder {
  private pos: number[] = []
  private nor: number[] = []
  private col: number[] = []
  private sty: number[] = []
  private idx: number[] = []
  // Current transform as a 3×4 row-major matrix (rotation | translation).
  private m: number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]

  /** Runs `fn` with everything it adds rotated (Euler YXZ, radians) and then offset. */
  group(offset: Vec3, rotation: Vec3, fn: () => void): this {
    const prev = this.m
    const [rx, ry, rz] = rotation
    const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz)
    // R = Ry · Rx · Rz
    const r = [
      cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx,
      cx * sz, cx * cz, -sx,
      -sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx,
    ]
    const local = [r[0], r[1], r[2], offset[0], r[3], r[4], r[5], offset[1], r[6], r[7], r[8], offset[2]]
    const out = new Array<number>(12)
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 4; j++) {
        out[i * 4 + j] = prev[i * 4] * local[j] + prev[i * 4 + 1] * local[4 + j] + prev[i * 4 + 2] * local[8 + j] + (j === 3 ? prev[i * 4 + 3] : 0)
      }
    }
    this.m = out
    fn()
    this.m = prev
    return this
  }

  private xf(p: Vec3): Vec3 {
    const m = this.m
    return [
      m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
      m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
      m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
    ]
  }

  /**
   * Adds a planar convex polygon (fan-triangulated, flat normal). With `inside`, the face is turned to
   * point away from that point.
   */
  face(points: Vec3[], s: Paint, inside?: Vec3): this {
    let pts = points.map((p) => this.xf(p)).filter((p, i, a) => i === 0 || dist2(p, a[i - 1]) > 1e-12)
    if (pts.length > 2 && dist2(pts[0], pts[pts.length - 1]) <= 1e-12) pts.pop()
    if (pts.length < 3) return this
    // Newell's method: robust for any polygon.
    let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length]
      nx += (a[1] - b[1]) * (a[2] + b[2])
      ny += (a[2] - b[2]) * (a[0] + b[0])
      nz += (a[0] - b[0]) * (a[1] + b[1])
      cx += a[0]; cy += a[1]; cz += a[2]
    }
    const len = Math.hypot(nx, ny, nz)
    if (len < 1e-10) return this
    nx /= len; ny /= len; nz /= len
    if (inside) {
      const q = this.xf(inside)
      const k = pts.length
      if (nx * (cx / k - q[0]) + ny * (cy / k - q[1]) + nz * (cz / k - q[2]) < 0) {
        pts = pts.reverse()
        nx = -nx; ny = -ny; nz = -nz
      }
    }
    const base = this.pos.length / 3
    for (const p of pts) {
      this.pos.push(p[0], p[1], p[2])
      this.nor.push(nx, ny, nz)
      this.col.push(s.color[0], s.color[1], s.color[2])
      this.sty.push(s.paint, s.glow, s.finish ?? 0)
    }
    for (let i = 1; i < pts.length - 1; i++) this.idx.push(base, base + i, base + i + 1)
    return this
  }

  /**
   * An axis-aligned box centred at `c` with full `size`. `taper` scales the top face's x and z half
   * sizes; `shift` moves the top face along z (raked windscreens, sloped bows).
   */
  box(c: Vec3, size: Vec3, s: Paint, taper: [x: number, z: number] = [1, 1], shift = 0): this {
    const hx = size[0] / 2, hy = size[1] / 2, hz = size[2] / 2
    const tx = hx * taper[0], tz = hz * taper[1]
    const y0 = c[1] - hy, y1 = c[1] + hy
    const b: Vec3[] = [[c[0] - hx, y0, c[2] - hz], [c[0] + hx, y0, c[2] - hz], [c[0] + hx, y0, c[2] + hz], [c[0] - hx, y0, c[2] + hz]]
    const t: Vec3[] = [[c[0] - tx, y1, c[2] - tz + shift], [c[0] + tx, y1, c[2] - tz + shift], [c[0] + tx, y1, c[2] + tz + shift], [c[0] - tx, y1, c[2] + tz + shift]]
    const inside: Vec3 = [c[0], c[1], c[2] + shift / 2]
    this.face([t[0], t[3], t[2], t[1]], s, inside)
    this.face([b[0], b[1], b[2], b[3]], s, inside)
    this.face([b[3], b[2], t[2], t[3]], s, inside)
    this.face([b[1], b[0], t[0], t[1]], s, inside)
    this.face([b[2], b[1], t[1], t[2]], s, inside)
    this.face([b[0], b[3], t[3], t[0]], s, inside)
    return this
  }

  /** A cylinder (or cone/frustum with `radius2`) along an axis, centred at `c`. */
  cylinder(axis: Axis, c: Vec3, radius: number, length: number, s: Paint, segments = 10, radius2 = radius, caps: Paint | null = s): this {
    const r0: Vec3[] = [], r1: Vec3[] = []
    for (let k = 0; k < segments; k++) {
      const a = (k / segments) * Math.PI * 2
      r0.push(axisPoint(axis, Math.cos(a) * radius, Math.sin(a) * radius, -length / 2, c))
      r1.push(axisPoint(axis, Math.cos(a) * radius2, Math.sin(a) * radius2, length / 2, c))
    }
    for (let k = 0; k < segments; k++) {
      const n = (k + 1) % segments
      // Inside point on the axis at this face's height keeps cones oriented right.
      this.face([r0[k], r0[n], r1[n], r1[k]], s, c)
    }
    if (caps) {
      if (radius > 1e-6) this.face([...r0].reverse(), caps, c)
      if (radius2 > 1e-6) this.face(r1, caps, c)
    }
    return this
  }

  /** A hollow tube (duct, ring) along an axis. */
  tube(axis: Axis, c: Vec3, outer: number, inner: number, length: number, s: Paint, segments = 12): this {
    const p = (r: number, a: number, h: number) => axisPoint(axis, Math.cos(a) * r, Math.sin(a) * r, h, c)
    for (let k = 0; k < segments; k++) {
      const a0 = (k / segments) * Math.PI * 2, a1 = ((k + 1) / segments) * Math.PI * 2
      const h = length / 2
      const mid = (a0 + a1) / 2
      // Outer wall faces out, inner wall faces in (towards the axis), rims face along the axis.
      this.face([p(outer, a0, -h), p(outer, a1, -h), p(outer, a1, h), p(outer, a0, h)], s, axisPoint(axis, 0, 0, 0, c))
      this.face([p(inner, a0, -h), p(inner, a1, -h), p(inner, a1, h), p(inner, a0, h)], s, p(inner * 2 + outer, mid, 0))
      this.face([p(inner, a0, h), p(outer, a0, h), p(outer, a1, h), p(inner, a1, h)], s, p((inner + outer) / 2, mid, 0))
      this.face([p(inner, a0, -h), p(outer, a0, -h), p(outer, a1, -h), p(inner, a1, -h)], s, p((inner + outer) / 2, mid, 0))
    }
    return this
  }

  /** A low-poly ellipsoid (`top` = upper half only: canopies, domes). */
  ellipsoid(c: Vec3, radii: Vec3, s: Paint, segU = 10, segV = 6, top = false): this {
    const v0 = top ? 0 : -Math.PI / 2
    const pt = (u: number, v: number): Vec3 => [c[0] + radii[0] * Math.cos(v) * Math.cos(u), c[1] + radii[1] * Math.sin(v), c[2] + radii[2] * Math.cos(v) * Math.sin(u)]
    for (let j = 0; j < segV; j++) {
      const va = v0 + ((Math.PI / 2 - v0) * j) / segV, vb = v0 + ((Math.PI / 2 - v0) * (j + 1)) / segV
      for (let i = 0; i < segU; i++) {
        const ua = (i / segU) * Math.PI * 2, ub = ((i + 1) / segU) * Math.PI * 2
        this.face([pt(ua, va), pt(ub, va), pt(ub, vb), pt(ua, vb)], s, c)
      }
    }
    if (top) {
      const ring: Vec3[] = []
      for (let i = 0; i < segU; i++) ring.push(pt((i / segU) * Math.PI * 2, 0))
      this.face(ring, s, [c[0], c[1] + radii[1], c[2]])
    }
    return this
  }

  /**
   * A hull lofted through cross-sections along z (fuselages, boat hulls, train cars). Faces whose centre
   * lies below `split.y` use `split.paint` (antifouling under the waterline, a belly colour).
   */
  loft(sections: Section[], s: Paint, segments = 12, split?: { y: number; paint: Paint }): this {
    const rings = sections.map((sec) => {
      const ring: Vec3[] = []
      const p = 0.2 + 0.8 * sec.round
      const mid = (sec.top + sec.bottom) / 2, hh = (sec.top - sec.bottom) / 2
      for (let k = 0; k < segments; k++) {
        const a = (k / segments) * Math.PI * 2
        const c = Math.cos(a), sn = Math.sin(a)
        let x = sec.w * Math.sign(c) * Math.abs(c) ** p
        const y = mid + hh * Math.sign(sn) * Math.abs(sn) ** p
        if (sn < 0 && sec.keel) x *= 1 - sec.keel * -sn
        ring.push([x, y, sec.z])
      }
      return ring
    })
    const pick = (pts: Vec3[]) => (split && pts.reduce((a, q) => a + q[1], 0) / pts.length < split.y ? split.paint : s)
    for (let i = 0; i < rings.length - 1; i++) {
      const a = sections[i], b = sections[i + 1]
      const inside: Vec3 = [0, (a.top + a.bottom + b.top + b.bottom) / 4, (a.z + b.z) / 2]
      for (let k = 0; k < segments; k++) {
        const n = (k + 1) % segments
        const quad = [rings[i][k], rings[i][n], rings[i + 1][n], rings[i + 1][k]]
        this.face(quad, pick(quad), inside)
      }
    }
    for (const [i, dir] of [[0, 1], [rings.length - 1, -1]] as const) {
      const sec = sections[i]
      if (sec.w < 1e-4 || sec.top - sec.bottom < 1e-4) continue
      const inside: Vec3 = [0, (sec.top + sec.bottom) / 2, sec.z + dir]
      this.face(rings[i], pick(rings[i]), inside)
    }
    return this
  }

  /**
   * A flat convex outline (`[u, v]` points) in the plane through `origin` spanned by `u` and `v`,
   * extruded by `thickness` (wings, tail fins, rudders, blades).
   */
  fin(outline: [number, number][], origin: Vec3, u: Vec3, v: Vec3, thickness: number, s: Paint): this {
    const n: Vec3 = normalize(cross(u, v))
    const at = (p: [number, number], side: number): Vec3 => [
      origin[0] + u[0] * p[0] + v[0] * p[1] + n[0] * side * thickness / 2,
      origin[1] + u[1] * p[0] + v[1] * p[1] + n[1] * side * thickness / 2,
      origin[2] + u[2] * p[0] + v[2] * p[1] + n[2] * side * thickness / 2,
    ]
    const cu = outline.reduce((a, p) => a + p[0], 0) / outline.length, cv = outline.reduce((a, p) => a + p[1], 0) / outline.length
    const centre = at([cu, cv], 0)
    this.face(outline.map((p) => at(p, 1)), s, centre)
    this.face(outline.map((p) => at(p, -1)), s, centre)
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i], b = outline[(i + 1) % outline.length]
      this.face([at(a, -1), at(b, -1), at(b, 1), at(a, 1)], s, centre)
    }
    return this
  }

  /** A square-section beam from `a` to `b` (frames, masts, struts, legs). */
  beam(a: Vec3, b: Vec3, width: number, s: Paint): this {
    const d = normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]])
    const ref: Vec3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    const u = normalize(cross(d, ref)), v = cross(d, u)
    const h = width / 2
    const corner = (p: Vec3, su: number, sv: number): Vec3 => [p[0] + (u[0] * su + v[0] * sv) * h, p[1] + (u[1] * su + v[1] * sv) * h, p[2] + (u[2] * su + v[2] * sv) * h]
    const signs: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
    const ca = signs.map(([x, y]) => corner(a, x, y)), cb = signs.map(([x, y]) => corner(b, x, y))
    const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
    for (let i = 0; i < 4; i++) this.face([ca[i], ca[(i + 1) % 4], cb[(i + 1) % 4], cb[i]], s, mid)
    this.face(ca, s, mid)
    this.face(cb, s, mid)
    return this
  }

  /**
   * A smooth-shaded surface through a grid of points: `rows[i][j]`, rows along the length, points around
   * (`closed`: each row is a ring). Normals are averaged over the grid, so curved bodywork shows no
   * facets; `paintOf(i, j)` colours the cell between rows i, i+1 and points j, j+1 (colour edges stay
   * crisp). Faces are turned outwards (away from each row's centre); `caps` closes the first and last
   * ring with flat faces.
   */
  surface(rows: Vec3[][], paintOf: (i: number, j: number) => Paint, closed = true, caps: [Paint | null, Paint | null] = [null, null]): this {
    const nr = rows.length, nc = rows[0]?.length ?? 0
    if (nr < 2 || nc < 2) return this
    const P = rows.map((row) => row.map((p) => this.xf(p)))
    const cells = closed ? nc : nc - 1
    // Area-weighted face normal per cell; vertex normals average the cells round a vertex that meet the
    // cell within the crease angle, so curved panels are smooth and sharp edges (arch lips) stay crisp.
    const F = new Float64Array((nr - 1) * cells * 3), U = new Float64Array((nr - 1) * cells * 3)
    const centre = P.map((row) => row.reduce((a, p) => [a[0] + p[0] / nc, a[1] + p[1] / nc, a[2] + p[2] / nc], [0, 0, 0]))
    let out = 0
    for (let i = 0; i < nr - 1; i++) for (let j = 0; j < cells; j++) {
      const j1 = (j + 1) % nc
      const a = P[i][j], b = P[i + 1][j], c = P[i + 1][j1], d = P[i][j1]
      const n = cross(sub(c, a), sub(d, b))
      const o = (i * cells + j) * 3, l = Math.hypot(n[0], n[1], n[2])
      F[o] = n[0]; F[o + 1] = n[1]; F[o + 2] = n[2]
      if (l > 1e-14) { U[o] = n[0] / l; U[o + 1] = n[1] / l; U[o + 2] = n[2] / l }
      const m: Vec3 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2]
      const q = centre[i]
      out += n[0] * (m[0] - q[0]) + n[1] * (m[1] - q[1]) + n[2] * (m[2] - q[2])
    }
    const sign = out < 0 ? -1 : 1
    const cellAt = (i: number, j: number) => {
      if (i < 0 || i >= nr - 1) return -1
      if (closed) j = ((j % nc) + nc) % nc
      else if (j < 0 || j >= cells) return -1
      return i * cells + j
    }
    const DI = [-1, -1, 0, 0], DJ = [-1, 0, -1, 0]
    const CR = [0, 1, 1, 0], CK = [0, 0, 1, 1]
    for (let i = 0; i < nr - 1; i++) for (let j = 0; j < cells; j++) {
      const s = paintOf(i, j)
      const self = (i * cells + j) * 3
      const fx = U[self], fy = U[self + 1], fz = U[self + 2]
      const base = this.pos.length / 3
      for (let q = 0; q < 4; q++) {
        const r = i + CR[q], k = (j + CK[q]) % nc
        const p = P[r][k]
        let nx = 0, ny = 0, nz = 0
        for (let t = 0; t < 4; t++) {
          const c = cellAt(r + DI[t], k + DJ[t])
          if (c < 0) continue
          const o = c * 3
          if (o !== self && U[o] * fx + U[o + 1] * fy + U[o + 2] * fz < 0.6) continue
          nx += F[o]; ny += F[o + 1]; nz += F[o + 2]
        }
        const l = Math.hypot(nx, ny, nz)
        if (l > 1e-12) { nx = (nx / l) * sign; ny = (ny / l) * sign; nz = (nz / l) * sign }
        else if (fx || fy || fz) { nx = fx * sign; ny = fy * sign; nz = fz * sign }
        else { nx = 0; ny = 1; nz = 0 }
        this.pos.push(p[0], p[1], p[2])
        this.nor.push(nx, ny, nz)
        this.col.push(s.color[0], s.color[1], s.color[2])
        this.sty.push(s.paint, s.glow, s.finish ?? 0)
      }
      // Triangles wound like the cell (a planar quad's triangles share its orientation); slivers skipped.
      if (!(fx || fy || fz)) continue
      if (sign > 0) this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
      else this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2)
    }
    if (closed) {
      if (caps[0]) this.face([...rows[0]], caps[0], rows[1].reduce((a, p) => [a[0] + p[0] / nc, a[1] + p[1] / nc, a[2] + p[2] / nc], [0, 0, 0] as Vec3))
      if (caps[1]) this.face([...rows[nr - 1]], caps[1], rows[nr - 2].reduce((a, p) => [a[0] + p[0] / nc, a[1] + p[1] / nc, a[2] + p[2] / nc], [0, 0, 0] as Vec3))
    }
    return this
  }

  /**
   * A smooth solid of revolution about an axis through `c`: `profile` is a list of (radius, offset
   * along the axis) points (tyres, hubs, headlight buckets, tanks). `paintOf(k)` colours the band
   * between profile points k and k+1.
   */
  lathe(axis: Axis, c: Vec3, profile: [radius: number, offset: number][], paintOf: Paint | ((k: number) => Paint), segments = 24): this {
    const rows = profile.map(([r, h]) => Array.from({ length: segments }, (_, k) => {
      const a = (k / segments) * Math.PI * 2
      return axisPoint(axis, Math.cos(a) * r, Math.sin(a) * r, h, c)
    }))
    const f = typeof paintOf === 'function' ? paintOf : () => paintOf
    return this.surface(rows, (i) => f(i))
  }

  /**
   * A smooth rounded box (superellipsoid) centred at `c` with full `size`: exponent `e` 2 = ellipsoid,
   * higher = boxier with rounded edges (seats, mirrors, lamps, bumpers, cabs).
   */
  rounded(c: Vec3, size: Vec3, s: Paint, e = 4, segU = 16, segV = 8): this {
    const p = 2 / e
    const rows: Vec3[][] = []
    for (let i = 0; i <= segV; i++) {
      const phi = -Math.PI / 2 + (Math.PI * i) / segV
      const k = Math.abs(Math.cos(phi)) ** p, z = c[2] + (size[2] / 2) * sgnpow(Math.sin(phi), p)
      const ring: Vec3[] = []
      for (let j = 0; j < segU; j++) {
        const a = (j / segU) * Math.PI * 2
        ring.push([c[0] + (size[0] / 2) * k * sgnpow(Math.cos(a), p), c[1] + (size[1] / 2) * k * sgnpow(Math.sin(a), p), z])
      }
      rows.push(ring)
    }
    return this.surface(rows, () => s)
  }

  /** Number of vertices so far. */
  get vertexCount(): number {
    return this.pos.length / 3
  }

  /** The finished mesh. */
  build(): MeshData {
    const position = new Float32Array(this.pos)
    const bounds: MeshData['bounds'] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (let i = 0; i < position.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        bounds[k] = Math.min(bounds[k], position[i + k])
        bounds[k + 3] = Math.max(bounds[k + 3], position[i + k])
      }
    }
    if (!position.length) bounds.fill(0)
    return { position, normal: new Float32Array(this.nor), color: new Float32Array(this.col), style: new Float32Array(this.sty), index: new Uint32Array(this.idx), bounds }
  }
}

function dist2(a: Vec3, b: Vec3): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
