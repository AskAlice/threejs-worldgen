import type { LocalFrame, WorldSample } from 'threejs-biomes'

/** Ground under one point: terrain height and the water surface there (`NaN` where dry). */
export interface SitePoint {
  /** Terrain height (local y), metres. */
  height: number
  /** Water surface height, or `NaN` where the ground is dry. */
  waterLevel: number
}

/** Anything that can say how high the ground is and whether it is under water. */
export type SiteFn = (x: number, z: number) => SitePoint

/**
 * The ground under a settlement, sampled once on a regular grid so the whole generator (roads,
 * lots, terrain flattening) reads cheap bilinear lookups instead of the full world noise. Pure data:
 * build it from a world frame with {@link Site.fromFrame}, or from any {@link SiteFn} (tests do).
 */
export class Site {
  /** West edge (min x) of the grid. */
  readonly minX: number
  /** North edge (min z) of the grid. */
  readonly minZ: number
  /** Grid spacing, metres. */
  readonly cell: number
  /** Samples per side. */
  readonly count: number
  /** Heights, row-major (z rows of x samples). */
  readonly heights: Float32Array
  /** Water surface per sample, `NaN` where dry. */
  readonly water: Float32Array

  /** Allocates an unsampled grid of `count × count` samples, `cell` metres apart, from (`minX`, `minZ`). */
  constructor(minX: number, minZ: number, cell: number, count: number) {
    this.minX = minX
    this.minZ = minZ
    this.cell = cell
    this.count = count
    this.heights = new Float32Array(count * count)
    this.water = new Float32Array(count * count)
  }

  /** Samples one grid row (`j`) from `fn`; {@link Site.fill} calls it for every row. */
  fillRow(fn: SiteFn, j: number): void {
    const n = this.count
    for (let i = 0; i < n; i++) {
      const p = fn(this.minX + i * this.cell, this.minZ + j * this.cell)
      this.heights[j * n + i] = p.height
      this.water[j * n + i] = p.waterLevel
    }
  }

  /** Samples every row. */
  fill(fn: SiteFn): this {
    for (let j = 0; j < this.count; j++) this.fillRow(fn, j)
    return this
  }

  /** A square grid centred on (`cx`, `cz`) reaching `radius` metres out, `cell` metres apart (unsampled). */
  static around(cx: number, cz: number, radius: number, cell: number): Site {
    const count = Math.max(2, Math.ceil((radius * 2) / cell) + 1)
    return new Site(cx - radius, cz - radius, cell, count)
  }

  /** Reads ground height and water from a world frame (`frame.sample`). */
  static frameFn(frame: LocalFrame): SiteFn {
    let s: WorldSample | undefined
    const out: SitePoint = { height: 0, waterLevel: NaN }
    return (x, z) => {
      s = frame.sample(x, z, s)
      out.height = s.elevation
      out.waterLevel = s.waterLevel > s.elevation ? s.waterLevel : NaN
      return out
    }
  }

  /** Builds and fills a grid from a world frame. */
  static fromFrame(frame: LocalFrame, cx: number, cz: number, radius: number, cell: number): Site {
    return Site.around(cx, cz, radius, cell).fill(Site.frameFn(frame))
  }

  /** Bilinear terrain height (clamped to the grid). */
  height(x: number, z: number): number {
    return this.bilinear(this.heights, x, z)
  }

  /** True where the ground is under water (more than half of the surrounding samples are wet). */
  wet(x: number, z: number): boolean {
    const n = this.count
    const fx = Math.min(n - 1, Math.max(0, (x - this.minX) / this.cell))
    const fz = Math.min(n - 1, Math.max(0, (z - this.minZ) / this.cell))
    const i = Math.min(n - 2, Math.floor(fx)), j = Math.min(n - 2, Math.floor(fz))
    const tx = fx - i, tz = fz - j
    const w = (k: number) => (this.water[k] === this.water[k] ? 1 : 0)
    const a = w(j * n + i) * (1 - tx) + w(j * n + i + 1) * tx
    const b = w((j + 1) * n + i) * (1 - tx) + w((j + 1) * n + i + 1) * tx
    return a * (1 - tz) + b * tz > 0.5
  }

  /** Highest water surface among the four surrounding samples, or `NaN` if all are dry. */
  waterLevel(x: number, z: number): number {
    const n = this.count
    const i = Math.min(n - 2, Math.max(0, Math.floor((x - this.minX) / this.cell)))
    const j = Math.min(n - 2, Math.max(0, Math.floor((z - this.minZ) / this.cell)))
    let level = NaN
    for (const k of [j * n + i, j * n + i + 1, (j + 1) * n + i, (j + 1) * n + i + 1]) {
      const w = this.water[k]
      if (w === w && !(level >= w)) level = w
    }
    return level
  }

  /** Height gradient (dh/dx, dh/dz) by central differences over one cell. */
  gradient(x: number, z: number, out: [number, number] = [0, 0]): [number, number] {
    const e = this.cell
    out[0] = (this.height(x + e, z) - this.height(x - e, z)) / (2 * e)
    out[1] = (this.height(x, z + e) - this.height(x, z - e)) / (2 * e)
    return out
  }

  /** Slope (rise / run). */
  slope(x: number, z: number): number {
    const g = this.gradient(x, z, this.g)
    return Math.hypot(g[0], g[1])
  }

  /** True if (x, z) lies inside the sampled area. */
  contains(x: number, z: number): boolean {
    const size = (this.count - 1) * this.cell
    return x >= this.minX && z >= this.minZ && x <= this.minX + size && z <= this.minZ + size
  }

  private g: [number, number] = [0, 0]

  private bilinear(a: Float32Array, x: number, z: number): number {
    const n = this.count
    const fx = Math.min(n - 1, Math.max(0, (x - this.minX) / this.cell))
    const fz = Math.min(n - 1, Math.max(0, (z - this.minZ) / this.cell))
    const i = Math.min(n - 2, Math.floor(fx)), j = Math.min(n - 2, Math.floor(fz))
    const tx = fx - i, tz = fz - j
    const k = j * n + i
    return (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - tz) + (a[k + n] * (1 - tx) + a[k + n + 1] * tx) * tz
  }
}
