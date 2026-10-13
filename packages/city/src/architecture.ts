/** Wall materials. Each has its own procedural pattern in the facade shader. */
export type WallMaterial = 'plaster' | 'brick' | 'wood' | 'stone' | 'concrete' | 'glass' | 'adobe' | 'metal'

/** Every wall material, in shader-index order. */
export const WALL_MATERIALS: readonly WallMaterial[] = ['plaster', 'brick', 'wood', 'stone', 'concrete', 'glass', 'adobe', 'metal']

/** Roof shapes. */
export type RoofShape = 'flat' | 'gable' | 'hip' | 'skillion' | 'sawtooth'

/** Roof materials. Each has its own procedural pattern in the roof shader. */
export type RoofMaterial = 'tile' | 'slate' | 'shingle' | 'metal' | 'thatch' | 'concrete'

/** Every roof material, in shader-index order. */
export const ROOF_MATERIALS: readonly RoofMaterial[] = ['tile', 'slate', 'shingle', 'metal', 'thatch', 'concrete']

/** Regional building traditions, picked from the climate at the settlement centre. */
export type ArchitectureName = 'temperate' | 'cold' | 'arid' | 'mediterranean' | 'tropical' | 'wetland'

/** Weights: keys are options, values their relative likelihood. */
export type Weights<K extends string> = Partial<Record<K, number>>

/** How a region builds. All weights are relative. */
export interface Architecture {
  /** House wall materials. */
  houseMaterials: Weights<WallMaterial>
  /** Apartment block wall materials. */
  blockMaterials: Weights<WallMaterial>
  /** Tower wall materials. */
  towerMaterials: Weights<WallMaterial>
  /** House roof shapes. */
  houseRoofs: Weights<RoofShape>
  /** Pitched roof materials. */
  roofMaterials: Weights<RoofMaterial>
  /** Pitched roof slope range (rise / run): steep where it snows. */
  pitch: [number, number]
  /** Eave overhang, metres. */
  overhang: number
  /** Houses stand on stilts this tall, metres (0 = on the ground). */
  stilts: number
  /** Chance (0..1) that a house has an L-shaped plan (a cross wing). */
  wings: number
  /** Chance (0..1) that an apartment block has balconies. */
  balconies: number
  /** Most wall-mounted air-conditioning units per building. */
  airConditioners: number
}

/** Built-in architectures. */
export const ARCHITECTURES: Record<ArchitectureName, Architecture> = {
  temperate: {
    houseMaterials: { plaster: 4, brick: 4, wood: 1.5, stone: 1 }, blockMaterials: { brick: 3, plaster: 3, concrete: 3 }, towerMaterials: { glass: 5, concrete: 2, stone: 1 },
    houseRoofs: { gable: 6, hip: 3, skillion: 0.5 }, roofMaterials: { tile: 5, slate: 3, shingle: 2 },
    pitch: [0.5, 0.85], overhang: 0.45, stilts: 0, wings: 0.35, balconies: 0.45, airConditioners: 1,
  },
  cold: {
    houseMaterials: { wood: 5, stone: 2, plaster: 1.5 }, blockMaterials: { concrete: 3, brick: 3, plaster: 1 }, towerMaterials: { glass: 3, concrete: 3 },
    houseRoofs: { gable: 9, hip: 1 }, roofMaterials: { metal: 4, slate: 3, shingle: 3 },
    pitch: [0.95, 1.35], overhang: 0.6, stilts: 0, wings: 0.3, balconies: 0.2, airConditioners: 0,
  },
  arid: {
    houseMaterials: { adobe: 6, plaster: 3, stone: 1 }, blockMaterials: { plaster: 4, adobe: 2, concrete: 2 }, towerMaterials: { glass: 4, concrete: 2, stone: 1 },
    houseRoofs: { flat: 9, skillion: 1 }, roofMaterials: { tile: 3, concrete: 4 },
    pitch: [0.15, 0.3], overhang: 0.1, stilts: 0, wings: 0.45, balconies: 0.3, airConditioners: 4,
  },
  mediterranean: {
    houseMaterials: { plaster: 6, stone: 2 }, blockMaterials: { plaster: 5, concrete: 1 }, towerMaterials: { glass: 4, concrete: 2 },
    houseRoofs: { hip: 4, gable: 2, flat: 3 }, roofMaterials: { tile: 8 },
    pitch: [0.3, 0.45], overhang: 0.35, stilts: 0, wings: 0.4, balconies: 0.7, airConditioners: 3,
  },
  tropical: {
    houseMaterials: { wood: 3, plaster: 4, concrete: 1 }, blockMaterials: { plaster: 4, concrete: 3 }, towerMaterials: { glass: 5, concrete: 2 },
    houseRoofs: { hip: 6, gable: 2 }, roofMaterials: { metal: 4, tile: 3, thatch: 1 },
    pitch: [0.6, 0.9], overhang: 0.9, stilts: 0, wings: 0.3, balconies: 0.6, airConditioners: 4,
  },
  wetland: {
    houseMaterials: { wood: 6, plaster: 1 }, blockMaterials: { concrete: 2, plaster: 2 }, towerMaterials: { glass: 3, concrete: 2 },
    houseRoofs: { gable: 5, hip: 3 }, roofMaterials: { metal: 3, thatch: 2, shingle: 2 },
    pitch: [0.6, 0.95], overhang: 0.7, stilts: 1.8, wings: 0.2, balconies: 0.3, airConditioners: 1,
  },
}

/** Climate at a settlement (from the world sample at its centre). */
export interface Climate {
  /** Temperature, °C. */
  temperature: number
  /** Moisture 0..1. */
  moisture: number
  /** Strongest biome id (e.g. `'wetland'`). */
  biome: string
}

/** Picks the architecture for a climate: wetlands build on stilts, cold places steep, dry places flat. */
export function architectureFor(c: Climate): ArchitectureName {
  if (c.biome === 'wetland' || c.biome === 'mangrove') return 'wetland'
  if (c.temperature < 3 || c.biome === 'taiga' || c.biome === 'tundra' || c.biome === 'alpineMeadow' || c.biome === 'glacier') return 'cold'
  if (c.temperature > 19 && c.moisture < 0.3) return 'arid'
  if (c.temperature > 20 && c.moisture > 0.6) return 'tropical'
  if (c.temperature > 14 && c.moisture < 0.45) return 'mediterranean'
  return 'temperate'
}

/** Weighted random choice (falls back to the first key when every weight is 0). */
export function pick<K extends string>(weights: Weights<K>, r: number): K {
  const entries = Object.entries(weights) as [K, number][]
  let total = 0
  for (const [, w] of entries) total += Math.max(0, w)
  let x = r * total
  for (const [k, w] of entries) {
    x -= Math.max(0, w)
    if (x < 0) return k
  }
  return entries[0][0]
}
