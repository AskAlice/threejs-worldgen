import { hash4, mulberry32, seedOf } from 'threejs-biomes'
import { architectureFor, type ArchitectureName, type Climate } from './architecture.ts'
import { extractBlocks, type Block } from './blocks.ts'
import { planBuilding, type Building } from './buildings.ts'
import { DistrictMap, type District } from './districts.ts'
import type { RoadGraph } from './graph.ts'
import { roadsideLots, subdivideBlock, type Lot } from './lots.ts'
import type { CityOptions } from './options.ts'
import type { RoadStyle } from './placement.ts'
import { pointInPolygon, pointSegment, segmentIntersection } from './polygon.ts'
import { assignSurfaces, growRoads } from './roads.ts'
import { Site, type SiteFn } from './site.ts'
import { TensorField } from './tensor-field.ts'
import { gradeRoads, type RoadProfile } from './terrain.ts'

/** A lot with its district. */
export interface PlannedLot extends Lot {
  /** District at the lot's centroid. */
  district: District
}

/** Everything generated for one settlement, before any rendering. Plain data plus the road graph. */
export interface CityPlan {
  /** Centre (frame-local). */
  center: [number, number]
  /** Radius used, metres. */
  radius: number
  /** Street layout used. */
  style: RoadStyle
  /** Architecture used. */
  architecture: ArchitectureName
  /** Ground under the settlement. */
  site: Site
  /** District layout. */
  districts: DistrictMap
  /** Road network (planar graph); node heights are graded road surface heights. */
  graph: RoadGraph
  /** Graded centreline of every road edge, by edge id. */
  profiles: RoadProfile[]
  /** City blocks. */
  blocks: Block[]
  /** Lots. */
  lots: PlannedLot[]
  /** Buildings (with base heights). */
  buildings: Building[]
  /** Estimated residents. */
  population: number
}

/** Automatic terrain sampling resolution for a radius, metres. */
export function siteResolution(radius: number): number {
  return Math.min(25, Math.max(6, radius / 60))
}

/**
 * Plans a whole settlement: samples the ground, grows roads, grades them, extracts blocks, splits
 * lots and plans buildings. A generator that yields every few milliseconds of work, so it can run
 * to completion at once (`runToEnd`) or spread over frames. Pure: the same ground and options give
 * the same plan.
 * @param ground Height and water lookup in frame-local coordinates (e.g. `Site.frameFn(frame)`).
 * @param climate Climate at the centre, for `architecture: 'auto'` (`options.climate` wins; temperate if neither).
 */
export function* planCity(ground: SiteFn, o: CityOptions, climate: Climate | null = null): Generator<void, CityPlan> {
  const seed = seedOf(o.seed)
  const sizeClass = o.sizes[o.size]
  const radius = o.radius > 0 ? o.radius : (sizeClass.radius[0] + sizeClass.radius[1]) / 2
  const style: RoadStyle = o.style === 'auto' ? sizeClass.style : o.style
  const [cx, cz] = o.center
  const c = o.climate ?? climate
  const architecture: ArchitectureName = o.architecture !== 'auto' ? o.architecture : c ? architectureFor(c) : 'temperate'
  const arch = o.architectures[architecture]

  // 1. Ground.
  const site = Site.around(cx, cz, radius * (o.roads.extent + 0.15), o.siteResolution > 0 ? o.siteResolution : siteResolution(radius))
  for (let j = 0; j < site.count; j++) {
    site.fillRow(ground, j)
    if ((j & 7) === 7) yield
  }

  // 2. Roads.
  const districts = new DistrictMap(o.districts, sizeClass.districts, cx, cz, radius, seed)
  const field = new TensorField(o.field, cx, cz, radius, seed, site)
  const graph = yield* growRoads({ site, field, districts, cx, cz, radius, arms: o.roads.arms > 0 ? o.roads.arms : sizeClass.arms, seed }, o.roads)
  assignSurfaces(graph, districts, sizeClass.surfaces, sizeClass.oldTown, o.roads)
  const profiles = gradeRoads(graph, site, o.terrain)
  yield

  // 3. Blocks and lots.
  const blocks = extractBlocks(graph, o.blocks)
  const lots: PlannedLot[] = []
  const target = (x: number, z: number) => {
    const s = districts.style(x, z)
    return { area: s.lotArea, width: s.lotWidth }
  }
  for (const block of blocks) {
    const rand = mulberry32(hash4(seed, block.id, 17, 3))
    for (const lot of subdivideBlock(block.polygon, target, rand, o.lotJitter, block.id, lots.length)) {
        if (lot.polygon.some(([x, z]) => site.wet(x, z)) || site.wet(lot.center[0], lot.center[1]) || crossedByRoad(lot, graph)) continue
      lot.id = lots.length
      lots.push({ ...lot, district: districts.at(lot.center[0], lot.center[1]) })
    }
    if ((block.id & 15) === 15) yield
  }

  // Roadside lots where roads run through open ground (villages, outskirts, farm roads).
  const blockGrid = new Map<number, number[]>()
  for (const b of blocks) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
    for (const [x, z] of b.outline) { minX = Math.min(minX, x); minZ = Math.min(minZ, z); maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z) }
    for (let i = Math.floor(minX / 50); i <= Math.floor(maxX / 50); i++) for (let j = Math.floor(minZ / 50); j <= Math.floor(maxZ / 50); j++) {
      const k = ((i + 32768) & 0xffff) | (((j + 32768) & 0xffff) << 16)
      const list = blockGrid.get(k)
      if (list) list.push(b.id)
      else blockGrid.set(k, [b.id])
    }
  }
  const inBlock = (x: number, z: number) => {
    const k = ((Math.floor(x / 50) + 32768) & 0xffff) | (((Math.floor(z / 50) + 32768) & 0xffff) << 16)
    for (const id of blockGrid.get(k) ?? []) if (pointInPolygon(x, z, blocks[id].outline)) return true
    return false
  }
  const roadside = roadsideLots(graph, (x, z) => {
    if (Math.hypot(x - cx, z - cz) > radius * 1.1) return null
    const s = districts.style(x, z)
    return s.coverage > 0 ? { area: s.lotArea, width: s.lotWidth } : null
  }, (lot) => inBlock(lot.center[0], lot.center[1]) || lot.polygon.some(([x, z]) => inBlock(x, z) || site.wet(x, z)) || crossedByRoad(lot, graph), o.roadside)
  for (const lot of roadside) {
    lot.id = lots.length
    lots.push({ ...lot, district: districts.at(lot.center[0], lot.center[1]) })
  }
  yield

  // 4. Buildings.
  const buildings: Building[] = []
  const t = o.terrain
  for (const lot of lots) {
    const s = o.districts.styles[lot.district]
    const rand = mulberry32(hash4(seed, lot.id, 29, 5))
    const b = planBuilding(lot, {
      district: lot.district, density: districts.density(lot.center[0], lot.center[1]),
      floors: s.floors, maxFloors: sizeClass.maxFloors, setback: s.setback, coverage: s.coverage, architecture: arch,
    }, o.buildings, rand, buildings.length)
    if (!b) continue
    let lo = Infinity, hi = -Infinity
    for (const part of b.parts) for (const [x, z] of part.tiers[0].polygon) {
      const h = site.height(x, z)
      lo = Math.min(lo, h); hi = Math.max(hi, h)
    }
    if (b.stilts > 0) {
      // Stilt houses leave the ground alone and stand clear of the highest point (or water).
      const w = site.waterLevel(b.center[0], b.center[1])
      b.base = Math.max(hi, w === w ? w : -Infinity) + b.stilts
      b.bottom = b.base - 0.3
    } else if (t.flatten && t.flattenLots) {
      b.base = site.height(b.center[0], b.center[1])
      b.bottom = Math.min(lo, b.base) - t.foundation
    } else {
      b.base = hi
      b.bottom = lo - t.foundation
    }
    buildings.push(b)
    if ((buildings.length & 255) === 255) yield
  }

  let population = 0
  for (const b of buildings) population += b.population
  return { center: [cx, cz], radius, style, architecture, site, districts, graph, profiles, blocks, lots, buildings, population: Math.round(population) }
}

/** True if a road (e.g. a dead-end street the block outline ignored) runs through or too close to the lot. */
function crossedByRoad(lot: Lot, graph: RoadGraph): boolean {
  const p = lot.polygon
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
  for (const [x, z] of p) { minX = Math.min(minX, x); minZ = Math.min(minZ, z); maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z) }
  const pad = 12
  for (const id of graph.edgesInBox(minX - pad, minZ - pad, maxX + pad, maxZ + pad)) {
    const e = graph.edges[id]
    const a = graph.nodes[e.a], b = graph.nodes[e.b]
    const clear = e.width / 2 + e.sidewalk - 0.25
    if (pointInPolygon(a.x, a.z, p) || pointInPolygon(b.x, b.z, p)) return true
    for (let i = 0; i < p.length; i++) {
      const q = p[i], r = p[(i + 1) % p.length]
      if (segmentIntersection(a.x, a.z, b.x, b.z, q[0], q[1], r[0], r[1])) return true
      if (pointSegment(q[0], q[1], a.x, a.z, b.x, b.z).distance < clear) return true
    }
  }
  return false
}
