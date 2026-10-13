import type { DeepPartial } from 'threejs-biomes'
import { ARCHITECTURES, type ArchitectureName, type Architecture, type Climate, type RoofMaterial, type WallMaterial } from './architecture.ts'
import { DEFAULT_BLOCKS, type BlockOptions } from './blocks.ts'
import { DEFAULT_BUILDINGS, type BuildingOptions } from './buildings.ts'
import { DEFAULT_DISTRICTS, type DistrictOptions } from './districts.ts'
import { DEFAULT_ROADSIDE, type RoadsideOptions } from './lots.ts'
import { DEFAULT_SIZE_CLASSES, type RoadStyle, type SettlementSize, type SizeClass } from './placement.ts'
import { DEFAULT_ROADS, type RoadOptions } from './roads.ts'
import { DEFAULT_TENSOR_FIELD, type TensorFieldOptions } from './tensor-field.ts'
import { DEFAULT_TERRAIN, type TerrainOptions } from './terrain.ts'
import type { BuildingStyle } from './buildings.ts'
import type { RoadSurface } from './graph.ts'

/** Window grid of one building style (metres). */
export interface WindowStyle {
  /** Width of one window bay (window plus wall between windows). */
  bayWidth: number
  /** Window width. */
  windowWidth: number
  /** Window height. */
  windowHeight: number
  /** Window bottom above the floor. */
  sill: number
  /** Frame and mullion thickness. */
  frame: number
  /** Share (0..1) of windows lit at night. */
  lit: number
}

/** Facade and roof look. Everything except the palettes is a shader uniform (instant to change). */
export interface FacadeOptions {
  /** 0 = day, 1 = night: how much lit windows glow. Drive it from a day/night cycle. */
  night: number
  /** Colour of lit windows (`#rrggbb`). */
  windowLight: string
  /** Brightness of lit windows. */
  lightIntensity: number
  /** Window glass colour. */
  glass: string
  /** Window frame colour. */
  frame: string
  /** Window grid per building style. */
  windows: Record<BuildingStyle, WindowStyle>
  /** Wall colours per material; each building picks one (baked into geometry). */
  walls: Record<WallMaterial, string[]>
  /** Roof colours per material; flat roofs use `concrete` (baked into geometry). */
  roofs: Record<RoofMaterial, string[]>
  /** ± brightness jitter per building, 0..1 (baked into geometry). */
  variation: number
  /** Size of the procedural wall and roof patterns (bricks, planks, tiles): 1 = real-world size. */
  patternScale: number
}

/**
 * Weather and wear, each 0..1 (default 0). Hooks for a shared weather layer: set them per material
 * group on {@link CityOptions.weather}, or per building with `City.setBuildingWeather`; the larger of
 * the two applies. All are shader uniforms or a small data texture: changing them costs nothing.
 */
export interface Weather {
  /** Rain: darker albedo, glossy surfaces, puddles on roads. */
  wetness: number
  /** Snow cover on upward-facing surfaces (roofs, ledges, roads outside tyre tracks). */
  snow: number
  /** Fire damage: charred patches, glowing embers near 1. */
  burn: number
  /** Wear and destruction: cracks, missing patches, broken windows, potholes. */
  damage: number
}

/** Weather per material group. */
export interface WeatherOptions {
  /** Walls. */
  walls: Weather
  /** Roofs and rooftop details. */
  roofs: Weather
  /** Roads, sidewalks and bridges. */
  roads: Weather
}

/** Road surface look (shader uniforms). */
export interface RoadLookOptions {
  /** Base colour per surface. */
  colors: Record<RoadSurface, string>
  /** Sidewalk colour. */
  sidewalk: string
  /** Kerb stone colour. */
  kerb: string
  /** Kerb height above the carriageway, metres (geometry). */
  kerbHeight: number
  /** Lane and edge marking colour. */
  marking: string
  /** Centre line colour on arterials. */
  centerLine: string
  /** Bridge concrete colour. */
  concrete: string
  /** Paint lane markings on asphalt. */
  markings: boolean
  /** 0..1: worn tyre tracks, cracks and patches on asphalt, ruts on dirt. */
  wear: number
}

/** Level of detail by distance from the camera (metres). */
export interface LodOptions {
  /** Beyond this, buildings switch to simple boxes. */
  simple: number
  /** Beyond this, buildings are hidden. */
  hide: number
  /** Beyond this, roads are hidden. */
  roads: number
}

/** Every setting of a {@link City}. All plain data. */
export interface CityOptions {
  /** Seed: same seed, options and world give the same settlement. */
  seed: number | string
  /** Centre, frame-local [x, z] metres. */
  center: [number, number]
  /** Size class (sets radius, height limit, layout style and district shares). */
  size: SettlementSize
  /** Radius, metres (0 = the middle of the size class's range). */
  radius: number
  /** Street layout; `'auto'` takes the size class's. */
  style: RoadStyle | 'auto'
  /** Terrain sampling resolution, metres (0 = automatic from the radius). */
  siteResolution: number
  /** Road network rules. */
  roads: RoadOptions
  /** Street direction field. */
  field: TensorFieldOptions
  /** District layout and per-district rules. */
  districts: DistrictOptions
  /** Block extraction. */
  blocks: BlockOptions
  /** Lot split jitter: 0 = regular halves, 1 = very uneven. */
  lotJitter: number
  /** Lots along roads through open ground (outside blocks). */
  roadside: RoadsideOptions
  /** Building rules. */
  buildings: BuildingOptions
  /** Regional building tradition; `'auto'` picks one from the climate at the centre. */
  architecture: ArchitectureName | 'auto'
  /** The architectures (materials, roofs, stilts, balconies, …). */
  architectures: Record<ArchitectureName, Architecture>
  /** Climate override for `'auto'` architecture (`null` = read from the world at the centre). */
  climate: Climate | null
  /** Terrain shaping. */
  terrain: TerrainOptions
  /** Size classes. */
  sizes: Record<SettlementSize, SizeClass>
  /** Facades and roofs. */
  facade: FacadeOptions
  /** Road surfaces. */
  roadLook: RoadLookOptions
  /** Weather and wear per material group (hooks for a weather system). */
  weather: WeatherOptions
  /** Level of detail. */
  lod: LodOptions
  /** Spread generation over several frames (see `buildBudget`) instead of finishing in `create`. */
  progressive: boolean
  /** Milliseconds per `update()` spent generating when `progressive`. */
  buildBudget: number
}

/** Settings accepted by `City.create`, `set` and `reset`, and the `<City>` props: any subset, nested. */
export type CityInput = DeepPartial<CityOptions>

const W = (bayWidth: number, windowWidth: number, windowHeight: number, sill: number, frame: number, lit: number): WindowStyle => ({ bayWidth, windowWidth, windowHeight, sill, frame, lit })

/** Default settings: a town. */
export const DEFAULT_CITY: CityOptions = {
  seed: 1,
  center: [0, 0],
  size: 'town',
  radius: 0,
  style: 'auto',
  siteResolution: 0,
  roads: DEFAULT_ROADS,
  field: DEFAULT_TENSOR_FIELD,
  districts: DEFAULT_DISTRICTS,
  blocks: DEFAULT_BLOCKS,
  lotJitter: 0.35,
  roadside: DEFAULT_ROADSIDE,
  buildings: DEFAULT_BUILDINGS,
  architecture: 'auto',
  architectures: ARCHITECTURES,
  climate: null,
  terrain: DEFAULT_TERRAIN,
  sizes: DEFAULT_SIZE_CLASSES,
  facade: {
    night: 0,
    windowLight: '#ffd59a',
    lightIntensity: 2.2,
    glass: '#33465a',
    frame: '#e8e4dc',
    windows: {
      tower: W(1.6, 1.42, 2.75, 0.45, 0.06, 0.45),
      block: W(3.1, 1.35, 1.65, 0.9, 0.09, 0.35),
      house: W(3.4, 1.05, 1.35, 0.95, 0.1, 0.3),
      shed: W(7, 4.5, 1.1, 4.6, 0.12, 0.2),
    },
    walls: {
      plaster: ['#efe7da', '#e8dcc8', '#d9c4a5', '#e6d3b3', '#d8d2c4', '#c9d3d6', '#e7c9a9', '#f2efe6'],
      brick: ['#9a4b37', '#a85a40', '#7f3f30', '#b06a4f', '#8a5442', '#6f4134'],
      wood: ['#8a6a4a', '#a4805a', '#6b5039', '#b8a17f', '#7d8b86', '#9c4a3b', '#c7b89a'],
      stone: ['#a7a196', '#8f8a80', '#bdb4a3', '#9c9483', '#c4bba8'],
      concrete: ['#a9a9a4', '#bab6ad', '#8f9193', '#c8c3b8', '#9da1a2'],
      glass: ['#5d7286', '#4c6a73', '#6e8494', '#3f5363', '#7a8a8f'],
      adobe: ['#c9a27a', '#d4b08a', '#b98d64', '#dcbf97', '#c28f6a'],
      metal: ['#9aa0a2', '#7f8a8c', '#a7a39a', '#6f7b84', '#b4b8b4'],
    },
    roofs: {
      tile: ['#a0573f', '#8e4a3a', '#b5643f', '#7a3f31', '#c27650'],
      slate: ['#4f5257', '#5b5f66', '#45474c', '#62666b'],
      shingle: ['#5b4a44', '#6e5a4c', '#4f4f55', '#7a6a58'],
      metal: ['#7d8b8f', '#8e3b33', '#3f5a4a', '#9aa0a2', '#4a5866'],
      thatch: ['#a88d5b', '#9a7f50', '#b59c6a'],
      concrete: ['#77736d', '#6a6c6e', '#85817a', '#5d5f61'],
    },
    variation: 0.12,
    patternScale: 1,
  },
  roadLook: {
    colors: { asphalt: '#3a3c3f', cobblestone: '#7c766c', gravel: '#9a8f7c', dirt: '#7a6249' },
    sidewalk: '#a8a49c', kerb: '#bdb8ae', kerbHeight: 0.15, marking: '#e9e9e2', centerLine: '#e2b842', concrete: '#9d9a93', markings: true, wear: 0.5,
  },
  weather: {
    walls: { wetness: 0, snow: 0, burn: 0, damage: 0 },
    roofs: { wetness: 0, snow: 0, burn: 0, damage: 0 },
    roads: { wetness: 0, snow: 0, burn: 0, damage: 0 },
  },
  lod: { simple: 450, hide: 9000, roads: 7000 },
  progressive: false,
  buildBudget: 6,
}

/** Street-layout presets, applied between the defaults and your input. */
export const ROAD_STYLES: Record<RoadStyle, CityInput> = {
  grid: { field: { grid: 1, radial: 0.12, noise: 3, terrain: 0.7, gridVariation: 25 } },
  radial: { field: { grid: 0.55, radial: 1.3, radialDecay: 0.65, noise: 5, terrain: 1 } },
  organic: {
    field: { grid: 0.35, radial: 0.4, noise: 28, noiseScale: 220, terrain: 1.6, gridVariation: 60 },
    roads: { primary: { segment: 30 }, secondary: { segment: 24, branchSpacing: 90 }, minor: { segment: 20 }, minAngle: 28 },
    districts: { styles: { residential: { blockSize: 85, lotArea: 650 } } },
  },
}

/** Deep-merges plain objects (arrays and everything else are replaced). Returns a new object. */
export function mergeOptions<T>(base: T, ...inputs: unknown[]): T {
  let out = structuredClone(base)
  for (const input of inputs) out = mergeInto(out, input)
  return out
}

function mergeInto<T>(target: T, input: unknown): T {
  if (!input || typeof input !== 'object') return target
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === undefined) continue
    const t = target as Record<string, unknown>
    const cur = t[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) t[k] = mergeInto(cur, v)
    else t[k] = Array.isArray(v) ? structuredClone(v) : v
  }
  return target
}

/** Resolves input into full settings: defaults ← the layout style's preset ← input. */
export function resolveCityOptions(input: CityInput = {}): CityOptions {
  const size = (input.size ?? DEFAULT_CITY.size) as SettlementSize
  const sizes = mergeOptions(DEFAULT_CITY.sizes, input.sizes)
  const style = input.style && input.style !== 'auto' ? input.style : sizes[size].style
  return mergeOptions(DEFAULT_CITY, ROAD_STYLES[style], input)
}
