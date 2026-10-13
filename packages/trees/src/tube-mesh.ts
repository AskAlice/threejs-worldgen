import { BufferAttribute, BufferGeometry, Color, Float32BufferAttribute } from 'three/webgpu'

/** A growable `Float32Array`: geometry is written straight into typed memory, no per-vertex objects. */
export class FloatList {
  /** Backing store; only the first `length` values are used. */
  data: Float32Array
  /** Values written so far. */
  length = 0
  /** @param capacity Initial capacity in values. */
  constructor(capacity = 1024) {
    this.data = new Float32Array(capacity)
  }
  private reserve(n: number) {
    if (this.length + n <= this.data.length) return
    const next = new Float32Array(Math.max(this.data.length * 2, this.length + n))
    next.set(this.data.subarray(0, this.length))
    this.data = next
  }
  /** Appends one value. */
  push1(a: number): void {
    this.reserve(1)
    this.data[this.length++] = a
  }
  /** Appends two values. */
  push2(a: number, b: number): void {
    this.reserve(2)
    this.data[this.length++] = a
    this.data[this.length++] = b
  }
  /** Appends three values. */
  push3(a: number, b: number, c: number): void {
    this.reserve(3)
    this.data[this.length++] = a
    this.data[this.length++] = b
    this.data[this.length++] = c
  }
  /** A tight copy of the values written. */
  toArray(): Float32Array {
    return this.data.slice(0, this.length)
  }
}

/** A growable index list, emitted as `Uint16Array` when every index fits, else `Uint32Array`. */
export class IndexList {
  /** Backing store; only the first `length` values are used. */
  data = new Uint32Array(1024)
  /** Indices written so far. */
  length = 0
  /** Appends one triangle. */
  push3(a: number, b: number, c: number): void {
    if (this.length + 3 > this.data.length) {
      const next = new Uint32Array(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    this.data[this.length++] = a
    this.data[this.length++] = b
    this.data[this.length++] = c
  }
  /** A tight copy, 16-bit when `vertexCount` allows. */
  toArray(vertexCount: number): Uint16Array | Uint32Array {
    const used = this.data.subarray(0, this.length)
    return vertexCount <= 65536 ? Uint16Array.from(used) : used.slice()
  }
}

/** Growable vertex streams that the generators append to, then turn into one `BufferGeometry`. */
export interface MeshArrays {
  /** xyz per vertex. */
  positions: FloatList
  /** xyz per vertex. */
  normals: FloatList
  /** uv per vertex. */
  uvs: FloatList
  /** Linear rgb per vertex. */
  colors: FloatList
  /** Triangle indices. */
  indices: IndexList
  /**
   * Per-vertex random number shared by a whole card, frond or branch (0..1), or -1 for parts that must never be
   * removed (the trunk). Materials use it to thin crowns and break branches per instance.
   */
  cards: FloatList
}

/** Empty {@link MeshArrays}. */
export function createArrays(): MeshArrays {
  return { positions: new FloatList(), normals: new FloatList(), uvs: new FloatList(), colors: new FloatList(), indices: new IndexList(), cards: new FloatList(256) }
}

/** Appends one vertex to every stream of `out`. */
export function pushVertex(out: MeshArrays, x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, r: number, g: number, b: number, card: number): void {
  out.positions.push3(x, y, z)
  out.normals.push3(nx, ny, nz)
  out.uvs.push2(u, v)
  out.colors.push3(r, g, b)
  out.cards.push1(card)
}

/** A 3D point as a tuple. */
export type Vec3 = [x: number, y: number, z: number]

/** Options of {@link addTube}. */
export interface TubeOptions {
  /** Sides around the tube (at least 3). */
  segments: number
  /** Linear rgb colour of the whole tube. */
  color: Vec3
  /** Radius multiplier per ring and angle (flares, buttresses, cactus ribs). */
  shape?: (ring: number, theta: number, point: Vec3) => number
  /** Per-ring brightness multiplier (e.g. darker near the ground). */
  shade?: (ring: number, point: Vec3) => number
  /** Collapse the last ring to a point (closed tip). */
  closeEnd?: boolean
  /** Value written to `cards` for every vertex (default -1: never removed). */
  card?: number
}

/**
 * Appends a tube through `points` with a radius per point. Rings are oriented by parallel transport, so tubes don't
 * twist; texture v runs along the tube in units of the starting circumference so bark detail stays square.
 */
export function addTube(out: MeshArrays, points: Vec3[], radii: number[], o: TubeOptions): void {
  const n = points.length
  if (n < 2) return
  const segs = Math.max(3, Math.round(o.segments))
  const base = out.positions.length / 3
  // Initial frame: any normal perpendicular to the first tangent.
  let t = tangent(points, 0)
  let nrm: Vec3 = Math.abs(t[1]) < 0.9 ? normalize(cross(t, [0, 1, 0])) : normalize(cross(t, [1, 0, 0]))
  let length = 0
  const vScale = 1 / (2 * Math.PI * Math.max(radii[0], 0.01))
  for (let k = 0; k < n; k++) {
    const p = points[k]
    if (k > 0) {
      t = tangent(points, k)
      // Parallel transport: remove the component along the new tangent.
      const d = dot(nrm, t)
      nrm = normalize([nrm[0] - t[0] * d, nrm[1] - t[1] * d, nrm[2] - t[2] * d])
      length += Math.hypot(p[0] - points[k - 1][0], p[1] - points[k - 1][1], p[2] - points[k - 1][2])
    }
    const bin = cross(t, nrm)
    const r = o.closeEnd && k === n - 1 ? 0 : radii[k]
    const shade = o.shade ? o.shade(k, p) : 1
    const card = o.card ?? -1
    for (let s = 0; s <= segs; s++) {
      const theta = (s / segs) * Math.PI * 2
      const c = Math.cos(theta)
      const si = Math.sin(theta)
      const dx = nrm[0] * c + bin[0] * si
      const dy = nrm[1] * c + bin[1] * si
      const dz = nrm[2] * c + bin[2] * si
      const rr = r * (o.shape ? o.shape(k, theta, p) : 1)
      pushVertex(out, p[0] + dx * rr, p[1] + dy * rr, p[2] + dz * rr, dx, dy, dz, s / segs, length * vScale, o.color[0] * shade, o.color[1] * shade, o.color[2] * shade, card)
    }
  }
  const row = segs + 1
  for (let k = 0; k < n - 1; k++) {
    for (let s = 0; s < segs; s++) {
      const a = base + k * row + s
      const b = a + row
      out.indices.push3(a, a + 1, b)
      out.indices.push3(a + 1, b + 1, b)
    }
  }
}

/** Options of {@link addStrip}. */
export interface StripOptions {
  /** Width across the strip at relative length `v` (0 = base, 1 = tip). */
  width: (v: number) => number
  /** Linear rgb colour. */
  color: Vec3
  /** Height of the centre fold as a fraction of the width (a V-shaped cross-section reads better than a flat card). */
  fold?: number
  /** Value written to `cards` for every vertex (default 0.5). */
  card?: number
}

/**
 * Appends a curved ribbon along `points` (fronds, blades): three vertices per row (left, fold, right), texture u
 * across (0..1), v along (0..1). The ribbon lies flat across the horizontal perpendicular of its direction.
 */
export function addStrip(out: MeshArrays, points: Vec3[], o: StripOptions): void {
  const n = points.length
  if (n < 2) return
  const base = out.positions.length / 3
  for (let k = 0; k < n; k++) {
    const p = points[k]
    const t = tangent(points, k)
    let side = cross(t, [0, 1, 0])
    if (Math.hypot(...side) < 1e-4) side = [1, 0, 0]
    side = normalize(side)
    const up = normalize(cross(side, t))
    const v = k / (n - 1)
    const w = o.width(v) / 2
    const lift = w * (o.fold ?? 0.25)
    const card = o.card ?? 0.5
    for (let s = -1; s <= 1; s++) {
      const centre = s === 0 ? lift : 0
      // Tilt the normals of each half outward a little so the fold shades.
      const nx = up[0] - side[0] * s * 0.35
      const ny = up[1] - side[1] * s * 0.35
      const nz = up[2] - side[2] * s * 0.35
      const nl = Math.hypot(nx, ny, nz) || 1
      pushVertex(out, p[0] + side[0] * w * s + up[0] * centre, p[1] + side[1] * w * s + up[1] * centre, p[2] + side[2] * w * s + up[2] * centre,
        nx / nl, ny / nl, nz / nl, (s + 1) / 2, v, o.color[0], o.color[1], o.color[2], card)
    }
  }
  for (let k = 0; k < n - 1; k++) {
    const a = base + k * 3
    out.indices.push3(a, a + 1, a + 3)
    out.indices.push3(a + 1, a + 4, a + 3)
    out.indices.push3(a + 1, a + 2, a + 4)
    out.indices.push3(a + 2, a + 5, a + 4)
  }
}

/** Builds an indexed `BufferGeometry` (position, normal, uv, color, cardRandom) from {@link MeshArrays}. */
export function toGeometry(a: MeshArrays): BufferGeometry {
  const g = new BufferGeometry()
  const count = a.positions.length / 3
  g.setAttribute('position', new Float32BufferAttribute(a.positions.toArray(), 3))
  g.setAttribute('normal', new Float32BufferAttribute(a.normals.toArray(), 3))
  g.setAttribute('uv', new Float32BufferAttribute(a.uvs.toArray(), 2))
  g.setAttribute('color', new Float32BufferAttribute(a.colors.toArray(), 3))
  g.setAttribute('cardRandom', new Float32BufferAttribute(a.cards.toArray(), 1))
  g.setIndex(new BufferAttribute(a.indices.toArray(count), 1))
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}

/** A CSS colour as linear rgb (three.js working colour space). */
export function linearColor(css: string): Vec3 {
  const c = new Color(css)
  return [c.r, c.g, c.b]
}

function tangent(points: Vec3[], k: number): Vec3 {
  const a = points[Math.max(0, k - 1)]
  const b = points[Math.min(points.length - 1, k + 1)]
  return normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]])
}

/** Cross product. */
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/** Dot product. */
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/** Unit vector (or +Y for a zero vector). */
export function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2])
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0]
}
