// Corn layout, free of three.js: rows of plants inside field polygons, and the persistent map of where
// interactors flattened them. The Corn field renders from these; tests run them directly.
import { hash2, mulberry32 } from './random.ts'

/**
 * A farm field: where corn grows and how its rows run. Plain JSON, in the shape threejs-city's farm planner
 * hands over.
 */
export interface CornField {
  /** Outline in world XZ metres, one `[x, z]` per vertex, either winding, closed implicitly. */
  polygon: [x: number, z: number][]
  /** Direction the rows run, in radians from +X towards +Z. */
  rowDirection: number
  /** Distance between rows in metres (0.76 m, 30 in, is typical). */
  rowSpacing: number
}

/** Options of {@link plantRows}. */
export interface PlantOptions {
  /** Distance between plants along a row, in metres. */
  plantSpacing: number
  /** Layout seed: the same seed always plants the same field. */
  seed: number
  /** Fraction of planting spots left empty (seeds that never came up). */
  gaps?: number
}

/** Floats per plant in {@link plantRows}' output: x, z, yaw, seed (0..1), rank (0..1). */
export const PLANT_STRIDE = 5

/**
 * Plants every field's rows inside a world-space rectangle `[minX, maxX) × [minZ, maxZ)`. Rows lie on a lattice
 * anchored at the field's first vertex, so adjacent rectangles stitch exactly and each plant falls in exactly one.
 * Plants are jittered along the row a little, some spots stay empty, and leaves face roughly across the row (as
 * real corn turns its leaves into the gaps). Output is sorted by `rank`, a per-plant random number in [0, 1): the
 * first `n` plants are an even thinning of the rectangle, which is how distant levels of detail drop plants.
 */
export function plantRows(fields: readonly CornField[], minX: number, minZ: number, maxX: number, maxZ: number, { plantSpacing, seed, gaps = 0.04 }: PlantOptions): Float32Array {
  const out: number[] = []
  fields.forEach((field, f) => {
    const { polygon, rowDirection, rowSpacing } = field
    if (polygon.length < 3 || !(rowSpacing > 0) || !(plantSpacing > 0)) return
    const b = bounds(polygon)
    const x0 = Math.max(minX, b.minX), x1 = Math.min(maxX, b.maxX)
    const z0 = Math.max(minZ, b.minZ), z1 = Math.min(maxZ, b.maxZ)
    if (x0 >= x1 || z0 >= z1) return
    const ax = Math.cos(rowDirection), az = Math.sin(rowDirection) // along the row
    const bx = -az, bz = ax // across the rows
    const [px, pz] = polygon[0]
    const u0 = px * ax + pz * az
    const v0 = px * bx + pz * bz
    // Lattice ranges covering the clipped rectangle (corners projected onto both axes), one spot of margin for jitter.
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity
    for (const [cx, cz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
      const u = cx * ax + cz * az, v = cx * bx + cz * bz
      uMin = Math.min(uMin, u); uMax = Math.max(uMax, u); vMin = Math.min(vMin, v); vMax = Math.max(vMax, v)
    }
    const kMin = Math.floor((vMin - v0) / rowSpacing - 0.5), kMax = Math.ceil((vMax - v0) / rowSpacing)
    const jMin = Math.floor((uMin - u0) / plantSpacing) - 1, jMax = Math.ceil((uMax - u0) / plantSpacing) + 1
    const fieldSeed = hash2(seed, f + 1)
    for (let k = kMin; k <= kMax; k++) {
      const v = v0 + (k + 0.5) * rowSpacing
      for (let j = jMin; j <= jMax; j++) {
        const rand = mulberry32(hash2(hash2(k, j), fieldSeed))
        const gap = rand(), along = rand(), across = rand(), turn = rand(), s = rand(), rank = rand()
        if (gap < gaps) continue
        const u = u0 + (j + 0.5 + (along - 0.5) * 0.5) * plantSpacing
        const w = v + (across - 0.5) * 0.04
        const x = ax * u + bx * w
        const z = az * u + bz * w
        if (x < minX || x >= maxX || z < minZ || z >= maxZ || !pointInPolygon(polygon, x, z)) continue
        out.push(x, z, rowDirection + Math.PI / 2 + (turn - 0.5) * 1.6, s, rank)
      }
    }
  })
  // Sort plants by rank so any prefix is an even thinning.
  const n = out.length / PLANT_STRIDE
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => out[a * PLANT_STRIDE + 4] - out[b * PLANT_STRIDE + 4])
  const sorted = new Float32Array(out.length)
  order.forEach((from, to) => sorted.set(out.slice(from * PLANT_STRIDE, from * PLANT_STRIDE + PLANT_STRIDE), to * PLANT_STRIDE))
  return sorted
}

/** Whether world point (x, z) is inside `polygon` (even-odd rule). */
export function pointInPolygon(polygon: readonly (readonly [number, number])[], x: number, z: number): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i]
    const [xj, zj] = polygon[j]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

/** Axis-aligned bounds of a polygon. */
export function bounds(polygon: readonly (readonly [number, number])[]) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
  for (const [x, z] of polygon) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
  }
  return { minX, minZ, maxX, maxZ }
}

/**
 * Where corn has been flattened, and which way it fell: a world-space grid over the fields, RGBA bytes per texel
 * (R = amount 0..255, G/B = fall direction x/z mapped from [-1, 1], A = 255). It only ever grows: corn that was
 * driven over stays down. Row 0 is at `minZ`; texel (i, j) is centred on `minX + (i + 0.5) * texel`.
 */
export class FlattenMap {
  /** Raw RGBA bytes, `width × height` texels. */
  readonly data: Uint8Array
  /** World X of the west edge. */
  readonly minX: number
  /** World Z of the north (−Z) edge. */
  readonly minZ: number
  /** Texel size in metres. */
  readonly texel: number
  /** Texels along X. */
  readonly width: number
  /** Texels along Z. */
  readonly height: number
  /** Increases on every change, so renderers know when to upload. */
  version = 0

  /** Covers `[minX, maxX] × [minZ, maxZ]` with square texels of `texel` metres (at most `maxTexels` per side). */
  constructor(minX: number, minZ: number, maxX: number, maxZ: number, texel: number, maxTexels = 2048) {
    const size = Math.max(maxX - minX, maxZ - minZ, 1e-3)
    this.texel = Math.max(texel, size / maxTexels)
    this.minX = minX
    this.minZ = minZ
    this.width = Math.max(1, Math.ceil((maxX - minX) / this.texel))
    this.height = Math.max(1, Math.ceil((maxZ - minZ) / this.texel))
    this.data = new Uint8Array(this.width * this.height * 4)
    this.clear()
  }

  /**
   * Flattens a disk of `radius` metres around (x, z), with an antialiased one-texel rim. Corn falls along
   * (dirX, dirZ) (the direction of travel), splayed outwards towards the rim; with no direction it falls straight
   * outwards. Returns whether anything changed.
   */
  stamp(x: number, z: number, radius: number, dirX = 0, dirZ = 0): boolean {
    const t = this.texel
    const i0 = Math.max(0, Math.floor((x - radius - t - this.minX) / t)), i1 = Math.min(this.width - 1, Math.floor((x + radius + t - this.minX) / t))
    const j0 = Math.max(0, Math.floor((z - radius - t - this.minZ) / t)), j1 = Math.min(this.height - 1, Math.floor((z + radius + t - this.minZ) / t))
    const travel = Math.hypot(dirX, dirZ)
    let changed = false
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = this.minX + (i + 0.5) * t - x
        const dz = this.minZ + (j + 0.5) * t - z
        const d = Math.hypot(dx, dz)
        const amount = Math.min(1, Math.max(0, (radius - d) / t + 0.5))
        const o = (j * this.width + i) * 4
        const value = Math.round(amount * 255)
        if (value <= this.data[o]) continue
        // Fall direction: forwards, splayed outwards by how far off the centreline the stalk stood.
        const out = d > 1e-6 ? 1 / d : 0
        let fx = travel ? dirX / travel : 0
        let fz = travel ? dirZ / travel : 0
        const splay = travel ? 0.7 * Math.min(1, d / Math.max(radius, 1e-6)) : 1
        fx += dx * out * splay
        fz += dz * out * splay
        const len = Math.hypot(fx, fz) || 1
        this.data[o] = value
        this.data[o + 1] = Math.round((fx / len) * 127.5 + 127.5)
        this.data[o + 2] = Math.round((fz / len) * 127.5 + 127.5)
        changed = true
      }
    }
    if (changed) this.version++
    return changed
  }

  /** Flattened amount (0 standing … 1 flat) of the texel containing (x, z); 0 outside the map. */
  sample(x: number, z: number): number {
    const i = Math.floor((x - this.minX) / this.texel)
    const j = Math.floor((z - this.minZ) / this.texel)
    if (i < 0 || j < 0 || i >= this.width || j >= this.height) return 0
    return this.data[(j * this.width + i) * 4] / 255
  }

  /** Stands every stalk back up. */
  clear(): void {
    for (let o = 0; o < this.data.length; o += 4) {
      this.data[o] = 0
      this.data[o + 1] = 255
      this.data[o + 2] = 128
      this.data[o + 3] = 255
    }
    this.version++
  }
}
