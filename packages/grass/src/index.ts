/**
 * Framework-agnostic entry point: the {@link Grass} field, grass maps, the terrain painter, presets and
 * terrain helpers. Requires `WebGPURenderer` from `three/webgpu`.
 *
 * @module threejs-grass
 */
export { Grass, createBladeGeometry, createBillboardGeometry } from './grass.ts'
export type { GrassOptions, GrassInput, GrassSettings, GrassLOD, GrassRenderer, GrassStats, WindOptions, Interactor } from './grass.ts'
export { MAX_INTERACTORS, createGrassUniforms } from './material.ts'
export type { GrassUniforms, GrassMapSample } from './material.ts'
export { GrassMap, TerrainPainter } from './grass-map.ts'
export type { GrassMapOptions, Brush, BrushMode } from './grass-map.ts'
export { Corn, DEFAULT_CORN, createCornGeometry, createCanopyGeometry } from './corn.ts'
export type { CornOptions, CornInput, CornSettings, CornLOD, CornStats } from './corn.ts'
export { FlattenMap, PLANT_STRIDE, plantRows, pointInPolygon } from './corn-layout.ts'
export type { CornField, PlantOptions } from './corn-layout.ts'
export { createCornUniforms } from './corn-material.ts'
export type { CornUniforms } from './corn-material.ts'
export { presets } from './presets.ts'
export type { GrassStyle, PresetName } from './presets.ts'
export { createHeightSampler, bakeHeightfield, raycastHeight, slopeAt } from 'threejs-heightfield'
export type { HeightFn, Terrain } from 'threejs-heightfield'
