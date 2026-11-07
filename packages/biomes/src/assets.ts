import type { Object3D } from 'three/webgpu'
import { createSample, type LocalFrame, type World, type WorldSample } from './world.ts'

/** One editable parameter of an asset, as JSON (GUIs are generated from these). */
export type AssetParam =
  | { type: 'number'; default: number; min: number; max: number; step?: number }
  | { type: 'boolean'; default: boolean }
  | { type: 'choice'; default: string; options: string[] }
  | { type: 'color'; default: string }

/** Where an asset can plausibly go. Every field is optional; unset fields don't constrain. */
export interface PlacementRule {
  /** What it stands on or in. */
  surface: 'ground' | 'water' | 'underwater' | 'air' | 'shore'
  /** Biome ids it belongs to (empty = any). Matched against the strongest biomes at the spot. */
  biomes?: string[]
  /** Minimum share of the matching biomes at the spot (0…1). */
  minBiomeWeight?: number
  /** Ground slope range (rise/run). */
  slope?: [min: number, max: number]
  /** Height above sea level range, metres (ground/shore) or flight height above ground (air). */
  height?: [min: number, max: number]
  /** Water depth range, metres (water/underwater). */
  depth?: [min: number, max: number]
  /** Temperature range, °C. */
  temperature?: [min: number, max: number]
  /** Must be within this many metres of water (river or sea). */
  nearWater?: number
}

/** A registered asset: metadata, parameters, placement rule and a generator. */
export interface AssetDef {
  /** Unique id, `package/name` (e.g. `trees/oak`). */
  id: string
  /** Display name. */
  name: string
  /** Package that provides it (e.g. `threejs-trees`). */
  package: string
  /** Category (`tree`, `shrub`, `plant`, `rock`, `fish`, `building`, `road`, `prop`, `vehicle`, …). */
  category: string
  /** Search tags. */
  tags: string[]
  /** Other names it goes by (`sequoia`, `big tree`), searched like tags. */
  aliases?: string[]
  /** Editable parameters with defaults. */
  params: Record<string, AssetParam>
  /** Where it plausibly goes. */
  placement: PlacementRule
  /** Builds one instance. `seed` drives per-instance variety; params come from `params` defaults merged with overrides. */
  create: (params: Record<string, unknown>, seed: number) => Object3D | Promise<Object3D>
  /** Optional thumbnail (URL or data URL) for the gallery. */
  thumbnail?: string
}

const scratch: WorldSample = createSample()

/**
 * Whether local position (x, z) of `frame` suits a placement rule. `sample` may be passed in when you
 * already have it. Slope is measured with four extra height samples `step` metres apart.
 */
export function isPlausible(
  world: World,
  frame: LocalFrame,
  x: number,
  z: number,
  rule: PlacementRule,
  step = 1,
  sample = frame.sample(x, z, scratch)
): boolean {
  const sea = world.options.seaLevel
  const ground = sample.elevation
  const water = sample.waterLevel
  const wet = !Number.isNaN(water) && water > ground
  const depth = wet ? water - ground : 0
  switch (rule.surface) {
    case 'ground':
      if (wet) return false
      break
    case 'water':
    case 'underwater':
      if (!wet) return false
      break
    case 'shore':
      if (wet || ground - sea > 3) return false
      break
    case 'air':
      break
  }
  if (rule.depth && (depth < rule.depth[0] || depth > rule.depth[1])) return false
  if (rule.height && rule.surface !== 'air' && (ground - sea < rule.height[0] || ground - sea > rule.height[1]))
    return false
  if (rule.temperature && (sample.temperature < rule.temperature[0] || sample.temperature > rule.temperature[1]))
    return false
  if (rule.biomes?.length) {
    let share = 0
    for (let i = 0; i < sample.count; i++)
      if (rule.biomes.includes(world.options.biomes[sample.biomes[i]].id)) share += sample.weights[i]
    if (share < (rule.minBiomeWeight ?? 0.35)) return false
  }
  if (rule.slope) {
    const hx = frame.height(x + step, z) - frame.height(x - step, z)
    const hz = frame.height(x, z + step) - frame.height(x, z - step)
    const slope = Math.hypot(hx, hz) / (2 * step)
    if (slope < rule.slope[0] || slope > rule.slope[1]) return false
  }
  if (rule.nearWater !== undefined && !wet) {
    let near = sample.river > 0.01
    for (let k = 0; k < 8 && !near; k++) {
      const a = (k / 8) * Math.PI * 2
      const s = frame.sample(x + Math.cos(a) * rule.nearWater, z + Math.sin(a) * rule.nearWater)
      near = !Number.isNaN(s.waterLevel) && s.waterLevel > s.elevation
    }
    if (!near) return false
  }
  return true
}
