import { BIOMES, GROUND_COLORS, GROUND_MATERIALS, type BiomeDef, type GroundMaterial } from './biomes.ts'
import { cellular, clamp, curve, erodedFbm, fbm, lerp, ridged, seedOf, smoothstep, warp, type CellSample, type FractalOptions, type Vec3 } from './noise.ts'

/** A flat world (an infinite plane, y up) or a planet (a sphere centred on the origin). */
export type SurfaceKind = 'plane' | 'sphere'

/** Continents: where land and ocean are, and the base height of each. */
export interface ContinentOptions {
  /** Typical continent size, metres. */
  scale: number
  /** Octaves of the continent noise. */
  octaves: number
  /** Domain-warp strength as a fraction of `scale` (coastline wiggle). */
  warp: number
  /** Shifts land vs ocean: positive = more land. Roughly −0.5 … 0.5. */
  landBias: number
  /** `[continentalness, height]` points (continentalness in −1…1, height in metres). */
  curve: [number, number][]
}

/** Ridged mountain ranges. */
export interface MountainOptions {
  /** Peak height above the land, metres. */
  height: number
  /** Typical ridge spacing, metres. */
  scale: number
  /** Octaves of ridged noise. */
  octaves: number
  /** Ridge sharpness exponent (1 = rounded, 3 = knife-edged). */
  sharpness: number
  /** Size of the regions that have ranges at all, metres. */
  rangeScale: number
  /** 0…1: how much of the land is mountainous (lower = more ranges). */
  threshold: number
  /** 0…1: how strongly the erosion field flattens mountains. */
  erosionDamping: number
}

/** Rolling hills built from eroded fBm. */
export interface HillOptions {
  /** Hill height, metres. */
  height: number
  /** Typical hill size, metres. */
  scale: number
  /** Octaves. */
  octaves: number
  /** Slope damping (0 = plain fBm; higher = smoother valleys, sharper gullies). */
  erosion: number
}

/** A band of fractal detail (used for ground detail and ant-scale micro relief). */
export interface DetailOptions {
  /** Amplitude, metres. */
  height: number
  /** Largest feature size, metres. */
  scale: number
  /** Octaves (each half the size of the last). */
  octaves: number
}

/** Rivers carved from a noise field. */
export interface RiverOptions {
  /** Turn rivers on or off. */
  enabled: boolean
  /** Typical distance between rivers, metres. */
  scale: number
  /** Channel half-width in noise units (≈ fraction of `scale`). */
  width: number
  /** Valley half-width in noise units. */
  valleyWidth: number
  /** Channel depth below the river surface, metres. */
  depth: number
  /** 0…1: how far valleys pull the land down towards sea level. */
  valleyDepth: number
  /** Rivers fade out above this height (they don't run along ridges), metres. */
  maxHeight: number
}

/** Climate: temperature and moisture fields. */
export interface ClimateOptions {
  /** Temperature at sea level on a flat world (°C). */
  baseTemperature: number
  /** ± temperature variation from the temperature noise (°C). */
  temperatureRange: number
  /** Typical size of warm and cold regions, metres. */
  temperatureScale: number
  /** Planets: sea-level temperature at the equator (°C). */
  equatorTemperature: number
  /** Planets: sea-level temperature at the poles (°C). */
  poleTemperature: number
  /** Flat worlds: °C lost per km towards −Z (a latitude stand-in). */
  latitudeGradient: number
  /** °C lost per km of altitude (Earth ≈ 6.5). */
  lapseRate: number
  /** Typical size of wet and dry regions, metres. */
  moistureScale: number
  /** Overall moisture offset (−0.5 … 0.5). */
  moistureBias: number
  /** 0…1: how much mountains dry out the land downwind of them. */
  rainShadow: number
  /** Prevailing wind on a flat world as [x, z] (planets use the local east). */
  windDirection: [number, number]
  /** Extra moisture near coasts. */
  coastalMoisture: number
  /** Extra moisture along river valleys. */
  riverMoisture: number
}

/** Rules for the override biomes (ocean, coast, alpine, glacier, wetland, …). */
export interface BiomeRuleOptions {
  /** Softness of the blend between climate biomes (larger = wider transitions). */
  blend: number
  /** Most biomes that can share one position. */
  maxBiomes: number
  /** Land up to this height above sea level counts as coast, metres. */
  coastHeight: number
  /** Water deeper than this is deep ocean, metres. */
  deepWater: number
  /** Temperature (°C) at the treeline; colder high ground is alpine. */
  treelineTemperature: number
  /** Alpine meadows start above this height, metres. */
  alpineMinHeight: number
  /** 0…1 share of full mountain height above which ridges are bare rock (peaks). */
  peakShare: number
  /** Temperature (°C) below which land is glacier. */
  glacierTemperature: number
  /** Moisture above which low flat land becomes wetland. */
  wetlandMoisture: number
  /** Wetlands only form below this height above sea level, metres. */
  wetlandMaxHeight: number
  /** Mangroves need at least this temperature (°C) on a wet coast. */
  mangroveTemperature: number
}

/** Volcanoes: rare cones with craters. */
export interface VolcanoOptions {
  /** 0…1 chance that a region has a volcano. */
  chance: number
  /** Region size (one possible volcano per region), metres. */
  regionSize: number
  /** Base radius of the cone, metres. */
  radius: number
  /** Cone height, metres. */
  height: number
  /** Crater radius as a fraction of `radius`. */
  crater: number
}

/** How the ground material mix reacts to slope, cold and water. */
export interface GroundOptions {
  /** Slope (rise/run) where bare rock takes over. */
  rockSlope: number
  /** Temperature (°C, after altitude) below which snow settles. */
  snowTemperature: number
  /** Height band around sea level that is sand, metres. */
  sandBand: number
  /** Colours of the ground materials (`#rrggbb`). */
  colors: Record<GroundMaterial, string>
}

/** Flattens a circular area to a height (e.g. a town square or a building pad). */
export interface FlattenCircle {
  /** Modifier type. */
  type: 'circle'
  /** Centre on the base surface, [x, y, z] (planets) or [x, 0, z] (flat worlds). */
  center: [number, number, number]
  /** Fully flat inside this radius, metres. */
  radius: number
  /** Blend distance outside `radius`, metres. */
  falloff: number
  /** Target height, metres; `null` keeps the natural height at the centre. */
  height: number | null
}

/** Flattens strips along polylines (e.g. roads), with a height per vertex. */
export interface FlattenPath {
  /** Modifier type. */
  type: 'path'
  /** Polyline points on the base surface with target height: [x, y, z, height]. */
  points: [number, number, number, number][]
  /** Flat half-width, metres. */
  width: number
  /** Blend distance beyond `width`, metres. */
  falloff: number
}

/** A data-only height edit applied after generation (so it also works inside workers). */
export type HeightModifier = FlattenCircle | FlattenPath

/** Every world setting. All plain data: save it, share it, send it to a worker, bind it to a GUI. */
export interface WorldOptions {
  /** Seed: the same seed and options always give the same world. */
  seed: number | string
  /** Flat world or planet. */
  surface: SurfaceKind
  /** Planet radius, metres (planets only). */
  radius: number
  /** Planets: [latitude, longitude] in degrees where {@link World.height} (local x/z) is centred. */
  origin: [number, number]
  /** Sea level, metres. */
  seaLevel: number
  /** Continents. */
  continents: ContinentOptions
  /** Erosion field: flat plains vs rugged land. */
  erosion: { scale: number; octaves: number }
  /** Mountains. */
  mountains: MountainOptions
  /** Hills. */
  hills: HillOptions
  /** Ground detail (metres down to decimetres). */
  detail: DetailOptions
  /** Micro relief (decimetres down to millimetres; what an ant walks over). */
  micro: DetailOptions
  /** Rivers. */
  rivers: RiverOptions
  /** Climate. */
  climate: ClimateOptions
  /** Override-biome rules. */
  rules: BiomeRuleOptions
  /** Volcanoes. */
  volcanoes: VolcanoOptions
  /** Ground materials. */
  ground: GroundOptions
  /** The biome table. Defaults to the 20 built-in {@link BIOMES}. */
  biomes: BiomeDef[]
  /** Height edits applied last (cities flatten their roads and lots here). */
  modifiers: HeightModifier[]
}

/** Recursive partial, for {@link World.set}. Arrays are replaced, not merged. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] }

/** Input accepted by the {@link World} constructor and {@link World.set}. */
export type WorldInput = DeepPartial<WorldOptions>

/** Default world settings: a temperate, mountainous flat world. */
export const DEFAULT_WORLD: WorldOptions = {
  seed: 1,
  surface: 'plane',
  radius: 120_000,
  origin: [20, 0],
  seaLevel: 0,
  continents: {
    scale: 6000, octaves: 5, warp: 0.4, landBias: 0.12,
    curve: [[-1, -140], [-0.45, -70], [-0.2, -12], [-0.06, -1], [0.02, 1.5], [0.15, 8], [0.45, 30], [1, 70]],
  },
  erosion: { scale: 2600, octaves: 3 },
  mountains: { height: 950, scale: 2400, octaves: 8, sharpness: 2, rangeScale: 7000, threshold: 0.5, erosionDamping: 0.75 },
  hills: { height: 55, scale: 900, octaves: 6, erosion: 1.5 },
  detail: { height: 1.6, scale: 48, octaves: 8 },
  micro: { height: 0.05, scale: 0.8, octaves: 7 },
  rivers: { enabled: true, scale: 3400, width: 0.018, valleyWidth: 0.11, depth: 3, valleyDepth: 0.7, maxHeight: 320 },
  climate: {
    baseTemperature: 15, temperatureRange: 16, temperatureScale: 9000,
    equatorTemperature: 28, poleTemperature: -18, latitudeGradient: 0, lapseRate: 6.5,
    moistureScale: 5200, moistureBias: 0, rainShadow: 0.35, windDirection: [1, 0], coastalMoisture: 0.12, riverMoisture: 0.25,
  },
  rules: {
    blend: 0.2, maxBiomes: 4, coastHeight: 1.6, deepWater: 6, treelineTemperature: 2, alpineMinHeight: 350,
    peakShare: 0.42, glacierTemperature: -14, wetlandMoisture: 0.72, wetlandMaxHeight: 8, mangroveTemperature: 23,
  },
  volcanoes: { chance: 0.05, regionSize: 14000, radius: 2200, height: 1100, crater: 0.14 },
  ground: { rockSlope: 0.85, snowTemperature: -3, sandBand: 1.2, colors: { ...GROUND_COLORS } },
  biomes: BIOMES.map((b) => structuredClone(b)),
  modifiers: [],
}

/** Everything known about one point of the world. Reuse one object across calls (pass it as `out`). */
export interface WorldSample {
  /** Height above the base surface (plane y = 0 / planet radius), metres. */
  elevation: number
  /** Continentalness, −1 (deep ocean) … 1 (deep inland). */
  continentalness: number
  /** Erosion field 0 (rugged) … 1 (flat). */
  erosion: number
  /** Mountain contribution 0 … 1 (share of full mountain height). */
  mountain: number
  /** Temperature at this altitude, °C. */
  temperature: number
  /** Moisture 0 … 1. */
  moisture: number
  /** 0 … 1 strength of the river valley here. */
  valley: number
  /** 0 … 1 strength of the river channel here. */
  river: number
  /** Water surface height (sea or river), or NaN where dry. */
  waterLevel: number
  /** Biome indices into `world.options.biomes`, strongest first (length `count`). */
  biomes: Int32Array
  /** Weights matching `biomes`, summing to 1. */
  weights: Float32Array
  /** Number of valid entries in `biomes`/`weights`. */
  count: number
}

/** Creates an empty {@link WorldSample} sized for `maxBiomes`. */
export function createSample(maxBiomes = 8): WorldSample {
  return {
    elevation: 0, continentalness: 0, erosion: 0, mountain: 0, temperature: 0, moisture: 0, valley: 0, river: 0, waterLevel: NaN,
    biomes: new Int32Array(maxBiomes), weights: new Float32Array(maxBiomes), count: 0,
  }
}

/** Plane worlds sample their 3D noise on this horizontal slice (off the lattice, so no octave is degenerate). */
export const PLANE_Y = 137.31

const PLACEMENT_ORDER = ['volcanic', 'ocean', 'glacier', 'peaks', 'alpine', 'mangrove', 'coast', 'wetland'] as const

/**
 * A procedural world: climate, height, rivers, volcanoes, 20 blended biomes and their ground, as
 * deterministic functions of `seed` and position. Works as an infinite flat world or as a planet, and
 * is cheap enough to query per vertex, per blade of grass or per tree.
 *
 * Positions on the *base surface* are 3D metres: `(x, ·, z)` on a flat world (y is ignored), or any
 * point on a planet (it is projected onto the sphere). Use {@link World.height} for a classic
 * `(x, z) => y` height function — on a planet it works in a local flat frame around `origin`.
 *
 * @example
 * ```ts
 * const world = new World({ seed: 'archipelago', continents: { landBias: -0.1 } })
 * world.height(120, -40)                           // metres
 * world.biomeAt(120, -40).name                     // 'Temperate grassland'
 * world.set({ mountains: { height: 1600 } })       // live update; listeners rebuild
 * ```
 */
export class World {
  /** Resolved settings. Change them with {@link World.set} / {@link World.reset}. */
  options: WorldOptions
  /** Bumped on every change; caches compare it. */
  version = 0
  /** Local flat frame used by {@link World.height} on planets (identity on flat worlds). */
  frame!: LocalFrame

  private seed = 0
  private climateIdx: number[] = []
  private overrideIdx: Record<string, number> = {}
  private tints: Float32Array = new Float32Array(0)
  private groundMix: Float32Array = new Float32Array(0)
  private listeners = new Set<(world: World, region?: WorldRegion) => void>()
  private readonly cell: CellSample = { distance: 0, point: [0, 0, 0], random: 0 }
  private readonly w3: Vec3 = [0, 0, 0]
  private readonly scratch = createSample(32)

  /** Creates a world; anything not given uses {@link DEFAULT_WORLD}. */
  constructor(input: WorldInput = {}) {
    this.options = sanitize(merge(structuredClone(DEFAULT_WORLD), input))
    this.prepare()
  }

  /** Merges `input` into the current settings (nested objects merge; arrays replace) and notifies listeners. */
  set(input: WorldInput): this {
    this.options = sanitize(merge(this.options, input))
    return this.changed()
  }

  /** Replaces all settings: anything not in `input` goes back to the defaults. */
  reset(input: WorldInput = {}): this {
    const next = sanitize(merge(structuredClone(DEFAULT_WORLD), input))
    if (JSON.stringify(next) === JSON.stringify(this.options)) return this
    this.options = next
    return this.changed()
  }

  /** Adds height modifiers (e.g. from a city) and notifies listeners with the region they touch. */
  addModifier(...modifiers: HeightModifier[]): this {
    this.options.modifiers.push(...modifiers)
    return this.changed(modifierRegion(modifiers))
  }

  /** Removes height modifiers previously added. */
  removeModifier(...modifiers: HeightModifier[]): this {
    for (const m of modifiers) {
      const i = this.options.modifiers.indexOf(m)
      if (i >= 0) this.options.modifiers.splice(i, 1)
    }
    return this.changed(modifierRegion(modifiers))
  }

  /**
   * Calls `listener` after every change. `region` is set when only that box (base-surface coordinates)
   * changed — e.g. a modifier was added — so caches can rebuild just what it touches. Returns an
   * unsubscribe function.
   */
  onChange(listener: (world: World, region?: WorldRegion) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(region?: WorldRegion): this {
    this.prepare()
    this.version++
    for (const l of this.listeners) l(this, region)
    return this
  }

  private prepare() {
    const o = this.options
    this.seed = seedOf(o.seed)
    this.climateIdx = []
    this.overrideIdx = {}
    o.biomes.forEach((b, i) => {
      if (b.placement === 'climate') this.climateIdx.push(i)
      else if (!(b.placement in this.overrideIdx)) this.overrideIdx[b.placement] = i
    })
    const n = o.biomes.length
    const m = GROUND_MATERIALS.length
    this.tints = new Float32Array(n * 3)
    this.groundMix = new Float32Array(n * m)
    o.biomes.forEach((b, i) => {
      const [r, g, bl] = hexToRgb(b.groundTint)
      this.tints.set([r, g, bl], i * 3)
      let total = 0
      for (const k of GROUND_MATERIALS) total += b.ground[k] ?? 0
      GROUND_MATERIALS.forEach((k, j) => (this.groundMix[i * m + j] = (b.ground[k] ?? 0) / (total || 1)))
    })
    this.frame = new LocalFrame(this)
    this.modifierIndex = new ModifierGrid(buildModifierIndex(o.modifiers))
  }

  /** Planet radius, or 0 on a flat world. */
  get radius(): number {
    return this.options.surface === 'sphere' ? this.options.radius : 0
  }

  /**
   * Samples everything at a base-surface position (see the class docs for what that means).
   * @param minWavelength Skip noise detail smaller than this many metres (pass a LOD's vertex spacing ×2).
   */
  sampleAt(px: number, py: number, pz: number, out: WorldSample = createSample(this.options.rules.maxBiomes), minWavelength = 0): WorldSample {
    const o = this.options
    const sphere = o.surface === 'sphere'
    // P: the noise-space point. On a planet it is the point on the sphere; on a plane, the y = PLANE_Y slice.
    let x = px, y = PLANE_Y, z = pz
    let lat = 0
    if (sphere) {
      const len = Math.hypot(px, py, pz) || 1
      x = (px / len) * o.radius; y = (py / len) * o.radius; z = (pz / len) * o.radius
      lat = Math.asin(clamp(py / len, -1, 1))
    }
    const seed = this.seed
    const sea = o.seaLevel

    // Continents (warped so coastlines don't follow the noise lattice).
    const c0 = o.continents
    const q = warp(seed + 101, x, y, z, 1 / (c0.scale * 1.7), c0.warp * c0.scale, this.w3)
    const continental = clamp(fbm(seed + 1, q[0], q[1], q[2], frac(1 / c0.scale, c0.octaves)) * 1.25 + c0.landBias, -1, 1)
    const base = curve(c0.curve, continental)
    const land = smoothstep(-0.08, 0.1, continental)

    const erosion = 0.5 + 0.5 * spread(fbm(seed + 2, x, y, z, frac(1 / o.erosion.scale, o.erosion.octaves)))

    // Mountains: ridged noise inside "range" regions, flattened where erosion is high.
    const m0 = o.mountains
    const rangeField = 0.5 + 0.5 * spread(fbm(seed + 3, x, y, z, frac(1 / m0.rangeScale, 3)))
    const rangeMask = smoothstep(m0.threshold, m0.threshold + 0.25, rangeField) * (1 - erosion * m0.erosionDamping) * land
    const ridge = rangeMask > 0.001 ? ridged(seed + 4, x, y, z, frac(1 / m0.scale, m0.octaves), m0.sharpness, minWavelength) : 0
    const mountainShare = ridge * rangeMask
    const mountains = m0.height * mountainShare

    const h0 = o.hills
    const hills = h0.height * erodedFbm(seed + 5, x, y, z, frac(1 / h0.scale, h0.octaves), h0.erosion, minWavelength) * (0.35 + 0.65 * (1 - erosion)) * (0.25 + 0.75 * land)

    // Volcanoes: at most one per region, a cone with a crater.
    let volcano = 0
    let volcanic = 0
    const v0 = o.volcanoes
    if (v0.chance > 0) {
      const cell = cellular(seed + 6, x / v0.regionSize, y / v0.regionSize, z / v0.regionSize, 0.8, this.cell)
      if (cell.random < v0.chance) {
        const d = cell.distance * v0.regionSize
        const t = smoothstep(v0.radius, 0, d)
        const crater = smoothstep(v0.radius * v0.crater, v0.radius * v0.crater * 0.4, d)
        volcano = v0.height * (Math.pow(t, 1.6) - crater * 0.35) * land
        volcanic = smoothstep(v0.radius * 1.15, v0.radius * 0.7, d) * land
      }
    }

    let h = base + mountains + hills + volcano

    // Rivers: valleys where a warped noise field crosses zero, fading out on high ground.
    let valley = 0
    let river = 0
    let waterLevel = h < sea ? sea : NaN
    const r0 = o.rivers
    if (r0.enabled) {
      const rq = warp(seed + 201, x, y, z, 1 / (r0.scale * 0.8), r0.scale * 0.35, this.w3)
      const rn = Math.abs(fbm(seed + 7, rq[0], rq[1], rq[2], frac(1 / r0.scale, 3)))
      const mask = smoothstep(sea + 0.5, sea + 4, base + hills * 0.5) * (1 - smoothstep(r0.maxHeight * 0.6, r0.maxHeight, h)) * (1 - volcanic)
      valley = smoothstep(r0.valleyWidth, 0, rn) * mask
      river = smoothstep(r0.width, r0.width * 0.35, rn) * mask
      if (valley > 0) {
        const low = base + hills * 0.35 + mountains * 0.15
        const surface = sea + Math.max(0.4, (low - sea) * (1 - r0.valleyDepth))
        h = lerp(h, Math.min(h, surface + 0.6), valley)
        h = lerp(h, surface - r0.depth, river)
        if (river > 0.02 && h < surface) waterLevel = surface
      }
    }

    // Climate.
    const cl = o.climate
    const above = Math.max(0, h - sea)
    let temperature: number
    if (sphere) {
      const t = Math.pow(Math.abs(Math.sin(lat)), 1.3)
      temperature = lerp(cl.equatorTemperature, cl.poleTemperature, t) + cl.temperatureRange * 0.5 * spread(fbm(seed + 8, x, y, z, frac(1 / cl.temperatureScale, 3)))
    } else {
      temperature = cl.baseTemperature + cl.temperatureRange * spread(fbm(seed + 8, x, y, z, frac(1 / cl.temperatureScale, 3))) + (cl.latitudeGradient * pz) / 1000
    }
    temperature -= (cl.lapseRate * above) / 1000

    let moisture = 0.5 + 0.55 * spread(fbm(seed + 9, x, y, z, frac(1 / cl.moistureScale, 3))) + cl.moistureBias
    moisture += cl.coastalMoisture * smoothstep(0.25, -0.02, continental) + cl.riverMoisture * valley
    if (cl.rainShadow > 0 && m0.height > 0) {
      // Upwind ridges dry the air: compare the land upwind with here.
      const [wx, wy, wz] = this.windAt(x, y, z, sphere)
      let upwind = 0
      for (const dist of [m0.scale * 0.6, m0.scale * 1.4]) {
        const ux = x - wx * dist, uy = y - wy * dist, uz = z - wz * dist
        const rf = 0.5 + 0.5 * spread(fbm(seed + 3, ux, uy, uz, frac(1 / m0.rangeScale, 3)))
        const mask = smoothstep(m0.threshold, m0.threshold + 0.25, rf)
        if (mask > 0.001) upwind = Math.max(upwind, m0.height * mask * ridged(seed + 4, ux, uy, uz, frac(1 / m0.scale, 3), m0.sharpness))
      }
      moisture -= cl.rainShadow * clamp((upwind - mountains) / m0.height, 0, 1)
    }
    moisture = clamp(moisture, 0, 1)

    out.continentalness = continental
    out.erosion = erosion
    out.mountain = mountainShare
    out.temperature = temperature
    out.moisture = moisture
    out.valley = valley
    out.river = river

    this.weighBiomes(h, sea, continental, erosion, mountainShare, volcanic, temperature, moisture, out)

    // Biome shaping, blended by weight.
    for (let i = 0; i < out.count; i++) {
      const b = o.biomes[out.biomes[i]]
      if (b.shape === 'none' || b.shapeAmount === 0) continue
      const w = out.weights[i]
      const a = b.shapeAmount
      switch (b.shape) {
        case 'dunes': {
          const [wx, , wz] = sphere ? [1, 0, 0] : [cl.windDirection[0], 0, cl.windDirection[1]]
          const len = Math.hypot(wx, wz) || 1
          const phase = ((x * wx + z * wz) / len) / 70 + 1.8 * fbm(seed + 10, x, y, z, frac(1 / 260, 3))
          const crest = 1 - Math.abs(Math.sin(phase * Math.PI))
          h += w * a * (crest * crest * (0.6 + 0.4 * fbm(seed + 11, x, y, z, frac(1 / 500, 2))) - 0.3)
          break
        }
        case 'terraces': {
          const step = a
          const k = (h - sea) / step
          const f = k - Math.floor(k)
          const terraced = sea + (Math.floor(k) + smoothstep(0.75, 1, f)) * step
          h = lerp(h, terraced, w * 0.85)
          break
        }
        case 'hummocks':
          h += w * a * fbm(seed + 12, x, y, z, frac(1 / 9, 2), minWavelength)
          break
        case 'flatten': {
          const target = sea + 0.3 + (h - sea) * 0.25
          h = lerp(h, target, w * 0.8)
          break
        }
        case 'crevasses':
          h -= w * a * smoothstep(0.05, 0, Math.abs(fbm(seed + 13, x, y, z, frac(1 / 70, 3))))
          break
      }
    }

    // Ground detail and ant-scale micro relief (skipped below the LOD's resolution).
    const d0 = o.detail
    if (d0.height > 0) h += d0.height * fbm(seed + 14, x, y, z, frac(1 / d0.scale, d0.octaves), minWavelength) * (0.5 + mountainShare * 2)
    const u0 = o.micro
    if (u0.height > 0 && (minWavelength === 0 || minWavelength < u0.scale)) h += u0.height * fbm(seed + 15, x, y, z, frac(1 / u0.scale, u0.octaves), minWavelength)

    if (this.modifierIndex.length) h = this.applyModifiers(sphere ? x : px, sphere ? y : 0, sphere ? z : pz, h)

    if (h < sea) waterLevel = Number.isNaN(waterLevel) ? sea : Math.max(waterLevel, sea)
    else if (!(waterLevel > h)) waterLevel = NaN
    out.elevation = h
    out.waterLevel = waterLevel
    return out
  }

  private windAt(x: number, y: number, z: number, sphere: boolean): Vec3 {
    if (!sphere) {
      const [wx, wz] = this.options.climate.windDirection
      const l = Math.hypot(wx, wz) || 1
      return [wx / l, 0, wz / l]
    }
    // Local east on the sphere: up × north-pole axis.
    const ex = -z, ez = x
    const l = Math.hypot(ex, ez) || 1
    return [ex / l, 0, ez / l]
  }

  private weighBiomes(h: number, sea: number, continental: number, erosion: number, mountainShare: number, volcanic: number, temperature: number, moisture: number, out: WorldSample) {
    const o = this.options
    const r = o.rules
    const s = this.scratch
    let n = 0
    let remaining = 1
    const depth = sea - h
    const aboveSea = h - sea
    const onLand = smoothstep(sea - 0.5, sea + 0.3, h)
    for (const kind of PLACEMENT_ORDER) {
      const idx = this.overrideIdx[kind]
      if (idx === undefined || remaining <= 1e-4) continue
      let strength = 0
      switch (kind) {
        case 'volcanic': strength = volcanic; break
        case 'ocean': strength = smoothstep(r.deepWater * 0.5, r.deepWater, depth); break
        case 'glacier': strength = smoothstep(r.glacierTemperature + 3, r.glacierTemperature - 2, temperature) * onLand; break
        case 'peaks': strength = smoothstep(r.peakShare, r.peakShare + 0.15, mountainShare); break
        case 'alpine':
          strength = smoothstep(r.treelineTemperature + 1.5, r.treelineTemperature - 1.5, temperature) * smoothstep(r.alpineMinHeight * 0.7, r.alpineMinHeight, aboveSea)
          break
        case 'mangrove':
        case 'coast': {
          const shore = smoothstep(r.coastHeight, r.coastHeight * 0.4, aboveSea) * smoothstep(r.deepWater, r.deepWater * 0.5, depth) * smoothstep(0.12, -0.02, continental)
          const mangrove = shore * smoothstep(r.mangroveTemperature - 2, r.mangroveTemperature + 2, temperature) * smoothstep(0.6, 0.8, moisture)
          strength = kind === 'mangrove' ? mangrove : shore - mangrove
          if (kind === 'coast') strength /= Math.max(1e-4, 1 - mangrove) // share of what mangrove left
          break
        }
        case 'wetland':
          strength = smoothstep(r.wetlandMoisture - 0.06, r.wetlandMoisture + 0.06, moisture) * smoothstep(r.wetlandMaxHeight, r.wetlandMaxHeight * 0.4, aboveSea) * smoothstep(0.45, 0.7, erosion) * onLand
          break
      }
      const w = clamp(strength, 0, 1) * remaining
      if (w > 1e-4) {
        s.biomes[n] = idx
        s.weights[n++] = w
        remaining -= w
      }
    }
    if (remaining > 1e-4 && this.climateIdx.length) {
      // Whittaker diagram: Gaussian falloff with distance in (temperature, moisture) space.
      let total = 0
      const start = n
      const b2 = r.blend * r.blend
      for (const i of this.climateIdx) {
        const b = o.biomes[i]
        const dt = (temperature - b.temperature) / 25
        const dm = (moisture - b.moisture) / 0.45
        const w = Math.exp(-(dt * dt + dm * dm) / b2)
        if (w < 1e-5 && total > 0) continue
        s.biomes[n] = i
        s.weights[n++] = w
        total += w
      }
      if (total <= 0) {
        // Far outside every climate biome: take the nearest one.
        let best = this.climateIdx[0], bestD = Infinity
        for (const i of this.climateIdx) {
          const b = o.biomes[i]
          const d = ((temperature - b.temperature) / 25) ** 2 + ((moisture - b.moisture) / 0.45) ** 2
          if (d < bestD) { bestD = d; best = i }
        }
        n = start
        s.biomes[n] = best
        s.weights[n++] = remaining
      } else {
        for (let i = start; i < n; i++) s.weights[i] = (s.weights[i] / total) * remaining
      }
    }
    // Keep the strongest `maxBiomes`, renormalised.
    const max = Math.min(r.maxBiomes, out.biomes.length)
    out.count = 0
    let sum = 0
    for (let k = 0; k < max && k < n; k++) {
      let best = -1, bw = -1
      for (let i = 0; i < n; i++) if (s.weights[i] > bw) { bw = s.weights[i]; best = i }
      if (best < 0 || bw <= 0) break
      out.biomes[out.count] = s.biomes[best]
      out.weights[out.count++] = bw
      sum += bw
      s.weights[best] = -1
    }
    for (let i = 0; i < out.count; i++) out.weights[i] /= sum || 1
  }

  /**
   * Ground material weights (in {@link GROUND_MATERIALS} order, summing to 1) and the blended ground
   * colour (sRGB) for a sample. `slope` is rise/run (0 = flat); pass it from your mesh normals.
   * @param overrides Apply the slope/cold/waterline/river overrides (rock, snow, sand, mud). The terrain
   *   shader applies those per pixel itself, so chunks pass `false` and get the biome soil colour only.
   */
  ground(sample: WorldSample, slope: number, weightsOut: Float32Array = new Float32Array(GROUND_MATERIALS.length), colorOut: Float32Array = new Float32Array(3), overrides = true): { weights: Float32Array; color: Float32Array } {
    const o = this.options
    const m = GROUND_MATERIALS.length
    weightsOut.fill(0)
    let tr = 0, tg = 0, tb = 0
    for (let i = 0; i < sample.count; i++) {
      const b = sample.biomes[i]
      const w = sample.weights[i]
      for (let j = 0; j < m; j++) weightsOut[j] += w * this.groundMix[b * m + j]
      tr += w * this.tints[b * 3]; tg += w * this.tints[b * 3 + 1]; tb += w * this.tints[b * 3 + 2]
    }
    const g = o.ground
    // Overrides: steep ground is rock, cold ground is snow, the waterline is sand, river banks are mud.
    const rock = smoothstep(g.rockSlope * 0.7, g.rockSlope, slope)
    const snow = smoothstep(g.snowTemperature + 1.5, g.snowTemperature - 1.5, sample.temperature) * (1 - smoothstep(1.2, 1.8, slope))
    const sand = smoothstep(g.sandBand, g.sandBand * 0.3, Math.abs(sample.elevation - o.seaLevel)) * (1 - rock)
    const mud = sample.river * 0.8
    const blend = (j: number, t: number) => {
      for (let k = 0; k < m; k++) weightsOut[k] *= 1 - t
      weightsOut[j] += t
    }
    if (overrides) {
      blend(6, mud)
      blend(3, sand)
      blend(4, rock)
      blend(5, snow)
    }
    const cols = this.groundColors()
    let r = 0, gg = 0, bb = 0
    for (let j = 0; j < m; j++) {
      r += weightsOut[j] * cols[j * 3]; gg += weightsOut[j] * cols[j * 3 + 1]; bb += weightsOut[j] * cols[j * 3 + 2]
    }
    // Biome tint applies to living/soil materials, not to rock and snow.
    const tintAmount = 1 - weightsOut[4] - weightsOut[5]
    colorOut[0] = r * lerp(1, tr, tintAmount)
    colorOut[1] = gg * lerp(1, tg, tintAmount)
    colorOut[2] = bb * lerp(1, tb, tintAmount)
    return { weights: weightsOut, color: colorOut }
  }

  private groundColorCache: { key: Record<GroundMaterial, string>; rgb: Float32Array } | null = null
  private groundColors(): Float32Array {
    const colors = this.options.ground.colors
    if (this.groundColorCache?.key !== colors) {
      const rgb = new Float32Array(GROUND_MATERIALS.length * 3)
      GROUND_MATERIALS.forEach((k, j) => rgb.set(hexToRgb(colors[k]), j * 3))
      this.groundColorCache = { key: colors, rgb }
    }
    return this.groundColorCache.rgb
  }

  /** Height function `(x, z) => y`: the flat world itself, or a local flat frame around `origin` on a planet. */
  height = (x: number, z: number): number => this.frame.height(x, z)

  /** Everything about local position (x, z) (flat world, or the `origin` frame on a planet). */
  sample(x: number, z: number, out?: WorldSample): WorldSample {
    return this.frame.sample(x, z, out)
  }

  /** The strongest biome at local (x, z). */
  biomeAt(x: number, z: number): BiomeDef {
    const s = this.sample(x, z, this.scratch)
    return this.options.biomes[s.biomes[0]]
  }

  /**
   * A local flat frame centred at a planet position given in degrees (or the world itself on a flat
   * world). Packages that think in `(x, z) => y` — grass, scatter, water, cities — work in frames.
   */
  frameAt(latitude: number, longitude: number): LocalFrame {
    return new LocalFrame(this, latitude, longitude)
  }

  // --- modifiers -------------------------------------------------------------------------------
  private modifierIndex = new ModifierGrid([])

  private applyModifiers(x: number, y: number, z: number, h: number): number {
    return this.modifierIndex.apply(x, y, z, h)
  }
}

/**
 * Uniform hash grid over modifier boxes, so a sample only visits the few modifiers near it (cities add
 * thousands). Lists hold modifier indices in insertion order, because modifiers apply in order.
 * Modifiers spanning more than `MAX_CELLS` cells go in `big`, and are merged in by index at query time.
 */
class ModifierGrid {
  readonly length: number
  private mods: PreparedModifier[]
  private cell: number
  private cells = new Map<number, number[]>()
  private big: number[] = []

  constructor(mods: PreparedModifier[]) {
    this.mods = mods
    this.length = mods.length
    // Cell size ≈ median modifier size, so a typical modifier touches a handful of cells.
    const sizes = mods.map((m) => Math.max(m.maxX - m.minX, m.maxY - m.minY, m.maxZ - m.minZ)).sort((a, b) => a - b)
    this.cell = Math.max(8, sizes[sizes.length >> 1] ?? 8)
    const c = this.cell
    mods.forEach((m, i) => {
      const x0 = Math.floor(m.minX / c), x1 = Math.floor(m.maxX / c)
      const y0 = Math.floor(m.minY / c), y1 = Math.floor(m.maxY / c)
      const z0 = Math.floor(m.minZ / c), z1 = Math.floor(m.maxZ / c)
      if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > MAX_CELLS) { this.big.push(i); return }
      for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) for (let iz = z0; iz <= z1; iz++) {
        const k = cellKey(ix, iy, iz)
        const list = this.cells.get(k)
        if (!list) this.cells.set(k, [i])
        else if (list[list.length - 1] !== i) list.push(i) // hash collisions could repeat an index
      }
    })
  }

  /** Applies every modifier whose box contains (x, y, z), in insertion order. */
  apply(x: number, y: number, z: number, h: number): number {
    if (!this.length) return h
    const c = this.cell
    const local = this.cells.get(cellKey(Math.floor(x / c), Math.floor(y / c), Math.floor(z / c)))
    const big = this.big
    let a = 0, b = 0
    const na = local?.length ?? 0, nb = big.length
    while (a < na || b < nb) {
      const i = b >= nb || (a < na && local![a] < big[b]) ? local![a++] : big[b++]
      const m = this.mods[i]
      if (x < m.minX || x > m.maxX || y < m.minY || y > m.maxY || z < m.minZ || z > m.maxZ) continue
      h = m.apply(x, y, z, h)
    }
    return h
  }
}

const MAX_CELLS = 512

function cellKey(x: number, y: number, z: number): number {
  return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0
}

/** An axis-aligned box in base-surface coordinates (what a change touched). */
export interface WorldRegion {
  /** Minimum corner. */
  min: Vec3
  /** Maximum corner. */
  max: Vec3
}

function modifierRegion(mods: HeightModifier[]): WorldRegion | undefined {
  if (!mods.length) return undefined
  const prepared = buildModifierIndex(mods)
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const m of prepared) {
    min[0] = Math.min(min[0], m.minX); min[1] = Math.min(min[1], m.minY); min[2] = Math.min(min[2], m.minZ)
    max[0] = Math.max(max[0], m.maxX); max[1] = Math.max(max[1], m.maxY); max[2] = Math.max(max[2], m.maxZ)
  }
  return { min, max }
}

interface PreparedModifier {
  minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number
  apply: (x: number, y: number, z: number, h: number) => number
}

function buildModifierIndex(mods: HeightModifier[]): PreparedModifier[] {
  return mods.map((m) => {
    if (m.type === 'circle') {
      const [cx, cy, cz] = m.center
      const r = m.radius + m.falloff
      return {
        minX: cx - r, maxX: cx + r, minY: cy - r, maxY: cy + r, minZ: cz - r, maxZ: cz + r,
        apply: (x, y, z, h) => {
          if (m.height === null) return h
          const d = Math.hypot(x - cx, y - cy, z - cz)
          return lerp(h, m.height, smoothstep(m.radius + m.falloff, m.radius, d))
        },
      }
    }
    const pts = m.points
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const [x, y, z] of pts) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
    }
    const pad = m.width + m.falloff
    return {
      minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad, minZ: minZ - pad, maxZ: maxZ + pad,
      apply: (x, y, z, h) => {
        let best = Infinity, target = h
        for (let i = 1; i < pts.length; i++) {
          const [ax, ay, az, ah] = pts[i - 1]
          const [bx, by, bz, bh] = pts[i]
          const abx = bx - ax, aby = by - ay, abz = bz - az
          const len2 = abx * abx + aby * aby + abz * abz || 1
          const t = clamp(((x - ax) * abx + (y - ay) * aby + (z - az) * abz) / len2, 0, 1)
          const d = Math.hypot(x - (ax + abx * t), y - (ay + aby * t), z - (az + abz * t))
          if (d < best) { best = d; target = ah + (bh - ah) * t }
        }
        return lerp(h, target, smoothstep(m.width + m.falloff, m.width, best))
      },
    }
  })
}

/**
 * A locally flat frame on a world: `x` east, `z` south (three.js convention: −z is north), `y` up.
 * On a flat world it is the world itself. On a planet it is the tangent plane at a latitude/longitude,
 * accurate for tens of kilometres — enough for grass, forests, rivers and cities. Heights include the
 * planet's curvature drop, so things placed with it sit exactly on the rendered sphere.
 */
export class LocalFrame {
  /** Planet-centred position of the frame origin on the base sphere (zero on a flat world). */
  readonly origin: Vec3
  /** Unit east vector. */
  readonly east: Vec3
  /** Unit up vector. */
  readonly up: Vec3
  /** Unit north vector. */
  readonly north: Vec3
  private readonly world: World

  /** Prefer {@link World.frameAt}. Without a position, uses `world.options.origin`. */
  constructor(world: World, latitude = world.options.origin[0], longitude = world.options.origin[1]) {
    this.world = world
    if (world.options.surface !== 'sphere') {
      this.origin = [0, 0, 0]; this.east = [1, 0, 0]; this.up = [0, 1, 0]; this.north = [0, 0, -1]
      return
    }
    const la = (latitude * Math.PI) / 180, lo = (longitude * Math.PI) / 180
    const up: Vec3 = [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)]
    const east: Vec3 = [Math.cos(lo), 0, -Math.sin(lo)]
    const north: Vec3 = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]]
    const R = world.options.radius
    this.origin = [up[0] * R, up[1] * R, up[2] * R]
    this.up = up; this.east = east; this.north = north
  }

  /** Base-surface point under local (x, z), planet-centred. */
  basePoint(x: number, z: number, out: Vec3 = [0, 0, 0]): Vec3 {
    const o = this.origin, e = this.east, n = this.north
    out[0] = o[0] + e[0] * x - n[0] * z
    out[1] = o[1] + e[1] * x - n[1] * z
    out[2] = o[2] + e[2] * x - n[2] * z
    return out
  }

  /** Everything about local (x, z). `elevation` is converted to local y (curvature included). */
  sample(x: number, z: number, out?: WorldSample, minWavelength = 0): WorldSample {
    const w = this.world
    if (w.options.surface !== 'sphere') return w.sampleAt(x, 0, z, out, minWavelength)
    const p = this.basePoint(x, z, this.p)
    const s = w.sampleAt(p[0], p[1], p[2], out, minWavelength)
    const drop = this.drop(p)
    s.elevation = s.elevation * this.cosine(p) - drop
    if (!Number.isNaN(s.waterLevel)) s.waterLevel = s.waterLevel * this.cosine(p) - drop
    return s
  }

  /** Local height at (x, z): what a `(x, z) => y` height function should return. */
  height = (x: number, z: number): number => this.sample(x, z, this.s).elevation

  /** Converts local (x, y, z) to a planet-centred position (identity on a flat world). */
  toWorld(x: number, y: number, z: number, out: Vec3 = [0, 0, 0]): Vec3 {
    if (this.world.options.surface !== 'sphere') { out[0] = x; out[1] = y; out[2] = z; return out }
    const o = this.origin, e = this.east, n = this.north, u = this.up
    out[0] = o[0] + e[0] * x + u[0] * y - n[0] * z
    out[1] = o[1] + e[1] * x + u[1] * y - n[1] * z
    out[2] = o[2] + e[2] * x + u[2] * y - n[2] * z
    return out
  }

  private p: Vec3 = [0, 0, 0]
  private s = createSample(8)

  // Distance from the tangent plane down to the sphere below a base point, and the radial→local-y factor.
  private drop(p: Vec3): number {
    const R = this.world.options.radius
    const len = Math.hypot(p[0], p[1], p[2])
    const u = this.up
    return R - (R * (p[0] * u[0] + p[1] * u[1] + p[2] * u[2])) / len
  }
  private cosine(p: Vec3): number {
    const u = this.up
    return (p[0] * u[0] + p[1] * u[1] + p[2] * u[2]) / Math.hypot(p[0], p[1], p[2])
  }
}

// fBm values cluster around 0 (σ ≈ 0.3); stretch them so climate fields use their whole range.
function spread(v: number): number {
  return clamp(v * 2.6, -1, 1)
}

function frac(frequency: number, octaves: number): FractalOptions {
  return { frequency, octaves, lacunarity: 2, gain: 0.5 }
}

/** Parses `#rrggbb` into linear-ish 0…1 RGB (sRGB values; three converts when you set `color.setRGB` with a colour space). */
export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace('#', ''), 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

// Options often come from GUIs, URLs or files: replace non-finite numbers with defaults and keep sizes,
// octave counts and the radius in ranges that can't divide by zero or hang a build.
function sanitize(o: WorldOptions): WorldOptions {
  const fix = (obj: Record<string, unknown>, defaults: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(obj)) {
      const d = defaults?.[k]
      if (typeof d === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) obj[k] = d
      else if (v && typeof v === 'object' && !Array.isArray(v) && d && typeof d === 'object') fix(v as Record<string, unknown>, d as Record<string, unknown>)
    }
  }
  fix(o as unknown as Record<string, unknown>, DEFAULT_WORLD as unknown as Record<string, unknown>)
  const positive = (v: number, min: number) => Math.max(min, v)
  const octaves = (v: number) => Math.min(16, Math.max(1, Math.round(v)))
  o.radius = positive(o.radius, 100)
  o.continents.scale = positive(o.continents.scale, 1); o.continents.octaves = octaves(o.continents.octaves)
  o.erosion.scale = positive(o.erosion.scale, 1); o.erosion.octaves = octaves(o.erosion.octaves)
  o.mountains.scale = positive(o.mountains.scale, 1); o.mountains.rangeScale = positive(o.mountains.rangeScale, 1); o.mountains.octaves = octaves(o.mountains.octaves)
  o.hills.scale = positive(o.hills.scale, 0.01); o.hills.octaves = octaves(o.hills.octaves)
  o.detail.scale = positive(o.detail.scale, 0.001); o.detail.octaves = octaves(o.detail.octaves)
  o.micro.scale = positive(o.micro.scale, 0.0001); o.micro.octaves = octaves(o.micro.octaves)
  o.rivers.scale = positive(o.rivers.scale, 1); o.rivers.width = positive(o.rivers.width, 1e-4); o.rivers.valleyWidth = positive(o.rivers.valleyWidth, o.rivers.width)
  o.climate.temperatureScale = positive(o.climate.temperatureScale, 1); o.climate.moistureScale = positive(o.climate.moistureScale, 1)
  o.volcanoes.regionSize = positive(o.volcanoes.regionSize, 1); o.volcanoes.radius = positive(o.volcanoes.radius, 0.01)
  o.rules.blend = positive(o.rules.blend, 0.01); o.rules.maxBiomes = Math.min(16, Math.max(1, Math.round(o.rules.maxBiomes)))
  if (!o.continents.curve?.length) o.continents.curve = structuredClone(DEFAULT_WORLD.continents.curve)
  if (!o.biomes?.length) o.biomes = structuredClone(DEFAULT_WORLD.biomes)
  return o
}

function merge<T>(target: T, input: unknown): T {
  if (!input || typeof input !== 'object') return target
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === undefined) continue
    const cur = (target as Record<string, unknown>)[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      ;(target as Record<string, unknown>)[k] = merge({ ...(cur as object) }, v)
    } else {
      ;(target as Record<string, unknown>)[k] = Array.isArray(v) ? structuredClone(v) : v
    }
  }
  return target
}
