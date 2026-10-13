/** Typed vertex attributes plus an index buffer: geometry as plain data (no three.js needed). */
export interface MeshData {
  /** Attribute arrays by name. */
  attributes: Record<string, Float32Array>
  /** Item size per attribute. */
  itemSizes: Record<string, number>
  /** Triangle indices (16-bit when the vertex count allows). */
  index: Uint16Array | Uint32Array
  /** Vertex count. */
  count: number
}

/**
 * Accumulates indexed triangles straight into growable typed arrays with a fixed set of float
 * attributes. Set the "current" value of an attribute with {@link MeshBuilder.set}, then emit
 * vertices with {@link MeshBuilder.vertex}; attributes keep their last value.
 */
export class MeshBuilder {
  /** Attribute item sizes. */
  readonly spec: Record<string, number>
  private names: string[]
  private sizes: number[]
  private arrays: Float32Array[]
  private current: Float64Array[]
  private posSlot: number
  private uvSlot: number
  private indices = new Uint32Array(256)
  private ni = 0
  private n = 0
  private capacity = 64

  /** A builder for the given attributes, e.g. `{ position: 3, normal: 3, uv: 2 }`. */
  constructor(spec: Record<string, number>) {
    this.spec = spec
    this.names = Object.keys(spec)
    this.sizes = this.names.map((k) => spec[k])
    this.arrays = this.sizes.map((s) => new Float32Array(this.capacity * s))
    this.current = this.sizes.map((s) => new Float64Array(s))
    this.posSlot = this.names.indexOf('position')
    this.uvSlot = this.names.indexOf('uv')
  }

  /** Vertices emitted so far. */
  get count(): number {
    return this.n
  }

  /** Triangle indices added so far. */
  get indexCount(): number {
    return this.ni
  }

  /** Sets the current value of an attribute (used by following vertices). */
  set(name: string, a = 0, b = 0, c = 0, d = 0): this {
    const cur = this.current[this.names.indexOf(name)]
    cur[0] = a
    if (cur.length > 1) cur[1] = b
    if (cur.length > 2) cur[2] = c
    if (cur.length > 3) cur[3] = d
    return this
  }

  /** Emits a vertex at (x, y, z) with uv (u, v) and the current values of the other attributes. Returns its index. */
  vertex(x: number, y: number, z: number, u = 0, v = 0): number {
    if (this.n === this.capacity) {
      this.capacity *= 2
      this.arrays = this.arrays.map((a, i) => {
        const g = new Float32Array(this.capacity * this.sizes[i])
        g.set(a)
        return g
      })
    }
    const n = this.n
    for (let i = 0; i < this.arrays.length; i++) {
      const a = this.arrays[i], s = this.sizes[i], o = n * s
      if (i === this.posSlot) { a[o] = x; a[o + 1] = y; a[o + 2] = z }
      else if (i === this.uvSlot) { a[o] = u; a[o + 1] = v }
      else { const c = this.current[i]; for (let k = 0; k < s; k++) a[o + k] = c[k] }
    }
    return this.n++
  }

  /** Adds a triangle. */
  triangle(a: number, b: number, c: number): this {
    if (this.ni + 3 > this.indices.length) {
      const g = new Uint32Array(this.indices.length * 2)
      g.set(this.indices)
      this.indices = g
    }
    this.indices[this.ni++] = a
    this.indices[this.ni++] = b
    this.indices[this.ni++] = c
    return this
  }

  /**
   * Adds a flat quad from four corners given counter-clockwise as seen from the front, with the
   * normal computed from them. `uvs` = [u0, v0, u1, v1, …] per corner.
   */
  quad(p: readonly (readonly [number, number, number])[], uvs: readonly number[]): this {
    const [a, b, c, d] = p
    this.flatNormal(a, b, d)
    const i0 = this.vertex(a[0], a[1], a[2], uvs[0], uvs[1])
    const i1 = this.vertex(b[0], b[1], b[2], uvs[2], uvs[3])
    const i2 = this.vertex(c[0], c[1], c[2], uvs[4], uvs[5])
    const i3 = this.vertex(d[0], d[1], d[2], uvs[6], uvs[7])
    return this.triangle(i0, i1, i2).triangle(i0, i2, i3)
  }

  /** Adds a flat triangle from three corners counter-clockwise as seen from the front. */
  tri(p: readonly (readonly [number, number, number])[], uvs: readonly number[]): this {
    const [a, b, c] = p
    this.flatNormal(a, b, c)
    return this.triangle(this.vertex(a[0], a[1], a[2], uvs[0], uvs[1]), this.vertex(b[0], b[1], b[2], uvs[2], uvs[3]), this.vertex(c[0], c[1], c[2], uvs[4], uvs[5]))
  }

  private flatNormal(a: readonly number[], b: readonly number[], c: readonly number[]) {
    const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2]
    const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2]
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x
    const l = Math.hypot(nx, ny, nz) || 1
    this.set('normal', nx / l, ny / l, nz / l)
  }

  /** Trims the arrays to size (16-bit indices when the vertex count allows). */
  build(): MeshData {
    const attributes: Record<string, Float32Array> = {}
    const itemSizes: Record<string, number> = {}
    this.names.forEach((k, i) => {
      attributes[k] = this.arrays[i].slice(0, this.n * this.sizes[i])
      itemSizes[k] = this.sizes[i]
    })
    const idx = this.indices.subarray(0, this.ni)
    return { attributes, itemSizes, index: this.n <= 65536 ? Uint16Array.from(idx) : idx.slice(), count: this.n }
  }
}
