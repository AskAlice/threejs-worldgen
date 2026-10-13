import { clamp, fbm, hash01, hash4, noise3, seedOf, smoothstep, createSample, type DeepPartial, type FractalOptions, type LocalFrame, type World } from 'threejs-biomes'
import { merge, resolve } from './util.ts'

/** What falls from the sky. `sleet` is the mixed band between {@link RainSettings.snowTemperature} and `rainTemperature`. */
export type PrecipitationType = 'none' | 'rain' | 'sleet' | 'snow'

/** Prevailing wind, its slow swings and its gusts. */
export interface WindSettings {
  /** Direction the prevailing wind blows towards, `[x, z]`; `null` uses the world's `climate.windDirection` (east on planets). */
  direction: [number, number] | null
  /** Mean wind speed, m/s (Beaufort 4 ≈ 6 m/s). */
  speed: number
  /** 0…1: how much the speed varies across space and time. */
  variability: number
  /** Largest slow swing of the direction, radians. */
  veer: number
  /** Typical time for the direction to swing, seconds. */
  veerPeriod: number
  /** 0…1: gust strength as a share of the local wind speed. */
  gustiness: number
  /** Typical size of a gust, metres. */
  gustScale: number
  /** Typical duration of a gust, seconds. */
  gustPeriod: number
}

/** Weather systems (fronts and cloud masses) drifting with the prevailing wind. */
export interface FrontSettings {
  /** Typical size of a weather system, metres. */
  scale: number
  /** Speed systems drift along the prevailing wind, m/s. */
  speed: number
  /** Time for a system to change shape, seconds. */
  evolution: number
  /** −1 (clear skies) … 1 (overcast): shifts overall cloudiness. */
  coverage: number
  /** 0…1: how strongly the world's moisture controls cloudiness (deserts clear, rainforests cloudy). */
  climate: number
  /** Octaves of the cloud noise. */
  octaves: number
}

/** Rain and snow from fronts. */
export interface RainSettings {
  /** Cloud cover (0…1) above which it starts to rain or snow. */
  threshold: number
  /** Precipitation under full cover, mm/h (water equivalent). */
  maxRate: number
  /** At or below this temperature (°C) everything falls as snow. */
  snowTemperature: number
  /** At or above this temperature (°C) everything falls as rain; between the two it is sleet. */
  rainTemperature: number
}

/** Convective storm cells: thunderstorms with heavy showers, outflow gusts and lightning. */
export interface StormSettings {
  /** Turn storms on or off. */
  enabled: boolean
  /** Distance between potential storm cells, metres. Storm radius is capped at a quarter of this. */
  spacing: number
  /** Mean storm radius, metres. */
  radius: number
  /** Life of one storm from first cloud to last rain, seconds. */
  lifetime: number
  /** 0…1: chance that a cell hosts a storm in each lifetime, before the climate factor. */
  chance: number
  /** Storms need at least this temperature (°C); full strength 12 °C above it. */
  minTemperature: number
  /** Extra rain at a mature storm's core, mm/h. */
  rain: number
  /** Outflow gust at a mature storm's core, m/s. */
  wind: number
  /** Lightning strikes per minute from a mature storm of full strength. */
  lightning: number
}

/** Ground fog and mist. */
export interface FogSettings {
  /** Humidity (0…1) above which fog forms. */
  humidity: number
  /** Wind speed (m/s) that clears fog completely. */
  maxWind: number
  /** Multiplier on the fog value. */
  density: number
}

/** How rain and snow accumulate on the ground (see {@link Weather.surfaceAt}). */
export interface SurfaceSettings {
  /** How far back the ground remembers weather, seconds. Older rain and snow are forgotten. */
  memory: number
  /** Weather samples taken over `memory` (more = smoother, slower). */
  samples: number
  /** e-folding time for surfaces to dry, seconds. */
  dryTime: number
  /** Standing water (mm) that makes a surface fully wet (~63 %). */
  wetDepth: number
  /** Snow water equivalent (mm) that fully covers the ground (~63 %). */
  coverDepth: number
  /** Melt per degree above freezing, mm water equivalent per °C per hour. */
  meltRate: number
}

/** Every weather setting. Plain JSON: save it, share it, send it to a worker, bind it to a GUI. */
export interface WeatherOptions {
  /** Seed: the same seed, world and time always give the same weather. */
  seed: number | string
  /** Added to every temperature, °C (drive seasons or a day/night cycle with it). */
  temperatureOffset: number
  /** Climate used when there is no world. */
  climate: {
    /** Temperature, °C. */
    temperature: number
    /** Moisture 0 (arid) … 1 (saturated). */
    moisture: number
  }
  /** Wind. */
  wind: WindSettings
  /** Fronts and clouds. */
  fronts: FrontSettings
  /** Rain and snow. */
  precipitation: RainSettings
  /** Thunderstorms and lightning. */
  storms: StormSettings
  /** Fog. */
  fog: FogSettings
  /** Accumulation on the ground. */
  surface: SurfaceSettings
}

/** Partial settings accepted by the {@link Weather} constructor, `set` and `reset`. */
export type WeatherInput = DeepPartial<WeatherOptions>

/** Default weather: temperate, changeable, with the odd summer thunderstorm. */
export const DEFAULT_WEATHER: WeatherOptions = {
  seed: 1,
  temperatureOffset: 0,
  climate: { temperature: 12, moisture: 0.5 },
  wind: { direction: null, speed: 6, variability: 0.5, veer: 0.6, veerPeriod: 6 * 3600, gustiness: 0.45, gustScale: 90, gustPeriod: 9 },
  fronts: { scale: 14_000, speed: 9, evolution: 5 * 3600, coverage: 0, climate: 0.8, octaves: 4 },
  precipitation: { threshold: 0.75, maxRate: 7, snowTemperature: 0, rainTemperature: 2.5 },
  storms: { enabled: true, spacing: 9000, radius: 1800, lifetime: 3600, chance: 0.3, minTemperature: 8, rain: 30, wind: 14, lightning: 6 },
  fog: { humidity: 0.86, maxWind: 5, density: 1 },
  surface: { memory: 24 * 3600, samples: 12, dryTime: 4 * 3600, wetDepth: 1.5, coverDepth: 4, meltRate: 0.25 },
}

/** The weather at one place and time. Reuse one object across calls (pass it as `out`). */
export interface WeatherSample {
  /** Cloud cover 0 (clear) … 1 (overcast). */
  cloudCover: number
  /** Precipitation rate, mm/h water equivalent. */
  precipitation: number
  /** Share of the precipitation that is snow, 0 (rain) … 1 (snow). */
  snowFraction: number
  /** What is falling. */
  type: PrecipitationType
  /** Air temperature at the ground, °C (world climate at this altitude, storms cool it). */
  temperature: number
  /** Relative humidity 0…1. */
  humidity: number
  /** Wind velocity towards +x, m/s (gusts included). */
  windX: number
  /** Wind velocity towards +z, m/s (gusts included). */
  windZ: number
  /** Wind speed, m/s (gusts included). */
  windSpeed: number
  /** The gust part of `windSpeed`, m/s. */
  gust: number
  /** Thunderstorm intensity 0…1 (convective cells). */
  storm: number
  /** Expected lightning strikes per minute per km². */
  lightning: number
  /** Fog 0 (clear) … 1 (thick). */
  fog: number
}

/** Creates an empty {@link WeatherSample}. */
export function createWeatherSample(): WeatherSample {
  return { cloudCover: 0, precipitation: 0, snowFraction: 0, type: 'none', temperature: 0, humidity: 0, windX: 0, windZ: 0, windSpeed: 0, gust: 0, storm: 0, lightning: 0, fog: 0 }
}

/** The static climate at a point, from the world. Cache it for points you query often (see {@link Weather.at}). */
export interface ClimatePoint {
  /** Temperature at this altitude, °C (before `temperatureOffset`). */
  temperature: number
  /** Moisture 0…1. */
  moisture: number
  /** Ground height, metres (local y). */
  elevation: number
  /** True over sea, lakes and rivers. */
  water: boolean
}

/** Rain and snow accumulated on the ground (see {@link Weather.surfaceAt}). */
export interface SurfaceSample {
  /** How wet surfaces are, 0…1. Feeds the `wetness` material state. */
  wetness: number
  /** Snow cover 0…1. Feeds the `snow` material state. */
  snow: number
  /** Snow pack, mm water equivalent (≈ ×10 for fresh snow depth in mm). */
  snowDepth: number
  /** Standing water, mm. */
  water: number
}

/** One lightning strike (see {@link Weather.strikes}). */
export interface Strike {
  /** Ground position x (frame coordinates), metres. */
  x: number
  /** Ground position z (frame coordinates), metres. */
  z: number
  /** Time of the strike, seconds. */
  time: number
  /** Strength 0…1 of the storm that made it. */
  intensity: number
  /** A stable 32-bit seed for this strike (bolt shape, ignition rolls, …). */
  seed: number
}

interface Storm {
  /** Centre in advected coordinates. */
  cx: number
  cz: number
  r: number
  strength: number
}

/** Lightning strikes are drawn per storm per time slot of this many seconds. */
const STRIKE_SLOT = 1

// Noise values cluster around 0; stretch them to use the full range.
const spread = (v: number) => clamp(v * 2.4, -1, 1)

/**
 * Seeded, time-driven weather over a world: weather systems that drift with the prevailing wind
 * (advected noise), cloud cover, rain/sleet/snow from the world's temperature at altitude, wind with
 * gusts and slow veering, humidity, fog, and thunderstorm cells with lightning. Climate-aware: deserts
 * rarely rain, rainforests often do, mountains get snow.
 *
 * Everything is a pure function of the seed, the world, the position and the time, so you can scrub
 * time backwards and forwards and always get the same weather. Positions are local frame coordinates
 * (`x` east, `z` south) of `frame` (the world itself on a flat world).
 *
 * @example
 * ```ts
 * const weather = new Weather({ seed: 'storm', wind: { speed: 9 } }, world)
 * const w = weather.at(120, -40, time)    // { precipitation, type, windX, windZ, fog, … }
 * weather.strikes(-5000, -5000, 5000, 5000, time - 1, time) // lightning in the last second
 * ```
 */
export class Weather {
  /** Resolved settings. Change them with {@link Weather.set} / {@link Weather.reset}. */
  options: WeatherOptions
  /** Bumped on every change; caches compare it. */
  version = 0
  /** The world whose climate drives the weather, or `null` (then `options.climate` is used everywhere). */
  readonly world: World | null
  /** The frame positions are given in. */
  readonly frame: LocalFrame | null

  private seed = 0
  private dirX = 1
  private dirZ = 0
  private frontX = 0
  private frontZ = 0
  private cloudFractal: FractalOptions = { frequency: 1, octaves: 1, lacunarity: 2, gain: 0.5 }
  private windFractal: FractalOptions = { frequency: 1, octaves: 2, lacunarity: 2, gain: 0.5 }
  private storms = new Map<number | string, Storm | null>()
  private readonly worldSample = createSample(8)
  private readonly climateScratch: ClimatePoint = { temperature: 0, moisture: 0, elevation: 0, water: false }
  private readonly stormClimate: ClimatePoint = { temperature: 0, moisture: 0, elevation: 0, water: false }
  private readonly historySample = createWeatherSample()
  private stormIntensity = 0
  private stormLightning = 0

  /**
   * Creates weather over `world` (or over a uniform `options.climate` without one).
   * @param input Settings; anything not given uses {@link DEFAULT_WEATHER}.
   * @param world Optional `threejs-biomes` world for climate (temperature at altitude, moisture, water).
   * @param frame Frame positions are given in; defaults to `world.frame`.
   */
  constructor(input: WeatherInput = {}, world: World | null = null, frame?: LocalFrame) {
    this.world = world
    this.frame = frame ?? world?.frame ?? null
    this.options = resolve(DEFAULT_WEATHER, input)
    this.prepare()
  }

  /** Merges `input` into the current settings (nested objects merge, arrays replace). */
  set(input: WeatherInput): this {
    this.options = merge(this.options, input)
    return this.changed()
  }

  /** Replaces all settings: anything not in `input` goes back to the defaults. */
  reset(input: WeatherInput = {}): this {
    const next = resolve(DEFAULT_WEATHER, input)
    if (JSON.stringify(next) === JSON.stringify(this.options)) return this
    this.options = next
    return this.changed()
  }

  private changed(): this {
    this.prepare()
    this.version++
    return this
  }

  private prepare() {
    const o = this.options
    this.seed = seedOf(o.seed) ^ 0x3c6ef372
    const d = o.wind.direction ?? (this.world && this.world.options.surface === 'plane' ? this.world.options.climate.windDirection : [1, 0])
    const len = Math.hypot(d[0], d[1]) || 1
    this.dirX = d[0] / len
    this.dirZ = d[1] / len
    this.frontX = this.dirX * o.fronts.speed
    this.frontZ = this.dirZ * o.fronts.speed
    this.cloudFractal = { frequency: 1 / o.fronts.scale, octaves: Math.max(1, Math.round(o.fronts.octaves)), lacunarity: 2, gain: 0.5 }
    this.windFractal = { frequency: 2 / o.fronts.scale, octaves: 2, lacunarity: 2, gain: 0.5 }
    this.storms.clear()
  }

  /** Unit vector the prevailing wind blows towards, `[x, z]`. */
  get prevailing(): [number, number] {
    return [this.dirX, this.dirZ]
  }

  /** Static climate at local (x, z): from the world, or `options.climate` without one. */
  climateAt(x: number, z: number, out: ClimatePoint = { temperature: 0, moisture: 0, elevation: 0, water: false }): ClimatePoint {
    if (!this.frame) {
      out.temperature = this.options.climate.temperature
      out.moisture = this.options.climate.moisture
      out.elevation = 0
      out.water = false
      return out
    }
    const s = this.frame.sample(x, z, this.worldSample)
    out.temperature = s.temperature
    out.moisture = s.moisture
    out.elevation = s.elevation
    out.water = s.waterLevel > s.elevation
    return out
  }

  /**
   * The weather at local (x, z) at `time` seconds.
   * @param climate Pass a cached {@link ClimatePoint} for this position to skip sampling the world
   *   (the climate never changes with time, so per-texel or per-instance caches are exact).
   */
  at(x: number, z: number, time: number, out: WeatherSample = createWeatherSample(), climate?: ClimatePoint): WeatherSample {
    const o = this.options
    const c = climate ?? this.climateAt(x, z, this.climateScratch)
    const seed = this.seed
    // Weather systems drift with the prevailing wind: sample the noise in advected coordinates.
    const ax = x - this.frontX * time
    const az = z - this.frontZ * time
    const evolve = time / o.fronts.evolution

    // Clouds: advected fBm, shifted by coverage and the local climate. With the default threshold this
    // rains ~0 / 3 / 10 / 30 / 44 % of hours at moisture 0.04 / 0.3 / 0.5 / 0.78 / 0.93 (desert → rainforest).
    const n = fbm(seed + 10, ax, evolve * o.fronts.scale, az, this.cloudFractal)
    const raw = 0.5 + 0.5 * spread(n) + o.fronts.coverage * 0.5 + o.fronts.climate * (c.moisture - 0.45) * 0.6
    let cloud = smoothstep(0.15, 1.0, raw)

    // Thunderstorms.
    this.evaluateStorms(ax, az, time)
    const storm = this.stormIntensity
    cloud = Math.max(cloud, smoothstep(0, 0.35, storm))

    // Precipitation and its type.
    const p = o.precipitation
    const frontal = p.maxRate * Math.pow(smoothstep(p.threshold, 1, cloud), 1.5) * (0.35 + 0.65 * c.moisture)
    const precipitation = frontal + o.storms.rain * storm * storm
    const temperature = c.temperature + o.temperatureOffset - 4 * storm
    const snowFraction = smoothstep(p.rainTemperature, p.snowTemperature, temperature)

    // Wind: prevailing direction with slow veering, speed varying with the systems, gusts riding the wind.
    const w = o.wind
    const veer = w.veer * (spread(noise3(seed + 20, time / w.veerPeriod, 0.37, 0.71)) + 0.3 * spread(fbm(seed + 21, ax, evolve * o.fronts.scale * 0.5, az, this.windFractal)))
    const base = w.speed * Math.max(0.05, 1 + w.variability * spread(fbm(seed + 22, ax + 913.7, evolve * o.fronts.scale, az - 377.1, this.windFractal))) * (0.75 + 0.5 * cloud)
    const gx = x - this.dirX * w.speed * time
    const gz = z - this.dirZ * w.speed * time
    const gustNoise = Math.max(0, spread(noise3(seed + 23, gx / w.gustScale, time / w.gustPeriod, gz / w.gustScale)))
    const gust = w.gustiness * base * 1.6 * gustNoise + o.storms.wind * storm * (0.6 + 0.4 * gustNoise)
    const speed = base + gust
    const cos = Math.cos(veer), sin = Math.sin(veer)

    // Humidity and fog.
    const humidity = clamp(0.2 + 0.55 * c.moisture + 0.3 * cloud + 0.25 * Math.min(1, precipitation / 3) + (c.water ? 0.08 : 0) - 0.008 * Math.max(0, temperature - 25), 0, 1)
    const fog = clamp(smoothstep(o.fog.humidity, 1, humidity) * (1 - smoothstep(o.fog.maxWind * 0.4, o.fog.maxWind, speed)) * o.fog.density, 0, 1)

    out.cloudCover = cloud
    out.precipitation = precipitation
    out.snowFraction = snowFraction
    out.type = precipitation < 0.05 ? 'none' : snowFraction > 0.85 ? 'snow' : snowFraction < 0.15 ? 'rain' : 'sleet'
    out.temperature = temperature
    out.humidity = humidity
    out.windX = (this.dirX * cos - this.dirZ * sin) * speed
    out.windZ = (this.dirX * sin + this.dirZ * cos) * speed
    out.windSpeed = speed
    out.gust = gust
    out.storm = storm
    out.lightning = this.stormLightning
    out.fog = fog
    return out
  }

  /**
   * Rain and snow accumulated on the ground at local (x, z) by `time`: the last `surface.memory`
   * seconds of weather integrated with drying and melting. Still a pure function of time (it re-samples
   * the history), so scrubbing works. Costs `surface.samples` × {@link Weather.at}.
   */
  surfaceAt(x: number, z: number, time: number, out: SurfaceSample = { wetness: 0, snow: 0, snowDepth: 0, water: 0 }, climate?: ClimatePoint): SurfaceSample {
    const s = this.options.surface
    const c = climate ?? this.climateAt(x, z, { temperature: 0, moisture: 0, elevation: 0, water: false })
    const n = Math.max(1, Math.round(s.samples))
    const dt = s.memory / n
    const dry = Math.exp(-dt / s.dryTime)
    let water = 0, snow = 0
    const w = this.historySample
    for (let k = n - 1; k >= 0; k--) {
      this.at(x, z, time - dt * (k + 0.5), w, c)
      const hours = dt / 3600
      const melt = Math.min(snow, Math.max(0, w.temperature) * s.meltRate * hours)
      snow += w.precipitation * w.snowFraction * hours - melt
      water = water * dry + w.precipitation * (1 - w.snowFraction) * hours + melt
    }
    out.water = water
    out.snowDepth = snow
    out.wetness = 1 - Math.exp(-water / s.wetDepth)
    out.snow = 1 - Math.exp(-snow / s.coverDepth)
    return out
  }

  /**
   * Every lightning strike inside the box `[minX, maxX] × [minZ, maxZ]` (frame coordinates) with
   * `t0 <= time < t1`, sorted by time. Deterministic: the same window always gives the same strikes,
   * and splitting a window into pieces gives the same strikes as asking for it whole.
   */
  strikes(minX: number, minZ: number, maxX: number, maxZ: number, t0: number, t1: number, out: Strike[] = []): Strike[] {
    const cv = this.options.storms
    if (!cv.enabled || cv.lightning <= 0 || cv.chance <= 0 || !(t1 > t0)) return out
    const S = cv.spacing, T = cv.lifetime
    const fx = this.frontX, fz = this.frontZ
    const pad = S * 0.5
    const first = out.length
    for (let c0 = Math.floor(t0 / T) * T; c0 < t1; c0 += T) {
      const a = Math.max(t0, c0), b = Math.min(t1, c0 + T)
      // The query box in advected coordinates over [a, b].
      const i0 = Math.floor((Math.min(minX - fx * a, minX - fx * b) - pad) / S)
      const i1 = Math.floor((Math.max(maxX - fx * a, maxX - fx * b) + pad) / S)
      const j0 = Math.floor((Math.min(minZ - fz * a, minZ - fz * b) - pad) / S)
      const j1 = Math.floor((Math.max(maxZ - fz * a, maxZ - fz * b) + pad) / S)
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const phase = this.phase(i, j)
        for (let e = Math.floor((a + phase) / T); e <= Math.floor((b + phase) / T); e++) {
          const s = this.storm(i, j, e, phase)
          if (!s) continue
          const lifeStart = e * T - phase
          const lo = Math.max(a, lifeStart), hi = Math.min(b, lifeStart + T)
          for (let k = Math.floor(lo / STRIKE_SLOT); k * STRIKE_SLOT < hi; k++) {
            const time = (k + hash01(i, j, k, this.seed + 85)) * STRIKE_SLOT
            if (time < lo || time >= hi) continue
            const life = Math.sin(Math.PI * ((time - lifeStart) / T)) ** 2
            const rate = cv.lightning * s.strength * life // strikes per minute
            if (hash01(i, j, k, this.seed + 81) >= (rate / 60) * STRIKE_SLOT) continue
            const sigma = s.r * 0.5
            const rr = sigma * Math.sqrt(-2 * Math.log(Math.max(1e-9, hash01(i, j, k, this.seed + 82))))
            const ang = 2 * Math.PI * hash01(i, j, k, this.seed + 83)
            const x = s.cx + fx * time + Math.cos(ang) * rr
            const z = s.cz + fz * time + Math.sin(ang) * rr
            if (x < minX || x > maxX || z < minZ || z > maxZ) continue
            out.push({ x, z, time, intensity: s.strength * life, seed: hash4(i, j, k, this.seed + 84) })
          }
        }
      }
    }
    const added = out.splice(first).sort((p, q) => p.time - q.time || p.seed - q.seed)
    out.push(...added)
    return out
  }

  private phase(i: number, j: number): number {
    return hash01(i, j, 7, this.seed + 71) * this.options.storms.lifetime
  }

  /** The storm of cell (i, j) in its `e`-th lifetime, or null. Climate is taken at its mid-life position. */
  private storm(i: number, j: number, e: number, phase: number): Storm | null {
    // Packed numeric key (fast); strings only far outside the packable range.
    const key = Math.abs(i) < 32768 && Math.abs(j) < 32768 && e >= 0 && e < 2097152 ? ((i + 32768) * 65536 + (j + 32768)) * 2097152 + e : `${i},${j},${e}`
    const cached = this.storms.get(key)
    if (cached !== undefined) return cached
    const cv = this.options.storms
    const S = cv.spacing, T = cv.lifetime
    let storm: Storm | null = null
    const roll = hash01(i, j, e, this.seed + 72)
    if (roll < cv.chance) {
      const cx = (i + 0.2 + 0.6 * hash01(i, j, e, this.seed + 73)) * S
      const cz = (j + 0.2 + 0.6 * hash01(i, j, e, this.seed + 74)) * S
      const mid = (e + 0.5) * T - phase
      const c = this.climateAt(cx + this.frontX * mid, cz + this.frontZ * mid, this.stormClimate)
      const factor = smoothstep(cv.minTemperature, cv.minTemperature + 12, c.temperature + this.options.temperatureOffset) * smoothstep(0.15, 0.65, c.moisture) * (c.water ? 0.6 : 1)
      if (roll < cv.chance * factor) {
        storm = {
          cx, cz,
          r: Math.min(S * 0.25, cv.radius * (0.6 + 0.8 * hash01(i, j, e, this.seed + 75))),
          strength: 0.5 + 0.5 * hash01(i, j, e, this.seed + 76),
        }
      }
    }
    if (this.storms.size > 50_000) this.storms.clear() // pure function of the key, so dropping the cache is safe
    this.storms.set(key, storm)
    return storm
  }

  private evaluateStorms(ax: number, az: number, time: number) {
    this.stormIntensity = 0
    this.stormLightning = 0
    const cv = this.options.storms
    if (!cv.enabled || cv.chance <= 0) return
    const S = cv.spacing, T = cv.lifetime
    const ci = Math.floor(ax / S), cj = Math.floor(az / S)
    for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++) {
      const phase = this.phase(i, j)
      const e = Math.floor((time + phase) / T)
      const s = this.storm(i, j, e, phase)
      if (!s) continue
      const dx = ax - s.cx, dz = az - s.cz
      const d2 = dx * dx + dz * dz
      const r2 = s.r * s.r
      if (d2 > 9 * r2) continue
      const life = Math.sin(Math.PI * ((time + phase) / T - e)) ** 2
      const a = s.strength * life
      this.stormIntensity = Math.max(this.stormIntensity, a * Math.exp(-d2 / r2))
      // Strike density of a Gaussian with σ = r / 2 (matches `strikes`), per km².
      const sigma2 = r2 * 0.25
      this.stormLightning += ((cv.lightning * a * Math.exp(-d2 / (2 * sigma2))) / (2 * Math.PI * sigma2)) * 1e6
    }
  }
}
