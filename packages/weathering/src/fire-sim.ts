import { createSample, hash01, seedOf, type DeepPartial, type LocalFrame, type World, type WorldSample } from 'threejs-biomes'
import { createWeatherSample, type ClimatePoint, type SurfaceSample, type Weather, type WeatherSample } from './weather.ts'
import { merge, resolve } from './util.ts'

/** Fuel classes. Each burns, spreads and regrows at its own pace. */
export type FuelKind = 'grass' | 'shrub' | 'tree' | 'none'

/** How much a scattered species feeds a fire. */
export interface FuelModel {
  /** Fuel class. `none` for rocks. */
  kind: FuelKind
  /** Fire-available biomass per instance (leaves, twigs, bark, litter), kg. */
  biomass: number
}

/** Fuel per species name of the biome scatter tables (`threejs-biomes` `ScatterEntry.species`). */
export const DEFAULT_FUEL_MODELS: Record<string, FuelModel> = {
  oak: { kind: 'tree', biomass: 180 }, beech: { kind: 'tree', biomass: 160 }, maple: { kind: 'tree', biomass: 150 },
  redwood: { kind: 'tree', biomass: 400 }, fir: { kind: 'tree', biomass: 220 }, spruce: { kind: 'tree', biomass: 200 },
  pine: { kind: 'tree', biomass: 220 }, birch: { kind: 'tree', biomass: 100 }, palm: { kind: 'tree', biomass: 80 },
  acacia: { kind: 'tree', biomass: 90 }, baobab: { kind: 'tree', biomass: 300 }, jungleEmergent: { kind: 'tree', biomass: 350 },
  olive: { kind: 'tree', biomass: 70 }, cypress: { kind: 'tree', biomass: 120 }, mangrove: { kind: 'tree', biomass: 90 },
  deadSnag: { kind: 'tree', biomass: 60 },
  shrub: { kind: 'shrub', biomass: 12 }, dwarfShrub: { kind: 'shrub', biomass: 3 }, thornShrub: { kind: 'shrub', biomass: 10 },
  fern: { kind: 'shrub', biomass: 1.5 }, reed: { kind: 'shrub', biomass: 1 }, cactus: { kind: 'shrub', biomass: 4 },
  rock: { kind: 'none', biomass: 0 }, boulder: { kind: 'none', biomass: 0 }, pebble: { kind: 'none', biomass: 0 },
  cliffChunk: { kind: 'none', biomass: 0 }, scree: { kind: 'none', biomass: 0 },
}

/** Cell states. Regrowing cells can burn again once enough fuel is back. */
export const FIRE_STATE = {
  /** Full fuel, never burnt (or fully regrown). */
  unburnt: 0,
  /** On fire. */
  burning: 1,
  /** Burnt out; nothing has regrown yet. */
  burnt: 2,
  /** Grass, then shrubs, then trees are coming back. */
  regrowing: 3,
} as const

/** A cell state value (see {@link FIRE_STATE}). */
export type FireCellState = (typeof FIRE_STATE)[keyof typeof FIRE_STATE]

/** A scheduled ignition: `[x, z, time, radius]` (frame coordinates, seconds, metres). */
export type Ignition = [x: number, z: number, time: number, radius: number]

/** A strip that fire cannot cross (a road, a dug firebreak). */
export interface Firebreak {
  /** Polyline `[x, z]` points, frame coordinates. */
  points: [number, number][]
  /** Full width, metres. */
  width: number
}

/** Every wildfire setting. Plain JSON. */
export interface FireOptions {
  /** Seed for the ragged fire front and ignition rolls. */
  seed: number | string
  /** Centre `[x, z]` of the simulated square, frame coordinates. */
  center: [number, number]
  /** Edge length of the simulated square, metres. */
  size: number
  /** Cell size, metres. */
  cellSize: number
  /** Simulation step, seconds. The sim always advances in whole ticks, so results never depend on frame rate. */
  tick: number
  /** Time of tick 0, seconds. */
  startTime: number
  /** Base rate of spread on dry, flat, calm ground, m/s, per fuel class. */
  spread: {
    /** Grass and litter. */
    grass: number
    /** Shrubs. */
    shrub: number
    /** Forest (surface + crown). */
    tree: number
  }
  /** Wind effect: spread × exp(windCoefficient × wind component along the spread direction in m/s). */
  windCoefficient: number
  /** Slope effect: spread × exp(slopeCoefficient × rise/run); uphill runs, downhill crawls. */
  slopeCoefficient: number
  /** Fuel moisture (fraction of dry weight) at which fire stops spreading (Rothermel's Mx). */
  moistureOfExtinction: number
  /** Cells with less fuel than this (kg/m²) don't carry fire. */
  minFuel: number
  /** Burn time per kg/m² of fuel, seconds (a cell burns `residence × (0.5 + load)`). */
  residence: number
  /** Share of fuel a dry fire consumes (wetter fuel burns less completely). */
  consumption: number
  /** 0…1: per-cell randomness of ignition thresholds (ragged fronts). */
  jitter: number
  /** Fuel derived from biomes. */
  fuel: {
    /** Grass load at full coverage and height, kg/m². */
    grassLoad: number
    /** Load multiplier per `threejs-grass` preset (dry grasses burn hotter). */
    grassPresets: Record<string, number>
    /** Fuel model per scatter species. */
    species: Record<string, FuelModel>
    /** Biomass of species not in `species`, kg (counted as shrub). */
    unknownBiomass: number
  }
  /** What stops fire. */
  firebreaks: {
    /** Sea, lakes and rivers. */
    water: boolean
    /** Rise/run above which ground is bare rock. */
    rockSlope: number
    /** Rock + snow ground share (0…1) above which ground doesn't burn. */
    bareGround: number
    /** Roads: the world's `path` height modifiers (flat worlds). */
    roads: boolean
    /** Extra firebreaks. */
    lines: Firebreak[]
  }
  /** Succession after a fire: days for each class to return to full fuel. Grass first, then shrubs, then trees. */
  regrowth: {
    /** Grass. */
    grassDays: number
    /** Shrubs. */
    shrubDays: number
    /** Trees. */
    treeDays: number
  }
  /** Lightning ignitions from the weather's thunderstorms. */
  lightning: {
    /** Let lightning start fires. */
    enabled: boolean
    /** Chance (0…1) that a strike on dry fuel starts a fire. */
    chance: number
  }
  /** Seconds between weather refreshes (wind, fuel moisture). */
  weatherInterval: number
  /** Conditions without a weather: wind `[x, z]` in m/s and fuel moisture. */
  fallback: {
    /** Wind velocity `[x, z]`, m/s. */
    wind: [number, number]
    /** Fuel moisture, fraction of dry weight. */
    moisture: number
  }
  /** Scheduled ignitions (also added by {@link FireSim.ignite}). */
  ignitions: Ignition[]
}

/** Partial settings for {@link FireSim}. */
export type FireInput = DeepPartial<FireOptions>

/** Default wildfire: 1 km square, 8 m cells, 2 s ticks. */
export const DEFAULT_FIRE: FireOptions = {
  seed: 1,
  center: [0, 0],
  size: 1024,
  cellSize: 8,
  tick: 2,
  startTime: 0,
  spread: { grass: 0.9, shrub: 0.35, tree: 0.12 },
  windCoefficient: 0.13,
  slopeCoefficient: 3.5,
  moistureOfExtinction: 0.3,
  minFuel: 0.05,
  residence: 90,
  consumption: 0.9,
  jitter: 0.5,
  fuel: {
    grassLoad: 0.4,
    grassPresets: { goldenSavanna: 1.4, autumnHaze: 1.2, buffaloGrass: 1.1, frostbite: 0.5, stAugustineGrass: 0.8, perennialRyegrass: 0.8 },
    species: DEFAULT_FUEL_MODELS,
    unknownBiomass: 8,
  },
  firebreaks: { water: true, rockSlope: 1.1, bareGround: 0.6, roads: true, lines: [] },
  regrowth: { grassDays: 30, shrubDays: 700, treeDays: 7300 },
  lightning: { enabled: true, chance: 0.4 },
  weatherInterval: 60,
  fallback: { wind: [3, 0], moisture: 0.08 },
  ignitions: [],
}

/** What one cell of land offers a fire (see {@link FireLandscape}). */
export interface FireCellInfo {
  /** Ground height, metres. */
  elevation: number
  /** Fire cannot enter this cell. */
  firebreak: boolean
  /** Grass fuel, kg/m². */
  grass: number
  /** Shrub fuel, kg/m². */
  shrub: number
  /** Tree fuel, kg/m². */
  tree: number
}

/** A custom source of terrain and fuel (instead of a world): fill `out` for the cell centred at (x, z). */
export interface FireLandscape {
  /** Describes the cell centred at (x, z). */
  cell(x: number, z: number, out: FireCellInfo): FireCellInfo
}

/** What a {@link FireSim} runs on. All optional: without them it burns uniform grass on flat ground. */
export interface FireEnvironment {
  /** World for terrain, water, biomes (fuel) and roads. */
  world?: World | null
  /** Frame the sim's coordinates are in. Default `world.frame`. */
  frame?: LocalFrame
  /** Weather for wind, fuel moisture and lightning. */
  weather?: Weather | null
  /** Custom terrain and fuel (overrides `world`). */
  landscape?: FireLandscape | null
}

/** Share (0…1) of each fuel class's full load present at a point (see {@link FireSim.regrowthAt}). */
export interface Regrowth {
  /** Grass. */
  grass: number
  /** Shrubs. */
  shrub: number
  /** Trees. */
  tree: number
}

/** Running totals of a {@link FireSim}. */
export interface FireStats {
  /** Cells burning now. */
  burning: number
  /** Cells burnt and not regrowing yet. */
  burnt: number
  /** Cells regrowing. */
  regrowing: number
  /** Fuel on the grid now, kg. */
  fuel: number
  /** Fuel burnt since the last restart, kg. */
  consumed: number
  /** Fuel regrown since the last restart, kg. */
  regrown: number
}

const GRASS = 0, SHRUB = 1, TREE = 2
const NDI = [1, -1, 0, 0, 1, 1, -1, -1]
const NDJ = [0, 0, 1, -1, 1, -1, 1, -1]
const NLEN = NDI.map((di, k) => Math.hypot(di, NDJ[k]))
const DAY = 86400

/**
 * A deterministic cellular-automaton wildfire over a square region of a frame, after Rothermel: each
 * cell's rate of spread comes from its fuel (grass, shrubs, trees from the biome scatter tables and
 * grass presets), fuel moisture (from the weather's humidity, rain and snow, damped by Rothermel's
 * moisture coefficient), wind along the spread direction and slope (uphill runs). Water, bare rock,
 * snow, roads and firebreak lines stop it. Cells go unburnt → burning → burnt → regrowing (grass in
 * weeks, shrubs in years, trees in decades) → unburnt, and lightning from the weather starts new fires.
 *
 * Everything advances in whole ticks and is seeded, so the same options, world, weather and time give
 * the same fire; {@link FireSim.runTo} replays from the start when time goes backwards, and quiet
 * periods (nothing burning) are skipped in one jump.
 *
 * @example
 * ```ts
 * const fire = new FireSim({ center: [0, 0], size: 2048 }, { world, weather })
 * fire.ignite(40, -12)
 * fire.runTo(time)                         // any time, forwards or backwards
 * fire.stats.burning
 * ```
 */
export class FireSim {
  /** Resolved settings. */
  options: FireOptions
  /** Cells per side. */
  cols = 0
  /** Cells per side (same as `cols`). */
  rows = 0
  /** Cell states (see {@link FIRE_STATE}), row-major from (minX, minZ). */
  state = new Uint8Array(0)
  /** Ground height per cell, metres. */
  elevation = new Float64Array(0)
  /** 1 where fire cannot go. */
  firebreak = new Uint8Array(0)
  /** Current fuel per cell and class (grass, shrub, tree), kg/m², 3 per cell. */
  fuel = new Float32Array(0)
  /** Full fuel per cell and class, kg/m², 3 per cell. */
  capacity = new Float32Array(0)
  /** Fuel moisture per cell (fraction of dry weight) at the last weather refresh. */
  moisture = new Float32Array(0)
  /** Ticks since tick 0. */
  tickIndex = 0
  /** Bumped on every tick or change (renderers compare it). */
  version = 0
  /** Running totals. */
  readonly stats: FireStats = { burning: 0, burnt: 0, regrowing: 0, fuel: 0, consumed: 0, regrown: 0 }

  private env: FireEnvironment
  private seed = 0
  private ignition = new Float32Array(0)
  private threshold = new Float32Array(0)
  private burnLeft = new Float32Array(0)
  private burnTotal = new Float32Array(0)
  private ignitionFuel = new Float32Array(0)
  private residual = new Float32Array(0)
  private burntTick = new Int32Array(0)
  private windX = new Float32Array(0)
  private windZ = new Float32Array(0)
  private lastRefresh = -1
  private burning = new Int32Array(0)
  private coarse = 0
  private coarseClimate: ClimatePoint[] = []

  /**
   * Creates a fire grid over `options.center`/`size` (sampling the world or landscape once per cell).
   * @param input Settings; anything not given uses {@link DEFAULT_FIRE}.
   * @param env World, weather or a custom landscape (object inputs, not JSON).
   */
  constructor(input: FireInput = {}, env: FireEnvironment = {}) {
    this.env = env
    this.options = resolve(DEFAULT_FIRE, input)
    this.build()
  }

  /** Merges `input` into the settings, rebuilds the grid and replays to the current time. */
  set(input: FireInput): this {
    const time = this.time
    this.options = merge(this.options, input)
    this.build()
    return this.runTo(time)
  }

  /** Replaces all settings (anything not given goes back to defaults), rebuilds and replays. */
  reset(input: FireInput = {}): this {
    const next = resolve(DEFAULT_FIRE, input)
    if (JSON.stringify(next) === JSON.stringify(this.options)) return this
    const time = this.time
    this.options = next
    this.build()
    return this.runTo(time)
  }

  /** Simulation time at the start of the next tick, seconds. */
  get time(): number {
    return this.options.startTime + this.tickIndex * this.options.tick
  }

  /** Minimum x of the grid (frame coordinates). */
  get minX(): number {
    return this.options.center[0] - (this.cols * this.options.cellSize) / 2
  }

  /** Minimum z of the grid (frame coordinates). */
  get minZ(): number {
    return this.options.center[1] - (this.rows * this.options.cellSize) / 2
  }

  /** Cell index at (x, z), or −1 outside the grid. */
  index(x: number, z: number): number {
    const i = Math.floor((x - this.minX) / this.options.cellSize), j = Math.floor((z - this.minZ) / this.options.cellSize)
    return i < 0 || j < 0 || i >= this.cols || j >= this.rows ? -1 : j * this.cols + i
  }

  /** Centre of cell `index`, `[x, z]`. */
  center(index: number): [number, number] {
    const c = this.options.cellSize
    return [this.minX + ((index % this.cols) + 0.5) * c, this.minZ + (Math.floor(index / this.cols) + 0.5) * c]
  }

  /** Total current fuel of a cell, kg/m². */
  fuelAt(index: number): number {
    return this.fuel[index * 3] + this.fuel[index * 3 + 1] + this.fuel[index * 3 + 2]
  }

  /** Fire intensity 0…1 of a cell (0 unless burning): rises and falls over its burn. */
  heat(index: number): number {
    if (this.state[index] !== FIRE_STATE.burning) return 0
    const progress = 1 - this.burnLeft[index] / this.burnTotal[index]
    const load = this.ignitionFuel[index * 3] + this.ignitionFuel[index * 3 + 1] + this.ignitionFuel[index * 3 + 2]
    return Math.min(1, 0.35 + load / 3) * Math.sqrt(Math.max(0, Math.sin(Math.PI * Math.min(1, 0.08 + progress))))
  }

  /** Burn scar 0…1 of a cell: rises while burning, 1 when burnt, fading as it regrows. Feeds the `burn` state. */
  scar(index: number): number {
    const s = this.state[index]
    if (s === FIRE_STATE.burning) return Math.min(1, (1 - this.burnLeft[index] / this.burnTotal[index]) * 1.2)
    if (s === FIRE_STATE.unburnt) return 0
    const g = this.growth(index)
    const capS = this.capacity[index * 3 + 1], capT = this.capacity[index * 3 + 2]
    const woody = capS + capT > 0 ? (g[SHRUB] * capS + g[TREE] * capT) / (capS + capT) : g[GRASS]
    return Math.max(0, 1 - (0.6 * g[GRASS] + 0.4 * woody))
  }

  /** Seconds since cell `index` burnt out, or `Infinity` if it is not burnt or regrowing. */
  burntAge(index: number): number {
    const s = this.state[index]
    return s === FIRE_STATE.burnt || s === FIRE_STATE.regrowing ? (this.tickIndex - this.burntTick[index]) * this.options.tick : Infinity
  }

  /** Wind velocity `[x, z]` (m/s) the cell saw at the last weather refresh. */
  windAt(index: number): [number, number] {
    return [this.windX[index], this.windZ[index]]
  }

  /** Ground height at (x, z), bilinear between cell centres. */
  elevationAt(x: number, z: number): number {
    const c = this.options.cellSize
    const fi = Math.min(this.cols - 1, Math.max(0, (x - this.minX) / c - 0.5)), fj = Math.min(this.rows - 1, Math.max(0, (z - this.minZ) / c - 0.5))
    const i0 = Math.floor(fi), j0 = Math.floor(fj), i1 = Math.min(this.cols - 1, i0 + 1), j1 = Math.min(this.rows - 1, j0 + 1)
    const tx = fi - i0, tz = fj - j0, e = this.elevation, n = this.cols
    return (e[j0 * n + i0] * (1 - tx) + e[j0 * n + i1] * tx) * (1 - tz) + (e[j1 * n + i0] * (1 - tx) + e[j1 * n + i1] * tx) * tz
  }

  /** Share (0…1) of each class's full fuel that has grown back at (x, z): 1 where never burnt. */
  regrowthAt(x: number, z: number): Regrowth {
    const i = this.index(x, z)
    if (i < 0) return { grass: 1, shrub: 1, tree: 1 }
    const f = (c: number) => (this.capacity[i * 3 + c] > 0 ? Math.min(1, this.fuel[i * 3 + c] / this.capacity[i * 3 + c]) : 1)
    return { grass: f(GRASS), shrub: f(SHRUB), tree: f(TREE) }
  }

  /**
   * Starts a fire at (x, z) within `radius` metres at `time` (default: the next tick). Ignitions are
   * stored in `options.ignitions`, so they replay when time is scrubbed back.
   */
  ignite(x: number, z: number, radius = this.options.cellSize * 0.5, time = this.time): this {
    this.options.ignitions.push([x, z, time, radius])
    this.options.ignitions.sort((a, b) => a[2] - b[2])
    if (time < this.time) {
      const now = this.time
      this.restart()
      this.runTo(now)
    }
    return this
  }

  /**
   * Runs (or replays) to `time`, seconds. Quiet stretches with nothing burning are skipped in one jump.
   * With a `budget` (milliseconds) it stops early once that much time is spent and catches up on later
   * calls; the result is the same either way, since the state depends only on the tick.
   */
  runTo(time: number, budget = Infinity): this {
    const target = Math.floor((time - this.options.startTime) / this.options.tick + 1e-9)
    if (target < this.tickIndex) this.restart()
    const start = budget < Infinity ? performance.now() : 0
    while (this.tickIndex < target) {
      if (budget < Infinity && performance.now() - start > budget) break
      if (this.stats.burning === 0) {
        const next = this.nextEvent(target)
        if (next > this.tickIndex) this.jump(next - this.tickIndex)
        if (this.tickIndex >= target) break
      }
      this.step()
    }
    return this
  }

  /** Back to tick 0: full fuel everywhere, nothing burning (scheduled ignitions are kept). */
  restart(): this {
    const n = this.cols * this.rows
    this.state.fill(FIRE_STATE.unburnt)
    this.fuel.set(this.capacity)
    this.ignition.fill(0)
    this.burnLeft.fill(0)
    this.burnTotal.fill(1)
    this.burntTick.fill(0)
    this.tickIndex = 0
    this.lastRefresh = -1
    Object.assign(this.stats, { burning: 0, burnt: 0, regrowing: 0, consumed: 0, regrown: 0 })
    this.stats.fuel = this.totalFuel()
    this.version++
    return this
  }

  /** Advances exactly one tick. */
  step(): this {
    const o = this.options
    const n = this.cols * this.rows
    const dt = o.tick
    const t0 = this.time, t1 = t0 + dt
    this.refreshWeather()

    // Ignitions: scheduled, then lightning.
    for (const [x, z, time, radius] of o.ignitions) {
      if (time >= t1) break
      if (time >= t0) this.igniteArea(x, z, radius)
    }
    if (o.lightning.enabled && this.env.weather) {
      const strikes = this.env.weather.strikes(this.minX, this.minZ, this.minX + this.cols * o.cellSize, this.minZ + this.rows * o.cellSize, t0, t1)
      for (const s of strikes) {
        const i = this.index(s.x, s.z)
        if (i < 0 || !this.canBurn(i)) continue
        if (hash01(s.seed | 0, this.seed, 91, 0) < o.lightning.chance * moistureDamping(this.moisture[i] / o.moistureOfExtinction)) this.startBurning(i)
      }
    }

    // Spread from cells burning at the start of the tick, then burn their fuel.
    if (this.burning.length < n) this.burning = new Int32Array(n)
    const burning = this.burning
    let count = 0
    for (let i = 0; i < n; i++) if (this.state[i] === FIRE_STATE.burning) burning[count++] = i
    const c = o.cellSize
    for (let b = 0; b < count; b++) {
      const i = burning[b]
      const ci = i % this.cols, cj = (i - ci) / this.cols
      const wx = this.windX[i], wz = this.windZ[i]
      for (let q = 0; q < 8; q++) {
        const di = NDI[q], dj = NDJ[q]
        const ni = ci + di, nj = cj + dj
        if (ni < 0 || nj < 0 || ni >= this.cols || nj >= this.rows) continue
        const k = nj * this.cols + ni
        if (!this.canBurn(k)) continue
        const d = c * NLEN[q]
        const wind = Math.min(20, Math.exp((o.windCoefficient * (wx * di + wz * dj)) / NLEN[q]))
        const rise = Math.max(-1, Math.min(1.5, (this.elevation[k] - this.elevation[i]) / d))
        const slope = Math.max(0.25, Math.exp(o.slopeCoefficient * rise))
        this.ignition[k] += (this.rateOfSpread(k) * wind * slope * dt) / d
      }
    }
    for (let b = 0; b < count; b++) {
      const i = burning[b]
      const used = Math.min(dt, this.burnLeft[i]) / this.burnTotal[i]
      const share = o.consumption * moistureDamping(this.moisture[i] / (o.moistureOfExtinction * 2))
      for (let f = 0; f < 3; f++) {
        const burnt = Math.min(this.fuel[i * 3 + f], this.ignitionFuel[i * 3 + f] * share * used)
        this.fuel[i * 3 + f] -= burnt
        this.stats.consumed += burnt * c * c
        this.stats.fuel -= burnt * c * c
      }
      this.burnLeft[i] -= dt
      if (this.burnLeft[i] <= 0) {
        this.state[i] = FIRE_STATE.burnt
        this.burntTick[i] = this.tickIndex + 1
        this.residual.set(this.fuel.subarray(i * 3, i * 3 + 3), i * 3)
        this.stats.burning--
        this.stats.burnt++
      }
    }
    for (let i = 0; i < n; i++) if (this.ignition[i] >= this.threshold[i] && this.canBurn(i)) this.startBurning(i)

    this.tickIndex++
    this.regrow()
    this.version++
    return this
  }

  // Skips `ticks` quiet ticks: only regrowth happens, and it is a function of age, so this is exact.
  private jump(ticks: number) {
    this.tickIndex += ticks
    this.regrow()
    this.version++
  }

  /** First tick (≤ target) at which something could ignite: a scheduled ignition or a lightning strike on fuel. */
  private nextEvent(target: number): number {
    const o = this.options
    let next = target
    for (const ig of o.ignitions) {
      const k = Math.floor((ig[2] - o.startTime) / o.tick + 1e-9)
      if (k >= this.tickIndex) { next = Math.min(next, k); break }
    }
    const weather = this.env.weather
    if (!o.lightning.enabled || !weather) return next
    const span = 86400 // query long quiet stretches a day at a time
    for (let t = this.time, end = o.startTime + next * o.tick; t < end; t += span) {
      const strikes = weather.strikes(this.minX, this.minZ, this.minX + this.cols * o.cellSize, this.minZ + this.rows * o.cellSize, t, Math.min(end, t + span))
      for (const s of strikes) {
        const i = this.index(s.x, s.z)
        if (i >= 0 && !this.firebreak[i] && this.capacity[i * 3] + this.capacity[i * 3 + 1] + this.capacity[i * 3 + 2] >= o.minFuel) {
          return Math.min(next, Math.max(this.tickIndex, Math.floor((s.time - o.startTime) / o.tick + 1e-9)))
        }
      }
    }
    return next
  }

  private canBurn(i: number): boolean {
    const s = this.state[i]
    return !this.firebreak[i] && (s === FIRE_STATE.unburnt || s === FIRE_STATE.regrowing) && this.fuelAt(i) >= this.options.minFuel && this.moisture[i] < this.options.moistureOfExtinction
  }

  private startBurning(i: number) {
    const o = this.options
    const load = this.fuelAt(i)
    this.ignitionFuel.set(this.fuel.subarray(i * 3, i * 3 + 3), i * 3)
    this.burnTotal[i] = this.burnLeft[i] = o.residence * (0.5 + load)
    this.ignition[i] = 0
    if (this.state[i] === FIRE_STATE.regrowing) this.stats.regrowing--
    this.state[i] = FIRE_STATE.burning
    this.stats.burning++
  }

  private igniteArea(x: number, z: number, radius: number) {
    const c = this.options.cellSize
    const r = Math.max(radius, c * 0.5)
    for (let zz = z - r; zz <= z + r + 1e-9; zz += c) for (let xx = x - r; xx <= x + r + 1e-9; xx += c) {
      if (Math.hypot(xx - x, zz - z) > r + 1e-9) continue
      const i = this.index(xx, zz)
      if (i >= 0 && this.canBurn(i)) this.startBurning(i)
    }
    const i = this.index(x, z)
    if (i >= 0 && this.canBurn(i)) this.startBurning(i)
  }

  /** Rate of spread into cell `k` on flat, calm ground at its moisture, m/s. */
  private rateOfSpread(k: number): number {
    const o = this.options.spread
    const g = this.fuel[k * 3], s = this.fuel[k * 3 + 1], t = this.fuel[k * 3 + 2]
    const total = g + s + t
    if (total <= 0) return 0
    const base = (g * o.grass + s * o.shrub + t * o.tree) / total
    return base * Math.min(1, total / 0.3) * moistureDamping(this.moisture[k] / this.options.moistureOfExtinction)
  }

  private growthScratch = [0, 0, 0]
  private growth(i: number): number[] {
    const r = this.options.regrowth
    const days = ((this.tickIndex - this.burntTick[i]) * this.options.tick) / DAY
    const g = this.growthScratch
    g[GRASS] = smooth(r.grassDays * 0.1, r.grassDays, days)
    g[SHRUB] = smooth(r.grassDays * 0.5, r.shrubDays, days)
    g[TREE] = smooth(r.shrubDays * 0.3, r.treeDays, days)
    return g
  }

  private regrow() {
    if (this.stats.burnt + this.stats.regrowing === 0) return
    const n = this.cols * this.rows
    const area = this.options.cellSize ** 2
    for (let i = 0; i < n; i++) {
      const s = this.state[i]
      if (s !== FIRE_STATE.burnt && s !== FIRE_STATE.regrowing) continue
      // Nothing grows for the first tenth of grassDays: fuel stays at the residual set at burnout.
      if (s === FIRE_STATE.burnt && (this.tickIndex - this.burntTick[i]) * this.options.tick < this.options.regrowth.grassDays * 0.1 * DAY) continue
      const g = this.growth(i)
      let full = true
      for (let f = 0; f < 3; f++) {
        const cap = this.capacity[i * 3 + f], res = Math.min(cap, this.residual[i * 3 + f])
        const next = res + (cap - res) * g[f]
        this.stats.regrown += (next - this.fuel[i * 3 + f]) * area
        this.stats.fuel += (next - this.fuel[i * 3 + f]) * area
        this.fuel[i * 3 + f] = next
        if (cap > 0 && g[f] < 1) full = false
      }
      const nextState = full ? FIRE_STATE.unburnt : g[GRASS] > 0 ? FIRE_STATE.regrowing : FIRE_STATE.burnt
      if (nextState !== s) {
        if (s === FIRE_STATE.burnt) this.stats.burnt--
        else this.stats.regrowing--
        if (nextState === FIRE_STATE.burnt) this.stats.burnt++
        else if (nextState === FIRE_STATE.regrowing) this.stats.regrowing++
        this.state[i] = nextState
      }
    }
  }

  /** Fuel on the grid now, kg, summed cell by cell (`stats.fuel` is the running total). */
  totalFuel(): number {
    let total = 0
    for (let i = 0; i < this.fuel.length; i++) total += this.fuel[i]
    return total * this.options.cellSize ** 2
  }

  // Wind and fuel moisture from the weather on a coarse grid (weather is km-scale), refreshed every
  // `weatherInterval` seconds. Keyed by tick index, so jumping and stepping see the same values.
  private refreshWeather() {
    const o = this.options
    const every = Math.max(1, Math.round(o.weatherInterval / o.tick))
    const key = Math.floor(this.tickIndex / every) * every
    if (key === this.lastRefresh) return
    this.lastRefresh = key
    const n = this.cols * this.rows
    const weather = this.env.weather
    if (!weather) {
      this.windX.fill(o.fallback.wind[0])
      this.windZ.fill(o.fallback.wind[1])
      this.moisture.fill(o.fallback.moisture)
      return
    }
    const time = o.startTime + key * o.tick
    const g = this.coarse
    const step = (this.cols * o.cellSize) / (g - 1)
    const w: WeatherSample = createWeatherSample()
    const surf: SurfaceSample = { wetness: 0, snow: 0, snowDepth: 0, water: 0 }
    const grid = new Float32Array(g * g * 3)
    for (let b = 0; b < g; b++) for (let a = 0; a < g; a++) {
      const x = this.minX + a * step, z = this.minZ + b * step
      const climate = (this.coarseClimate[b * g + a] ??= weather.climateAt(x, z))
      weather.at(x, z, time, w, climate)
      weather.surfaceAt(x, z, time, surf, climate)
      const k = (b * g + a) * 3
      grid[k] = w.windX
      grid[k + 1] = w.windZ
      grid[k + 2] = surf.snow > 0.2 ? 1 : 0.03 + 0.22 * w.humidity * w.humidity + 0.5 * surf.wetness + (w.precipitation > 0.2 ? 0.3 : 0)
    }
    for (let i = 0; i < n; i++) {
      const fx = ((i % this.cols) + 0.5) * o.cellSize / step, fz = (Math.floor(i / this.cols) + 0.5) * o.cellSize / step
      const a = Math.min(g - 2, Math.floor(fx)), b = Math.min(g - 2, Math.floor(fz))
      const tx = fx - a, tz = fz - b
      const lerp4 = (c: number) => {
        const p = grid[(b * g + a) * 3 + c], q = grid[(b * g + a + 1) * 3 + c], r = grid[((b + 1) * g + a) * 3 + c], s = grid[((b + 1) * g + a + 1) * 3 + c]
        return (p + (q - p) * tx) * (1 - tz) + (r + (s - r) * tx) * tz
      }
      this.windX[i] = lerp4(0)
      this.windZ[i] = lerp4(1)
      this.moisture[i] = lerp4(2)
    }
  }

  private build() {
    const o = this.options
    this.seed = seedOf(o.seed)
    const cols = Math.max(2, Math.round(o.size / o.cellSize))
    this.cols = this.rows = cols
    const n = cols * cols
    this.state = new Uint8Array(n)
    this.elevation = new Float64Array(n)
    this.firebreak = new Uint8Array(n)
    this.fuel = new Float32Array(n * 3)
    this.capacity = new Float32Array(n * 3)
    this.moisture = new Float32Array(n)
    this.ignition = new Float32Array(n)
    this.threshold = new Float32Array(n)
    this.burnLeft = new Float32Array(n)
    this.burnTotal = new Float32Array(n)
    this.ignitionFuel = new Float32Array(n * 3)
    this.residual = new Float32Array(n * 3)
    this.burntTick = new Int32Array(n)
    this.windX = new Float32Array(n)
    this.windZ = new Float32Array(n)
    this.coarse = Math.max(2, Math.ceil((cols * o.cellSize) / 500) + 1) // weather is km-scale: ~500 m samples
    this.coarseClimate = []
    o.ignitions.sort((a, b) => a[2] - b[2])

    const landscape = this.env.landscape ?? (this.env.world ? new WorldLandscape(this.env.world, this.env.frame ?? this.env.world.frame, o) : null)
    const info: FireCellInfo = { elevation: 0, firebreak: false, grass: 0, shrub: 0, tree: 0 }
    for (let i = 0; i < n; i++) {
      const [x, z] = this.center(i)
      if (landscape) landscape.cell(x, z, info)
      else Object.assign(info, { elevation: 0, firebreak: false, grass: o.fuel.grassLoad, shrub: 0, tree: 0 })
      this.elevation[i] = info.elevation
      this.firebreak[i] = info.firebreak ? 1 : 0
      this.capacity[i * 3] = info.grass
      this.capacity[i * 3 + 1] = info.shrub
      this.capacity[i * 3 + 2] = info.tree
      this.threshold[i] = Math.max(0.1, 1 + o.jitter * (hash01(i % cols, Math.floor(i / cols), this.seed, 5) * 2 - 1))
    }
    // Steep ground is bare rock; firebreak lines and roads cut through.
    const c = o.cellSize
    for (let i = 0; i < n; i++) {
      const ci = i % cols, cj = Math.floor(i / cols)
      const dx = (this.elevation[cj * cols + Math.min(cols - 1, ci + 1)] - this.elevation[cj * cols + Math.max(0, ci - 1)]) / (2 * c)
      const dz = (this.elevation[Math.min(cols - 1, cj + 1) * cols + ci] - this.elevation[Math.max(0, cj - 1) * cols + ci]) / (2 * c)
      if (Math.hypot(dx, dz) > o.firebreaks.rockSlope) this.firebreak[i] = 1
    }
    const lines: Firebreak[] = [...o.firebreaks.lines]
    if (o.firebreaks.roads && this.env.world && this.env.world.options.surface === 'plane') {
      for (const m of this.env.world.options.modifiers) if (m.type === 'path') lines.push({ points: m.points.map((p) => [p[0], p[2]]), width: m.width * 2 })
    }
    for (const line of lines) {
      for (let i = 0; i < n; i++) {
        const [x, z] = this.center(i)
        if (distanceToPolyline(x, z, line.points) <= line.width / 2 + c * 0.35) this.firebreak[i] = 1
      }
    }
    this.restart()
  }
}

/** Fuel and terrain from a `threejs-biomes` world (used by {@link FireSim} when given a world). */
class WorldLandscape implements FireLandscape {
  private readonly world: World
  private readonly frame: LocalFrame
  private readonly o: FireOptions
  private readonly sample: WorldSample = createSample(8)
  private readonly weights = new Float32Array(7)
  private readonly color = new Float32Array(3)

  constructor(world: World, frame: LocalFrame, o: FireOptions) {
    this.world = world
    this.frame = frame
    this.o = o
  }

  cell(x: number, z: number, out: FireCellInfo): FireCellInfo {
    const s = this.frame.sample(x, z, this.sample)
    const o = this.o
    out.elevation = s.elevation
    const water = s.waterLevel > s.elevation
    const ground = this.world.ground(s, 0, this.weights, this.color).weights
    out.firebreak = (o.firebreaks.water && water) || ground[4] + ground[5] > o.firebreaks.bareGround
    out.grass = out.shrub = out.tree = 0
    if (water) return out
    const biomes = this.world.options.biomes
    for (let k = 0; k < s.count; k++) {
      const b = biomes[s.biomes[k]], w = s.weights[k]
      if (b.grass.preset) out.grass += w * b.grass.coverage * b.grass.height * o.fuel.grassLoad * (o.fuel.grassPresets[b.grass.preset] ?? 1)
      for (const e of b.scatter) {
        const model = o.fuel.species[e.species] ?? { kind: 'shrub', biomass: o.fuel.unknownBiomass }
        if (model.kind === 'none') continue
        const load = (w * e.probability * model.biomass) / (e.spacing * e.spacing)
        if (model.kind === 'grass') out.grass += load
        else if (model.kind === 'shrub') out.shrub += load
        else out.tree += load
      }
    }
    return out
  }
}

/** Rothermel's moisture damping coefficient for r = moisture / moisture of extinction (1 at dry, 0 at r ≥ 1). */
export function moistureDamping(r: number): number {
  if (!(r < 1)) return 0
  const x = Math.max(0, r)
  return Math.max(0, 1 - 2.59 * x + 5.11 * x * x - 3.52 * x * x * x)
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / Math.max(1e-9, b - a)))
  return t * t * (3 - 2 * t)
}

function distanceToPolyline(x: number, z: number, pts: [number, number][]): number {
  if (pts.length === 1) return Math.hypot(x - pts[0][0], z - pts[0][1])
  let best = Infinity
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i]
    const abx = bx - ax, abz = bz - az
    const t = Math.min(1, Math.max(0, ((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz || 1)))
    best = Math.min(best, Math.hypot(x - ax - abx * t, z - az - abz * t))
  }
  return best
}
