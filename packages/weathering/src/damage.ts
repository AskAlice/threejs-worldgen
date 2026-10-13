import { hash01, seedOf } from 'threejs-biomes'
import type { InstanceStates } from './instance-states.ts'
import type { StateField } from './state-field.ts'
import type { StateChannel } from './states.ts'
import { createWeatherSample, type ClimatePoint, type Weather } from './weather.ts'
import { merge, resolve } from './util.ts'

/** What damage is written into: a state field, per-instance states (with their positions), or both. */
export interface DamageTarget {
  /** World-space state field. */
  field?: StateField | null
  /** Per-instance states. Needs `positions`. */
  instances?: InstanceStates | null
  /** Instance positions in frame coordinates (x at 0, z at 2 of each `stride` floats). */
  positions?: ArrayLike<number>
  /** Floats per instance in `positions`. Default 3. */
  stride?: number
}

/**
 * Damages everything within `radius` metres of (x, z): impacts, explosions, falling trees, a burning
 * building (`channel: 'burn'`). Adds `amount` at the centre, fading to 0 over the outer `falloff`
 * share of the radius, clamped to 0…1. Returns the number of instances hit.
 */
export function applyDamage(target: DamageTarget, x: number, z: number, radius: number, amount: number, channel: StateChannel = 'damage', falloff = 0.5): number {
  target.field?.paint(x, z, radius, { [channel]: amount }, 'add', falloff)
  const { instances, positions, stride = 3 } = target
  if (!instances || !positions) return 0
  const inner = radius * (1 - Math.min(1, Math.max(0, falloff)))
  let hit = 0
  for (let i = 0; i < instances.count; i++) {
    const d = Math.hypot(positions[i * stride] - x, positions[i * stride + 2] - z)
    if (d > radius) continue
    const w = d <= inner ? 1 : 1 - (d - inner) / Math.max(1e-6, radius - inner)
    if (w <= 0) continue
    instances.add(i, channel, amount * w)
    hit++
  }
  return hit
}

/** Storm damage settings. Plain JSON. */
export interface StormDamageOptions {
  /** Seed for per-instance susceptibility. */
  seed: number | string
  /** Wind speed (gusts included) where damage starts, m/s (gale ≈ 20). */
  threshold: number
  /** Wind speed of full damage rate, m/s (hurricane ≈ 45). */
  full: number
  /** Damage per hour at `full` wind. */
  rate: number
  /** Seconds between damage ticks. */
  interval: number
  /** 0…1: spread of per-instance susceptibility (some trees snap, others don't). */
  susceptibility: number
  /** Texels per side of the blocks the field is evaluated in (weather is coarse; this keeps ticks cheap). */
  fieldBlock: number
  /** Most ticks processed per `update` (a long jump forward skips the rest). */
  maxTicks: number
}

/** Default storm damage: starts at gale force, heavy in hurricanes. */
export const DEFAULT_STORM_DAMAGE: StormDamageOptions = { seed: 1, threshold: 20, full: 45, rate: 0.6, interval: 10, susceptibility: 0.6, fieldBlock: 4, maxTicks: 720 }

/**
 * Accumulates wind damage from a {@link Weather} into a {@link DamageTarget}: every `interval` seconds,
 * wherever the wind (with gusts) is above `threshold`, damage grows with the excess. Deterministic per
 * tick: ticks sit at fixed times, so the same weather and time range give the same damage. Damage is
 * never undone when time goes backwards.
 */
export class StormDamage {
  /** Resolved settings. */
  options: StormDamageOptions
  /** The weather read for wind. */
  weather: Weather
  /** Where damage goes. */
  target: DamageTarget
  private lastTick: number | null = null
  private climate: ClimatePoint[] = []
  private climateKey = ''
  private fieldClimate: ClimatePoint[] = []
  private fieldKey = ''
  private readonly sample = createWeatherSample()

  /** Creates storm damage for `target`; anything not given uses {@link DEFAULT_STORM_DAMAGE}. */
  constructor(weather: Weather, target: DamageTarget, input: Partial<StormDamageOptions> = {}) {
    this.weather = weather
    this.target = target
    this.options = resolve(DEFAULT_STORM_DAMAGE, input)
  }

  /** Merges `input` into the settings. */
  set(input: Partial<StormDamageOptions>): this {
    this.options = merge(this.options, input)
    return this
  }

  /** Replaces all settings (anything not given goes back to defaults). */
  reset(input: Partial<StormDamageOptions> = {}): this {
    this.options = resolve(DEFAULT_STORM_DAMAGE, input)
    return this
  }

  /** Processes every damage tick up to `time` seconds. The first call only sets the starting time. */
  update(time: number): void {
    const o = this.options
    const end = Math.floor(time / o.interval)
    if (this.lastTick === null || end < this.lastTick) {
      this.lastTick = end
      return
    }
    // ponytail: ticks beyond maxTicks are skipped on huge jumps; fine for storms that last hours.
    const first = Math.max(this.lastTick + 1, end - o.maxTicks + 1)
    for (let k = first; k <= end; k++) this.tick(k * o.interval)
    this.lastTick = end
  }

  private damageAt(x: number, z: number, time: number, climate: ClimatePoint): number {
    const o = this.options
    const w = this.weather.at(x, z, time, this.sample, climate)
    if (w.windSpeed <= o.threshold) return 0
    const excess = Math.min(1, (w.windSpeed - o.threshold) / Math.max(1e-6, o.full - o.threshold))
    return o.rate * excess * excess * (o.interval / 3600)
  }

  private tick(time: number) {
    const o = this.options
    const seed = seedOf(o.seed)
    const { field, instances, positions, stride = 3 } = this.target
    const world = this.weather.world?.version ?? 0
    const key = `${world}|${positions?.length ?? 0}`
    if (instances && positions) {
      if (this.climateKey !== key) {
        this.climateKey = key
        this.climate = []
      }
      for (let i = 0; i < instances.count; i++) {
        const x = positions[i * stride], z = positions[i * stride + 2]
        const c = (this.climate[i] ??= this.weather.climateAt(x, z))
        const d = this.damageAt(x, z, time, c)
        if (d > 0) instances.add(i, 'damage', d * (1 - o.susceptibility * hash01(i, 0, 0, seed)))
      }
    }
    if (field) {
      const n = field.options.resolution, b = Math.max(1, Math.round(o.fieldBlock)), t = field.texel
      const fieldKey = `${world}|${JSON.stringify(field.options)}|${b}`
      if (this.fieldKey !== fieldKey) {
        this.fieldKey = fieldKey
        this.fieldClimate = []
      }
      let block = 0
      for (let bj = 0; bj < n; bj += b) for (let bi = 0; bi < n; bi += b, block++) {
        const x = field.minX + (bi + b / 2) * t, z = field.minZ + (bj + b / 2) * t
        const d = this.damageAt(x, z, time, (this.fieldClimate[block] ??= this.weather.climateAt(x, z)))
        if (d <= 0) continue
        for (let j = bj; j < Math.min(n, bj + b); j++) for (let i = bi; i < Math.min(n, bi + b); i++) {
          const k = (j * n + i) * 4 + 3
          field.data[k] = Math.min(1, field.data[k] + d * (1 - o.susceptibility * hash01(i, j, 1, seed)))
        }
      }
      field.touch()
    }
  }
}
