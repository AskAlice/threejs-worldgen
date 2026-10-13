/**
 * Procedural fish meshes as plain typed arrays (no three.js), so they can be built in a worker and
 * tested in Node. The body is lofted from superellipse cross-sections along a spine and is closed
 * (watertight); fins are thin two-sided sheets. Every vertex carries `fish` = (s, h, part, w):
 * s = 0 at the nose … 1 at the tail tip, h = −1 belly … 1 back, `part` (see {@link PART}) and
 * w = 0 at a fin's root … 1 at its edge. The shader animates and colours from these.
 */
import type { FishShape } from './fish-species.ts'

/** Values of the `part` channel. */
export const PART = {
  /** Fish body. */
  body: 0,
  /** Tail (caudal) fin. */
  tail: 1,
  /** Dorsal and anal fins. */
  fin: 2,
  /** Pectoral and pelvic fins. */
  paired: 3,
  /** Bird wing. */
  wing: 5,
  /** Bird tail. */
  birdTail: 6,
} as const

/** A mesh as typed arrays. */
export interface MeshData {
  /** xyz per vertex. Fish face +z (nose at z = 0.5, tail tip at z = −0.5), y up. */
  position: Float32Array
  /** Unit normals, xyz per vertex. */
  normal: Float32Array
  /** (s, h, part, w) per vertex; see the module docs. */
  attr: Float32Array
  /** Triangle indices. */
  index: Uint32Array
  /** The first `bodyIndexCount` indices are the closed body; the rest are fins. */
  bodyIndexCount: number
  /** Axis-aligned bounds: [minX, minY, minZ, maxX, maxY, maxZ]. */
  bounds: [number, number, number, number, number, number]
}

/** Fish mesh plus what the shader needs to paint the face. */
export interface FishMeshData extends MeshData {
  /** Eye centre (z, y) and radius, in mesh units. */
  eye: [z: number, y: number, radius: number]
  /** Mouth line height (y) and length (in s). */
  mouth: [y: number, length: number]
}

/** Mesh resolution. */
export interface FishDetail {
  /** Cross-sections along the body. */
  rings: number
  /** Vertices around each cross-section. */
  sides: number
  /** Columns along each fin. */
  finColumns: number
}

/** Default {@link FishDetail}: ~600 vertices. */
export const DEFAULT_FISH_DETAIL: FishDetail = { rings: 20, sides: 12, finColumns: 7 }

/** Accumulates vertices and triangles. */
export class MeshBuilder {
  /** Positions. */
  readonly position: number[] = []
  /** Normals (filled by {@link MeshBuilder.smoothNormals} or given per vertex). */
  readonly normal: number[] = []
  /** (s, h, part, w). */
  readonly attr: number[] = []
  /** Indices. */
  readonly index: number[] = []

  /** Adds a vertex and returns its index. */
  vertex(x: number, y: number, z: number, s: number, h: number, part: number, w: number, nx = 0, ny = 0, nz = 0): number {
    this.position.push(x, y, z)
    this.normal.push(nx, ny, nz)
    this.attr.push(s, h, part, w)
    return this.position.length / 3 - 1
  }

  /** Adds a triangle. */
  tri(a: number, b: number, c: number): void {
    this.index.push(a, b, c)
  }

  /** Area-weighted smooth normals for vertices in [from, to), from the triangles in [iFrom, iTo). */
  smoothNormals(from: number, to: number, iFrom: number, iTo: number): void {
    const p = this.position, n = this.normal
    for (let v = from; v < to; v++) n[v * 3] = n[v * 3 + 1] = n[v * 3 + 2] = 0
    for (let t = iFrom; t < iTo; t += 3) {
      const a = this.index[t], b = this.index[t + 1], c = this.index[t + 2]
      const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2]
      const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2]
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx
      for (const q of [a, b, c]) { n[q * 3] += fx; n[q * 3 + 1] += fy; n[q * 3 + 2] += fz }
    }
    for (let v = from; v < to; v++) {
      const l = Math.hypot(n[v * 3], n[v * 3 + 1], n[v * 3 + 2])
      if (l > 1e-12) { n[v * 3] /= l; n[v * 3 + 1] /= l; n[v * 3 + 2] /= l } else { n[v * 3] = 0; n[v * 3 + 1] = 1; n[v * 3 + 2] = 0 }
    }
  }

  /**
   * Adds a flat sheet, two-sided (a copy per side with opposite normals and winding). `point(r, c)`
   * returns the position of row `r` (0 = root … rows−1 = edge) and column `c`; `normal` is the sheet's
   * plane normal for the front copy.
   */
  sheet(rows: number, cols: number, point: (r: number, c: number) => [number, number, number], normal: [number, number, number], part: number, depth: number): void {
    const l = Math.hypot(...normal) || 1
    const nx = normal[0] / l, ny = normal[1] / l, nz = normal[2] / l
    for (const side of [1, -1]) {
      const first = this.position.length / 3
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const [x, y, z] = point(r, c)
          this.vertex(x, y, z, Math.min(1, Math.max(0, 0.5 - z)), Math.max(-1, Math.min(1, y / Math.max(depth * 0.5, 1e-6))), part, r / (rows - 1), nx * side, ny * side, nz * side)
        }
      }
      const at = (r: number, c: number) => first + r * cols + c
      for (let r = 0; r + 1 < rows; r++) {
        for (let c = 0; c + 1 < cols; c++) {
          this.facing(at(r, c), at(r + 1, c), at(r + 1, c + 1), nx * side, ny * side, nz * side)
          this.facing(at(r, c), at(r + 1, c + 1), at(r, c + 1), nx * side, ny * side, nz * side)
        }
      }
    }
  }

  /** Adds a triangle wound so its face normal points along (nx, ny, nz); skips degenerate ones. */
  private facing(a: number, b: number, c: number, nx: number, ny: number, nz: number) {
    const p = this.position
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2]
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2]
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx
    if (Math.hypot(fx, fy, fz) < 1e-10) return
    if (fx * nx + fy * ny + fz * nz >= 0) this.tri(a, b, c)
    else this.tri(a, c, b)
  }

  /** Packs into typed arrays. */
  build(bodyIndexCount: number): MeshData {
    const position = new Float32Array(this.position)
    const bounds: MeshData['bounds'] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (let i = 0; i < position.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        bounds[k] = Math.min(bounds[k], position[i + k])
        bounds[k + 3] = Math.max(bounds[k + 3], position[i + k])
      }
    }
    return { position, normal: new Float32Array(this.normal), attr: new Float32Array(this.attr), index: new Uint32Array(this.index), bodyIndexCount, bounds }
  }
}

/** A cross-section of a lofted body. */
export interface Section {
  /** Position along the spine. */
  z: number
  /** Spine height. */
  y: number
  /** Height of the back above the spine. */
  top: number
  /** Depth of the belly below the spine. */
  bottom: number
  /** Half width. */
  halfWidth: number
  /** `s` attribute value (0 = nose … 1 = tail tip). */
  s: number
}

/**
 * Lofts a closed body: a nose vertex, `rings` superellipse sections from `section(u)` with u in
 * (0, 1], and a cap at u = 1. Normals are smooth. Returns the number of body indices added.
 */
export function loftBody(b: MeshBuilder, section: (u: number) => Section, rings: number, sides: number, squareness: number, part: number = PART.body): number {
  const v0 = b.position.length / 3, i0 = b.index.length
  const e = 2 / Math.max(1, squareness)
  const sp = (x: number) => Math.sign(x) * Math.pow(Math.abs(x), e)
  const nose = section(0)
  const tip = b.vertex(0, nose.y, nose.z, nose.s, 0, part, 0)
  let prev: number[] | null = null
  for (let i = 1; i <= rings; i++) {
    const u = 0.5 - 0.5 * Math.cos((Math.PI * i) / rings) // denser at both ends
    const sec = section(u)
    const ring: number[] = []
    for (let j = 0; j < sides; j++) {
      const t = (2 * Math.PI * j) / sides
      const c = sp(Math.cos(t)), s = sp(Math.sin(t))
      ring.push(b.vertex(sec.halfWidth * c, sec.y + (s >= 0 ? sec.top : sec.bottom) * s, sec.z, sec.s, s, part, 0))
    }
    for (let j = 0; j < sides; j++) {
      const j1 = (j + 1) % sides
      if (!prev) b.tri(tip, ring[j], ring[j1])
      else {
        b.tri(prev[j], ring[j], prev[j1])
        b.tri(prev[j1], ring[j], ring[j1])
      }
    }
    prev = ring
  }
  const end = section(1)
  const cap = b.vertex(0, end.y, end.z, end.s, 0, part, 0)
  for (let j = 0; j < sides; j++) b.tri(prev![j], cap, prev![(j + 1) % sides])
  b.smoothNormals(v0, b.position.length / 3, i0, b.index.length)
  return b.index.length - i0
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Body cross-section of a fish shape at u (0 = nose … 1 = tail stalk). */
export function fishSection(shape: FishShape, u: number): Section {
  const B = shape.bodyLength
  const a = Math.min(0.9, Math.max(0.05, shape.depthAt))
  let e: number
  if (u <= a) e = Math.pow(Math.sin((Math.PI / 2) * (u / a)), shape.nose)
  else {
    const t = (u - a) / (1 - a)
    e = shape.peduncle + (1 - shape.peduncle) * (0.5 + 0.5 * Math.cos(Math.PI * t))
  }
  const nose = Math.max(0, 1 - u / a)
  return {
    z: 0.5 - u * B,
    y: -shape.mouth.tilt * shape.depth * 0.15 * nose * nose,
    top: shape.depth * shape.back * e,
    bottom: shape.depth * (1 - shape.back) * e,
    halfWidth: shape.width * 0.5 * e * (1 - 0.5 * smooth(a, 1, u)),
    s: u * B,
  }
}

/** Builds a fish mesh from a {@link FishShape}. Total length is 1 (nose z = 0.5, tail tip z = −0.5). */
export function buildFishMesh(shape: FishShape, detail: FishDetail = DEFAULT_FISH_DETAIL): FishMeshData {
  const b = new MeshBuilder()
  const B = Math.min(0.97, Math.max(0.5, shape.bodyLength))
  const sh = { ...shape, bodyLength: B }
  const sec = (u: number) => fishSection(sh, u)
  const bodyIndexCount = loftBody(b, sec, Math.max(4, detail.rings), Math.max(4, detail.sides), shape.squareness)
  const D = shape.depth
  const K = Math.max(3, detail.finColumns)

  // Median fins: on the back (dorsal) or belly (anal), rooted a little inside the body.
  const median = (fin: { start: number; length: number; height: number; sweep: number }, up: 1 | -1) => {
    if (fin.length <= 0 || fin.height <= 0) return
    b.sheet(3, K, (r, c) => {
      const v = c / (K - 1)
      const s = Math.min(B, fin.start + fin.length * v)
      const q = sec(s / B)
      const rootY = q.y + up * (up > 0 ? q.top : q.bottom) * 0.8
      const h = fin.height * Math.pow(Math.sin(Math.PI * v), 0.6) * (1.15 - 0.3 * v)
      const t = r / 2
      return [0, rootY + up * h * t, 0.5 - s - fin.sweep * h * t]
    }, [1, 0, 0], PART.fin, D)
  }
  for (const f of shape.dorsal) median(f, 1)
  for (const f of shape.anal) median(f, -1)

  // Paired fins: small paddles on each flank.
  const paired = (fin: { position: number; height: number; size: number; angle: number }) => {
    if (fin.size <= 0) return
    const q = sec(Math.min(1, fin.position / B))
    const h = Math.max(-0.98, Math.min(0.98, fin.height))
    for (const side of [1, -1]) {
      const px = side * q.halfWidth * Math.sqrt(1 - h * h) * 0.85
      const py = q.y + h * (h >= 0 ? q.top : q.bottom) * 0.9
      const pz = 0.5 - fin.position
      const out: [number, number, number] = [side * Math.cos(fin.angle), -Math.sin(fin.angle), 0]
      const back: [number, number, number] = [0, 0, -1]
      const point = (r: number, c: number): [number, number, number] => {
        const v = c / (K - 1)
        const phi = 1.25 - 1.1 * v
        const rad = fin.size * (0.75 + 0.25 * Math.sin(Math.PI * v))
        const rootA = 0.25 * fin.size * v
        const ea = rad * Math.cos(phi) + rootA * 0.3, eb = rad * Math.sin(phi)
        const t = r / 2
        const a = rootA + (ea - rootA) * t, bb = eb * t
        return [px + back[0] * a + out[0] * bb, py + back[1] * a + out[1] * bb, pz + back[2] * a + out[2] * bb]
      }
      const n: [number, number, number] = [back[1] * out[2] - back[2] * out[1], back[2] * out[0] - back[0] * out[2], back[0] * out[1] - back[1] * out[0]]
      b.sheet(3, K, point, n, PART.paired, D)
    }
  }
  paired(shape.pectoral)
  paired(shape.pelvic)

  // Tail fin: a fan from the tail stalk to an outline set by the tail shape.
  const tail = shape.tail
  const end = sec(1)
  const zr = 0.5 - B + 0.01
  const Lt = 0.5 + zr
  const T = K + (K % 2 === 0 ? 1 : 0) + 2 // odd, so v = 0 is a column
  const reach = (v: number) => {
    const a = Math.abs(v)
    switch (tail.shape) {
      case 'forked': return 1 - tail.fork * Math.pow(1 - a, 1.3)
      case 'lunate': return 1 - tail.fork * (1 - a * a)
      case 'rounded': return Math.sqrt(Math.max(0, 1 - 0.75 * a * a))
      default: return 1 - 0.08 * a * a
    }
  }
  b.sheet(3, T, (r, c) => {
    const v = (c / (T - 1)) * 2 - 1
    const rootY = end.y + (v >= 0 ? v * end.top : v * end.bottom) * 0.9
    const edgeY = end.y + v * tail.height * 0.5 * (v >= 0 ? 1 + tail.asymmetry * 0.3 : 1 - tail.asymmetry * 0.6)
    const edgeZ = zr - Lt * reach(v) * (v < 0 ? 1 - tail.asymmetry * 0.5 : 1)
    const t = r / 2
    return [0, rootY + (edgeY - rootY) * t, zr + (edgeZ - zr) * t]
  }, [1, 0, 0], PART.tail, D)

  const data = b.build(bodyIndexCount) as FishMeshData
  const eyeSec = sec(Math.min(1, shape.eye.position / B))
  const eh = Math.max(-0.95, Math.min(0.95, shape.eye.height))
  data.eye = [0.5 - shape.eye.position, eyeSec.y + eh * (eh >= 0 ? eyeSec.top : eyeSec.bottom), shape.eye.size]
  data.mouth = [sec(0).y + shape.mouth.tilt * D * 0.2, shape.mouth.size]
  return data
}
