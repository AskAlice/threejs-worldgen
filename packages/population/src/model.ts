import type { DeepPartial, LocalFrame, World, WorldSample } from 'threejs-biomes'
import { cellKey, HexGrid } from './hex.ts'

/** Size class of a settlement, by population (see {@link SettlementThresholds}). */
export type SettlementClass = 'metropolis' | 'city' | 'town' | 'village' | 'hamlet' | 'farmstead'

/** What a fine cell is used for. */
export type LandUse = 'urban' | 'suburban' | 'farmland' | 'wilderness' | 'water'

/** Minimum populations of each settlement class; ranked settlements below `village` are hamlets. */
export interface SettlementThresholds {
  /** People in a metropolis. */
  metropolis: number
  /** People in a city. */
  city: number
  /** People in a town. */
  town: number
  /** People in a village. */
  village: number
}

/** When a fine cell counts as each land use (water comes from the world; the rest is wilderness). */
export interface LandUseThresholds {
  /** People per km² from which a cell is urban. */
  urban: number
  /** People per km² from which a cell is suburban. */
  suburban: number
  /** Habitability from which a (rural) cell is farmland. */
  farmland: number
}

/** How good a place is to live: each factor is 0…1 and they multiply. */
export interface HabitabilityOptions {
  /** Biome ids that are never settled where they dominate (weight > 0.5) and thin out settlement elsewhere. */
  avoid: string[]
  /** Fertility 0…1 per biome id (blended by biome weight). */
  fertility: Record<string, number>
  /** Fertility of biomes missing from `fertility`. */
  defaultFertility: number
  /** Slope (rise/run) at which land becomes uninhabitable; gentler is better. */
  maxSlope: number
  /** Most comfortable temperature, °C. */
  temperature: number
  /** Temperature distance (°C) at which comfort drops to 1/e. */
  temperatureRange: number
  /** 0…1: how much fresh water (rivers, valleys) or a coast nearby matters. */
  water: number
}

/** How settlements and people are connected (see `generateNetworks`). */
export interface NetworkOptions {
  /** Build networks at all. */
  enabled: boolean
  /** Extra road links beyond the spanning tree, as a fraction of the settlement count (gravity model). */
  extraEdges: number
  /** Distance exponent of the gravity model (interaction = P₁·P₂ / dᵏ). */
  gravityExponent: number
  /** Add a gravity link only when the network path is at least this many times the straight distance. */
  detour: number
  /** Nearest settlements considered for gravity links, per settlement. */
  neighbours: number
  /** Extra cost per unit slope² for roads (cost = length × (1 + slopeCost × slope²)). */
  slopeCost: number
  /** Extra cost per unit slope² for railways (rail hates hills). */
  railSlopeCost: number
  /** Cost multiplier for crossing water (bridges). */
  waterCost: number
  /** Cost multiplier on cells an earlier route already uses, so roads merge into trunks (1 = off). */
  reuse: number
  /** Both ends at least this populous: highway. */
  highwayPopulation: number
  /** Both ends at least this populous: road (else track). */
  roadPopulation: number
  /** Settlements at least this populous get a railway (0 = no rail). */
  railPopulation: number
  /** Settlements at least this populous get power lines (0 = none). */
  powerlinePopulation: number
  /** Chaikin smoothing passes on routed polylines. */
  smoothing: number
}

/** Every population setting. Plain data: save it, share it, send it to a worker, bind it to a GUI. */
export interface PopulationOptions {
  /** Seed: the same seed, options and world always give the same population. */
  seed: number | string
  /** Planets: `[latitude, longitude]` of the local frame the region is in; `null` = `world.frame`. */
  location: [number, number] | null
  /** Centre of the populated region in local `[x, z]`, metres. */
  center: [number, number]
  /** Radius of the populated region, metres. */
  radius: number
  /** Target edge length of the finest cells, metres (picks the nearest H3 resolution for this world). */
  cellSize: number
  /** People in the region. */
  totalPopulation: number
  /** 0…1 share living dispersed in the countryside rather than in ranked settlements. */
  ruralShare: number
  /** Rank-size (Zipf) exponent: the r-th settlement has P₁ / rᵏ people. */
  zipf: number
  /** Tiers of central places (1…4): urban centres, towns, villages, hamlets; one H3 resolution apart. */
  levels: number
  /** 0…1 seeded jitter on site scores, so the lattice of central places looks natural. */
  jitter: number
  /** Smoothed habitability a site needs to become a settlement. */
  minHabitability: number
  /** 0…1 share of hamlet sites that are settled. */
  hamletChance: number
  /** 0…1 chance that a farmland cell has a farmstead. */
  farmsteadChance: number
  /** People per km² in a settlement's core; sets each settlement's radius. */
  urbanDensity: number
  /** Extra rural density along rivers and coasts (corridors): × (1 + corridor × water access). */
  corridor: number
  /** Rural density halves roughly every this many metres away from settlements. */
  ruralDecay: number
  /** Settlement class thresholds. */
  thresholds: SettlementThresholds
  /** Land-use thresholds. */
  landUse: LandUseThresholds
  /** People per km² at which night lights reach 63 % brightness. */
  lightDensity: number
  /** Habitability model. */
  habitability: HabitabilityOptions
  /** Road, rail and power networks. */
  network: NetworkOptions
}

/** Recursive partial input for population settings. */
export type PopulationInput = DeepPartial<PopulationOptions>

/** Default population: 1.5 million people within 24 km, on ~530 m cells (H3 res 8 on flat worlds). */
export const DEFAULT_POPULATION: PopulationOptions = {
  seed: 1,
  location: null,
  center: [0, 0],
  radius: 24_000,
  cellSize: 500,
  totalPopulation: 1_500_000,
  ruralShare: 0.15,
  zipf: 1,
  levels: 4,
  jitter: 0.35,
  minHabitability: 0.12,
  hamletChance: 0.6,
  farmsteadChance: 0.5,
  urbanDensity: 4000,
  corridor: 1.5,
  ruralDecay: 4000,
  thresholds: { metropolis: 1_000_000, city: 100_000, town: 10_000, village: 1_000 },
  landUse: { urban: 2500, suburban: 400, farmland: 0.15 },
  lightDensity: 1500,
  habitability: {
    avoid: ['deepOcean', 'glacier', 'mountainPeaks', 'volcanic'],
    fertility: {
      grassland: 1, deciduousForest: 0.8, mediterranean: 0.85, coast: 0.8, dryForest: 0.7, savanna: 0.6, steppe: 0.5,
      temperateRainforest: 0.5, jungle: 0.45, taiga: 0.35, wetland: 0.3, mangrove: 0.2, alpineMeadow: 0.25, tundra: 0.1,
      badlands: 0.1, desert: 0.05, mountainPeaks: 0, glacier: 0, deepOcean: 0, volcanic: 0,
    },
    defaultFertility: 0.5,
    maxSlope: 0.35,
    temperature: 16,
    temperatureRange: 14,
    water: 0.5,
  },
  network: {
    enabled: true, extraEdges: 0.3, gravityExponent: 2, detour: 1.35, neighbours: 6, slopeCost: 60, railSlopeCost: 400,
    waterCost: 12, reuse: 0.55, highwayPopulation: 50_000, roadPopulation: 1_000, railPopulation: 20_000,
    powerlinePopulation: 200, smoothing: 2,
  },
}

/** One fine cell of the population grid. */
export interface PopulationCell {
  /** H3 index. */
  cell: string
  /** Centre in local `[x, z]`, metres. */
  position: [number, number]
  /** Ground height at the centre (local y), metres. */
  elevation: number
  /** Ground slope (rise/run). */
  slope: number
  /** Cell area on this world, m². */
  area: number
  /** 0…1 how good a place to live this is. */
  habitability: number
  /** 0…1 access to fresh water or a coast. */
  water: number
  /** People living here (an integer; the cells sum to the region's total). */
  population: number
  /** People per km². */
  density: number
  /** Land use. */
  landUse: LandUse
  /** 0…1 night-light brightness. */
  light: number
}

/** A place people live. Settlements are central places in a hierarchy (Christaller), sized by rank (Zipf). */
export interface Settlement {
  /** Index in `PopulationData.settlements` (0 = the largest). */
  id: number
  /** Fine H3 cell it is centred in. */
  cell: string
  /** Centre in local `[x, z]`, metres (seeded jitter inside the cell, always on dry land). */
  position: [number, number]
  /** People (an integer). Ranked settlements' people are spread over the cells around them. */
  population: number
  /** Size class. */
  class: SettlementClass
  /** Radius of the built-up core, metres. */
  radius: number
  /** Tier: 0 urban centre, 1 town, 2 village, 3 hamlet (with `levels` = 4); farmsteads are `levels`. */
  level: number
  /** Rank-size rank (1 = largest); 0 for farmsteads. */
  rank: number
}

/** Generated population: per-cell people and land use, plus settlements. */
export interface PopulationData {
  /** Settings it was generated with. */
  options: PopulationOptions
  /** The hex index (and the frame local positions are in). */
  grid: HexGrid
  /** H3 resolution of `cells`. */
  resolution: number
  /** Average edge of a fine cell on this world, metres. */
  cellEdge: number
  /** Fine cells inside the region. */
  cells: PopulationCell[]
  /** Cell index → position in `cells`. */
  index: Map<string, number>
  /** For each cell, the positions in `cells` of its (up to 6) neighbours inside the region: the hex graph. */
  neighbours: number[][]
  /** Settlements, ranked ones first (by size), then farmsteads. */
  settlements: Settlement[]
  /** People in the region (sum of `cells[i].population`). */
  total: number
}

/** Population of one cell at any resolution (see {@link aggregatePopulation}). */
export interface AggregateCell {
  /** H3 index. */
  cell: string
  /** People (exact sum of fine cells when coarser than the data; an even share when finer). */
  population: number
  /** Area inside the region, m². */
  area: number
  /** People per km² over `area`. */
  density: number
  /** 0…1 night-light brightness. */
  light: number
  /** Mean habitability. */
  habitability: number
  /** Most common land use (by area). */
  landUse: LandUse
}

/** Fills defaults in: anything not in `input` comes from {@link DEFAULT_POPULATION}. */
export function resolvePopulationOptions(input: PopulationInput = {}, base: PopulationOptions = DEFAULT_POPULATION): PopulationOptions {
  return merge(structuredClone(base), input)
}

/**
 * Generates the population of a region of a world: pure and deterministic (same world, options and
 * seed → identical result).
 *
 * 1. **Habitability** per fine cell from the world: dry land, not an avoided biome (glacier, peaks,
 *    volcanic, deep ocean), gentle slope, comfortable temperature, fertile biome, fresh water or a coast nearby.
 * 2. **Central places** (Christaller, with H3's aperture 7 as his K = 7 administrative principle): urban
 *    centres are local maxima of smoothed, seeded-jittered habitability at the coarsest tier; towns,
 *    villages and hamlets follow, one resolution finer each, in the market areas between them.
 * 3. **Rank-size**: the r-th settlement (by tier, then score) gets P₁ / r^zipf people.
 * 4. Settlement people spread over nearby cells with a Gaussian distance decay; rural people spread
 *    over habitable land, denser along rivers and coasts and near settlements.
 *
 * @param frame Local frame (default: `world.frameAt(...options.location)` or `world.frame`).
 */
export function generatePopulation(world: World, input: PopulationInput = {}, frame?: LocalFrame): PopulationData {
  const o = resolvePopulationOptions(input)
  const f = frame ?? (o.location ? world.frameAt(o.location[0], o.location[1]) : world.frame)
  const grid = new HexGrid(world, f)
  const levels = Math.max(1, Math.min(4, Math.round(o.levels)))
  const res = Math.max(levels - 1, grid.resolutionFor(o.cellSize))
  const edge = grid.edgeLength(res)
  const seed = seedOf(o.seed)
  const h = o.habitability
  const [cx, cz] = o.center

  // --- fine cells in the region -------------------------------------------------------------------
  // ponytail: one disk in one local frame; whole-planet coverage would need a disk per frame (or a coarse
  // global pass over getRes0Cells) and stitching, add when an orbit view needs real global data.
  const ids: string[] = []
  const pos: [number, number][] = []
  const k = Math.ceil(o.radius / (1.5 * edge)) + 1
  for (const c of grid.disk(grid.cellAtLocal(cx, cz, res), k)) {
    const p = grid.centerLocal(c)
    if (Math.hypot(p[0] - cx, p[1] - cz) <= o.radius) { ids.push(c); pos.push(p) }
  }
  const index = new Map<string, number>()
  ids.forEach((c, i) => index.set(c, i))
  const n = ids.length

  // --- habitability ------------------------------------------------------------------------------
  const biomes = world.options.biomes
  const avoid = new Set(h.avoid)
  const s = sample()
  const d = edge * 0.6
  const elevation = new Float64Array(n), slope = new Float64Array(n), base = new Float64Array(n), wetland = new Uint8Array(n), fresh = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const [x, z] = pos[i]
    let wet = 0, valley = 0
    const hs = [0, 0, 0]
    for (let j = 0; j < 3; j++) {
      f.sample(x + (j === 1 ? d : 0), z + (j === 2 ? d : 0), s, edge * 0.5)
      hs[j] = s.elevation
      if (s.waterLevel > s.elevation) wet++
      valley = Math.max(valley, s.valley, s.river)
      if (j === 0) {
        // Climate and biomes at the centre.
        let fert = 0, avoided = 0
        for (let b = 0; b < s.count; b++) {
          const id = biomes[s.biomes[b]]?.id ?? ''
          const w = s.weights[b]
          if (avoid.has(id)) avoided += w
          fert += w * (h.fertility[id] ?? h.defaultFertility)
        }
        const t = (s.temperature - h.temperature) / Math.max(1e-3, h.temperatureRange)
        base[i] = avoided > 0.5 ? 0 : fert * (1 - avoided) * Math.exp(-t * t)
      }
    }
    elevation[i] = hs[0]
    slope[i] = Math.hypot(hs[1] - hs[0], hs[2] - hs[0]) / d
    wetland[i] = wet >= 2 ? 1 : 0
    fresh[i] = valley
    base[i] *= wetland[i] ? 0 : smoothstep(h.maxSlope, h.maxSlope * 0.25, slope[i])
  }
  // Neighbours inside the region, then coasts: dry cells next to (or two steps from) water.
  const near: number[][] = ids.map((c) => grid.disk(c, 1).map((q) => index.get(q) ?? -1).filter((j) => j >= 0 && ids[j] !== c))
  const water = new Float64Array(n), hab = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let coast = 0
    for (const j of near[i]) {
      if (wetland[j]) coast = 1
      else for (const q of near[j]) if (wetland[q]) coast = Math.max(coast, 0.5)
    }
    water[i] = wetland[i] ? 1 : Math.max(fresh[i], coast)
    hab[i] = base[i] * (1 - h.water + h.water * water[i])
  }

  // --- central places ----------------------------------------------------------------------------
  interface Site { cell: number; level: number; score: number; position: [number, number] }
  const sites: Site[] = []
  const taken = new Set<number>()
  for (let L = 0; L < levels; L++) {
    const r = res - (levels - 1 - L)
    const expected = 7 ** (res - r)
    const sum = new Map<string, number>(), count = new Map<string, number>(), best = new Map<string, number>()
    const parentOf = r === res ? ids : ids.map((c) => grid.parent(c, r))
    for (let i = 0; i < n; i++) {
      const p = parentOf[i]
      sum.set(p, (sum.get(p) ?? 0) + hab[i])
      count.set(p, (count.get(p) ?? 0) + 1)
      const bi = best.get(p)
      if (!taken.has(i) && hab[i] > 0 && (bi === undefined || pick(seed, ids[i], hab[i]) > pick(seed, ids[bi], hab[bi]))) best.set(p, i)
    }
    // Market areas of every higher-tier place are closed to this tier.
    const blocked = new Set<string>()
    for (const site of sites) for (const q of grid.disk(r === res ? ids[site.cell] : grid.parent(ids[site.cell], r), 1)) blocked.add(q)
    const score = new Map<string, number>()
    for (const [p, total] of sum) {
      if (blocked.has(p) || (count.get(p) ?? 0) < expected * 0.5) continue
      score.set(p, (total / (count.get(p) ?? 1)) * (1 + o.jitter * (hash01(seed, p, 11 + L) * 2 - 1)))
    }
    const found: Site[] = []
    for (const [p, v] of score) {
      if (v < o.minHabitability || !best.has(p)) continue
      if (L === levels - 1 && levels > 1 && hash01(seed, p, 21) >= o.hamletChance) continue
      let max = true
      for (const q of grid.disk(p, 1)) {
        const w = score.get(q)
        if (q !== p && w !== undefined && (w > v || (w === v && q < p))) { max = false; break }
      }
      if (!max) continue
      const i = best.get(p)!
      const position = dryPosition(f, ids[i], pos[i], edge, seed, avoid, biomes, s)
      if (position) found.push({ cell: i, level: L, score: v, position })
    }
    for (const site of found) { sites.push(site); taken.add(site.cell) }
  }
  sites.sort((a, b) => a.level - b.level || b.score - a.score || (ids[a.cell] < ids[b.cell] ? -1 : 1))

  // --- rank-size populations ---------------------------------------------------------------------
  const total = Math.max(0, Math.round(o.totalPopulation))
  const urbanBudget = sites.length ? total * (1 - clamp01(o.ruralShare)) : 0
  let harmonic = 0
  for (let r = 1; r <= sites.length; r++) harmonic += r ** -o.zipf
  const p1 = harmonic > 0 ? urbanBudget / harmonic : 0
  const perKm2 = Math.max(1e-6, o.urbanDensity) / 1e6
  const settlements: Settlement[] = sites.map((site, r) => {
    const people = p1 * (r + 1) ** -o.zipf
    return { id: r, cell: ids[site.cell], position: site.position, population: Math.round(people), class: classify(people, o.thresholds), radius: Math.sqrt(people / (Math.PI * perKm2)), level: site.level, rank: r + 1 }
  })

  // --- spread people over cells ------------------------------------------------------------------
  const people = new Float64Array(n)
  sites.forEach((site, r) => {
    const P = p1 * (r + 1) ** -o.zipf
    const R = settlements[r].radius
    if (R < edge * 0.5) { people[site.cell] += P; return }
    const ring = Math.ceil((2.5 * R) / (1.5 * edge)) + 1
    const js: number[] = [], ws: number[] = []
    let wsum = 0
    for (const q of grid.disk(ids[site.cell], ring)) {
      const j = index.get(q)
      if (j === undefined || hab[j] <= 0) continue
      const dist = Math.hypot(pos[j][0] - site.position[0], pos[j][1] - site.position[1]) / R
      const w = Math.exp(-dist * dist) * (0.25 + 0.75 * hab[j])
      if (w < 1e-6) continue
      js.push(j); ws.push(w); wsum += w
    }
    if (wsum <= 0) { people[site.cell] += P; return }
    for (let m = 0; m < js.length; m++) people[js[m]] += (P * ws[m]) / wsum
  })
  const ruralBudget = total - urbanBudget
  const rural = new Float64Array(n)
  let rsum = 0
  for (let i = 0; i < n; i++) {
    if (hab[i] <= 0) continue
    let dn = Infinity
    for (const st of settlements) dn = Math.min(dn, Math.max(0, Math.hypot(pos[i][0] - st.position[0], pos[i][1] - st.position[1]) - st.radius))
    const w = hab[i] * (1 + o.corridor * water[i]) * (0.35 + 0.65 * Math.exp(-(sites.length ? dn : 0) / Math.max(1, o.ruralDecay)))
    rural[i] = w; rsum += w
  }
  if (rsum > 0) for (let i = 0; i < n; i++) people[i] += (ruralBudget * rural[i]) / rsum
  const counts = largestRemainder(people, ids, rsum > 0 || sites.length ? total : 0)

  // --- cells -------------------------------------------------------------------------------------
  const cells: PopulationCell[] = ids.map((c, i) => {
    const area = grid.area(c)
    const density = counts[i] / Math.max(1e-9, area / 1e6)
    const landUse: LandUse = wetland[i] ? 'water' : density >= o.landUse.urban ? 'urban' : density >= o.landUse.suburban ? 'suburban' : hab[i] >= o.landUse.farmland ? 'farmland' : 'wilderness'
    return { cell: c, position: pos[i], elevation: elevation[i], slope: slope[i], area, habitability: hab[i], water: water[i], population: counts[i], density, landUse, light: wetland[i] ? 0 : lightOf(density, o.lightDensity) }
  })

  // --- farmsteads: one per farmland cell, by chance ---------------------------------------------
  for (let i = 0; i < n; i++) {
    const c = cells[i]
    if (c.landUse !== 'farmland' || taken.has(i) || c.population < 1 || hash01(seed, c.cell, 31) >= o.farmsteadChance) continue
    const position = dryPosition(f, c.cell, c.position, edge, seed + 7, avoid, biomes, s)
    if (!position) continue
    const pop = Math.min(c.population, 2 + Math.floor(hash01(seed, c.cell, 32) * 9))
    settlements.push({ id: settlements.length, cell: c.cell, position, population: pop, class: 'farmstead', radius: Math.sqrt(pop / (Math.PI * perKm2)), level: levels, rank: 0 })
  }

  let sumPeople = 0
  for (const c of cells) sumPeople += c.population
  return { options: o, grid, resolution: res, cellEdge: edge, cells, index, neighbours: near, settlements, total: sumPeople }
}

/**
 * People per cell at any resolution. Coarser than the data: exact integer sums of the fine cells (so
 * every parent equals the sum of its children). Finer: each fine cell's people shared evenly among its
 * descendants. Only cells overlapping the region appear.
 */
export function aggregatePopulation(data: PopulationData, res: number): Map<string, AggregateCell> {
  const out = new Map<string, AggregateCell>()
  const { grid, options } = data
  const use = new Map<string, Record<LandUse, number>>()
  const add = (cell: string, people: number, area: number, hab: number, landUse: LandUse) => {
    let a = out.get(cell)
    if (!a) { a = { cell, population: 0, area: 0, density: 0, light: 0, habitability: 0, landUse }; out.set(cell, a); use.set(cell, { urban: 0, suburban: 0, farmland: 0, wilderness: 0, water: 0 }) }
    a.population += people; a.area += area; a.habitability += hab * area
    use.get(cell)![landUse] += area
  }
  for (const c of data.cells) {
    const area = c.area
    if (res <= data.resolution) add(res === data.resolution ? c.cell : grid.parent(c.cell, res), c.population, area, c.habitability, c.landUse)
    else {
      const kids = grid.children(c.cell, res)
      for (const k of kids) add(k, c.population / kids.length, area / kids.length, c.habitability, c.landUse)
    }
  }
  for (const a of out.values()) {
    a.habitability /= a.area || 1
    a.density = a.population / Math.max(1e-9, a.area / 1e6)
    const u = use.get(a.cell)!
    a.landUse = (Object.keys(u) as LandUse[]).reduce((m, k) => (u[k] > u[m] ? k : m), 'water')
    a.light = a.landUse === 'water' && a.population === 0 ? 0 : lightOf(a.density, options.lightDensity)
  }
  return out
}

/** Night-light brightness per H3 cell as flat typed arrays (GPU-ready), plus point samplers. */
export interface NightLightField {
  /** H3 resolution of the cells. */
  resolution: number
  /** H3 index per cell. */
  cells: string[]
  /** Base-surface world position of each cell centre, `[x, y, z]` per cell (planet-centred on planets). */
  centers: Float64Array
  /** Local `[x, z]` of each cell centre, per cell. */
  local: Float32Array
  /** 0…1 brightness per cell. */
  intensity: Float32Array
  /** People per cell. */
  population: Float32Array
  /** Average cell edge on this world, metres (a glow radius for point sprites). */
  cellEdge: number
  /** Brightness of the cell containing a base-surface world position (0 outside the region). */
  sample(px: number, py: number, pz: number): number
  /** Brightness of the cell containing local `[x, z]` (0 outside the region). */
  sampleLocal(x: number, z: number): number
}

/**
 * Night lights at any resolution: brightness 1 − exp(−density / `lightDensity`) per cell, as typed
 * arrays for a city-lights view from orbit (e.g. instanced glow sprites at `centers`, sized by `cellEdge`).
 */
export function nightLights(data: PopulationData, res: number = data.resolution): NightLightField {
  const agg = [...aggregatePopulation(data, res).values()]
  const n = agg.length
  const cells = agg.map((a) => a.cell)
  const centers = new Float64Array(n * 3), local = new Float32Array(n * 2), intensity = new Float32Array(n), population = new Float32Array(n)
  const lookup = new Map<string, number>()
  const p: [number, number, number] = [0, 0, 0]
  agg.forEach((a, i) => {
    lookup.set(a.cell, i)
    data.grid.center(a.cell, p)
    centers.set(p, i * 3)
    local.set(data.grid.toLocal(p), i * 2)
    intensity[i] = a.light
    population[i] = a.population
  })
  const at = (cell: string) => { const i = lookup.get(cell); return i === undefined ? 0 : intensity[i] }
  return {
    resolution: res, cells, centers, local, intensity, population, cellEdge: data.grid.edgeLength(res),
    sample: (px, py, pz) => at(data.grid.cellAt(px, py, pz, res)),
    sampleLocal: (x, z) => at(data.grid.cellAtLocal(x, z, res)),
  }
}

/** The size class for a population. */
export function classify(population: number, t: SettlementThresholds): SettlementClass {
  return population >= t.metropolis ? 'metropolis' : population >= t.city ? 'city' : population >= t.town ? 'town' : population >= t.village ? 'village' : 'hamlet'
}

// --- helpers --------------------------------------------------------------------------------------

function lightOf(density: number, lightDensity: number): number {
  return 1 - Math.exp(-density / Math.max(1e-6, lightDensity))
}

// A seeded, jittered score so ties between equally good cells break the same way every time.
function pick(seed: number, cell: string, hab: number): number {
  return hab * (1 + 0.5 * hash01(seed, cell, 41))
}

// A seeded spot inside the cell that is dry land and not an avoided biome (else the centre; else null).
function dryPosition(f: LocalFrame, cell: string, center: [number, number], edge: number, seed: number, avoid: Set<string>, biomes: World['options']['biomes'], s: WorldSample): [number, number] | null {
  const a = hash01(seed, cell, 51) * Math.PI * 2, r = Math.sqrt(hash01(seed, cell, 52)) * edge * 0.4
  for (const [x, z] of [[center[0] + Math.cos(a) * r, center[1] + Math.sin(a) * r], center] as [number, number][]) {
    f.sample(x, z, s)
    if (s.waterLevel > s.elevation) continue
    let avoided = 0
    for (let b = 0; b < s.count; b++) if (avoid.has(biomes[s.biomes[b]]?.id ?? '')) avoided += s.weights[b]
    if (avoided <= 0.5) return [x, z]
  }
  return null
}

// Rounds to integers that sum exactly to `total` (largest remainder; ties by cell id, so deterministic).
function largestRemainder(values: Float64Array, ids: string[], total: number): number[] {
  let sum = 0
  for (const v of values) sum += v
  const out = new Array<number>(values.length).fill(0)
  if (sum <= 0 || total <= 0) return out
  const scaled = Array.from(values, (v) => (v * total) / sum)
  let used = 0
  scaled.forEach((v, i) => { out[i] = Math.floor(v); used += out[i] })
  const order = scaled.map((_, i) => i).sort((a, b) => scaled[b] - out[b] - (scaled[a] - out[a]) || (ids[a] < ids[b] ? -1 : 1))
  for (let k = 0; k < total - used; k++) out[order[k % order.length]]++
  return out
}

function sample(): WorldSample {
  return { elevation: 0, continentalness: 0, erosion: 0, mountain: 0, temperature: 0, moisture: 0, valley: 0, river: 0, waterLevel: NaN, biomes: new Int32Array(32), weights: new Float32Array(32), count: 0 }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/** Turns a string or number seed into a 32-bit integer (FNV-1a for strings). */
export function seedOf(seed: number | string): number {
  if (typeof seed === 'number') return seed | 0
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return h | 0
}

/** Deterministic hash of a seed, an H3 cell and a salt to [0, 1). */
export function hash01(seed: number, cell: string, salt: number): number {
  const [lo, hi] = cellKey(cell)
  let x = Math.imul(seed | 0, 0x27d4eb2d) ^ Math.imul(lo | 0, 0x165667b1) ^ Math.imul(hi | 0, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca77)
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b)
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35)
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}

function merge<T>(target: T, input: unknown): T {
  if (!input || typeof input !== 'object') return target
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === undefined) continue
    const cur = (target as Record<string, unknown>)[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) (target as Record<string, unknown>)[k] = merge({ ...(cur as object) }, v)
    else (target as Record<string, unknown>)[k] = Array.isArray(v) ? structuredClone(v) : v
  }
  return target
}
