/**
 * Oceans, lakes and rivers for three.js (WebGPU / TSL), from an ant on the beach to orbit:
 *
 * - {@link Ocean}: a sea-level surface for flat worlds and planets, Gerstner waves, refraction,
 *   depth-based absorption of the bed, foam (whitecaps from the wave Jacobian, shoreline and around
 *   obstacles), one draw call at every altitude.
 * - {@link Rivers}: streamed river surfaces for a `threejs-biomes` world, with flow-mapped water.
 * - Bounded-map hydrology ({@link computeHydrology}): depression filling, flow routing and
 *   accumulation, rivers and lakes, plus height modifiers that carve the rivers; {@link Lakes} draws it.
 * - Queries ({@link waterAt}, {@link hydrologyWaterAt}, {@link Ocean.waterAt}) for gameplay and buoyancy.
 * - {@link WaterPrepass}: an opt-in scene prepass giving the water the scene's depth, view-space
 *   normals and colour in the same frame (half resolution by default).
 *
 * @module threejs-water
 */
export * from './waves.ts'
export * from './material.ts'
export * from './ocean.ts'
export * from './rivers.ts'
export * from './hydrology.ts'
export * from './lakes.ts'
export * from './prepass.ts'
export { type WaterRenderer } from './common.ts'
