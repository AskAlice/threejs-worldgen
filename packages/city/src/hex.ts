import { cellArea, cellToBoundary, cellToChildren, cellToLatLng, cellToParent, getHexagonEdgeLengthAvg, getResolution, gridDisk, h3IndexToSplitLong, latLngToCell } from 'h3-js'
import type { LocalFrame, Vec3, World } from 'threejs-biomes'

/** H3's Earth radius (authalic), metres. Published H3 cell sizes are for a sphere this big. */
export const H3_EARTH_RADIUS = 6_371_007.180918475

/**
 * Where a flat world's origin sits on H3's globe, `[latitude, longitude]` in degrees: on the equator,
 * at the longitude farthest (3900 km) from H3's 12 pentagons, so flat worlds only ever see hexagons.
 */
export const PLANE_ANCHOR: readonly [number, number] = [0, -40.5]

const RAD = Math.PI / 180

/**
 * The H3 hexagonal hierarchical index laid over a world.
 *
 * - **Planets** use their own directions: a planet-centred point maps to latitude
 *   `asin(y / |p|)` and longitude `atan2(x, z)`, the same convention as `World.frameAt`. A resolution's
 *   metric size scales with the radius: edge(res) = H3 edge(res) × radius / 6 371 007 m. On a 120 km
 *   planet, resolution 8 (531 m on Earth) is 10 m across; resolution 3 (69 km on Earth) is 1.3 km.
 * - **Flat worlds** map local metres onto an Earth-sized globe near the equator (equirectangular around
 *   {@link PLANE_ANCHOR}): latitude = −z / R⊕, longitude = anchor + x / R⊕. Cell sizes then match H3's
 *   published resolutions in metres (res 8 ≈ 531 m edge, 0.74 km²). Within ±2000 km of the origin cells
 *   are within 5 % of their nominal size; beyond that they stretch east–west by 1 / cos(latitude).
 *
 * Local positions are `[x, z]` in a `LocalFrame` (x east, z south): the world itself on flat worlds,
 * a tangent plane (gnomonic projection) on planets.
 *
 * @example
 * ```ts
 * const grid = new HexGrid(world)
 * const res = grid.resolutionFor(400)          // the resolution whose edge is nearest 400 m
 * const cell = grid.cellAtLocal(120, -40, res)
 * grid.centerLocal(cell)                       // [x, z] of the cell centre
 * grid.boundaryLocal(cell)                     // hexagon corners, [x, z][]
 * ```
 */
export class HexGrid {
  /** The world the index is laid over. */
  readonly world: World
  private readonly fixedFrame?: LocalFrame

  /**
   * Lays the index over `world`.
   * @param frame Local frame for `…Local` positions (default: `world.frame`, followed across world changes). */
  constructor(world: World, frame?: LocalFrame) {
    this.world = world
    this.fixedFrame = frame
  }

  /** Frame that local `[x, z]` positions are in. */
  get frame(): LocalFrame {
    return this.fixedFrame ?? this.world.frame
  }

  /** True on planets. */
  get sphere(): boolean {
    return this.world.options.surface === 'sphere'
  }

  /** Metres per radian of H3 latitude/longitude: the planet radius, or H3's Earth radius on flat worlds. */
  get scale(): number {
    return this.sphere ? this.world.options.radius : H3_EARTH_RADIUS
  }

  /** Linear size of this world's cells relative to H3's published Earth sizes (1 on flat worlds). */
  get sizeFactor(): number {
    return this.scale / H3_EARTH_RADIUS
  }

  /** Average hexagon edge length at `res` on this world, metres. */
  edgeLength(res: number): number {
    return getHexagonEdgeLengthAvg(res, 'm') * this.sizeFactor
  }

  /** The resolution (0…15) whose average edge length is closest (in ratio) to `metres` on this world. */
  resolutionFor(metres: number): number {
    let best = 0, bestErr = Infinity
    for (let r = 0; r <= 15; r++) {
      const err = Math.abs(Math.log(this.edgeLength(r) / metres))
      if (err < bestErr) { bestErr = err; best = r }
    }
    return best
  }

  /** `[latitude, longitude]` in degrees of a base-surface world position (planet-centred, or `[x, ·, z]`). */
  toLatLng(px: number, py: number, pz: number): [number, number] {
    if (this.sphere) {
      const len = Math.hypot(px, py, pz) || 1
      return [Math.asin(Math.max(-1, Math.min(1, py / len))) / RAD, Math.atan2(px, pz) / RAD]
    }
    return [-pz / H3_EARTH_RADIUS / RAD + PLANE_ANCHOR[0], px / H3_EARTH_RADIUS / RAD + PLANE_ANCHOR[1]]
  }

  /** Base-surface world position of a latitude/longitude in degrees (on the sphere, or `[x, 0, z]`). */
  fromLatLng(lat: number, lng: number, out: Vec3 = [0, 0, 0]): Vec3 {
    if (this.sphere) {
      const R = this.world.options.radius, la = lat * RAD, lo = lng * RAD
      out[0] = Math.cos(la) * Math.sin(lo) * R; out[1] = Math.sin(la) * R; out[2] = Math.cos(la) * Math.cos(lo) * R
      return out
    }
    let dl = lng - PLANE_ANCHOR[1]
    dl -= Math.round(dl / 360) * 360
    out[0] = dl * RAD * H3_EARTH_RADIUS; out[1] = 0; out[2] = -(lat - PLANE_ANCHOR[0]) * RAD * H3_EARTH_RADIUS
    return out
  }

  /** Local `[x, z]` of a base-surface world position (NaN on the far side of a planet). */
  toLocal(p: Vec3, out: [number, number] = [0, 0]): [number, number] {
    if (!this.sphere) { out[0] = p[0]; out[1] = p[2]; return out }
    const f = this.frame, u = f.up, R = this.world.options.radius
    const len = Math.hypot(p[0], p[1], p[2]) || 1
    const cos = (p[0] * u[0] + p[1] * u[1] + p[2] * u[2]) / len
    if (cos <= 1e-6) { out[0] = NaN; out[1] = NaN; return out }
    // Gnomonic: scale the direction onto the frame's tangent plane (inverse of `frame.basePoint`).
    const t = R / (cos * len)
    const qx = p[0] * t - f.origin[0], qy = p[1] * t - f.origin[1], qz = p[2] * t - f.origin[2]
    out[0] = qx * f.east[0] + qy * f.east[1] + qz * f.east[2]
    out[1] = -(qx * f.north[0] + qy * f.north[1] + qz * f.north[2])
    return out
  }

  /** Base-surface world position under local `[x, z]` (on the sphere, or `[x, 0, z]`). */
  fromLocal(x: number, z: number, out: Vec3 = [0, 0, 0]): Vec3 {
    if (!this.sphere) { out[0] = x; out[1] = 0; out[2] = z; return out }
    const p = this.frame.basePoint(x, z, out)
    const k = this.world.options.radius / (Math.hypot(p[0], p[1], p[2]) || 1)
    out[0] *= k; out[1] *= k; out[2] *= k
    return out
  }

  /** Cell containing a base-surface world position. */
  cellAt(px: number, py: number, pz: number, res: number): string {
    const [lat, lng] = this.toLatLng(px, py, pz)
    return latLngToCell(lat, lng, res)
  }

  /** Cell containing local `[x, z]`. */
  cellAtLocal(x: number, z: number, res: number): string {
    const p = this.fromLocal(x, z, this.p)
    return this.cellAt(p[0], p[1], p[2], res)
  }

  /** Base-surface world position of a cell's centre. */
  center(cell: string, out: Vec3 = [0, 0, 0]): Vec3 {
    const [lat, lng] = cellToLatLng(cell)
    return this.fromLatLng(lat, lng, out)
  }

  /** Local `[x, z]` of a cell's centre. */
  centerLocal(cell: string, out: [number, number] = [0, 0]): [number, number] {
    return this.toLocal(this.center(cell, this.p), out)
  }

  /** Corners of a cell (6, or 5 for pentagons, plus extra points where it crosses an icosahedron edge) as local `[x, z]`, counter-clockwise seen from above. */
  boundaryLocal(cell: string): [number, number][] {
    return cellToBoundary(cell).map(([lat, lng]) => this.toLocal(this.fromLatLng(lat, lng, this.p), [0, 0]))
  }

  /** Area of a cell on this world, m². */
  area(cell: string): number {
    if (this.sphere) return cellArea(cell, 'm2') * this.sizeFactor ** 2
    const b = this.boundaryLocal(cell)
    let a = 0
    for (let i = 0; i < b.length; i++) {
      const [x0, z0] = b[i], [x1, z1] = b[(i + 1) % b.length]
      a += x0 * z1 - x1 * z0
    }
    return Math.abs(a) / 2
  }

  /** Every cell within `k` steps of `cell` (its k-ring disk, `cell` included). */
  disk(cell: string, k: number): string[] {
    return gridDisk(cell, k)
  }

  /** The ancestor of `cell` at a coarser resolution. */
  parent(cell: string, res: number): string {
    return cellToParent(cell, res)
  }

  /** The descendants of `cell` at a finer resolution (7 per level; 6 under pentagons). */
  children(cell: string, res: number): string[] {
    return cellToChildren(cell, res)
  }

  /** Resolution of a cell. */
  resolution(cell: string): number {
    return getResolution(cell)
  }

  private p: Vec3 = [0, 0, 0]
}

/** Two 32-bit integers identifying a cell, for hashing. */
export function cellKey(cell: string): [number, number] {
  return h3IndexToSplitLong(cell) as [number, number]
}
