import { hash01, seedOf } from 'threejs-biomes'
import type { DistrictShares } from './districts.ts'
import type { RoadSurface, RoadType } from './graph.ts'
import { cellKey } from './hex.ts'
import type { PopulationData, Settlement, SettlementClass } from './population-model.ts'

/** What a `City` builds, smallest first (see {@link citySize} for the population classes each one takes). */
export type SettlementSize = 'hamlet' | 'village' | 'town' | 'city'

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
}

/** Default size classes. Population ranges match the population model's default class thresholds. */
export const DEFAULT_SIZE_CLASSES: Record<SettlementSize, SizeClass> = {
  hamlet: { population: [50, 1000], radius: [70, 130], maxFloors: 2, style: 'organic', arms: 2, districts: { downtown: 0, farmland: 0.6, industrial: 0, park: 0 }, surfaces: { primary: 'gravel', secondary: 'dirt', minor: 'dirt' }, oldTown: null },
  village: { population: [1000, 10_000], radius: [160, 320], maxFloors: 3, style: 'organic', arms: 3, districts: { downtown: 0.12, farmland: 0.7, industrial: 0, park: 0.04 }, surfaces: { primary: 'asphalt', secondary: 'gravel', minor: 'gravel' }, oldTown: 'cobblestone' },
  town: { population: [10_000, 100_000], radius: [420, 800], maxFloors: 9, style: 'radial', arms: 4, districts: { downtown: 0.2, farmland: 0.85, industrial: 0.14, park: 0.06 }, surfaces: { primary: 'asphalt', secondary: 'asphalt', minor: 'asphalt' }, oldTown: 'cobblestone' },
  city: { population: [100_000, 1_000_000], radius: [1000, 2000], maxFloors: 70, style: 'grid', arms: 4, districts: { downtown: 0.26, farmland: 0.95, industrial: 0.16, park: 0.07 }, surfaces: { primary: 'asphalt', secondary: 'asphalt', minor: 'asphalt' }, oldTown: null },
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
}

const CITY_SIZE: Record<SettlementClass, SettlementSize | null> = { metropolis: 'city', city: 'city', town: 'town', village: 'village', hamlet: 'hamlet', farmstead: null }

/** What gets built for a population settlement class: metropolises and cities are cities; farmsteads get no `City` (`null`). */
export function citySize(settlementClass: SettlementClass): SettlementSize | null {
  return CITY_SIZE[settlementClass]
}

/** City radius for a settlement: where its population sits (log scale) in its size class's `population` range, mapped onto the class's `radius` range. */
export function cityRadius(settlement: Settlement, sizes: Record<SettlementSize, SizeClass> = DEFAULT_SIZE_CLASSES): number {
  const c = sizes[citySize(settlement.class) ?? 'hamlet']
  const p0 = Math.max(1, c.population[0]), p1 = c.population[1]
  const t = p1 > p0 ? Math.log(Math.max(1, settlement.population) / p0) / Math.log(p1 / p0) : 1
  return c.radius[0] + (c.radius[1] - c.radius[0]) * Math.min(1, Math.max(0, t))
}

/**
 * The cities to build for a population: one {@link CitySite} per settlement that gets one (see {@link citySize}),
 * largest first. Where settlements go and how many people they hold comes from the population model
 * ({@link generatePopulation}); this maps them onto size classes. Deterministic from the population.
 *
 * @example
 * ```ts
 * const [site] = planCities(generatePopulation(world, { radius: 10_000 }))
 * const city = await City.create({ world, camera, scene, center: [site.x, site.z], size: site.size, radius: site.radius, seed: site.seed })
 * ```
 */
export function planCities(data: PopulationData, sizes: Record<SettlementSize, SizeClass> = DEFAULT_SIZE_CLASSES): CitySite[] {
  const seed = seedOf(data.options.seed)
  const out: CitySite[] = []
  for (const s of data.settlements) {
    const size = citySize(s.class)
    if (!size) continue
    const [lo, hi] = cellKey(s.cell)
    out.push({ x: s.position[0], z: s.position[1], size, radius: cityRadius(s, sizes), seed: Math.floor(hash01(lo, hi, seed, 3) * 2 ** 31), settlement: s })
  }
  return out
}
