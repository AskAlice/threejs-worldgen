import { mulberry32 } from 'threejs-biomes'
import { MinHeap, RoadGraph, ROAD_SURFACES, type RoadSurface, type RoadType } from './graph.ts'
import type { DistrictMap } from './districts.ts'
import type { Site } from './site.ts'
import type { TensorField } from './tensor-field.ts'

/** Size and growth rules of one road class. */
export interface RoadClassOptions {
  /** Carriageway width, metres. */
  width: number
  /** Sidewalk width on each side, metres (0 = none). */
  sidewalk: number
  /** Length of one growth step, metres (shorter = smoother curves). */
  segment: number
  /** Distance between side-road branches, metres (minor roads use the district's `blockSize`). */
  branchSpacing: number
  /** Chance (0..1) that a branch is actually grown on each side. */
  branchChance: number
  /** Chance (0..1) that a road carries on through a junction it runs into, instead of ending there. */
  through: number
  /** Growth delay for new roads of this class (lower = grown earlier, so it wins contested ground). */
  delay: number
}

/** Traffic on one road class. */
export interface RoadTraffic {
  /** Lanes per direction. */
  lanes: number
  /** Speed limit, m/s. */
  speed: number
}

/** Road network rules (Parish & Müller 2001 global goals + local constraints). */
export interface RoadOptions {
  /** Arterial roads. */
  primary: RoadClassOptions
  /** Collector roads. */
  secondary: RoadClassOptions
  /** Local streets. */
  minor: RoadClassOptions
  /** Arterials leaving the centre (0 = from the size class). */
  arms: number
  /** Road ends within this distance of a junction or road join it, metres. */
  snapRadius: number
  /** Smallest angle between two roads at a junction, degrees. */
  minAngle: number
  /** Steepest grade a road segment may climb (rise / run) before it is steered or pruned. */
  maxGrade: number
  /** Longest stretch of water a bridge may span, metres (0 = no bridges). */
  maxBridge: number
  /** Hard cap on growth steps (keeps huge settings bounded). */
  maxSegments: number
  /** How far beyond the radius arterials reach (multiple of the radius). */
  extent: number
  /** Surfaces of roads through farmland (used where worse than the settlement's own). */
  rural: Record<RoadType, RoadSurface>
  /** Gravel and dirt roads are this much narrower (fraction of the class width). */
  unpavedWidth: number
  /** Lanes per direction and speed limit (m/s) per class, for vehicles. */
  traffic: Record<RoadType, RoadTraffic>
  /** Speed multiplier per surface (cobbles and dirt are slow). */
  surfaceSpeed: Record<RoadSurface, number>
}

/** Default road rules. */
export const DEFAULT_ROADS: RoadOptions = {
  primary: { width: 12, sidewalk: 3, segment: 48, branchSpacing: 150, branchChance: 0.85, through: 1, delay: 0 },
  secondary: { width: 8, sidewalk: 2.5, segment: 36, branchSpacing: 110, branchChance: 0.8, through: 0.85, delay: 4 },
  minor: { width: 6, sidewalk: 1.8, segment: 30, branchSpacing: 100, branchChance: 0.9, through: 0.6, delay: 9 },
  arms: 0,
  snapRadius: 14,
  minAngle: 32,
  maxGrade: 0.16,
  maxBridge: 140,
  maxSegments: 6000,
  extent: 1.3,
  rural: { primary: 'asphalt', secondary: 'gravel', minor: 'dirt' },
  unpavedWidth: 0.7,
  traffic: { primary: { lanes: 2, speed: 16.7 }, secondary: { lanes: 1, speed: 13.9 }, minor: { lanes: 1, speed: 8.3 } },
  surfaceSpeed: { asphalt: 1, cobblestone: 0.6, gravel: 0.7, dirt: 0.5 },
}

interface Proposal { from: number; dx: number; dz: number; type: RoadType; run: number; t: number }

/** Everything road growth needs about the place. */
export interface RoadContext {
  /** Terrain and water. */
  site: Site
  /** Street directions. */
  field: TensorField
  /** District layout (minor-street spacing). */
  districts: DistrictMap
  /** Settlement centre. */
  cx: number
  /** Settlement centre. */
  cz: number
  /** Settlement radius, metres. */
  radius: number
  /** Arterials leaving the centre. */
  arms: number
  /** Seed. */
  seed: number
}

const DEG = Math.PI / 180

/**
 * Grows a road network outwards from the centre. Generator form: yields every few dozen steps so
 * big cities can grow over several frames; the return value is the finished graph. See
 * {@link generateRoads} for the one-shot version.
 */
export function* growRoads(ctx: RoadContext, options: RoadOptions): Generator<void, RoadGraph> {
  const { site, field, districts, cx, cz, radius } = ctx
  const o = options
  const graph = new RoadGraph(Math.max(20, o.minor.segment))
  const rand = mulberry32(ctx.seed ^ 0x51ed)
  const proposals: Proposal[] = []
  const queue = new MinHeap()
  const push = (p: Proposal) => { proposals.push(p); queue.push(proposals.length - 1, p.t) }
  const cls = (t: RoadType) => o[t]
  const dir: [number, number] = [0, 0]

  // Arterials leave the centre along the field's major and minor directions.
  const centre = graph.addNode(cx, cz)
  const t0 = field.angle(cx, cz)
  const starts: [number, number][] = [[Math.cos(t0), Math.sin(t0)], [-Math.cos(t0), -Math.sin(t0)], [-Math.sin(t0), Math.cos(t0)], [Math.sin(t0), -Math.cos(t0)]]
  for (let i = 0; i < Math.max(1, Math.min(4, ctx.arms)); i++) push({ from: centre, dx: starts[i][0], dz: starts[i][1], type: 'primary', run: 0, t: 0 })

  const reach = (type: RoadType, x: number, z: number) => {
    const d = Math.hypot(x - cx, z - cz)
    if (type === 'primary') return d <= radius * o.extent
    if (type === 'secondary') return d <= radius * Math.max(1, o.extent * 0.85)
    return d <= radius && districts.style(x, z).blockSize > 0
  }

  // Local constraints for one step a→b. Returns null if the step must be pruned.
  const water = (ax: number, az: number, ux: number, uz: number, length: number, type: RoadType): { length: number; bridge: boolean } | null => {
    const step = site.cell * 0.5
    const n = Math.max(2, Math.ceil(length / step))
    let wetAt = -1
    for (let i = 1; i <= n; i++) if (site.wet(ax + (ux * length * i) / n, az + (uz * length * i) / n)) { wetAt = (length * i) / n; break }
    if (wetAt < 0) return { length, bridge: false }
    if (type === 'minor' || o.maxBridge <= 0) return null
    // Bridge: march across to the far bank (two dry samples in a row).
    let dry = 0
    for (let s = wetAt; s <= wetAt + o.maxBridge; s += step) {
      dry = site.wet(ax + ux * s, az + uz * s) ? 0 : dry + 1
      if (dry >= 2) return { length: Math.max(length, s + step), bridge: true }
    }
    return null
  }

  const gradeOk = (ax: number, az: number, bx: number, bz: number) => {
    const l = Math.hypot(bx - ax, bz - az) / 2 || 1
    const ha = site.height(ax, az), hm = site.height((ax + bx) / 2, (az + bz) / 2), hb = site.height(bx, bz)
    return Math.max(Math.abs(hm - ha), Math.abs(hb - hm)) / l <= o.maxGrade
  }

  const minCos = Math.cos(o.minAngle * DEG)
  // True if direction (ux, uz) leaving node n is at least minAngle away from every road there.
  const angleOk = (n: number, ux: number, uz: number, extra?: [number, number][]) => {
    const node = graph.nodes[n]
    const check = (vx: number, vz: number) => {
      const l = Math.hypot(vx, vz) || 1
      return (ux * vx + uz * vz) / l < minCos
    }
    for (const e of node.edges) {
      const m = graph.nodes[graph.other(e, n)]
      if (!check(m.x - node.x, m.z - node.z)) return false
    }
    for (const [vx, vz] of extra ?? []) if (!check(vx, vz)) return false
    return true
  }

  interface Step { end: number; stop: boolean; through: boolean; ux: number; uz: number }

  // Tries one step from `from` towards (ux, uz) with step length L; commits it and returns the result.
  const attempt = (from: number, ux: number, uz: number, L: number, type: RoadType): Step | null => {
    const a = graph.nodes[from]
    const c = cls(type)
    let bx = a.x + ux * L, bz = a.z + uz * L
    if (!reach(type, bx, bz) || !site.contains(bx, bz)) return null
    const w = water(a.x, a.z, ux, uz, L, type)
    if (!w) return null
    if (w.bridge) {
      bx = a.x + ux * w.length; bz = a.z + uz * w.length
      if (!site.contains(bx, bz)) return null
    } else if (!gradeOk(a.x, a.z, bx, bz)) return null

    const notMine = (n: number) => n === from || graph.edgeBetween(n, from) >= 0
    const commit = (end: number, stop: boolean, through: boolean, splitEdge = -1, sx = 0, sz = 0): Step | null => {
      if (splitEdge >= 0) end = graph.splitEdge(splitEdge, sx, sz)
      const e = graph.addEdge(from, end, type, c.width, c.sidewalk, w.bridge)
      if (e < 0) return null
      return { end, stop, through, ux, uz }
    }

    // 1. Crossing an existing road: end at the crossing (snapping to a nearby junction).
    const hit = graph.firstCrossing(a.x, a.z, bx, bz, from)
    if (hit) {
      const len = Math.hypot(bx - a.x, bz - a.z)
      if (w.bridge || hit.distance * len < o.snapRadius * 0.5) return null
      const edge = graph.edges[hit.edge]
      for (const n of [edge.a, edge.b]) {
        const node = graph.nodes[n]
        if (Math.hypot(node.x - hit.x, node.z - hit.z) < o.snapRadius * 0.6 && !notMine(n)) {
          const vx = node.x - a.x, vz = node.z - a.z
          if (graph.crosses(a.x, a.z, node.x, node.z, from, n) || !angleOk(from, vx, vz) || !angleOk(n, -vx, -vz)) return null
          return commit(n, true, true)
        }
      }
      const ex = graph.nodes[edge.b].x - graph.nodes[edge.a].x, ez = graph.nodes[edge.b].z - graph.nodes[edge.a].z
      const vx = hit.x - a.x, vz = hit.z - a.z
      if (graph.crosses(a.x, a.z, hit.x, hit.z, from, -1, hit.edge) || !angleOk(from, vx, vz)) return null
      // The new road must meet the crossed one at a decent angle (both of its directions at the split point).
      if (Math.abs((vx * ex + vz * ez) / ((Math.hypot(vx, vz) || 1) * (Math.hypot(ex, ez) || 1))) >= minCos) return null
      return commit(-1, true, true, hit.edge, hit.x, hit.z)
    }

    // 2. Ending near a junction: join it.
    const near = graph.nearestNode(bx, bz, o.snapRadius, notMine)
    if (near >= 0) {
      const node = graph.nodes[near]
      const vx = node.x - a.x, vz = node.z - a.z
      if (!w.bridge && !graph.crosses(a.x, a.z, node.x, node.z, from, near) && angleOk(from, vx, vz) && angleOk(near, -vx, -vz)) return commit(near, true, false)
      if (!w.bridge) return null
    }

    // 3. Ending near a road: join it with a T junction.
    const side = w.bridge ? null : graph.nearestEdge(bx, bz, o.snapRadius, (id) => graph.edges[id].a === from || graph.edges[id].b === from)
    if (side) {
      const edge = graph.edges[side.edge]
      const ex = graph.nodes[edge.b].x - graph.nodes[edge.a].x, ez = graph.nodes[edge.b].z - graph.nodes[edge.a].z
      const vx = side.x - a.x, vz = side.z - a.z
      const l = Math.hypot(vx, vz)
      const el = Math.hypot(ex, ez) || 1
      if (l > 1 && side.u > 0.02 && side.u < 0.98 && Math.abs((vx * ex + vz * ez) / (l * el)) < minCos
        && !graph.crosses(a.x, a.z, side.x, side.z, from, -1, side.edge) && angleOk(from, vx, vz)) {
        return commit(-1, true, false, side.edge, side.x, side.z)
      }
      return null
    }

    // 4. Open ground: a new node, and the road carries on.
    if (graph.crosses(a.x, a.z, bx, bz, from) || !angleOk(from, bx - a.x, bz - a.z)) return null
    return commit(graph.addNode(bx, bz), false, false)
  }

  const turns: Record<RoadType, number[]> = { primary: [0, 12, -12, 25, -25, 40, -40], secondary: [0, 15, -15, 30, -30], minor: [0, 12, -12] }
  let steps = 0
  while (queue.size && steps < o.maxSegments) {
    const p = proposals[queue.pop()]
    steps++
    if ((steps & 63) === 0) yield
    const c = cls(p.type)
    const a = graph.nodes[p.from]
    const L = c.segment * (0.85 + 0.3 * rand())
    // Follow the field (midpoint method), so roads trace its streamlines.
    field.align(a.x + p.dx * L * 0.5, a.z + p.dz * L * 0.5, p.dx, p.dz, dir)
    const fx = dir[0], fz = dir[1]
    let result: Step | null = null
    for (const turn of turns[p.type]) {
      const cs = Math.cos(turn * DEG), sn = Math.sin(turn * DEG)
      result = attempt(p.from, fx * cs - fz * sn, fx * sn + fz * cs, L, p.type)
      if (result) break
    }
    if (!result) continue
    const end = graph.nodes[result.end]
    if (result.stop) {
      // Ran into another road: maybe carry on through the junction.
      if (result.through && rand() < c.through) push({ from: result.end, dx: result.ux, dz: result.uz, type: p.type, run: p.run, t: p.t + 1 })
      continue
    }
    push({ from: result.end, dx: result.ux, dz: result.uz, type: p.type, run: p.run + L, t: p.t + 1 })

    // Global goals: side roads at regular spacing.
    const spacing = p.type === 'minor' || (p.type === 'secondary' && districts.style(end.x, end.z).blockSize > 0)
      ? districts.style(end.x, end.z).blockSize
      : c.branchSpacing
    const run = p.run + L
    if (spacing <= 0 || run < spacing * (0.85 + 0.3 * rand())) continue
    proposals[proposals.length - 1].run = 0
    let branch: RoadType = p.type === 'primary' ? 'secondary' : 'minor'
    if (branch === 'minor' && districts.style(end.x, end.z).blockSize <= 0) branch = 'secondary'
    const chance = cls(p.type).branchChance * (branch === 'secondary' && p.type === 'secondary' ? 0.35 : 1)
    for (const s of [-1, 1]) {
      if (rand() >= chance) continue
      field.align(end.x, end.z, -result.uz * s, result.ux * s, dir)
      push({ from: result.end, dx: dir[0], dz: dir[1], type: branch, run: 0, t: p.t + 1 + cls(branch).delay })
    }
  }
  return graph
}

/**
 * Sets each edge's surface: the settlement's surface for its class, the rural one where the road
 * runs through farmland (whichever is rougher), cobblestones for the side streets of an old-town
 * core. Unpaved and rural roads lose their sidewalks (no kerbs) and get narrower.
 */
export function assignSurfaces(graph: RoadGraph, districts: DistrictMap, urban: Record<RoadType, RoadSurface>, oldTown: RoadSurface | null, o: RoadOptions): void {
  const rank = (s: RoadSurface) => ROAD_SURFACES.indexOf(s)
  for (const e of graph.edges) {
    const a = graph.nodes[e.a], b = graph.nodes[e.b]
    const d = districts.at((a.x + b.x) / 2, (a.z + b.z) / 2)
    let s = urban[e.type]
    if (d === 'farmland' && rank(o.rural[e.type]) > rank(s)) s = o.rural[e.type]
    if (d === 'downtown' && oldTown && e.type !== 'primary') s = oldTown
    e.surface = s
    if (d === 'farmland' || s === 'gravel' || s === 'dirt') e.sidewalk = 0
    if (s === 'gravel' || s === 'dirt') e.width = o[e.type].width * o.unpavedWidth
  }
}

/** Grows a whole road network in one go (see {@link growRoads}). */
export function generateRoads(ctx: RoadContext, options: RoadOptions): RoadGraph {
  return runToEnd(growRoads(ctx, options))
}

/** Runs a generator to completion and returns its result. */
export function runToEnd<T>(gen: Generator<void, T>): T {
  for (;;) {
    const r = gen.next()
    if (r.done) return r.value
  }
}
