/**
 * Unit primitives every prop is assembled from, as plain typed arrays (no three.js, so they run in
 * workers and tests). Each fits the box x, z ∈ [−0.5, 0.5], y ∈ [0, 1] (base at y = 0), so an instance
 * scale is simply (width, height, depth).
 */

/** Plain indexed triangle mesh. */
export interface MeshData {
  /** xyz per vertex. */
  position: Float32Array
  /** Unit normal per vertex. */
  normal: Float32Array
  /** uv per vertex. */
  uv: Float32Array
  /** Triangle indices (counter-clockwise from outside). */
  index: Uint32Array
}

/** The primitive shapes. `cylinder3`/`cylinder8` are triangular and octagonal prisms (yield and stop signs). */
export type ShapeId = 'box' | 'cylinder' | 'cylinder3' | 'cylinder8' | 'sphere' | 'arch' | 'ring' | 'wire'

/** Every shape id. */
export const SHAPES: readonly ShapeId[] = ['box', 'cylinder', 'cylinder3', 'cylinder8', 'sphere', 'arch', 'ring', 'wire']

class Builder {
  p: number[] = []
  n: number[] = []
  t: number[] = []
  i: number[] = []
  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    this.p.push(x, y, z)
    this.n.push(nx, ny, nz)
    this.t.push(u, v)
    return this.p.length / 3 - 1
  }
  tri(a: number, b: number, c: number) {
    this.i.push(a, b, c)
  }
  build(): MeshData {
    return { position: new Float32Array(this.p), normal: new Float32Array(this.n), uv: new Float32Array(this.t), index: new Uint32Array(this.i) }
  }
}

function box(): MeshData {
  const b = new Builder()
  // [normal, u axis, v axis] per face; the face centre is normal * 0.5 (then shifted up by 0.5).
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ]
  for (const [n, u, v] of faces) {
    const k = b.p.length / 3
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      b.vertex(
        n[0] * 0.5 + u[0] * su * 0.5 + v[0] * sv * 0.5, 0.5 + n[1] * 0.5 + u[1] * su * 0.5 + v[1] * sv * 0.5, n[2] * 0.5 + u[2] * su * 0.5 + v[2] * sv * 0.5,
        n[0], n[1], n[2], (su + 1) / 2, (sv + 1) / 2,
      )
    }
    b.tri(k, k + 1, k + 2)
    b.tri(k, k + 2, k + 3)
  }
  return b.build()
}

/** Prism of `segments` sides (smooth normals above 8 sides), radius 0.5, y 0…1, with caps. */
function cylinder(segments: number, caps = true, inner = 0): MeshData {
  const b = new Builder()
  const smooth = segments > 8
  const side = (r: number, out: number) => {
    for (let s = 0; s < segments; s++) {
      const a0 = (s / segments) * Math.PI * 2, a1 = ((s + 1) / segments) * Math.PI * 2
      const am = (a0 + a1) / 2
      const k = b.p.length / 3
      for (const [a, y] of [[a0, 0], [a1, 0], [a1, 1], [a0, 1]]) {
        const na = smooth ? a : am
        b.vertex(Math.sin(a) * r, y, Math.cos(a) * r, Math.sin(na) * out, 0, Math.cos(na) * out, a / (Math.PI * 2), y)
      }
      if (out > 0) { b.tri(k, k + 1, k + 2); b.tri(k, k + 2, k + 3) } else { b.tri(k, k + 2, k + 1); b.tri(k, k + 3, k + 2) }
    }
  }
  side(0.5, 1)
  if (inner > 0) side(inner, -1)
  if (caps) {
    for (const y of [0, 1]) {
      const ny = y ? 1 : -1
      if (inner > 0) {
        // Annulus between the walls.
        for (let s = 0; s < segments; s++) {
          const a0 = (s / segments) * Math.PI * 2, a1 = ((s + 1) / segments) * Math.PI * 2
          const k = b.p.length / 3
          for (const [a, r] of [[a0, inner], [a1, inner], [a1, 0.5], [a0, 0.5]]) b.vertex(Math.sin(a) * r, y, Math.cos(a) * r, 0, ny, 0, Math.sin(a) * r + 0.5, Math.cos(a) * r + 0.5)
          if (y) { b.tri(k, k + 2, k + 1); b.tri(k, k + 3, k + 2) } else { b.tri(k, k + 1, k + 2); b.tri(k, k + 2, k + 3) }
        }
        continue
      }
      const c = b.vertex(0, y, 0, 0, ny, 0, 0.5, 0.5)
      const ring: number[] = []
      for (let s = 0; s < segments; s++) {
        const a = (s / segments) * Math.PI * 2
        ring.push(b.vertex(Math.sin(a) * 0.5, y, Math.cos(a) * 0.5, 0, ny, 0, Math.sin(a) * 0.5 + 0.5, Math.cos(a) * 0.5 + 0.5))
      }
      for (let s = 0; s < segments; s++) {
        const r0 = ring[s], r1 = ring[(s + 1) % segments]
        if (y) b.tri(c, r0, r1)
        else b.tri(c, r1, r0)
      }
    }
  }
  return b.build()
}

function sphere(w = 12, h = 8): MeshData {
  const b = new Builder()
  for (let j = 0; j <= h; j++) {
    const v = j / h, phi = v * Math.PI
    for (let i = 0; i <= w; i++) {
      const u = i / w, th = u * Math.PI * 2
      const x = Math.sin(phi) * Math.sin(th), y = Math.cos(phi), z = Math.sin(phi) * Math.cos(th)
      b.vertex(x * 0.5, 0.5 + y * 0.5, z * 0.5, x, y, z, u, v)
    }
  }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const a = j * (w + 1) + i, c = a + w + 1
    if (j > 0) b.tri(a, c, a + 1)
    if (j < h - 1) b.tri(a + 1, c, c + 1)
  }
  return b.build()
}

/** Half cylinder along z: a semi-ellipse in x (−0.5…0.5) and y (0…1), z −0.5…0.5, with end caps (mailbox tops). */
function arch(segments = 10): MeshData {
  const b = new Builder()
  const pt = (s: number) => {
    const a = (s / segments) * Math.PI
    return [Math.cos(a) * 0.5, Math.sin(a), Math.cos(a), Math.sin(a) * 0.5] // x, y, normal (unnormalised ellipse)
  }
  for (let s = 0; s < segments; s++) {
    const k = b.p.length / 3
    for (const [ss, z] of [[s, 0.5], [s + 1, 0.5], [s + 1, -0.5], [s, -0.5]] as const) {
      const [x, y, nx, ny] = pt(ss)
      const l = Math.hypot(nx, ny)
      b.vertex(x, y, z, nx / l, ny / l, 0, ss / segments, z + 0.5)
    }
    b.tri(k, k + 2, k + 1)
    b.tri(k, k + 3, k + 2)
  }
  for (const z of [0.5, -0.5]) {
    const c = b.vertex(0, 0, z, 0, 0, Math.sign(z), 0.5, 0)
    const ring: number[] = []
    for (let s = 0; s <= segments; s++) {
      const [x, y] = pt(s)
      ring.push(b.vertex(x, y, z, 0, 0, Math.sign(z), x + 0.5, y))
    }
    for (let s = 0; s < segments; s++) {
      if (z > 0) b.tri(c, ring[s], ring[s + 1])
      else b.tri(c, ring[s + 1], ring[s])
    }
  }
  // Flat bottom.
  const k = b.p.length / 3
  for (const [x, z] of [[-0.5, 0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]]) b.vertex(x, 0, z, 0, -1, 0, x + 0.5, z + 0.5)
  b.tri(k, k + 2, k + 1)
  b.tri(k, k + 3, k + 2)
  return b.build()
}

const cache = new Map<ShapeId, MeshData>()

/** The unit mesh of a shape (built once, shared). */
export function shapeData(id: ShapeId): MeshData {
  let m = cache.get(id)
  if (!m) {
    m = id === 'box' ? box()
      : id === 'cylinder' ? cylinder(14)
      : id === 'cylinder3' ? cylinder(3)
      : id === 'cylinder8' ? cylinder(8)
      : id === 'sphere' ? sphere()
      : id === 'arch' ? arch()
      : id === 'ring' ? cylinder(16, true, 0.4)
      : cylinder(4, false)
    cache.set(id, m)
  }
  return m
}
