import type { Object3D } from 'three/webgpu'
import { PROP_KIND_IDS, PROP_KINDS, type PropKind, type PropPlacement } from './catalog.ts'
import { FARM_BIOMES, FENCE_STYLES, WELL_BIOMES, type FenceStyle } from './placement.ts'
import { Props } from './props.ts'
import { ROAD_SURFACE_KINDS, RoadPath, type RoadSurfaceKind } from './roads.ts'

// These mirror threejs-worldgen's `AssetParam`, `PlacementRule` and `AssetDef` structurally (worldgen
// depends on this package, so importing them would be circular). `PropAssetDef` is assignable to
// `AssetDef`; worldgen's `isPlausible` checks the base rule and ignores `context`.

/** One editable parameter of an asset (as threejs-worldgen's `AssetParam`). */
export type PropAssetParam =
  | { type: 'number'; default: number; min: number; max: number; step?: number }
  | { type: 'boolean'; default: boolean }
  | { type: 'choice'; default: string; options: string[] }
  | { type: 'color'; default: string }

/** What a prop stands next to. Decorators (`decorateRoads`) honour it; generic spawners may ignore it. */
export type PropContext = 'urban-sidewalk' | 'rural-road' | 'rural-lot' | 'junction' | 'field' | 'settlement-link' | 'road'

/** threejs-worldgen's `PlacementRule` plus the man-made context a prop needs. */
export interface PropPlacementRule {
  /** What it stands on. */ surface: 'ground' | 'water' | 'underwater' | 'air' | 'shore'
  /** Biome ids it belongs to (empty = any). */ biomes?: string[]
  /** Minimum share of the matching biomes at the spot. */ minBiomeWeight?: number
  /** Ground slope range (rise/run). */ slope?: [min: number, max: number]
  /** Height above sea level range, metres. */ height?: [min: number, max: number]
  /** Water depth range, metres. */ depth?: [min: number, max: number]
  /** Temperature range, °C. */ temperature?: [min: number, max: number]
  /** Within this many metres of water. */ nearWater?: number
  /** Must be within `maxDistance` metres of this (roads, lots, junctions, fields, settlement links). */
  context?: { near: PropContext; maxDistance: number }
}

/** An asset definition, assignable to threejs-worldgen's `AssetDef`. */
export interface PropAssetDef {
  /** `props/<name>`. */ id: string
  /** Display name. */ name: string
  /** `threejs-props`. */ package: string
  /** `prop` or `road`. */ category: string
  /** Search tags. */ tags: string[]
  /** Editable parameters. */ params: Record<string, PropAssetParam>
  /** Where it plausibly goes. */ placement: PropPlacementRule
  /** Builds one instance at the origin. */ create: (params: Record<string, unknown>, seed: number) => Object3D | Promise<Object3D>
}

const SETTLED = ['grassland', 'deciduousForest', 'temperateRainforest', 'taiga', 'tundra', 'alpineMeadow', 'desert', 'badlands', 'savanna', 'jungle', 'dryForest', 'mediterranean', 'steppe', 'wetland', 'coast', 'mangrove', 'volcanic']

const RULES: Record<PropKind, PropPlacementRule> = {
  'mailbox-us': { surface: 'ground', slope: [0, 0.35], context: { near: 'rural-lot', maxDistance: 15 } },
  'mailbox-eu': { surface: 'ground', slope: [0, 0.35], context: { near: 'rural-lot', maxDistance: 15 } },
  'power-pole': { surface: 'ground', biomes: SETTLED, minBiomeWeight: 0.2, slope: [0, 0.6], context: { near: 'rural-road', maxDistance: 12 } },
  pylon: { surface: 'ground', slope: [0, 0.5], temperature: [-25, 45], context: { near: 'settlement-link', maxDistance: 60 } },
  'street-light': { surface: 'ground', slope: [0, 0.2], context: { near: 'urban-sidewalk', maxDistance: 3 } },
  fence: { surface: 'ground', slope: [0, 0.35], context: { near: 'rural-lot', maxDistance: 30 } },
  sign: { surface: 'ground', slope: [0, 0.3], context: { near: 'road', maxDistance: 5 } },
  bench: { surface: 'ground', slope: [0, 0.1], context: { near: 'urban-sidewalk', maxDistance: 4 } },
  bin: { surface: 'ground', slope: [0, 0.15], context: { near: 'urban-sidewalk', maxDistance: 4 } },
  hydrant: { surface: 'ground', slope: [0, 0.2], context: { near: 'urban-sidewalk', maxDistance: 3 } },
  'traffic-light': { surface: 'ground', slope: [0, 0.15], context: { near: 'junction', maxDistance: 15 } },
  'bus-stop': { surface: 'ground', slope: [0, 0.1], context: { near: 'urban-sidewalk', maxDistance: 4 } },
  'hay-bale': { surface: 'ground', biomes: FARM_BIOMES, slope: [0, 0.15], temperature: [-5, 32], context: { near: 'field', maxDistance: 80 } },
  well: { surface: 'ground', biomes: WELL_BIOMES, slope: [0, 0.2], temperature: [0, 40], context: { near: 'rural-lot', maxDistance: 40 } },
}

/** The biomes a fence style belongs to (from {@link FENCE_STYLES}). */
export function fenceBiomes(style: FenceStyle): string[] {
  return Object.entries(FENCE_STYLES).filter(([, s]) => s.includes(style)).map(([b]) => b)
}

const one = (kind: PropKind, params: Record<string, unknown>, seed: number, extra: Partial<PropPlacement> = {}): Object3D =>
  new Props({ placements: [{ kind, x: 0, y: 0, z: 0, yaw: 0, seed, variant: params.variant as string | undefined, ...extra }] }).object

/**
 * Asset definitions of every prop for threejs-worldgen's `AssetRegistry` (gallery, search and
 * plausible spawning): one per kind with its variants as a choice, plus a biome-matched def per fence
 * style, power lines (three poles or two pylons with cables) and road surface samples.
 *
 * @example
 * ```ts
 * registry.register(...propAssets())
 * registry.search('adobe wall')       // props/fence-adobe, matched to desert and badlands
 * ```
 */
export function propAssets(): PropAssetDef[] {
  const defs: PropAssetDef[] = PROP_KIND_IDS.map((kind) => {
    const info = PROP_KINDS[kind]
    return {
      id: `props/${kind}`, name: info.name, package: 'threejs-props', category: 'prop', tags: [...info.tags],
      params: { variant: { type: 'choice', default: info.variants[0], options: [...info.variants] } },
      placement: RULES[kind],
      create: (params, seed) => one(kind, params, seed, kind === 'fence' ? { length: Number(params.length ?? 2.5) } : {}),
    }
  })
  for (const style of ['picket', 'rail', 'adobe', 'stone'] as const) {
    defs.push({
      id: `props/fence-${style}`, name: `${style[0].toUpperCase()}${style.slice(1)} fence`, package: 'threejs-props', category: 'prop',
      tags: ['fence', 'wall', style, ...(style === 'adobe' || style === 'stone' ? [`${style} wall`] : ['wooden'])],
      params: { length: { type: 'number', default: 2.5, min: 0.5, max: 6, step: 0.1 } },
      placement: { ...RULES.fence, biomes: fenceBiomes(style), minBiomeWeight: 0.3 },
      create: (params, seed) => one('fence', { variant: style }, seed, { length: Number(params.length ?? 2.5) }),
    })
  }
  for (const kind of ['power-pole', 'pylon'] as const) {
    defs.push({
      id: `props/power-line-${kind === 'pylon' ? 'pylons' : 'poles'}`, name: kind === 'pylon' ? 'High-voltage line' : 'Power line',
      package: 'threejs-props', category: 'prop', tags: ['power line', 'cable', 'wire', 'electricity', kind],
      params: { span: { type: 'number', default: kind === 'pylon' ? 120 : 40, min: 10, max: 400, step: 1 }, sag: { type: 'number', default: 0.025, min: 0, max: 0.1, step: 0.001 } },
      placement: kind === 'pylon' ? RULES.pylon : RULES['power-pole'],
      create: (params, seed) => {
        const span = Number(params.span ?? 40), n = kind === 'pylon' ? 2 : 3
        const placements = Array.from({ length: n }, (_, i): PropPlacement => ({ kind, x: 0, y: 0, z: (i - (n - 1) / 2) * span, yaw: 0, seed: seed + i, line: 1 }))
        return new Props({ placements, cables: { sag: Number(params.sag ?? 0.025) } }).object
      },
    })
  }
  for (const surface of ROAD_SURFACE_KINDS) {
    defs.push({
      id: `props/road-${surface}`, name: `${surface[0].toUpperCase()}${surface.slice(1)} road`, package: 'threejs-props', category: 'road',
      tags: ['road', 'street', 'path', surface, ...(surface === 'asphalt' ? ['sidewalk', 'markings'] : ['track', 'rural'])],
      params: { width: { type: 'number', default: surface === 'dirt' ? 4 : 7, min: 2, max: 20, step: 0.5 }, sidewalk: { type: 'number', default: surface === 'asphalt' ? 2 : 0, min: 0, max: 5, step: 0.5 } },
      placement: { surface: 'ground', slope: [0, 0.25] },
      create: (params) => roadSample(surface, Number(params.width ?? 7), Number(params.sidewalk ?? 0)),
    })
  }
  return defs
}

function roadSample(surface: RoadSurfaceKind, width: number, sidewalk: number): Object3D {
  return new RoadPath({ points: [[0, -10], [0, 10]], width, sidewalk, step: 2, surface: { surface, centreLine: surface === 'asphalt' ? 'dashed' : 'none' } }).object
}
