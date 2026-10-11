import { hash4 } from 'threejs-biomes'

/** A point on a {@link Path}. */
export interface PathSample {
  /** Position. */
  x: number
  /** Position. */
  y: number
  /** Position. */
  z: number
  /** Unit tangent (direction of travel). */
  tx: number
  /** Unit tangent. */
  ty: number
  /** Unit tangent. */
  tz: number
}

/** Creates an empty {@link PathSample}. */
export function createPathSample(): PathSample {
  return { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 1 }
}

/**
 * Catmull-Rom spline through `points`, sampled `subdivisions` times per segment, as a flat xyz array.
 * Closed curves wrap around; open ones keep their end points.
 */
export function catmullRom(points: readonly (readonly number[])[], closed: boolean, subdivisions = 8): number[] {
  const n = points.length
  if (n < 3 || subdivisions <= 1) return points.flatMap((p) => [p[0], p[1], p[2]])
  const at = (i: number) => points[closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i))]
  const out: number[] = []
  const segs = closed ? n : n - 1
  for (let i = 0; i < segs; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2)
    for (let s = 0; s < subdivisions; s++) {
      const t = s / subdivisions, t2 = t * t, t3 = t2 * t
      for (let k = 0; k < 3; k++) {
        out.push(0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3))
      }
    }
  }
  if (!closed) out.push(points[n - 1][0], points[n - 1][1], points[n - 1][2])
  return out
}

/**
 * A polyline with arc-length lookup: rails, flight paths, shipping lanes, roads without a graph.
 * Closed paths loop; open paths are driven back and forth (vehicles turn round at the ends).
 */
export class Path {
  /** xyz per vertex. */
  readonly points: Float64Array
  /** Distance from the start to each vertex. */
  readonly distances: Float64Array
  /** Total length, metres (closed paths include the closing segment). */
  readonly length: number
  /** Whether the path loops. */
  readonly closed: boolean

  /** Builds a path through `points`; `smooth` > 1 runs a Catmull-Rom spline with that many samples per segment. */
  constructor(points: readonly (readonly number[])[], closed = true, smooth = 8) {
    const flat = catmullRom(points, closed, smooth)
    if (closed && flat.length >= 6) flat.push(flat[0], flat[1], flat[2])
    this.points = new Float64Array(flat)
    this.closed = closed
    const n = flat.length / 3
    this.distances = new Float64Array(n)
    for (let i = 1; i < n; i++) {
      this.distances[i] = this.distances[i - 1] + Math.hypot(flat[i * 3] - flat[i * 3 - 3], flat[i * 3 + 1] - flat[i * 3 - 2], flat[i * 3 + 2] - flat[i * 3 - 1])
    }
    this.length = n ? this.distances[n - 1] : 0
  }

  /**
   * Position and travel direction at distance `s` from the start (wrapped on closed paths, ping-pong on
   * open ones, where the tangent flips on the way back).
   */
  sample(s: number, out: PathSample = createPathSample()): PathSample {
    const L = this.length, n = this.distances.length
    if (n < 2 || L <= 0) {
      out.x = this.points[0] ?? 0; out.y = this.points[1] ?? 0; out.z = this.points[2] ?? 0
      return out
    }
    let d = s, dir = 1
    if (this.closed) d = ((s % L) + L) % L
    else {
      d = ((s % (2 * L)) + 2 * L) % (2 * L)
      if (d > L) { d = 2 * L - d; dir = -1 }
    }
    // Binary search for the segment.
    let lo = 0, hi = n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (this.distances[mid] <= d) lo = mid
      else hi = mid
    }
    const seg = this.distances[hi] - this.distances[lo] || 1
    const t = (d - this.distances[lo]) / seg
    const p = this.points
    const ax = p[lo * 3], ay = p[lo * 3 + 1], az = p[lo * 3 + 2]
    const bx = p[hi * 3], by = p[hi * 3 + 1], bz = p[hi * 3 + 2]
    out.x = ax + (bx - ax) * t; out.y = ay + (by - ay) * t; out.z = az + (bz - az) * t
    const len = Math.hypot(bx - ax, by - ay, bz - az) || 1
    out.tx = ((bx - ax) / len) * dir; out.ty = ((by - ay) / len) * dir; out.tz = ((bz - az) / len) * dir
    return out
  }
}

/** A circle of `segments` points (closed path input) around `center` at height `center[1]`. */
export function circlePoints(center: readonly number[], radius: number, segments = 48, clockwise = false): [number, number, number][] {
  const pts: [number, number, number][] = []
  for (let i = 0; i < segments; i++) {
    const a = ((clockwise ? -i : i) / segments) * Math.PI * 2
    pts.push([center[0] + Math.cos(a) * radius, center[1], center[2] + Math.sin(a) * radius])
  }
  return pts
}

/**
 * The road network vehicles drive on. `RoadGraph` from threejs-city fits as is (`city.graph`), but any
 * planar graph with these fields works.
 */
export interface RoadNetwork {
  /** Intersections; `y` may be NaN (then a height function or 0 is used). */
  readonly nodes: readonly { readonly x: number; readonly y: number; readonly z: number; readonly edges: readonly number[] }[]
  /** Straight road segments between nodes. */
  readonly edges: readonly { readonly a: number; readonly b: number; readonly width: number }[]
}

/** A pose on the road network. */
export interface RoadPose {
  /** Position (lane centre). */
  x: number
  /** Position. */
  y: number
  /** Position. */
  z: number
  /** Heading, radians (0 = +z, π/2 = +x). */
  yaw: number
  /** Climb angle, radians. */
  pitch: number
}

/**
 * Drives many vehicles over a road network: each one keeps to its lane, picks a seeded turn at every
 * junction (never a U-turn unless it's a dead end) and rounds corners on a curve instead of snapping.
 * State is in typed arrays, one slot per vehicle.
 */
export class RoadNavigator {
  /** The network. */
  readonly roads: RoadNetwork
  /** Current edge per vehicle (−1 = not placed). */
  readonly edge: Int32Array
  /** Node the vehicle came from (start of its current edge in travel direction). */
  readonly from: Int32Array
  /** Edge chosen for after the next junction. */
  readonly next: Int32Array
  /** Metres travelled along the current edge. */
  readonly u: Float64Array
  /** Corner radius at the end of the current edge. */
  readonly cornerOut: Float32Array
  /** Corner radius at the start of the current edge (shared with the previous edge). */
  readonly cornerIn: Float32Array
  /** Direction (x, z) of the previous edge, for the corner just rounded. */
  readonly prevDir: Float32Array
  /** Junctions passed (seeds the next choice). */
  readonly visits: Uint32Array
  /** Seed for turn choices. */
  seed: number
  /** Drive on the left instead of the right. */
  leftHand = false
  /** Ground height for nodes without `y`. */
  height: ((x: number, z: number) => number) | null = null
  /** Largest corner radius, metres. */
  maxCorner = 7

  /** Navigation state for `count` vehicles. */
  constructor(roads: RoadNetwork, count: number, seed = 1) {
    this.roads = roads
    this.seed = seed
    this.edge = new Int32Array(count).fill(-1)
    this.from = new Int32Array(count)
    this.next = new Int32Array(count)
    this.u = new Float64Array(count)
    this.cornerOut = new Float32Array(count)
    this.cornerIn = new Float32Array(count)
    this.prevDir = new Float32Array(count * 2)
    this.visits = new Uint32Array(count)
  }

  /** Length of edge `e`, metres. */
  length(e: number): number {
    const ed = this.roads.edges[e], a = this.roads.nodes[ed.a], b = this.roads.nodes[ed.b]
    return Math.hypot(b.x - a.x, b.z - a.z)
  }

  private other(e: number, n: number): number {
    const ed = this.roads.edges[e]
    return ed.a === n ? ed.b : ed.a
  }

  private dir(e: number, from: number, out: Float32Array | number[], o: number): void {
    const a = this.roads.nodes[from], b = this.roads.nodes[this.other(e, from)]
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1
    out[o] = (b.x - a.x) / l
    out[o + 1] = (b.z - a.z) / l
  }

  private choose(i: number): void {
    const e = this.edge[i], at = this.other(e, this.from[i])
    const options = this.roads.nodes[at].edges.filter((x) => x !== e && this.length(x) > 0.5)
    const h = hash4(this.seed, i, this.visits[i]++, 0x7a3)
    this.next[i] = options.length ? options[h % options.length] : e
    const len = this.length(e), nextLen = this.length(this.next[i])
    this.cornerOut[i] = this.next[i] === e ? 0 : Math.min(this.maxCorner, len / 2.5, nextLen / 2.5)
  }

  /** Puts vehicle `i` at a seeded spot on the network. Returns false if the network has no usable edge. */
  place(i: number, salt = 0): boolean {
    const edges = this.roads.edges
    if (!edges.length) return false
    for (let attempt = 0; attempt < 16; attempt++) {
      const h = hash4(this.seed, i, attempt, salt + 0x51)
      const e = h % edges.length
      const len = this.length(e)
      if (len < 1) continue
      this.edge[i] = e
      this.from[i] = (h >>> 8) & 1 ? edges[e].a : edges[e].b
      this.u[i] = ((h >>> 9) / 8388608) * len * 0.8 + len * 0.1
      this.cornerIn[i] = 0
      this.dir(e, this.from[i], this.prevDir, i * 2)
      this.choose(i)
      return true
    }
    return false
  }

  /** Moves vehicle `i` forward by `ds` metres, turning onto chosen edges at junctions. */
  advance(i: number, ds: number): void {
    let e = this.edge[i]
    if (e < 0) return
    this.u[i] += ds
    let len = this.length(e)
    for (let guard = 0; this.u[i] >= len && guard < 32; guard++) {
      this.u[i] -= len
      this.dir(e, this.from[i], this.prevDir, i * 2)
      const at = this.other(e, this.from[i])
      this.cornerIn[i] = this.cornerOut[i]
      e = this.next[i]
      this.edge[i] = e
      this.from[i] = at
      len = this.length(e)
      this.choose(i)
    }
  }

  private nodeY(n: number): number {
    const node = this.roads.nodes[n]
    return Number.isFinite(node.y) ? node.y : this.height ? this.height(node.x, node.z) : 0
  }

  /** Current pose of vehicle `i`, on the right-hand (or left-hand) lane, corners rounded. */
  pose(i: number, out: RoadPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }): RoadPose {
    const e = this.edge[i]
    if (e < 0) return out
    const ed = this.roads.edges[e]
    const a = this.roads.nodes[this.from[i]], bId = this.other(e, this.from[i]), b = this.roads.nodes[bId]
    const len = this.length(e) || 1
    const u = this.u[i]
    const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len
    let x = a.x + dx * u, z = a.z + dz * u, tx = dx, tz = dz
    const rOut = this.cornerOut[i], rIn = this.cornerIn[i]
    // Quadratic Bézier through the junction: P0 = N − d_in·r, P2 = N + d_out·r.
    const corner = (nx: number, nz: number, ix: number, iz: number, ox: number, oz: number, r: number, t: number) => {
      const p0x = nx - ix * r, p0z = nz - iz * r, p2x = nx + ox * r, p2z = nz + oz * r
      const m = 1 - t
      x = m * m * p0x + 2 * m * t * nx + t * t * p2x
      z = m * m * p0z + 2 * m * t * nz + t * t * p2z
      tx = m * ix + t * ox; tz = m * iz + t * oz
      const l = Math.hypot(tx, tz) || 1
      tx /= l; tz /= l
    }
    if (rOut > 0 && u > len - rOut) {
      const o = [0, 0]
      this.dir(this.next[i], bId, o, 0)
      corner(b.x, b.z, dx, dz, o[0], o[1], rOut, (u - (len - rOut)) / (2 * rOut))
    } else if (rIn > 0 && u < rIn) {
      corner(a.x, a.z, this.prevDir[i * 2], this.prevDir[i * 2 + 1], dx, dz, rIn, 0.5 + u / (2 * rIn))
    }
    const lane = (ed.width / 4) * (this.leftHand ? -1 : 1)
    // Right of travel direction (tx, tz) with y up is (−tz, tx).
    out.x = x - tz * lane
    out.z = z + tx * lane
    const ya = this.nodeY(this.from[i]), yb = this.nodeY(bId)
    out.y = ya + (yb - ya) * Math.max(0, Math.min(1, u / len))
    out.yaw = Math.atan2(tx, tz)
    out.pitch = Math.atan2(yb - ya, len)
    return out
  }
}
