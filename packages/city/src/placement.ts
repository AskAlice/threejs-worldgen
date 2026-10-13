import { hash01, seedOf, smoothstep, type LocalFrame, type World, type WorldSample } from 'threejs-biomes'
import type { DistrictShares } from './districts.ts'
import type { RoadSurface, RoadType } from './graph.ts'

/** Settlement size classes, smallest first. */
export type SettlementSize = 'hamlet' | 'village' | 'town' | 'city'

/** Every size class, smallest first. */
export const SETTLEMENT_SIZES: readonly SettlementSize[] = ['hamlet', 'village', 'town', 'city']

/** Street layout styles. */
export type RoadStyle = 'grid' | 'organic' | 'radial'

/** What a size class looks like. */
export interface SizeClass {
  /** Importance (0..1, see {@link Settlement.importance}) a site needs for this class. */
  minScore: number
  /** Radius range, metres (interpolated by score within the class). */
  radius: [number, number]
  /** Population range (interpolated by score within the class). */
  population: [number, number]
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

/** Default size classes. */
export const DEFAULT_SIZE_CLASSES: Record<SettlementSize, SizeClass> = {
  hamlet: { minScore: 0, radius: [70, 130], population: [20, 150], maxFloors: 2, style: 'organic', arms: 2, districts: { downtown: 0, farmland: 0.6, industrial: 0, park: 0 }, surfaces: { primary: 'gravel', secondary: 'dirt', minor: 'dirt' }, oldTown: null },
  village: { minScore: 0.38, radius: [160, 320], population: [200, 2000], maxFloors: 3, style: 'organic', arms: 3, districts: { downtown: 0.12, farmland: 0.7, industrial: 0, park: 0.04 }, surfaces: { primary: 'asphalt', secondary: 'gravel', minor: 'gravel' }, oldTown: 'cobblestone' },
  town: { minScore: 0.58, radius: [420, 800], population: [3000, 40000], maxFloors: 9, style: 'radial', arms: 4, districts: { downtown: 0.2, farmland: 0.85, industrial: 0.14, park: 0.06 }, surfaces: { primary: 'asphalt', secondary: 'asphalt', minor: 'asphalt' }, oldTown: 'cobblestone' },
  city: { minScore: 0.76, radius: [1000, 2000], population: [60000, 2_000_000], maxFloors: 70, style: 'grid', arms: 4, districts: { downtown: 0.26, farmland: 0.95, industrial: 0.16, park: 0.07 }, surfaces: { primary: 'asphalt', secondary: 'asphalt', minor: 'asphalt' }, oldTown: null },
}

/** Settlement placement rules. */
export interface PlacementOptions {
  /** Seed (mixed with the world's). */
  seed: number | string
  /** One settlement at most per square region of this size, metres. */
  cellSize: number
  /** Distance between score samples inside a region, metres. */
  sampleSpacing: number
  /** Sites scoring below this get no settlement (0..1). */
  threshold: number
  /** Settlements keep this far from their region's edges, so neighbours are at least twice this apart, metres. */
  margin: number
  /** Slope (rise / run) at which flatness scores 0. */
  maxSlope: number
  /** How much nearness to water matters (0 = not at all, 1 = only waterside sites score well). */
  water: number
  /** Ideal temperature, °C. */
  temperature: number
  /** Temperature tolerance (σ), °C. */
  temperatureRange: number
  /** Ideal moisture, 0..1. */
  moisture: number
  /** Moisture tolerance (σ). */
  moistureRange: number
  /** Lowest acceptable height above sea level, metres (keeps towns out of flood plains). */
  minElevation: number
  /** Biome ids nobody settles in (their weight scales the score down). */
  excludeBiomes: string[]
  /** 0..1: how much a seeded per-region roll (prosperity, history) varies settlement size. */
  variety: number
  /** How much room to grow matters: the share of good land in the region scales the size (0..1). */
  room: number
  /** Size classes. */
  sizes: Record<SettlementSize, SizeClass>
}

/** Default placement rules. */
export const DEFAULT_PLACEMENT: PlacementOptions = {
  seed: 0, cellSize: 5000, sampleSpacing: 250, threshold: 0.35, margin: 600, maxSlope: 0.18, water: 0.6,
  temperature: 14, temperatureRange: 11, moisture: 0.5, moistureRange: 0.3, minElevation: 2,
  excludeBiomes: ['deepOcean', 'glacier', 'mountainPeaks', 'volcanic', 'wetland', 'mangrove'],
  variety: 0.5, room: 0.6,
  sizes: DEFAULT_SIZE_CLASSES,
}

/** Placement input: any subset of {@link PlacementOptions}. */
export type PlacementInput = Partial<PlacementOptions>

/** A rectangle in frame-local metres. */
export interface Region {
  /** West edge. */
  minX: number
  /** North edge. */
  minZ: number
  /** East edge. */
  maxX: number
  /** South edge. */
  maxZ: number
}

/** A chosen settlement site. */
export interface Settlement {
  /** Centre (frame-local). */
  x: number
  /** Centre (frame-local). */
  z: number
  /** Suitability of the site itself, 0..1. */
  score: number
  /** What the size class is chosen by: score × room to grow × a seeded prosperity roll, 0..1. */
  importance: number
  /** Size class. */
  size: SettlementSize
  /** Radius, metres. */
  radius: number
  /** Expected population. */
  population: number
  /** Seed for the settlement's own generation (stable per region cell). */
  seed: number
}

/** Result of {@link sizeForScore}. */
export interface SizePick {
  /** Size class. */
  size: SettlementSize
  /** Position within the class, 0..1. */
  t: number
}

/** Size class for an importance score (the largest whose `minScore` it meets) and how far into that class it is (0..1). */
export function sizeForScore(score: number, sizes: Record<SettlementSize, SizeClass>): SizePick {
  let size: SettlementSize = 'hamlet'
  for (const s of SETTLEMENT_SIZES) if (score >= sizes[s].minScore) size = s
  const i = SETTLEMENT_SIZES.indexOf(size)
  const lo = sizes[size].minScore
  const hi = i < SETTLEMENT_SIZES.length - 1 ? sizes[SETTLEMENT_SIZES[i + 1]].minScore : 1
  return { size, t: Math.min(1, Math.max(0, (score - lo) / Math.max(1e-6, hi - lo))) }
}

/**
 * Scores one site 0..1: flat × near water but dry × temperate × not in an excluded biome.
 * `sample` must be `frame.sample(x, z)`; `slope` is rise / run there.
 */
export function scoreSite(world: World, sample: WorldSample, slope: number, o: PlacementOptions): number {
  if (sample.waterLevel === sample.waterLevel) return 0
  if (sample.elevation - world.options.seaLevel < o.minElevation) return 0
  let excluded = 0
  for (let i = 0; i < sample.count; i++) if (o.excludeBiomes.includes(world.options.biomes[sample.biomes[i]]?.id)) excluded += sample.weights[i]
  const flat = 1 - smoothstep(0, o.maxSlope, slope)
  // Rivers (valleys) and coasts (continentalness just above 0) are good; the river channel itself is not.
  const near = Math.max(sample.valley * (1 - sample.river), smoothstep(0.35, 0.05, sample.continentalness) * smoothstep(-0.05, 0.03, sample.continentalness))
  const water = 1 - o.water + o.water * near
  const dt = (sample.temperature - o.temperature) / o.temperatureRange
  const dm = (sample.moisture - o.moisture) / o.moistureRange
  const climate = Math.exp(-0.5 * (dt * dt + dm * dm))
  return Math.max(0, flat * water * climate * (1 - excluded))
}

/**
 * Finds settlement sites in a region of a world frame. The plane is cut into `cellSize` squares
 * (aligned to the frame origin, so results don't depend on the region you ask for); each square's
 * inner area is sampled on a grid, and the best-scoring site above `threshold` becomes a settlement,
 * sized by its importance (score × room to grow × a seeded roll), so cities are rare and hamlets common. Deterministic from the world, frame and `seed`.
 */
export function findSettlements(world: World, frame: LocalFrame = world.frame, region: Region, input: PlacementInput = {}): Settlement[] {
  const o: PlacementOptions = { ...DEFAULT_PLACEMENT, ...input, sizes: { ...DEFAULT_PLACEMENT.sizes, ...input.sizes } }
  const seed = seedOf(o.seed) ^ seedOf(world.options.seed)
  const out: Settlement[] = []
  const cs = o.cellSize
  let s: WorldSample | undefined
  const e = Math.min(30, o.sampleSpacing / 4)
  for (let ci = Math.floor(region.minX / cs); ci <= Math.floor(region.maxX / cs); ci++) {
    for (let cj = Math.floor(region.minZ / cs); cj <= Math.floor(region.maxZ / cs); cj++) {
      let best = -1, bx = 0, bz = 0, good = 0, total = 0
      const m = Math.min(o.margin, cs * 0.45)
      // A per-cell jitter of the sampling grid keeps sites off a visible lattice.
      const jx = (hash01(ci, cj, seed, 1) - 0.5) * o.sampleSpacing, jz = (hash01(ci, cj, seed, 2) - 0.5) * o.sampleSpacing
      for (let x = ci * cs + m + o.sampleSpacing / 2; x < (ci + 1) * cs - m; x += o.sampleSpacing) {
        for (let z = cj * cs + m + o.sampleSpacing / 2; z < (cj + 1) * cs - m; z += o.sampleSpacing) {
          const px = Math.min((ci + 1) * cs - m, Math.max(ci * cs + m, x + jx)), pz = Math.min((cj + 1) * cs - m, Math.max(cj * cs + m, z + jz))
          s = frame.sample(px, pz, s)
          if (s.waterLevel === s.waterLevel) { total++; continue }
          const h = s.elevation
          const slope = Math.max(Math.abs(frame.height(px + e, pz) - h), Math.abs(frame.height(px, pz + e) - h)) / e
          const score = scoreSite(world, s, slope, o)
          total++
          if (score > 0.5) good++
          if (score > best) { best = score; bx = px; bz = pz }
        }
      }
      if (best < o.threshold || bx < region.minX || bx > region.maxX || bz < region.minZ || bz > region.maxZ) continue
      const room = total ? good / total : 0
      const importance = best * (1 - o.room + o.room * Math.sqrt(room)) * (1 - o.variety * hash01(ci, cj, seed, 4))
      const { size, t } = sizeForScore(importance, o.sizes)
      const c = o.sizes[size]
      out.push({
        x: bx, z: bz, score: best, importance, size,
        radius: c.radius[0] + (c.radius[1] - c.radius[0]) * t,
        population: Math.round(c.population[0] * Math.pow(c.population[1] / Math.max(1, c.population[0]), t)),
        seed: Math.floor(hash01(ci, cj, seed, 3) * 2 ** 31),
      })
    }
  }
  return out
}
