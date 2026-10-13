import { pointSegment, segmentIntersection, segmentsTouch } from './polygon.ts'

/** Road classes, widest first. */
export type RoadType = 'primary' | 'secondary' | 'minor'

/** Road surfaces, best first. Each has its own look in the road shader. */
export type RoadSurface = 'asphalt' | 'cobblestone' | 'gravel' | 'dirt'

/** Every road surface, best first (the shader indexes by this order). */
export const ROAD_SURFACES: readonly RoadSurface[] = ['asphalt', 'cobblestone', 'gravel', 'dirt']

/** An intersection, bend or dead end. */
export interface RoadNode {
  /** Index in {@link RoadGraph.nodes}. */
  id: number
  /** Position (frame-local), metres. */
  x: number
  /** Position (frame-local), metres. */
  z: number
  /** Road surface height (local y) after grading; `NaN` until {@link gradeRoads} runs. */
  y: number
  /** Ids of the edges meeting here. */
  edges: number[]
}

/** A straight road segment between two nodes. */
export interface RoadEdge {
  /** Index in {@link RoadGraph.edges}. */
  id: number
  /** Start node id. */
  a: number
  /** End node id. */
  b: number
  /** Road class. */
  type: RoadType
  /** Carriageway width (kerb to kerb), metres. */
  width: number
  /** Sidewalk width on each side, metres (0 on rural roads: no kerbs). */
  sidewalk: number
  /** Surface material. */
  surface: RoadSurface
  /** True where the segment spans water on a bridge deck. */
  bridge: boolean
}

/** Result of {@link RoadGraph.nearestEdge} and {@link RoadGraph.firstCrossing}. */
export interface EdgeHit {
  /** Edge id. */
  edge: number
  /** Position along the edge, 0 at `a` … 1 at `b`. */
  u: number
  /** Hit point. */
  x: number
  /** Hit point. */
  z: number
  /** Distance from the query point (nearestEdge) or parameter along the query segment (firstCrossing). */
  distance: number
}

/** Plain-data road graph (see {@link RoadGraph.toJSON}). */
export interface RoadGraphJSON {
  /** Nodes. */
  nodes: RoadNode[]
  /** Edges. */
  edges: RoadEdge[]
}

/**
 * A planar road graph: every crossing of two roads is a node. {@link RoadGraph.addEdge} refuses
 * edges that would cross or touch another edge away from a shared node, so the graph stays planar
 * by construction. Spatially hashed for fast snapping and crossing queries, and plain data
 * (`toJSON`) so crowds and vehicles can navigate it.
 */
export class RoadGraph {
  /** All nodes, by id. */
  readonly nodes: RoadNode[] = []
  /** All edges, by id. */
  readonly edges: RoadEdge[] = []
  /** Spatial hash cell size, metres. */
  readonly cellSize: number
  private edgeCells = new Map<number, number[]>()
  private nodeCells = new Map<number, number[]>()

  /** Creates an empty graph; `cellSize` should be about the typical segment length. */
  constructor(cellSize = 40) {
    this.cellSize = cellSize
  }

  private key(i: number, j: number): number {
    return ((i + 32768) & 0xffff) | (((j + 32768) & 0xffff) << 16)
  }

  /** Adds a node and returns its id. */
  addNode(x: number, z: number): number {
    const id = this.nodes.length
    this.nodes.push({ id, x, z, y: NaN, edges: [] })
    const k = this.key(Math.floor(x / this.cellSize), Math.floor(z / this.cellSize))
    const list = this.nodeCells.get(k)
    if (list) list.push(id)
    else this.nodeCells.set(k, [id])
    return id
  }

  private indexEdge(id: number) {
    const e = this.edges[id]
    const a = this.nodes[e.a], b = this.nodes[e.b]
    const cs = this.cellSize
    const i0 = Math.floor(Math.min(a.x, b.x) / cs), i1 = Math.floor(Math.max(a.x, b.x) / cs)
    const j0 = Math.floor(Math.min(a.z, b.z) / cs), j1 = Math.floor(Math.max(a.z, b.z) / cs)
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = this.key(i, j)
      const list = this.edgeCells.get(k)
      if (list) list.push(id)
      else this.edgeCells.set(k, [id])
    }
  }

  /** Edge ids whose cells overlap the box (may contain duplicates and false positives). */
  private edgesNear(minX: number, minZ: number, maxX: number, maxZ: number, out: Set<number>): Set<number> {
    out.clear()
    const cs = this.cellSize
    for (let i = Math.floor(minX / cs); i <= Math.floor(maxX / cs); i++) for (let j = Math.floor(minZ / cs); j <= Math.floor(maxZ / cs); j++) {
      const list = this.edgeCells.get(this.key(i, j))
      if (list) for (const e of list) out.add(e)
    }
    return out
  }
  private near = new Set<number>()

  /** Ids of edges that may overlap the box (a superset: check the geometry). */
  edgesInBox(minX: number, minZ: number, maxX: number, maxZ: number): number[] {
    return [...this.edgesNear(minX, minZ, maxX, maxZ, new Set())]
  }

  /** The other end of edge `e` seen from node `n`. */
  other(e: number, n: number): number {
    const edge = this.edges[e]
    return edge.a === n ? edge.b : edge.a
  }

  /** Edge id connecting nodes `a` and `b`, or −1. */
  edgeBetween(a: number, b: number): number {
    for (const e of this.nodes[a].edges) if (this.other(e, a) === b) return e
    return -1
  }

  /** Length of edge `e`, metres. */
  length(e: number): number {
    const edge = this.edges[e]
    const a = this.nodes[edge.a], b = this.nodes[edge.b]
    return Math.hypot(b.x - a.x, b.z - a.z)
  }

  /**
   * True if segment a→b (between nodes `na` and `nb`, which may be −1) would touch any edge not
   * sharing one of those nodes. `skipEdge` is ignored (the edge about to be split at b).
   */
  crosses(ax: number, az: number, bx: number, bz: number, na = -1, nb = -1, skipEdge = -1): boolean {
    const near = this.edgesNear(Math.min(ax, bx) - 0.01, Math.min(az, bz) - 0.01, Math.max(ax, bx) + 0.01, Math.max(az, bz) + 0.01, this.near)
    for (const id of near) {
      if (id === skipEdge) continue
      const e = this.edges[id]
      if (e.a === na || e.b === na || e.a === nb || e.b === nb) {
        // Sharing a node is fine, unless the edges overlap along their length.
        const shared = e.a === na || e.a === nb ? e.a : e.b
        const far = this.nodes[shared === e.a ? e.b : e.a]
        const mine = shared === na ? [bx, bz] : [ax, az]
        const s = this.nodes[shared]
        const d1x = far.x - s.x, d1z = far.z - s.z, d2x = mine[0] - s.x, d2z = mine[1] - s.z
        const cross = d1x * d2z - d1z * d2x, dot = d1x * d2x + d1z * d2z
        if (dot > 0 && Math.abs(cross) < 1e-6 * Math.hypot(d1x, d1z) * Math.hypot(d2x, d2z)) return true
        continue
      }
      const a = this.nodes[e.a], b = this.nodes[e.b]
      if (segmentsTouch(ax, az, bx, bz, a.x, a.z, b.x, b.z, 1e-4)) return true
    }
    return false
  }

  /**
   * Adds an edge between existing nodes. Returns its id, or −1 (and changes nothing) if it would
   * break planarity, duplicate an edge, or have zero length.
   */
  addEdge(a: number, b: number, type: RoadType, width: number, sidewalk: number, bridge = false): number {
    if (a === b || this.edgeBetween(a, b) >= 0) return -1
    const na = this.nodes[a], nb = this.nodes[b]
    if (Math.hypot(nb.x - na.x, nb.z - na.z) < 1e-3) return -1
    if (this.crosses(na.x, na.z, nb.x, nb.z, a, b)) return -1
    // A node lying on the new edge would be a crossing without a node.
    const cs = this.cellSize
    for (let i = Math.floor(Math.min(na.x, nb.x) / cs); i <= Math.floor(Math.max(na.x, nb.x) / cs); i++) {
      for (let j = Math.floor(Math.min(na.z, nb.z) / cs); j <= Math.floor(Math.max(na.z, nb.z) / cs); j++) {
        for (const n of this.nodeCells.get(this.key(i, j)) ?? []) {
          if (n === a || n === b) continue
          const p = this.nodes[n]
          if (pointSegment(p.x, p.z, na.x, na.z, nb.x, nb.z).distance < 1e-4) return -1
        }
      }
    }
    return this.pushEdge(a, b, type, width, sidewalk, bridge)
  }

  private pushEdge(a: number, b: number, type: RoadType, width: number, sidewalk: number, bridge: boolean): number {
    const id = this.edges.length
    this.edges.push({ id, a, b, type, width, sidewalk, surface: 'asphalt', bridge })
    this.nodes[a].edges.push(id)
    this.nodes[b].edges.push(id)
    this.indexEdge(id)
    return id
  }

  /** Splits edge `e` at (x, z) (projected onto it) with a new node; returns the node id. */
  splitEdge(e: number, x: number, z: number): number {
    const edge = this.edges[e]
    const a = this.nodes[edge.a], b = this.nodes[edge.b]
    const { t } = pointSegment(x, z, a.x, a.z, b.x, b.z)
    const n = this.addNode(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)
    const oldB = edge.b
    // Edge e becomes a→n (its hash cells are a superset, which queries tolerate); n→b is new.
    const ends = this.nodes[oldB].edges
    ends.splice(ends.indexOf(e), 1)
    edge.b = n
    this.nodes[n].edges.push(e)
    this.edges[this.pushEdge(n, oldB, edge.type, edge.width, edge.sidewalk, edge.bridge)].surface = edge.surface
    return n
  }

  /** Nearest node within `radius` of (x, z), skipping ids in `skip`; −1 if none. */
  nearestNode(x: number, z: number, radius: number, skip?: (id: number) => boolean): number {
    const cs = this.cellSize
    let best = -1, bestD = radius
    for (let i = Math.floor((x - radius) / cs); i <= Math.floor((x + radius) / cs); i++) {
      for (let j = Math.floor((z - radius) / cs); j <= Math.floor((z + radius) / cs); j++) {
        for (const n of this.nodeCells.get(this.key(i, j)) ?? []) {
          if (skip?.(n)) continue
          const d = Math.hypot(this.nodes[n].x - x, this.nodes[n].z - z)
          if (d <= bestD) { bestD = d; best = n }
        }
      }
    }
    return best
  }

  /** Nearest point on any edge within `radius` of (x, z), skipping edges for which `skip` is true. */
  nearestEdge(x: number, z: number, radius: number, skip?: (id: number) => boolean): EdgeHit | null {
    let best: EdgeHit | null = null
    for (const id of this.edgesNear(x - radius, z - radius, x + radius, z + radius, this.near)) {
      if (skip?.(id)) continue
      const e = this.edges[id]
      const a = this.nodes[e.a], b = this.nodes[e.b]
      const { distance, t } = pointSegment(x, z, a.x, a.z, b.x, b.z)
      if (distance <= radius && (!best || distance < best.distance)) {
        best = { edge: id, u: t, x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, distance }
      }
    }
    return best
  }

  /** First edge crossed by segment a→b (nearest to a), ignoring edges at node `skipNode`. `distance` is the parameter along a→b. */
  firstCrossing(ax: number, az: number, bx: number, bz: number, skipNode = -1): EdgeHit | null {
    let best: EdgeHit | null = null
    for (const id of this.edgesNear(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), this.near)) {
      const e = this.edges[id]
      if (e.a === skipNode || e.b === skipNode) continue
      const a = this.nodes[e.a], b = this.nodes[e.b]
      const hit = segmentIntersection(ax, az, bx, bz, a.x, a.z, b.x, b.z)
      if (hit && (!best || hit.t < best.distance)) best = { edge: id, u: hit.u, x: ax + (bx - ax) * hit.t, z: az + (bz - az) * hit.t, distance: hit.t }
    }
    return best
  }

  /** Total road length, metres (optionally only one class). */
  totalLength(type?: RoadType): number {
    let l = 0
    for (const e of this.edges) if (!type || e.type === type) l += this.length(e.id)
    return l
  }

  /**
   * Shortest route between two nodes along the roads (A*). Returns node ids from `from` to `to`,
   * or an empty array if they are not connected. `cost` can weight edges (default: length).
   */
  shortestPath(from: number, to: number, cost: (edge: RoadEdge, length: number) => number = (_e, l) => l): number[] {
    const n = this.nodes.length
    const g = new Float64Array(n).fill(Infinity)
    const prev = new Int32Array(n).fill(-1)
    const closed = new Uint8Array(n)
    const target = this.nodes[to]
    const h = (i: number) => Math.hypot(this.nodes[i].x - target.x, this.nodes[i].z - target.z)
    const open = new MinHeap()
    g[from] = 0
    open.push(from, h(from))
    while (open.size) {
      const cur = open.pop()
      if (cur === to) break
      if (closed[cur]) continue
      closed[cur] = 1
      for (const e of this.nodes[cur].edges) {
        const nx = this.other(e, cur)
        const d = g[cur] + cost(this.edges[e], this.length(e))
        if (d < g[nx]) { g[nx] = d; prev[nx] = cur; open.push(nx, d + h(nx)) }
      }
    }
    if (from !== to && prev[to] < 0) return []
    const path = [to]
    while (path[path.length - 1] !== from) path.push(prev[path[path.length - 1]])
    return path.reverse()
  }

  /** Plain-data copy (nodes and edges), e.g. to send to a worker or save. */
  toJSON(): RoadGraphJSON {
    return { nodes: this.nodes.map((n) => ({ ...n, edges: n.edges.slice() })), edges: this.edges.map((e) => ({ ...e })) }
  }
}

/** Binary min-heap of ids keyed by priority (ties: insertion order), shared by A* and road growth. */
export class MinHeap {
  private ids: number[] = []
  private keys: number[] = []
  private order: number[] = []
  private counter = 0
  /** Number of queued entries. */
  get size(): number {
    return this.ids.length
  }
  /** Queues `id` with priority `key`. */
  push(id: number, key: number): void {
    const ids = this.ids, keys = this.keys, ord = this.order
    let i = ids.length
    ids.push(id); keys.push(key); ord.push(this.counter++)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (keys[p] < keys[i] || (keys[p] === keys[i] && ord[p] < ord[i])) break
      this.swap(i, p)
      i = p
    }
  }
  /** Removes and returns the id with the smallest key. */
  pop(): number {
    const ids = this.ids, keys = this.keys, ord = this.order
    const top = ids[0]
    const last = ids.length - 1
    this.swap(0, last)
    ids.pop(); keys.pop(); ord.pop()
    let i = 0
    for (;;) {
      const l = i * 2 + 1, r = l + 1
      let m = i
      const less = (x: number, y: number) => keys[x] < keys[y] || (keys[x] === keys[y] && ord[x] < ord[y])
      if (l < ids.length && less(l, m)) m = l
      if (r < ids.length && less(r, m)) m = r
      if (m === i) break
      this.swap(i, m)
      i = m
    }
    return top
  }
  private swap(i: number, j: number) {
    const ids = this.ids, keys = this.keys, ord = this.order
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    ;[keys[i], keys[j]] = [keys[j], keys[i]]
    ;[ord[i], ord[j]] = [ord[j], ord[i]]
  }
}
