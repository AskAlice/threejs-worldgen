/**
 * Procedural trees, shrubs, palms, cacti, ferns, reeds and rocks for three.js: space-colonisation trees with
 * pipe-model radii, 22 species presets, procedural leaf cards, TSL bark/leaf/rock materials with wind, and
 * `createVegetationLayers` to scatter them (with LODs and impostors) through threejs-scatter.
 *
 * @module threejs-trees
 */
export { generateTree, generateTreeLevels } from './tree.ts'
export type { TreeDetailOptions, TreeGeometry } from './tree.ts'
export { DEFAULT_TREE_PARAMS, species } from './species.ts'
export type { CrownShape, LeafShape, SpeciesName, TreeKind, TreeParams } from './species.ts'
export { crownExtent, crownProfile, growSkeleton, sampleCrown } from './space-colonization.ts'
export type { TreeSkeleton } from './space-colonization.ts'
export { DEFAULT_ROCK_PARAMS, generateRock, icosphere, rocks } from './rock.ts'
export type { RockName, RockParams } from './rock.ts'
export {
  applyImpostorWeather, createBarkMaterial, createFruitMaterial, createLeafMaterial, createRockMaterial, getLeafTexture, impostorFoliageMask, setTreeEnvironment, treeUniforms,
} from './materials.ts'
export type { LeafMaterialOptions, MaterialOptions, TreeEnvironment, WeatherInputs } from './materials.ts'
export { drawLeafImage } from './leaf-texture.ts'
export type { LeafImage } from './leaf-texture.ts'
export { createVegetationLayers, mergeTreeGeometry } from './layers.ts'
export type { VegetationOptions, VegetationSpecies } from './layers.ts'
