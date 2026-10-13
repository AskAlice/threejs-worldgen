import { hash01, seedOf, type DeepPartial } from 'threejs-biomes'
import type { District, DistrictShares, DistrictStyle } from './districts.ts'
import type { RoadSurface, RoadType } from './graph.ts'
import { cellKey } from './hex.ts'
import { nearestOnPolyline } from './farm.ts'
import type { Landmark } from './landmarks.ts'
import type { PopulationData, Settlement, SettlementClass } from './population-model.ts'
import type { Network } from './population-network.ts'
import type { RoadOptions } from './roads.ts'

/** What a `City` builds, smallest first (see {@link citySize} for the population classes each one takes). */
export type SettlementSize = 'farmstead' | 'hamlet' | 'village' | 'town' | 'city' | 'metropolis'

/** Every size class, smallest first. */
export const SETTLEMENT_SIZES: readonly SettlementSize[] = ['farmstead', 'hamlet', 'village', 'town', 'city', 'metropolis']

/** Street layout styles. */
export type RoadStyle = 'grid' | 'organic' | 'radial'

/** What a size class looks like. */
export interface SizeClass {
  /** Population range of the class; a settlement's radius follows its population through it (log scale). */
  population: [number, number]
  /** Radius range, metres, from the smallest to the largest population of the class. */
  radius: [number, number]
  /** Tallest building, floors. */
  maxFloors: number
  /** Default street layout. */
  style: RoadStyle
  /** Arterial roads leaving the centre. */
  arms: number
  /** District shares. */
  districts: DistrictShares
  /** Road surface per road class. */
  surfaces: Record<RoadType, RoadSurface>
  /** Surface of the side streets in the downtown core (`null` = same as elsewhere). */
  oldTown: RoadSurface | null
  /** Downtown is a strip this many metres either side of the main street (the arterial through the centre), `districts.downtown` × radius long each way; 0 = a disc around the centre. */
  mainStreet: number
  /** Civic landmarks near the centre: how many of each (a fraction is the chance of one more). */
  landmarks: Record<Landmark, number>
  /** Road rules of this class, over the `roads` defaults (your own `roads` input still wins). */
  roads: DeepPartial<RoadOptions>
  /** District rules of this class, over the `districts.styles` defaults (your own input still wins). */
  styles: DeepPartial<Record<District, DistrictStyle>>
}

const NONE: Record<Landmark, number> = { church: 0, townHall: 0, waterTower: 0 }
const PAVED: Record<RoadType, RoadSurface> = { primary: 'asphalt', secondary: 'asphalt', minor: 'asphalt' }

/**
 * Default size classes. Population ranges match the population model's default class thresholds. A farmstead is a
 * farm (see `farm` options; its radius is the farmland around it); a hamlet a cluster of houses at a junction; a
 * village a few streets along the road through it, houses on big lots and a church; a town a main street of 2–3
 * storey shops and flats, a short grid of houses on big lots, a church, a town hall and a water tower, then fields;
 * cities and metropolises the full grid, with towers downtown.
 */
export const DEFAULT_SIZE_CLASSES: Record<SettlementSize, SizeClass> = {
  farmstead: {
    population: [1, 50], radius: [260, 420], maxFloors: 2, style: 'organic', arms: 0, districts: { downtown: 0, farmland: 0, industrial: 0, park: 0 },
    surfaces: { primary: 'asphalt', secondary: 'gravel', minor: 'dirt' }, oldTown: null, mainStreet: 0, landmarks: NONE,
    roads: { primary: { width: 7.5 } }, styles: {},
  },
  hamlet: {
    population: [50, 1000], radius: [70, 130], maxFloors: 2, style: 'organic', arms: 2, districts: { downtown: 0, farmland: 0.75, industrial: 0, park: 0 },
    surfaces: { primary: 'gravel', secondary: 'dirt', minor: 'dirt' }, oldTown: null, mainStreet: 0, landmarks: NONE,
    // Lanes branch off the road through it every ~40 m: the junctions the houses cluster round.
    roads: { primary: { width: 7, branchSpacing: 40, branchChance: 0.9 }, secondary: { width: 5, branchChance: 0.3 } },
    styles: { residential: { blockSize: 0, lotArea: 1000, lotWidth: 18, setback: 7, coverage: 0.9, floors: [1, 1.5] } },
  },
  village: {
    population: [1000, 10_000], radius: [160, 320], maxFloors: 2, style: 'organic', arms: 2, districts: { downtown: 0, farmland: 0.8, industrial: 0, park: 0.03 },
    surfaces: { primary: 'asphalt', secondary: 'gravel', minor: 'gravel' }, oldTown: null, mainStreet: 0, landmarks: { church: 1, townHall: 0.5, waterTower: 0 },
    roads: { primary: { width: 8, sidewalk: 1.5 }, secondary: { width: 6, branchSpacing: 130, branchChance: 0.6 } },
    styles: { residential: { blockSize: 0, lotArea: 1400, lotWidth: 20, setback: 7, coverage: 0.9, floors: [1, 2] } },
  },
  town: {
    population: [10_000, 100_000], radius: [420, 800], maxFloors: 3, style: 'grid', arms: 2, districts: { downtown: 0.3, farmland: 0.72, industrial: 0.1, park: 0.05 },
    surfaces: PAVED, oldTown: null, mainStreet: 42, landmarks: { church: 1, townHall: 1, waterTower: 1 },
    roads: {},
    styles: {
      downtown: { blockSize: 75, lotArea: 380, lotWidth: 9, setback: 0, coverage: 1, floors: [2, 3] },
      residential: { blockSize: 100, lotArea: 850, lotWidth: 17, setback: 6, floors: [1, 2] },
    },
  },
  city: {
    population: [100_000, 1_000_000], radius: [1000, 2000], maxFloors: 70, style: 'grid', arms: 4, districts: { downtown: 0.26, farmland: 0.95, industrial: 0.16, park: 0.07 },
    surfaces: PAVED, oldTown: null, mainStreet: 0, landmarks: NONE, roads: {}, styles: {},
  },
  metropolis: {
    population: [1_000_000, 10_000_000], radius: [1800, 2800], maxFloors: 110, style: 'grid', arms: 4, districts: { downtown: 0.3, farmland: 0.97, industrial: 0.16, park: 0.07 },
    surfaces: PAVED, oldTown: null, mainStreet: 0, landmarks: NONE,
    roads: { maxSegments: 15_000 },
    styles: { downtown: { floors: [8, 80] } },
  },
}

/** A settlement of the population model, as a `City` to build. */
export interface CitySite {
  /** Centre (frame-local). */
  x: number
  /** Centre (frame-local). */
  z: number
  /** Size class. */
  size: SettlementSize
  /** Radius, metres. */
  radius: number
  /** Seed for the city's own generation (stable per H3 cell and population seed). */
  seed: number
  /** The population model's settlement. */
  settlement: Settlement
  /** Farmsteads, when planned with a road network: the nearest road (frame-local polyline) and its class, for `farm.road` and `farm.roadType`. */
  road: { points: [number, number][]; type: RoadType } | null
}

/** What gets built for a population settlement class: the size class of the same name. */
export function citySize(settlementClass: SettlementClass): SettlementSize {
  return settlementClass
}

/** City radius for a settlement: where its population sits (log scale) in its size class's `population` range, mapped onto the class's `radius` range. */
export function cityRadius(settlement: Settlement, sizes: Record<SettlementSize, SizeClass> = DEFAULT_SIZE_CLASSES): number {
  const c = sizes[citySize(settlement.class)]
  const p0 = Math.max(1, c.population[0]), p1 = c.population[1]
  const t = p1 > p0 ? Math.log(Math.max(1, settlement.population) / p0) / Math.log(p1 / p0) : 1
  return c.radius[0] + (c.radius[1] - c.radius[0]) * Math.min(1, Math.max(0, t))
}

/**
 * The settlements to build for a population: one {@link CitySite} per settlement, largest first (farmsteads last).
 * Where settlements go and how many people they hold comes from the population model ({@link generatePopulation});
 * this maps them onto size classes. With the population's road network ({@link generateNetworks}), each farmstead
 * also gets the nearest road for its driveway. Deterministic from the population.
 *
 * @example
 * ```ts
 * const [site] = planCities(generatePopulation(world, { radius: 10_000 }))
 * const city = await City.create({ world, camera, scene, center: [site.x, site.z], size: site.size, radius: site.radius, seed: site.seed })
 * ```
 */
export function planCities(data: PopulationData, sizes: Record<SettlementSize, SizeClass> = DEFAULT_SIZE_CLASSES, network: Network | null = null): CitySite[] {
  const seed = seedOf(data.options.seed)
  const roads = network?.edges.filter((e) => e.type === 'highway' || e.type === 'road' || e.type === 'track') ?? []
  const out: CitySite[] = []
  for (const s of data.settlements) {
    const size = citySize(s.class)
    const [lo, hi] = cellKey(s.cell)
    let road: CitySite['road'] = null
    if (size === 'farmstead' && roads.length) {
      let best = Infinity
      for (const e of roads) {
        const d = nearestOnPolyline(e.points, s.position[0], s.position[1]).distance
        if (d < best) { best = d; road = { points: e.points.map(([x, z]) => [x, z]), type: e.type === 'track' ? 'secondary' : 'primary' } }
      }
    }
    out.push({ x: s.position[0], z: s.position[1], size, radius: cityRadius(s, sizes), seed: Math.floor(hash01(lo, hi, seed, 3) * 2 ** 31), settlement: s, road })
  }
  return out
}
