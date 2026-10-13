/**
 * The biome table: plain data (JSON-safe), so a world's biomes can be tweaked, saved, replaced or
 * extended without code. Each entry says where the biome appears, how it shapes the ground, what the
 * ground is made of, which `threejs-grass` preset grows there and what gets scattered on it.
 */

/** Ground materials the terrain blends between. */
export type GroundMaterial = 'grass' | 'dryGrass' | 'dirt' | 'sand' | 'rock' | 'snow' | 'mud'

/** Every ground material, in splat-channel order. */
export const GROUND_MATERIALS: readonly GroundMaterial[] = ['grass', 'dryGrass', 'dirt', 'sand', 'rock', 'snow', 'mud']

/**
 * How a biome earns its weight at a position.
 * - `climate`: by distance to (`temperature`, `moisture`) in climate space (a Whittaker diagram).
 * - the rest are overrides that take precedence over climate biomes where their condition holds:
 *   `ocean` (deep water), `coast` (the shore band), `mangrove` (hot, wet shores), `wetland` (low, flat,
 *   wet land), `alpine` (above the treeline), `peaks` (high mountain ridges), `glacier` (below the
 *   glacier temperature), `volcanic` (inside a volcano).
 */
export type BiomePlacement = 'climate' | 'ocean' | 'coast' | 'mangrove' | 'wetland' | 'alpine' | 'peaks' | 'glacier' | 'volcanic'

/** Extra terrain shaping a biome adds, blended by its weight. */
export type TerrainShape = 'none' | 'dunes' | 'terraces' | 'hummocks' | 'flatten' | 'crevasses'

/**
 * Something scattered over a biome: a tree or plant species from `threejs-trees`, or a rock preset.
 * Placement is blue-noise with `spacing` metres between instances; `probability` thins that out.
 */
export interface ScatterEntry {
  /** Species or rock preset name (e.g. `'oak'`, `'acacia'`, `'boulder'`). */
  species: string
  /** Minimum distance between instances of this entry, metres. */
  spacing: number
  /** Chance (0..1) that each blue-noise point keeps an instance. */
  probability: number
  /** 0 = even spread, 1 = strongly clumped into patches and clearings. */
  cluster: number
}

/** Grass a biome grows (a `threejs-grass` preset name, or `null` for none). */
export interface BiomeGrass {
  /** `threejs-grass` preset name, or `null` for bare ground. */
  preset: string | null
  /** Coverage 0..1 where the biome is at full weight. */
  coverage: number
  /** Height multiplier (1 = the preset's height). */
  height: number
}

/** One biome. All fields are plain data. */
export interface BiomeDef {
  /** Unique key, e.g. `'savanna'`. */
  id: string
  /** Display name. */
  name: string
  /** How the biome earns weight; see {@link BiomePlacement}. */
  placement: BiomePlacement
  /** Mean annual temperature (°C) at the biome's centre in climate space (used by `climate` placement). */
  temperature: number
  /** Moisture 0 (arid) … 1 (saturated) at the biome's centre in climate space (used by `climate` placement). */
  moisture: number
  /** Colour on the biome debug map (`#rrggbb`). */
  color: string
  /** Ground material mix (relative weights; normalised). */
  ground: Partial<Record<GroundMaterial, number>>
  /** Tint multiplied into this biome's ground colour (`#rrggbb`). */
  groundTint: string
  /** Extra terrain shaping. */
  shape: TerrainShape
  /** Strength of the shaping, metres. */
  shapeAmount: number
  /** Grass grown here. */
  grass: BiomeGrass
  /** Trees, plants and rocks scattered here. */
  scatter: ScatterEntry[]
}

const s = (species: string, spacing: number, probability: number, cluster = 0.3): ScatterEntry => ({ species, spacing, probability, cluster })
const g = (preset: string | null, coverage = 1, height = 1): BiomeGrass => ({ preset, coverage, height })

/** The 20 built-in biomes (see WORLDGEN.md). Copy and edit, or pass your own to the world. */
export const BIOMES: readonly BiomeDef[] = [
  {
    id: 'deepOcean', name: 'Deep ocean', placement: 'ocean', temperature: 15, moisture: 1, color: '#1d3f73',
    ground: { sand: 0.6, rock: 0.4 }, groundTint: '#7f8a8c', shape: 'none', shapeAmount: 0, grass: g(null, 0), scatter: [],
  },
  {
    id: 'coast', name: 'Beach and coast', placement: 'coast', temperature: 15, moisture: 0.5, color: '#e8d9a0',
    ground: { sand: 1 }, groundTint: '#f2e3bd', shape: 'none', shapeAmount: 0, grass: g('bermudaGrass', 0.25, 0.7),
    scatter: [s('palm', 14, 0.25, 0.5), s('pebble', 3, 0.15)],
  },
  {
    id: 'grassland', name: 'Temperate grassland', placement: 'climate', temperature: 12, moisture: 0.4, color: '#9bc25b',
    ground: { grass: 0.85, dirt: 0.15 }, groundTint: '#ffffff', shape: 'none', shapeAmount: 0, grass: g('kentuckyBluegrass', 1, 1.1),
    scatter: [s('oak', 40, 0.25, 0.7), s('shrub', 12, 0.15, 0.6), s('rock', 18, 0.15, 0.5)],
  },
  {
    id: 'deciduousForest', name: 'Temperate deciduous forest', placement: 'climate', temperature: 12, moisture: 0.68, color: '#3f8a3a',
    ground: { grass: 0.4, dirt: 0.5, mud: 0.1 }, groundTint: '#c9b58a', shape: 'none', shapeAmount: 0, grass: g('fineFescue', 0.55, 0.8),
    scatter: [s('oak', 7, 0.8, 0.6), s('beech', 7, 0.7, 0.6), s('maple', 8, 0.6, 0.6), s('fern', 3, 0.35, 0.7), s('boulder', 25, 0.2, 0.5)],
  },
  {
    id: 'temperateRainforest', name: 'Temperate rainforest', placement: 'climate', temperature: 10, moisture: 0.93, color: '#1f5e3d',
    ground: { mud: 0.4, grass: 0.4, dirt: 0.2 }, groundTint: '#7f9a6a', shape: 'none', shapeAmount: 0, grass: g('perennialRyegrass', 0.6, 0.7),
    scatter: [s('redwood', 10, 0.8, 0.5), s('fir', 8, 0.6, 0.5), s('fern', 2.5, 0.6, 0.6), s('boulder', 15, 0.35, 0.5)],
  },
  {
    id: 'taiga', name: 'Boreal forest (taiga)', placement: 'climate', temperature: 0, moisture: 0.55, color: '#2f5f4f',
    ground: { grass: 0.3, dirt: 0.5, snow: 0.2 }, groundTint: '#a6a483', shape: 'none', shapeAmount: 0, grass: g('fineFescue', 0.45, 0.7),
    scatter: [s('spruce', 6, 0.85, 0.5), s('pine', 7, 0.5, 0.5), s('birch', 10, 0.3, 0.7), s('rock', 14, 0.2, 0.4)],
  },
  {
    id: 'tundra', name: 'Tundra', placement: 'climate', temperature: -8, moisture: 0.35, color: '#93a59a',
    ground: { dryGrass: 0.4, dirt: 0.3, rock: 0.15, snow: 0.15 }, groundTint: '#b7b39a', shape: 'hummocks', shapeAmount: 0.6, grass: g('frostbite', 0.7, 0.45),
    scatter: [s('dwarfShrub', 4, 0.5, 0.6), s('rock', 9, 0.35, 0.4), s('pebble', 3, 0.3, 0.3)],
  },
  {
    id: 'glacier', name: 'Glacier and ice sheet', placement: 'glacier', temperature: -20, moisture: 0.4, color: '#e9f4fb',
    ground: { snow: 1 }, groundTint: '#f4f8ff', shape: 'crevasses', shapeAmount: 2.5, grass: g(null, 0), scatter: [],
  },
  {
    id: 'alpineMeadow', name: 'Alpine meadow', placement: 'alpine', temperature: 2, moisture: 0.5, color: '#a9c47f',
    ground: { grass: 0.6, rock: 0.3, dirt: 0.1 }, groundTint: '#d6dcb0', shape: 'none', shapeAmount: 0, grass: g('fineFescue', 0.85, 0.5),
    scatter: [s('boulder', 12, 0.35, 0.5), s('rock', 6, 0.35, 0.4), s('dwarfShrub', 5, 0.25, 0.6)],
  },
  {
    id: 'mountainPeaks', name: 'Mountain peaks', placement: 'peaks', temperature: -5, moisture: 0.4, color: '#8c8a88',
    ground: { rock: 0.8, snow: 0.2 }, groundTint: '#9a958e', shape: 'none', shapeAmount: 0, grass: g(null, 0),
    scatter: [s('cliffChunk', 14, 0.35, 0.4), s('scree', 4, 0.3, 0.5)],
  },
  {
    id: 'desert', name: 'Hot desert (erg)', placement: 'climate', temperature: 27, moisture: 0.04, color: '#efcf86',
    ground: { sand: 1 }, groundTint: '#f0cc8c', shape: 'dunes', shapeAmount: 9, grass: g(null, 0),
    scatter: [s('deadSnag', 90, 0.15, 0.3)],
  },
  {
    id: 'badlands', name: 'Rocky desert and badlands (mesa)', placement: 'climate', temperature: 21, moisture: 0.14, color: '#c46a3f',
    ground: { rock: 0.55, dirt: 0.3, sand: 0.15 }, groundTint: '#c9744a', shape: 'terraces', shapeAmount: 14, grass: g('goldenSavanna', 0.12, 0.6),
    scatter: [s('cactus', 18, 0.35, 0.4), s('thornShrub', 10, 0.25, 0.5), s('boulder', 14, 0.3, 0.5)],
  },
  {
    id: 'savanna', name: 'Savanna', placement: 'climate', temperature: 26, moisture: 0.36, color: '#c8b45a',
    ground: { dryGrass: 0.75, dirt: 0.25 }, groundTint: '#d7a96a', shape: 'none', shapeAmount: 0, grass: g('goldenSavanna', 1, 1.2),
    scatter: [s('acacia', 45, 0.45, 0.2), s('baobab', 160, 0.15, 0.1), s('thornShrub', 16, 0.2, 0.6), s('rock', 30, 0.1, 0.5)],
  },
  {
    id: 'jungle', name: 'Tropical rainforest (jungle)', placement: 'climate', temperature: 26, moisture: 0.92, color: '#1d7a2a',
    ground: { mud: 0.45, grass: 0.35, dirt: 0.2 }, groundTint: '#6f8a4a', shape: 'none', shapeAmount: 0, grass: g('stAugustineGrass', 0.7, 1),
    scatter: [s('jungleEmergent', 16, 0.6, 0.4), s('palm', 7, 0.6, 0.5), s('fern', 2.2, 0.7, 0.5), s('shrub', 4, 0.5, 0.5)],
  },
  {
    id: 'dryForest', name: 'Tropical dry forest', placement: 'climate', temperature: 25, moisture: 0.62, color: '#7f9a3a',
    ground: { dirt: 0.5, dryGrass: 0.4, grass: 0.1 }, groundTint: '#b59a64', shape: 'none', shapeAmount: 0, grass: g('zoysiaGrass', 0.6, 0.8),
    scatter: [s('maple', 9, 0.55, 0.5), s('thornShrub', 6, 0.4, 0.5), s('baobab', 120, 0.2, 0.2), s('rock', 20, 0.15, 0.5)],
  },
  {
    id: 'mediterranean', name: 'Mediterranean shrubland', placement: 'climate', temperature: 17, moisture: 0.3, color: '#a8a45a',
    ground: { dryGrass: 0.5, dirt: 0.3, rock: 0.2 }, groundTint: '#c9b483', shape: 'none', shapeAmount: 0, grass: g('buffaloGrass', 0.7, 0.8),
    scatter: [s('olive', 14, 0.5, 0.5), s('shrub', 3.5, 0.55, 0.6), s('cypress', 30, 0.15, 0.6), s('rock', 10, 0.3, 0.5)],
  },
  {
    id: 'steppe', name: 'Cold steppe', placement: 'climate', temperature: 5, moisture: 0.2, color: '#b8b07a',
    ground: { dryGrass: 0.7, dirt: 0.3 }, groundTint: '#c4b88c', shape: 'none', shapeAmount: 0, grass: g('autumnHaze', 0.9, 0.7),
    scatter: [s('dwarfShrub', 8, 0.25, 0.5), s('rock', 25, 0.15, 0.5)],
  },
  {
    id: 'wetland', name: 'Wetland (marsh and swamp)', placement: 'wetland', temperature: 14, moisture: 0.9, color: '#4f7a5c',
    ground: { mud: 0.6, grass: 0.4 }, groundTint: '#7d8a62', shape: 'flatten', shapeAmount: 1, grass: g('tallFescue', 0.8, 1.3),
    scatter: [s('reed', 1.6, 0.7, 0.7), s('cypress', 12, 0.4, 0.6), s('deadSnag', 40, 0.2, 0.4)],
  },
  {
    id: 'mangrove', name: 'Mangrove', placement: 'mangrove', temperature: 27, moisture: 0.95, color: '#2f6b55',
    ground: { mud: 0.8, sand: 0.2 }, groundTint: '#6e6a52', shape: 'flatten', shapeAmount: 0.5, grass: g(null, 0),
    scatter: [s('mangrove', 6, 0.75, 0.5)],
  },
  {
    id: 'volcanic', name: 'Volcanic', placement: 'volcanic', temperature: 20, moisture: 0.3, color: '#3b2f2f',
    ground: { rock: 0.7, dirt: 0.3 }, groundTint: '#3c3633', shape: 'none', shapeAmount: 0, grass: g(null, 0),
    scatter: [s('deadSnag', 25, 0.25, 0.5), s('boulder', 10, 0.4, 0.5), s('scree', 4, 0.3, 0.5)],
  },
]

/** Default colours of the ground materials (`#rrggbb`), multiplied by each biome's `groundTint`. */
export const GROUND_COLORS: Readonly<Record<GroundMaterial, string>> = {
  grass: '#4f7a2c',
  dryGrass: '#a99a5a',
  dirt: '#6b5138',
  sand: '#d8c393',
  rock: '#7a756e',
  snow: '#f2f5f8',
  mud: '#3f3a2c',
}
