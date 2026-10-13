import type { NetworkOptions, PopulationData, Settlement } from './model.ts'

/** Kind of link between settlements. */
export type NetworkType = 'highway' | 'road' | 'track' | 'rail' | 'powerline'

/** One link of a network, routed over the terrain. */
export interface NetworkEdge {
  /** Index in `Network.edges`. */
  id: number
  /** Kind of link. */
  type: NetworkType
  /** Settlement id at the start. */
  from: number
  /** Settlement id at the end. */
  to: number
  /** Polyline in local `[x, z]`, metres, from `from`'s position to `to`'s (smoothed). */
  points: [number, number][]
  /** Fine H3 cells the route passes through, in order. */
  cells: string[]
  /** Polyline length, metres. */
  length: number
}

/** Roads, railways and power lines between settlements. */
export interface Network {
  /** Every link; roads (highway, road, track) connect all non-farmstead settlements. */
  edges: NetworkEdge[]
}

/**
 * Builds road, rail and power networks between settlements. Pure and deterministic.
 *
 * - **Backbone:** a minimum spanning tree over all non-farmstead settlements (every one is reachable by
 *   road), plus extra links picked by a gravity model (P₁·P₂ / dᵏ) where the tree forces a detour.
 * - **Routing:** each link is an A* path over the fine hex grid, costed by slope² and water crossings, with
 *   a discount on cells earlier routes use, so roads merge into trunks. Highways route first.
 * - **Types:** a link is a highway / road / track by the smaller population at its ends. Railways repeat
 *   the plan over settlements above `railPopulation` with a much stronger slope cost. Power lines are straight
 *   spans along a spanning tree of settlements above `powerlinePopulation`.
 */
export function generateNetworks(data: PopulationData, input: Partial<NetworkOptions> = {}): Network {
  const o = { ...data.options.network, ...input }
  const edges: NetworkEdge[] = []
  if (!o.enabled) return { edges }
  const nodes = data.settlements.filter((s) => s.class !== 'farmstead')

  // Roads: tree + gravity links, most important first so the rest merge into them.
  const roadType = (a: Settlement, b: Settlement): NetworkType => {
    const m = Math.min(a.population, b.population)
    return m >= o.highwayPopulation ? 'highway' : m >= o.roadPopulation ? 'road' : 'track'
  }
  const order: NetworkType[] = ['highway', 'road', 'track']
  const roads = plan(nodes, o).map(([a, b]) => ({ a: nodes[a], b: nodes[b], type: roadType(nodes[a], nodes[b]) }))
  roads.sort((p, q) => order.indexOf(p.type) - order.indexOf(q.type) || Math.min(q.a.population, q.b.population) - Math.min(p.a.population, p.b.population) || p.a.id - q.a.id || p.b.id - q.b.id)
  const usedRoad = new Uint8Array(data.cells.length)
  for (const r of roads) edges.push(routed(data, edges.length, r.type, r.a, r.b, o.slopeCost, o, usedRoad))

  if (o.railPopulation > 0) {
    const big = nodes.filter((s) => s.population >= o.railPopulation)
    const usedRail = new Uint8Array(data.cells.length)
    for (const [a, b] of plan(big, o)) edges.push(routed(data, edges.length, 'rail', big[a], big[b], o.railSlopeCost, o, usedRail))
  }

  if (o.powerlinePopulation > 0) {
    const fed = nodes.filter((s) => s.population >= o.powerlinePopulation)
    for (const [a, b] of spanningTree(fed)) edges.push(straight(data, edges.length, fed[a], fed[b]))
  }
  return { edges }
}

/** Settlements reachable from `start` over edges of the given types (ids). */
export function reachable(network: Network, start: number, types: NetworkType[] = ['highway', 'road', 'track']): Set<number> {
  const adj = new Map<number, number[]>()
  for (const e of network.edges) {
    if (!types.includes(e.type)) continue
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to])
    adj.set(e.to, [...(adj.get(e.to) ?? []), e.from])
  }
  const seen = new Set([start]), stack = [start]
  while (stack.length) for (const m of adj.get(stack.pop()!) ?? []) if (!seen.has(m)) { seen.add(m); stack.push(m) }
  return seen
}

// --- planning --------------------------------------------------------------------------------------

const dist = (a: Settlement, b: Settlement) => Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1])

// Prim's minimum spanning tree on straight distances (O(n²), fine for hundreds of settlements).
function spanningTree(nodes: Settlement[]): [number, number][] {
  const n = nodes.length
  const links: [number, number][] = []
  if (n < 2) return links
  const inTree = new Uint8Array(n), best = new Float64Array(n).fill(Infinity), from = new Int32Array(n).fill(-1)
  best[0] = 0
  for (let it = 0; it < n; it++) {
    let u = -1
    for (let i = 0; i < n; i++) if (!inTree[i] && (u < 0 || best[i] < best[u])) u = i
    inTree[u] = 1
    if (from[u] >= 0) links.push([from[u], u])
    for (let v = 0; v < n; v++) {
      if (inTree[v]) continue
      const d = dist(nodes[u], nodes[v])
      if (d < best[v]) { best[v] = d; from[v] = u }
    }
  }
  return links
}

// Spanning tree plus gravity-model links that cut long detours.
function plan(nodes: Settlement[], o: NetworkOptions): [number, number][] {
  const links = spanningTree(nodes)
  const n = nodes.length
  const limit = Math.round(o.extraEdges * n)
  if (limit <= 0 || n < 3) return links
  const adj: { to: number; len: number }[][] = nodes.map(() => [])
  const linked = new Set<string>()
  const add = (a: number, b: number) => {
    const d = dist(nodes[a], nodes[b])
    adj[a].push({ to: b, len: d }); adj[b].push({ to: a, len: d })
    linked.add(a < b ? `${a},${b}` : `${b},${a}`)
  }
  for (const [a, b] of links) add(a, b)
  const candidates: { a: number; b: number; g: number }[] = []
  const seen = new Set<string>()
  for (let a = 0; a < n; a++) {
    const near = nodes.map((_, b) => b).filter((b) => b !== a).sort((p, q) => dist(nodes[a], nodes[p]) - dist(nodes[a], nodes[q]) || p - q).slice(0, o.neighbours)
    for (const b of near) {
      const key = a < b ? `${a},${b}` : `${b},${a}`
      if (seen.has(key)) continue
      seen.add(key)
      const d = Math.max(1, dist(nodes[a], nodes[b]))
      candidates.push({ a: Math.min(a, b), b: Math.max(a, b), g: (nodes[a].population * nodes[b].population) / d ** o.gravityExponent })
    }
  }
  candidates.sort((p, q) => q.g - p.g || p.a - q.a || p.b - q.b)
  let added = 0
  for (const { a, b } of candidates) {
    if (added >= limit) break
    if (linked.has(`${a},${b}`)) continue
    const d = dist(nodes[a], nodes[b])
    if (graphDistance(adj, a, b, d * o.detour) > d * o.detour) { add(a, b); links.push([a, b]); added++ }
  }
  return links
}

// Dijkstra from a to b, giving up beyond `bound` (returns Infinity then).
function graphDistance(adj: { to: number; len: number }[][], a: number, b: number, bound: number): number {
  const best = new Map<number, number>([[a, 0]])
  const heap = new Heap()
  heap.push(a, 0)
  while (heap.size) {
    const [u, du] = heap.pop()
    if (u === b) return du
    if (du > (best.get(u) ?? Infinity) || du > bound) continue
    for (const { to, len } of adj[u]) {
      const dv = du + len
      if (dv < (best.get(to) ?? Infinity) && dv <= bound) { best.set(to, dv); heap.push(to, dv) }
    }
  }
  return Infinity
}

// --- routing ---------------------------------------------------------------------------------------

function routed(data: PopulationData, id: number, type: NetworkType, a: Settlement, b: Settlement, slopeCost: number, o: NetworkOptions, used: Uint8Array): NetworkEdge {
  const path = aStar(data, data.index.get(a.cell)!, data.index.get(b.cell)!, slopeCost, o, used)
  for (const i of path) used[i] = 1
  const pts: [number, number][] = [a.position, ...path.slice(1, -1).map((i) => data.cells[i].position), b.position]
  const points = chaikin(pts, o.smoothing)
  return { id, type, from: a.id, to: b.id, points, cells: path.map((i) => data.cells[i].cell), length: polylineLength(points) }
}

function straight(data: PopulationData, id: number, a: Settlement, b: Settlement): NetworkEdge {
  const d = dist(a, b)
  const steps = Math.max(1, Math.ceil(d / (data.cellEdge * 0.5)))
  const cells: string[] = []
  for (let k = 0; k <= steps; k++) {
    const t = k / steps
    const c = data.grid.cellAtLocal(a.position[0] + (b.position[0] - a.position[0]) * t, a.position[1] + (b.position[1] - a.position[1]) * t, data.resolution)
    if (cells[cells.length - 1] !== c) cells.push(c)
  }
  return { id, type: 'powerline', from: a.id, to: b.id, points: [a.position, b.position], cells, length: d }
}

// A* over the fine hex grid: cost = length × (1 + slopeCost·slope²) × water × reuse.
function aStar(data: PopulationData, start: number, goal: number, slopeCost: number, o: NetworkOptions, used: Uint8Array): number[] {
  const cells = data.cells
  const g = new Float64Array(cells.length).fill(Infinity), came = new Int32Array(cells.length).fill(-1)
  const minFactor = Math.min(1, o.reuse)
  const gp = cells[goal].position
  const h = (i: number) => Math.hypot(cells[i].position[0] - gp[0], cells[i].position[1] - gp[1]) * minFactor
  const heap = new Heap()
  g[start] = 0
  heap.push(start, h(start))
  while (heap.size) {
    const [u, f] = heap.pop()
    if (u === goal) break
    if (f > g[u] + h(u) + 1e-9) continue
    const cu = cells[u]
    for (const v of data.neighbours[u]) {
      const cv = cells[v]
      const len = Math.hypot(cv.position[0] - cu.position[0], cv.position[1] - cu.position[1])
      const s = (cv.elevation - cu.elevation) / (len || 1)
      const cost = len * (1 + slopeCost * s * s) * (cv.landUse === 'water' ? o.waterCost : 1) * (used[v] ? o.reuse : 1)
      const gv = g[u] + cost
      if (gv < g[v]) { g[v] = gv; came[v] = u; heap.push(v, gv + h(v)) }
    }
  }
  const path = [goal]
  while (path[path.length - 1] !== start && came[path[path.length - 1]] >= 0) path.push(came[path[path.length - 1]])
  return path.reverse()
}

/** Chaikin corner cutting, keeping both ends. */
export function chaikin(points: [number, number][], passes: number): [number, number][] {
  let p = points
  for (let k = 0; k < passes && p.length > 2; k++) {
    const q: [number, number][] = [p[0]]
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1]
      if (i > 0) q.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25])
      if (i < p.length - 2) q.push([ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75])
    }
    q.push(p[p.length - 1])
    p = q
  }
  return p
}

function polylineLength(p: [number, number][]): number {
  let l = 0
  for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])
  return l
}

// Binary min-heap of (item, priority).
class Heap {
  private items: number[] = []
  private prio: number[] = []
  get size(): number { return this.items.length }
  push(item: number, p: number) {
    const it = this.items, pr = this.prio
    let i = it.length
    it.push(item); pr.push(p)
    while (i > 0) {
      const j = (i - 1) >> 1
      if (pr[j] <= p) break
      it[i] = it[j]; pr[i] = pr[j]; i = j
    }
    it[i] = item; pr[i] = p
  }
  pop(): [number, number] {
    const it = this.items, pr = this.prio
    const top: [number, number] = [it[0], pr[0]]
    const item = it.pop()!, p = pr.pop()!
    if (it.length) {
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= it.length) break
        if (c + 1 < it.length && pr[c + 1] < pr[c]) c++
        if (pr[c] >= p) break
        it[i] = it[c]; pr[i] = pr[c]; i = c
      }
      it[i] = item; pr[i] = p
    }
    return top
  }
}
