import type { ArchitectureName, RoofShape, WallMaterial } from './architecture.ts'
import type { BuildingStyle, Entrance } from './buildings.ts'
import type { District } from './districts.ts'
import type { RoadEdge, RoadSurface, RoadType } from './graph.ts'
import type { CityPlan } from './plan.ts'
import type { RoadStyle } from './placement.ts'
import type { Vec2 } from './polygon.ts'
import type { RoadOptions } from './roads.ts'

/** Who may use a road. */
export interface RoadAccess {
  /** Cars, vans, buses. */
  car: boolean
  /** Bicycles. */
  bicycle: boolean
  /** People on foot (on sidewalks where there are some, else on the verge). */
  pedestrian: boolean
}

/** A road node as plain data. */
export interface RoadNodeData {
  /** Node id. */
  id: number
  /** Position (frame-local). */
  x: number
  /** Graded road surface height (local y). */
  y: number
  /** Position (frame-local). */
  z: number
  /** Edge ids meeting here. */
  edges: number[]
}

/** A road edge as plain data, with what vehicles and prop placers need. */
export interface RoadEdgeData {
  /** Edge id. */
  id: number
  /** Start node id. */
  a: number
  /** End node id. */
  b: number
  /** Class. */
  type: RoadType
  /** Surface. */
  surface: RoadSurface
  /** Carriageway width, metres. */
  width: number
  /** Sidewalk width per side, metres (0 = rural, no kerbs). */
  sidewalk: number
  /** On a bridge deck. */
  bridge: boolean
  /** Length, metres. */
  length: number
  /** Lanes per direction (two-way everywhere). */
  lanes: number
  /** Speed limit including the surface's slow-down, m/s. */
  speed: number
  /** Who may use it. */
  access: RoadAccess
  /** Graded centreline [x, y, z] (frame-local), from `a` to `b`. */
  points: [number, number, number][]
}

/** Where a lot meets its street. */
export interface Frontage {
  /** Middle of the street-facing lot edge. */
  x: number
  /** Middle of the street-facing lot edge. */
  z: number
  /** Unit normal pointing from the street into the lot. */
  nx: number
  /** Unit normal pointing from the street into the lot. */
  nz: number
  /** Nearest road edge id (−1 if none found). */
  edge: number
}

/** A lot as plain data. */
export interface LotData {
  /** Lot id. */
  id: number
  /** Block id. */
  block: number
  /** District. */
  district: District
  /** Outline (frame-local), counter-clockwise. */
  polygon: Vec2[]
  /** Area, m². */
  area: number
  /** Street access (null for interior lots). */
  frontage: Frontage | null
  /** Building on the lot, or −1. */
  building: number
}

/** A building as plain data. */
export interface BuildingData {
  /** Building id. */
  id: number
  /** Lot id. */
  lot: number
  /** District. */
  district: District
  /** Style. */
  style: BuildingStyle
  /** Wall material. */
  material: WallMaterial
  /** Main roof shape. */
  roof: RoofShape
  /** Storeys. */
  floors: number
  /** Wall height above the base, metres. */
  height: number
  /** Ground-floor level (local y). */
  base: number
  /** Ground-floor outline of the main volume (frame-local). */
  footprint: Vec2[]
  /** Footprint centroid. */
  center: Vec2
  /** Main door. */
  entrance: Entrance
  /** Estimated residents. */
  population: number
}

/** The road network as plain data. */
export interface RoadNetworkData {
  /** Nodes. */
  nodes: RoadNodeData[]
  /** Edges. */
  edges: RoadEdgeData[]
}

/** Everything another package needs to put props, vehicles and people into a settlement. JSON-safe. */
export interface CityData {
  /** Centre (frame-local). */
  center: [number, number]
  /** Radius, metres. */
  radius: number
  /** Street layout. */
  style: RoadStyle
  /** Architecture. */
  architecture: ArchitectureName
  /** Estimated residents. */
  population: number
  /** Road network. */
  roads: RoadNetworkData
  /** Lots. */
  lots: LotData[]
  /** Buildings. */
  buildings: BuildingData[]
}

/** Plain-data snapshot of a plan (frame-local coordinates; y = local height). */
export function cityData(plan: CityPlan, roads: RoadOptions): CityData {
  const { graph } = plan
  const byLot = new Map<number, number>()
  for (const b of plan.buildings) byLot.set(b.lot, b.id)
  return {
    center: plan.center, radius: plan.radius, style: plan.style, architecture: plan.architecture, population: plan.population,
    roads: {
      nodes: graph.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, z: n.z, edges: n.edges.slice() })),
      edges: graph.edges.map((e) => ({
        id: e.id, a: e.a, b: e.b, type: e.type, surface: e.surface, width: e.width, sidewalk: e.sidewalk, bridge: e.bridge,
        length: graph.length(e.id), lanes: roads.traffic[e.type].lanes, speed: roads.traffic[e.type].speed * roads.surfaceSpeed[e.surface],
        access: { car: true, bicycle: true, pedestrian: true }, points: plan.profiles[e.id].points.map((p) => [p[0], p[1], p[2]] as [number, number, number]),
      })),
    },
    lots: plan.lots.map((l) => {
      let frontage: Frontage | null = null
      if (l.front >= 0) {
        const a = l.polygon[l.front], b = l.polygon[(l.front + 1) % l.polygon.length]
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
        const x = (a[0] + b[0]) / 2, z = (a[1] + b[1]) / 2
        const hit = graph.nearestEdge(x, z, 40)
        frontage = { x, z, nx: -(b[1] - a[1]) / len, nz: (b[0] - a[0]) / len, edge: hit ? hit.edge : -1 }
      }
      return { id: l.id, block: l.block, district: l.district, polygon: l.polygon.map((p) => [p[0], p[1]] as Vec2), area: l.area, frontage, building: byLot.get(l.id) ?? -1 }
    }),
    buildings: plan.buildings.map((b) => ({
      id: b.id, lot: b.lot, district: b.district, style: b.style, material: b.material, roof: b.parts[0].roof, floors: b.floors,
      height: b.height, base: b.base, footprint: b.parts[0].tiers[0].polygon.map((p) => [p[0], p[1]] as Vec2), center: b.center,
      entrance: { ...b.entrance }, population: b.population,
    })),
  }
}

/** Position on a road: `t` 0..1 from node `a` to `b`, `lateral` metres to the left of the direction of travel a→b. */
export function pointOnEdge(edge: RoadEdgeData, t: number, lateral = 0): [number, number, number] {
  const pts = edge.points
  const f = Math.min(1, Math.max(0, t)) * (pts.length - 1)
  const i = Math.min(pts.length - 2, Math.floor(f))
  const k = f - i
  const a = pts[0], b = pts[pts.length - 1]
  const len = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1
  const lx = (b[2] - a[2]) / len, lz = -(b[0] - a[0]) / len
  const p = pts[i], q = pts[i + 1]
  return [p[0] + (q[0] - p[0]) * k + lx * lateral, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k + lz * lateral]
}

/** Lateral offset (metres left of a→b) of the centre of lane `lane` (0 = nearest the centreline) in a direction (+1 = a→b, −1 = b→a). Drives on the right. */
export function laneOffset(edge: RoadEdgeData, lane: number, direction: 1 | -1): number {
  const laneWidth = edge.width / 2 / Math.max(1, edge.lanes)
  return -direction * laneWidth * (lane + 0.5)
}

/** A spot beside a road (for street lights, power poles, bins, mailboxes). */
export interface RoadAnchor {
  /** Position (frame-local). */
  x: number
  /** Height (local y). */
  y: number
  /** Position (frame-local). */
  z: number
  /** Unit normal facing the road from the anchor. */
  nx: number
  /** Unit normal facing the road from the anchor. */
  nz: number
  /** Edge id. */
  edge: number
}

/** Options for {@link roadAnchors}. */
export interface RoadAnchorOptions {
  /** Distance between anchors along a road, metres. */
  spacing: number
  /** `'kerb'`: on the sidewalk near the kerb (or the verge on rural roads); `'edge'`: at the outer edge. */
  place: 'kerb' | 'edge'
  /** Extra offset outwards, metres. */
  offset: number
  /** Which sides: both, or alternate sides (power lines usually run on one side). */
  sides: 'both' | 'one'
  /** Only these classes (empty = all). */
  types: RoadType[]
  /** Only these surfaces (empty = all). */
  surfaces: RoadSurface[]
  /** Skip anchors this close to a junction, metres. */
  junctionClearance: number
}

/** Evenly spaced spots along every matching road, e.g. street lights every 30 m on asphalt. */
export function roadAnchors(data: CityData, options: Partial<RoadAnchorOptions> = {}): RoadAnchor[] {
  const o: RoadAnchorOptions = { spacing: 30, place: 'kerb', offset: 0, sides: 'both', types: [], surfaces: [], junctionClearance: 8, ...options }
  const out: RoadAnchor[] = []
  for (const e of data.roads.edges) {
    if ((o.types.length && !o.types.includes(e.type)) || (o.surfaces.length && !o.surfaces.includes(e.surface)) || e.bridge) continue
    const usable = e.length - 2 * o.junctionClearance
    if (usable <= 0) continue
    const n = Math.max(1, Math.floor(usable / o.spacing))
    const lat = e.width / 2 + (o.place === 'kerb' ? Math.min(0.6, e.sidewalk * 0.3) || 0.8 : e.sidewalk + 0.5) + o.offset
    for (let i = 0; i < n; i++) {
      const t = (o.junctionClearance + ((i + 0.5) / n) * usable) / e.length
      for (const side of o.sides === 'both' ? [1, -1] : [e.id % 2 ? 1 : -1]) {
        const [x, y, z] = pointOnEdge(e, t, side * lat)
        const c = pointOnEdge(e, t, 0)
        const l = Math.hypot(c[0] - x, c[2] - z) || 1
        out.push({ x, y: y + (e.sidewalk > 0 ? 0.15 : 0), z, nx: (c[0] - x) / l, nz: (c[2] - z) / l, edge: e.id })
      }
    }
  }
  return out
}

/** Travel modes for {@link routeCost}. */
export type TravelMode = 'car' | 'bicycle' | 'pedestrian'

/**
 * Edge cost (seconds) for `RoadGraph.shortestPath`: cars prefer fast arterials, bicycles avoid
 * arterials and rough surfaces, pedestrians walk at 1.4 m/s and prefer sidewalks.
 */
export function routeCost(mode: TravelMode, roads: RoadOptions): (edge: RoadEdge, length: number) => number {
  return (e, length) => {
    if (mode === 'pedestrian') return (length / 1.4) * (e.sidewalk > 0 ? 1 : 1.3)
    const v = roads.traffic[e.type].speed * roads.surfaceSpeed[e.surface]
    if (mode === 'car') return length / v
    return (length / Math.min(5.5, v)) * (e.type === 'primary' ? 1.5 : 1) * (e.surface === 'asphalt' ? 1 : 1.4)
  }
}
