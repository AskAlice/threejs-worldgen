/**
 * Oceans, lakes and rivers for three.js (WebGPU / TSL), from an ant on the beach to orbit:
 *
 * - {@link Ocean}: a sea-level surface for flat worlds and planets, Gerstner waves, refraction,
 *   depth-tinted colour, shoreline foam and whitecaps, one draw call at every altitude.
 * - {@link Rivers}: streamed river surfaces for a `threejs-biomes` world, with flow-mapped water.
 * - Bounded-map hydrology ({@link computeHydrology}): depression filling, flow routing and
 *   accumulation, rivers and lakes, plus height modifiers that carve the rivers; {@link Lakes} draws it.
 * - Queries ({@link waterAt}, {@link hydrologyWaterAt}, {@link Ocean.waterAt}) for gameplay and buoyancy.
 *
 * @module threejs-water
 */
export * from './waves.ts'
export * from './material.ts'
export * from './ocean.ts'
export * from './rivers.ts'
export * from './hydrology.ts'
export * from './lakes.ts'
export { type WaterRenderer } from './common.ts'
