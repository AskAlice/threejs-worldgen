import { createSample, hash01, hash4, seedOf, type LocalFrame, type World, type WorldSample } from 'threejs-biomes'
import { PROP_KIND_IDS, type PropKind, type PropPlacement } from './catalog.ts'

/** A road node: threejs-city's `RoadGraph` nodes and `CityData.roads.nodes` both fit. */
export interface RoadNodeLike {
  /** Position (frame-local). */ x: number
  /** Position (frame-local). */ z: number
  /** Road surface height (local y); `NaN` or missing = read the ground. */ y?: number
}

/** A road edge: threejs-city's `RoadGraph` edges and `CityData.roads.edges` both fit. */
export interface RoadEdgeLike {
  /** Start node index. */ a: number
  /** End node index. */ b: number
  /** Road class. */ type?: 'primary' | 'secondary' | 'minor'
  /** Carriageway width, metres. */ width: number
  /** Sidewalk width per side, metres (0 = rural). */ sidewalk: number
  /** Surface (`asphalt`, `cobblestone`, `gravel`, `dirt`). */ surface?: string
  /** On a bridge (left bare). */ bridge?: boolean
  /** Graded centreline from a to b (frame-local xyz), if known. */ points?: readonly (readonly number[])[]
}

/** A road network: a threejs-city `RoadGraph`, or `CityData.roads`, or plain data of that shape. */
export interface RoadNetworkLike {
  /** Nodes. */ nodes: readonly RoadNodeLike[]
  /** Edges. */ edges: readonly RoadEdgeLike[]
}

/** A lot: threejs-city's `CityData.lots` entries fit. */
export interface LotLike {
  /** District (`residential`, `farmland`, …). */ district?: string
  /** Where the lot meets its street, or null. */ frontage: { x: number; z: number; nx: number; nz: number; edge: number } | null
  /** Building on the lot, or −1. */ building?: number
}

/** Fence styles. */
export type FenceStyle = 'picket' | 'rail' | 'adobe' | 'stone'

/** Biome-matched styles at a spot. */
export interface PropStyle {
  /** Fence style. */ fence: FenceStyle
  /** Well style. */ well: 'stone' | 'adobe'
  /** Power pole material. */ pole: 'wood' | 'concrete'
}

/** Fence styles per biome id (picked by hash where there are several). */
export const FENCE_STYLES: Readonly<Record<string, readonly FenceStyle[]>> = {
  desert: ['adobe'], badlands: ['adobe'], savanna: ['adobe', 'rail'], mediterranean: ['stone', 'adobe'], dryForest: ['adobe', 'rail'],
  volcanic: ['stone'], alpineMeadow: ['stone', 'rail'], mountainPeaks: ['stone'], tundra: ['rail', 'stone'], glacier: ['stone'],
  temperateRainforest: ['stone', 'rail'], coast: ['picket', 'stone'], taiga: ['rail'], steppe: ['rail'], grassland: ['rail', 'picket'],
  deciduousForest: ['picket', 'rail', 'stone'], wetland: ['rail'], jungle: ['rail'], mangrove: ['rail'],
}

const HOT_DRY = new Set(['desert', 'badlands', 'savanna', 'mediterranean', 'dryForest'])
/** Biomes where hay is made. */
export const FARM_BIOMES = ['grassland', 'steppe', 'savanna', 'mediterranean', 'deciduousForest', 'dryForest', 'taiga', 'coast']
/** Biomes where open wells are common. */
export const WELL_BIOMES = ['grassland', 'steppe', 'savanna', 'desert', 'badlands', 'mediterranean', 'dryForest']

const scratch: WorldSample = createSample()

/** Strongest biome id at a spot. */
export function biomeIdAt(world: World, frame: LocalFrame, x: number, z: number): string {
  const s = frame.sample(x, z, scratch)
  return world.options.biomes[s.biomes[0]]?.id ?? 'grassland'
}

/** Biome-matched styles at frame-local (x, z): adobe walls in the desert, stone in the mountains, rails in the taiga… */
export function propStyleAt(world: World, frame: LocalFrame, x: number, z: number, seed = 0): PropStyle {
  const id = biomeIdAt(world, frame, x, z)
  const r = hash01(Math.floor(x / 60), Math.floor(z / 60), seed, 0x5713)
  const fences = FENCE_STYLES[id] ?? ['rail']
  const dry = HOT_DRY.has(id)
  return { fence: fences[Math.floor(r * fences.length) % fences.length], well: dry && id !== 'mediterranean' ? 'adobe' : 'stone', pole: dry && r < 0.5 ? 'concrete' : 'wood' }
}

/** Where each kind of street furniture goes. Plain JSON; a spacing of 0 turns that kind off. */
export interface DecorateOptions {
  /** Seed: same roads, world and seed give the same props. */
  seed: number | string
  /** Distance from a junction kept clear of roadside props, metres. */
  junctionClearance: number
  /** Sidewalk height above the carriageway, metres (props on sidewalks stand on it). */
  curbHeight: number
  /** Street lights: spacing along urban roads; `rural` lights rural roads too (one side, 1.5× apart). */
  streetLights: { spacing: number; rural: boolean; variant: 'auto' | 'cobra' | 'post' }
  /** Fire hydrants along urban sidewalks. */
  hydrants: { spacing: number }
  /** Benches at the back of urban sidewalks. */
  benches: { spacing: number }
  /** Bins at the back of urban sidewalks. */
  bins: { spacing: number }
  /** Bus stops along primary and secondary urban roads (shelters where the sidewalk is wide enough). */
  busStops: { spacing: number }
  /** Speed limit signs at both ends of longer roads, stop signs where minor roads meet bigger ones, a street name sign per junction. */
  signs: { speed: boolean; stop: boolean; names: boolean; minLength: number }
  /** Traffic lights at junctions of at least `minRoads` roads where one is primary or secondary (masts on primaries). */
  trafficLights: { enabled: boolean; minRoads: number; mast: boolean }
  /** Mailboxes at lot frontages (residential and farm lots with a building), else every `spacing` metres along rural roads. */
  mailboxes: { style: 'us' | 'eu'; spacing: number; chance: number }
  /** Power poles along rural roads, `offset` metres beyond the carriageway edge. */
  powerLines: { spacing: number; offset: number; kind: 'power-pole' | 'pylon' }
  /** Fence runs along rural roads: chance per 40 m stretch, distance from the road edge, segment length, style (`auto` = by biome). */
  fences: { chance: number; offset: number; length: number; style: 'auto' | FenceStyle }
  /** Hay bales per 100 m of rural road (in fields beside it, farm biomes only). */
  hayBales: { density: number }
  /** Wells per km of rural road (beside it, in dry and farm biomes). */
  wells: { density: number }
}

/** Default decoration: lights every 30 m, hydrants every 80 m, poles every 45 m along rural roads, … */
export const DEFAULT_DECORATE: DecorateOptions = {
  seed: 1,
  junctionClearance: 9,
  curbHeight: 0.15,
  streetLights: { spacing: 30, rural: false, variant: 'auto' },
  hydrants: { spacing: 80 },
  benches: { spacing: 110 },
  bins: { spacing: 70 },
  busStops: { spacing: 280 },
  signs: { speed: true, stop: true, names: true, minLength: 60 },
  trafficLights: { enabled: true, minRoads: 3, mast: true },
  mailboxes: { style: 'us', spacing: 45, chance: 0.6 },
  powerLines: { spacing: 45, offset: 3, kind: 'power-pole' },
  fences: { chance: 0.45, offset: 4, length: 2.5, style: 'auto' },
  hayBales: { density: 1.2 },
  wells: { density: 0.6 },
}

/** Partial decoration options (groups merge). */
export type DecorateInput = { [K in keyof DecorateOptions]?: DecorateOptions[K] extends object ? Partial<DecorateOptions[K]> : DecorateOptions[K] }

/** Extra (non-JSON) inputs of {@link decorateRoads}. */
export interface DecorateContext {
  /** Frame the roads are laid out in. Default `world.frame`. */
  frame?: LocalFrame
  /** Lots (e.g. `city.data().lots`): mailboxes go to their frontages. */
  lots?: readonly LotLike[]
}

type V3 = [number, number, number]

/** A polyline with arc-length lookup. */
class Walker {
  readonly pts: V3[]
  readonly cum: number[] = [0]
  readonly length: number
  constructor(pts: V3[]) {
    this.pts = pts
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]))
    this.length = this.cum[this.cum.length - 1]
  }
  /** Position and unit tangent at arc length s. */
  at(s: number): { x: number; y: number; z: number; ux: number; uz: number } {
    const c = this.cum
    let i = 0
    while (i < c.length - 2 && c[i + 1] < s) i++
    const a = this.pts[i], b = this.pts[i + 1]
    const l = c[i + 1] - c[i] || 1e-9
    const t = Math.min(1, Math.max(0, (s - c[i]) / l))
    const dx = b[0] - a[0], dz = b[2] - a[2], d = Math.hypot(dx, dz) || 1
    return { x: a[0] + dx * t, y: a[1] + (b[1] - a[1]) * t, z: a[2] + dz * t, ux: dx / d, uz: dz / d }
  }
  /** Arc length of the nearest point to (x, z), and its distance. */
  nearest(x: number, z: number): { s: number; d: number } {
    let best = { s: 0, d: Infinity }
    for (let i = 0; i < this.pts.length - 1; i++) {
      const a = this.pts[i], b = this.pts[i + 1]
      const dx = b[0] - a[0], dz = b[2] - a[2], l2 = dx * dx + dz * dz || 1e-9
      const t = Math.min(1, Math.max(0, ((x - a[0]) * dx + (z - a[2]) * dz) / l2))
      const d = Math.hypot(a[0] + dx * t - x, a[2] + dz * t - z)
      if (d < best.d) best = { s: this.cum[i] + t * (this.cum[i + 1] - this.cum[i]), d }
    }
    return best
  }
}

/** A run of edges through plain bends (degree-2 nodes) with the same cross-section. */
interface Chain {
  edges: number[]
  start: number
  end: number
  edge: RoadEdgeLike
  walk: Walker
}

/** Splits a network into chains: maximal runs of same-profile edges through degree-2 nodes. */
function buildChains(net: RoadNetworkLike, height: (x: number, z: number) => number): Chain[] {
  const { nodes, edges } = net
  const adj: number[][] = nodes.map(() => [])
  edges.forEach((e, i) => { adj[e.a].push(i); adj[e.b].push(i) })
  const same = (p: RoadEdgeLike, q: RoadEdgeLike) => p.width === q.width && p.sidewalk === q.sidewalk && !!p.bridge === !!q.bridge && p.surface === q.surface
  const seen = new Uint8Array(edges.length)
  const out: Chain[] = []
  const other = (e: number, n: number) => (edges[e].a === n ? edges[e].b : edges[e].a)
  for (let i = 0; i < edges.length; i++) {
    if (seen[i]) continue
    seen[i] = 1
    const seq = [i]
    let start = edges[i].a, end = edges[i].b
    for (const forward of [true, false]) {
      let node = forward ? end : start, cur = i
      while (adj[node].length === 2) {
        const next = adj[node][0] === cur ? adj[node][1] : adj[node][0]
        if (seen[next] || !same(edges[next], edges[i])) break
        seen[next] = 1
        if (forward) seq.push(next)
        else seq.unshift(next)
        node = other(next, node)
        cur = next
      }
      if (forward) end = node
      else start = node
    }
    // Points from start to end.
    const pts: V3[] = []
    let n = start
    for (const e of seq) {
      const edge = edges[e]
      const reverse = edge.a !== n
      let ep: V3[]
      if (edge.points?.length) ep = edge.points.map((p) => [p[0], p[1], p[2]] as V3)
      else {
        // Ungraded edge: follow the ground every 5 m between the node heights.
        const A = nodes[edge.a], B = nodes[edge.b]
        const k = Math.max(1, Math.ceil(Math.hypot(B.x - A.x, B.z - A.z) / 5))
        ep = Array.from({ length: k + 1 }, (_, i): V3 => {
          const t = i / k, end = i === 0 ? A : i === k ? B : null
          return [A.x + (B.x - A.x) * t, end ? end.y ?? NaN : NaN, A.z + (B.z - A.z) * t]
        })
      }
      if (reverse) ep = ep.reverse()
      for (const p of ep) {
        if (!Number.isFinite(p[1])) p[1] = height(p[0], p[2])
        const last = pts[pts.length - 1]
        if (!last || Math.hypot(last[0] - p[0], last[2] - p[2]) > 1e-6) pts.push(p)
      }
      n = other(e, n)
    }
    if (pts.length >= 2) out.push({ edges: seq, start, end, edge: edges[i], walk: new Walker(pts) })
  }
  return out
}

function mergeInput<T>(base: T, input: object): T {
  const o = structuredClone(base) as Record<string, unknown>
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue
    o[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(o[k] as object), ...v } : v
  }
  return o as T
}

/** Yaw that turns a prop's front (+z) towards direction (fx, fz). */
export function yawFacing(fx: number, fz: number): number {
  return Math.atan2(fx, fz)
}

/**
 * Places street furniture and rural props along a road network deterministically: street lights,
 * hydrants, bins, benches and bus stops on urban sidewalks; traffic lights, stop signs and street name
 * signs at junctions; speed limit signs; and along rural roads power lines on one side, mailboxes at lot
 * frontages (or driveways), biome-matched fence runs, hay bales in the fields and the odd well. Props
 * never stand in water, on the carriageway, or on top of each other.
 *
 * @param roads A threejs-city `RoadGraph`, `CityData.roads`, or plain data of that shape.
 * @param world The world (ground height, water and biomes).
 * @returns Placements for {@link Props} (poles of one power line share a `line` id).
 *
 * @example
 * ```ts
 * const placements = decorateRoads(city.data()!.roads, world, { seed: 7, powerLines: { spacing: 40 } }, { frame: city.frame, lots: city.data()!.lots })
 * const props = await Props.create({ placements })
 * city.local.add(props.object)
 * ```
 */
export function decorateRoads(roads: RoadNetworkLike, world: World, input: DecorateInput = {}, ctx: DecorateContext = {}): PropPlacement[] {
  const o = mergeInput(DEFAULT_DECORATE, input)
  const frame = ctx.frame ?? world.frame
  const seed = seedOf(o.seed)
  const out: PropPlacement[] = []
  const sample = createSample()
  const ground = (x: number, z: number) => frame.height(x, z)
  const dry = (x: number, z: number) => {
    frame.sample(x, z, sample)
    return !(sample.waterLevel > sample.elevation)
  }
  // Spatial hash so props don't stand on each other.
  const cells = new Map<number, number[]>()
  const key = (i: number, j: number) => ((i + 32768) & 0xffff) | (((j + 32768) & 0xffff) << 16)
  const free = (x: number, z: number, r: number) => {
    const ci = Math.floor(x / 4), cj = Math.floor(z / 4)
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
      const list = cells.get(key(i, j))
      if (list) for (let k = 0; k < list.length; k += 3) if (Math.hypot(list[k] - x, list[k + 1] - z) < r + list[k + 2]) return false
    }
    return true
  }
  const counter = new Map<PropKind, number>()
  const add = (kind: PropKind, x: number, y: number, z: number, yaw: number, extra: Partial<PropPlacement> = {}, radius = 0.5, force = false): boolean => {
    if (!force && (!free(x, z, radius) || !dry(x, z))) return false
    const n = counter.get(kind) ?? 0
    counter.set(kind, n + 1)
    out.push({ kind, x, y, z, yaw, seed: hash4(seed, PROP_KIND_IDS.indexOf(kind), n, 0x7a11) & 0x7fffffff, ...extra })
    const k = key(Math.floor(x / 4), Math.floor(z / 4))
    const list = cells.get(k)
    if (list) list.push(x, z, radius)
    else cells.set(k, [x, z, radius])
    return true
  }
  const h = (a: number, b: number, c: number) => hash01(a, b, c, seed)

  // Carriageway keep-out: nothing off-road may stand on any road.
  const chains = buildChains(roads, ground)
  const onRoad = (x: number, z: number, margin: number) => {
    for (const c of chains) {
      const near = c.walk.nearest(x, z)
      if (near.d < c.edge.width / 2 + c.edge.sidewalk + margin) return true
    }
    return false
  }
  for (const c of chains) {
    const W = c.edge.width / 2
    for (let s = 0; s <= c.walk.length; s += 2) {
      const p = c.walk.at(s)
      const k = key(Math.floor(p.x / 4), Math.floor(p.z / 4))
      const list = cells.get(k)
      if (list) list.push(p.x, p.z, W - 0.2)
      else cells.set(k, [p.x, p.z, W - 0.2])
    }
  }

  // Degrees for junction clearance.
  const degree = new Int32Array(roads.nodes.length)
  for (const e of roads.edges) { degree[e.a]++; degree[e.b]++ }
  const nodeClear = new Float64Array(roads.nodes.length)
  roads.edges.forEach((e) => {
    for (const n of [e.a, e.b]) nodeClear[n] = Math.max(nodeClear[n], e.width / 2 + e.sidewalk)
  })

  // Junction furniture first (it has priority over roadside props near corners).
  roads.nodes.forEach((node, n) => {
    if (degree[n] < 3) return
    const incident = roads.edges.filter((e) => e.a === n || e.b === n).map((e) => ({ e }))
    if (incident.some(({ e }) => e.bridge)) return
    const big = incident.some(({ e }) => e.type === 'primary' || e.type === 'secondary')
    const signals = o.trafficLights.enabled && big && incident.length >= o.trafficLights.minRoads && incident.some(({ e }) => e.sidewalk > 0)
    incident.forEach(({ e }, k) => {
      const far = roads.nodes[e.a === n ? e.b : e.a]
      // Direction of travel towards the junction, and the approaching driver's right.
      let dx = node.x - far.x, dz = node.z - far.z
      const pts = e.points
      if (pts && pts.length >= 2) {
        const q = e.a === n ? pts[1] : pts[pts.length - 2]
        dx = node.x - q[0]; dz = node.z - q[2]
      }
      const l = Math.hypot(dx, dz) || 1
      dx /= l; dz /= l
      const rx = dz, rz = -dx
      const back = nodeClear[n] + 1.2
      const lat = e.width / 2 + (e.sidewalk > 0 ? Math.min(0.6, e.sidewalk * 0.3) : 1.2)
      const x = node.x - dx * back + rx * lat, z = node.z - dz * back + rz * lat
      const y = (Number.isFinite(node.y) ? (node.y as number) : ground(x, z)) + (e.sidewalk > 0 ? o.curbHeight : 0)
      const yaw = yawFacing(-dx, -dz)
      if (signals) add('traffic-light', x, y, z, yaw, { variant: o.trafficLights.mast && e.type === 'primary' ? 'mast' : 'post' }, 0.4, true)
      else if (o.signs.stop && (e.type === 'minor' || !big) && (big || h(n, 5, 0) < 0.5)) add('sign', x, y, z, yaw, { variant: 'stop' }, 0.3, true)
      if (o.signs.names && k === 0) {
        const nx = node.x - dx * back - rx * lat, nz = node.z - dz * back - rz * lat
        add('sign', nx, (Number.isFinite(node.y) ? (node.y as number) : ground(nx, nz)) + (e.sidewalk > 0 ? o.curbHeight : 0), nz, yaw, { variant: 'name' }, 0.3)
      }
    })
  })

  let lineId = hash4(seed, 0x11e, 0, 0) & 0xfffff
  chains.forEach((c, ci) => {
    const e = c.edge
    if (e.bridge) return
    const W = e.width / 2, sw = e.sidewalk
    const urban = sw > 0
    const L = c.walk.length
    const c0 = degree[c.start] >= 3 ? o.junctionClearance + nodeClear[c.start] : 1.5
    const c1 = L - (degree[c.end] >= 3 ? o.junctionClearance + nodeClear[c.end] : 1.5)
    if (c1 <= c0) return
    // A spot `lat` metres to the `side` (+1 left of the chain's direction) at arc length s, facing the road.
    const spot = (s: number, side: number, lat: number, raise: number | 'ground') => {
      const p = c.walk.at(s)
      const lx = -p.uz * side, lz = p.ux * side
      const x = p.x + lx * lat, z = p.z + lz * lat
      return { x, z, y: raise === 'ground' ? ground(x, z) : p.y + raise, yaw: yawFacing(-lx, -lz), ux: p.ux, uz: p.uz }
    }
    const every = (spacing: number, phase: number, fn: (s: number, i: number) => void) => {
      if (!(spacing > 0)) return
      const n = Math.floor((c1 - c0) / spacing)
      for (let i = 0; i <= n; i++) {
        const s = c0 + (i + phase) * spacing
        if (s <= c1) fn(s, i)
      }
    }

    if (urban) {
      const kerb = W + Math.min(0.6, sw * 0.3), back = W + sw - 0.5, up = o.curbHeight
      const lightVariant = o.streetLights.variant === 'auto' ? (e.surface === 'cobblestone' || (e.type === 'minor' && h(ci, 1, 0) < 0.3) ? 'post' : 'cobra') : o.streetLights.variant
      every(o.streetLights.spacing, 0.25, (s) => {
        // Staggered: the right-hand side half a spacing on.
        for (const [side, at] of [[1, s], [-1, s + o.streetLights.spacing / 2]]) {
          if (at > c1) continue
          const q = spot(at, side, kerb, up)
          add('street-light', q.x, q.y, q.z, q.yaw, { variant: lightVariant }, 0.5)
        }
      })
      every(o.hydrants.spacing, 0.6, (s, i) => {
        const q = spot(s, i % 2 ? 1 : -1, W + 0.45, up)
        add('hydrant', q.x, q.y, q.z, q.yaw, { variant: o.mailboxes.style === 'eu' ? 'pillar' : 'us' }, 0.4)
      })
      if (sw >= 1.5) {
        every(o.bins.spacing, 0.45, (s, i) => {
          const q = spot(s, h(ci, i, 2) < 0.5 ? 1 : -1, back, up)
          add('bin', q.x, q.y, q.z, q.yaw, { variant: h(ci, i, 3) < 0.6 ? 'metal' : 'wheelie' }, 0.4)
        })
        every(o.benches.spacing, 0.8, (s, i) => {
          const q = spot(s, h(ci, i, 4) < 0.5 ? 1 : -1, back - 0.1, up)
          add('bench', q.x, q.y, q.z, q.yaw, { variant: h(ci, i, 5) < 0.7 ? 'wood' : 'concrete' }, 1)
        })
      }
      if (e.type === 'primary' || e.type === 'secondary') {
        every(o.busStops.spacing, 0.5, (s, i) => {
          const shelter = sw >= 2.4
          const q = spot(s, i % 2 ? 1 : -1, shelter ? W + sw - 0.85 : kerb, up)
          add('bus-stop', q.x, q.y, q.z, q.yaw, { variant: shelter ? 'shelter' : 'pole' }, shelter ? 2 : 0.4)
        })
      }
      if (o.signs.speed && L > o.signs.minLength) {
        // Facing traffic entering the road at each end (drive on the right).
        const a = spot(c0 + 4, -1, kerb, up), b = spot(c1 - 4, 1, kerb, up)
        add('sign', a.x, a.y, a.z, yawFacing(-a.ux, -a.uz), { variant: 'speed' }, 0.3)
        add('sign', b.x, b.y, b.z, yawFacing(b.ux, b.uz), { variant: 'speed' }, 0.3)
      }
    } else {
      const edge = W + 1.2
      // Power line on one side, its poles turned across the line.
      if (o.powerLines.spacing > 0 && L > o.powerLines.spacing * 1.5) {
        const side = h(ci, 0, 6) < 0.5 ? 1 : -1
        const id = lineId++
        const n = Math.max(1, Math.round((L - 4) / o.powerLines.spacing))
        for (let i = 0; i <= n; i++) {
          const s = 2 + (i / n) * (L - 4)
          const q = spot(s, side, W + o.powerLines.offset, 'ground')
          if (onRoad(q.x, q.z, 0.8)) continue
          add(o.powerLines.kind, q.x, q.y, q.z, yawFacing(q.ux, q.uz), { line: id, variant: o.powerLines.kind === 'power-pole' ? propStyleAt(world, frame, q.x, q.z, seed).pole : undefined }, 0.6)
        }
      }
      if (o.streetLights.rural && o.streetLights.spacing > 0) {
        every(o.streetLights.spacing * 1.5, 0.5, (s) => {
          const q = spot(s, -1, edge, 'ground')
          add('street-light', q.x, q.y, q.z, q.yaw, { variant: 'cobra' }, 0.5)
        })
      }
      if (!ctx.lots && o.mailboxes.spacing > 0) {
        every(o.mailboxes.spacing, 0.5, (s, i) => {
          if (h(ci, i, 7) >= o.mailboxes.chance) return
          const q = spot(s, h(ci, i, 8) < 0.5 ? 1 : -1, W + 0.9, 'ground')
          add(o.mailboxes.style === 'eu' ? 'mailbox-eu' : 'mailbox-us', q.x, q.y, q.z, q.yaw, {}, 0.3)
        })
      }
      // Fence runs.
      if (o.fences.chance > 0) {
        const len = Math.max(0.5, o.fences.length)
        for (let s0 = c0, k = 0; s0 + 40 <= c1 + 1e-6; s0 += 40, k++) {
          if (h(ci, k, 9) >= o.fences.chance) continue
          const side = h(ci, k, 10) < 0.5 ? 1 : -1
          const mid = spot(s0 + 20, side, W + o.fences.offset, 'ground')
          const style = o.fences.style === 'auto' ? propStyleAt(world, frame, mid.x, mid.z, seed).fence : o.fences.style
          const run = 12 + Math.floor(h(ci, k, 11) * 24)
          for (let s = s0 + 2 + len / 2; s < s0 + 2 + run; s += len) {
            const q = spot(s, side, W + o.fences.offset, 'ground')
            if (onRoad(q.x, q.z, 0.3)) continue
            add('fence', q.x, q.y, q.z, q.yaw, { variant: style, length: len }, 0.2)
          }
        }
      }
      // Hay bales in the fields and the odd well, only where the land suits them.
      const field = (s: number, side: number, lat: number, biomes: string[], maxSlope: number) => {
        const q = spot(s, side, lat, 'ground')
        if (onRoad(q.x, q.z, 3) || !biomes.includes(biomeIdAt(world, frame, q.x, q.z))) return null
        const sl = Math.hypot(ground(q.x + 1, q.z) - ground(q.x - 1, q.z), ground(q.x, q.z + 1) - ground(q.x, q.z - 1)) / 2
        return sl <= maxSlope ? q : null
      }
      const bales = Math.floor((L / 100) * o.hayBales.density + h(ci, 0, 12))
      for (let b = 0; b < bales; b++) {
        const s = c0 + h(ci, b, 13) * (c1 - c0), side = h(ci, b, 14) < 0.5 ? 1 : -1
        const q = field(s, side, W + 10 + h(ci, b, 15) * 30, FARM_BIOMES, 0.15)
        if (!q) continue
        const round = h(ci, b, 16) < 0.6
        const group = 1 + Math.floor(h(ci, b, 17) * 4)
        for (let g = 0; g < group; g++) {
          const a = h(ci, b, 18 + g) * Math.PI * 2, r = g ? 2.2 + h(ci, b, 30 + g) * 2 : 0
          const x = q.x + Math.cos(a) * r, z = q.z + Math.sin(a) * r
          add('hay-bale', x, ground(x, z), z, h(ci, b, 40 + g) * Math.PI * 2, { variant: round ? 'round' : 'square' }, 0.9)
        }
      }
      const wells = Math.floor((L / 1000) * o.wells.density + h(ci, 0, 50))
      for (let w = 0; w < wells; w++) {
        const s = c0 + h(ci, w, 51) * (c1 - c0)
        const q = field(s, h(ci, w, 52) < 0.5 ? 1 : -1, W + 6 + h(ci, w, 53) * 8, WELL_BIOMES, 0.2)
        if (q) add('well', q.x, q.y, q.z, q.yaw, { variant: propStyleAt(world, frame, q.x, q.z, seed).well }, 1.1)
      }
    }
  })

  // Mailboxes at lot frontages.
  if (ctx.lots && o.mailboxes.chance > 0) {
    ctx.lots.forEach((lot, i) => {
      const f = lot.frontage
      if (!f || (lot.building ?? 0) < 0 || (lot.district && lot.district !== 'residential' && lot.district !== 'farmland')) return
      if (h(i, 0, 60) >= Math.max(o.mailboxes.chance, 0.85)) return
      // Nearest road chain to the frontage; the mailbox stands at its edge on the lot's side.
      let best: { c: Chain; s: number; d: number } | null = null
      for (const c of chains) {
        const n = c.walk.nearest(f.x, f.z)
        if (!best || n.d < best.d) best = { c, s: n.s, d: n.d }
      }
      if (!best || best.c.edge.bridge || best.d > 40) return
      const p = best.c.walk.at(best.s)
      const lx = -p.uz, lz = p.ux
      const side = (f.x - p.x) * lx + (f.z - p.z) * lz >= 0 ? 1 : -1
      const e = best.c.edge
      const lat = e.width / 2 + (e.sidewalk > 0 ? e.sidewalk - 0.35 : 0.9)
      const x = p.x + lx * side * lat, z = p.z + lz * side * lat
      const y = e.sidewalk > 0 ? p.y + o.curbHeight : ground(x, z)
      add(o.mailboxes.style === 'eu' ? 'mailbox-eu' : 'mailbox-us', x, y, z, yawFacing(-lx * side, -lz * side), {}, 0.3)
    })
  }
  return out
}

/** Settings of {@link planPowerLine}. Plain JSON. */
export interface PowerLineOptions {
  /** Seed for per-pole variety and the line id. */
  seed: number | string
  /** Distance between supports, metres (pylons: 250–400, wooden poles: 40–60). */
  spacing: number
  /** Support kind. */
  kind: 'power-pole' | 'pylon'
  /** Line id (default: hashed from the seed). */
  line?: number
  /** How far a support may slide along the line to stay out of water, as a share of `spacing`. */
  shift: number
}

/** Defaults of {@link planPowerLine}: pylons every 300 m. */
export const DEFAULT_POWER_LINE: PowerLineOptions = { seed: 1, spacing: 300, kind: 'pylon', shift: 0.35 }

/**
 * Supports for a power line along a polyline (e.g. between two settlement centres): evenly spaced,
 * turned across the line, slid along it to stay out of water (spans over water just get longer). The
 * poles share one `line` id, so {@link Props} strings them with catenary cables.
 */
export function planPowerLine(points: readonly (readonly [number, number])[], world: World, input: Partial<PowerLineOptions> = {}, frame: LocalFrame = world.frame): PropPlacement[] {
  const o = { ...DEFAULT_POWER_LINE, ...input }
  const seed = seedOf(o.seed)
  const line = o.line ?? (hash4(seed, 0x9a1, 0, 0) & 0xfffff)
  const walk = new Walker(points.map((p) => [p[0], 0, p[1]] as V3))
  const n = Math.max(1, Math.round(walk.length / o.spacing))
  const sample = createSample()
  const wet = (x: number, z: number) => {
    frame.sample(x, z, sample)
    return sample.waterLevel > sample.elevation
  }
  const out: PropPlacement[] = []
  for (let i = 0; i <= n; i++) {
    const s0 = (i / n) * walk.length
    let found: ReturnType<Walker['at']> | null = null
    // Try the planned spot, then alternately further away along the line.
    for (let k = 0; k <= 8 && !found; k++) {
      const off = k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (o.spacing * o.shift) / 4
      const s = Math.min(walk.length, Math.max(0, s0 + off))
      const p = walk.at(s)
      if (!wet(p.x, p.z)) found = p
    }
    if (!found) continue
    out.push({ kind: o.kind, x: found.x, y: frame.height(found.x, found.z), z: found.z, yaw: yawFacing(found.ux, found.uz), seed: hash4(seed, i, 0x9a2, 0) & 0x7fffffff, line })
  }
  return out
}
