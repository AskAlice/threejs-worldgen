/**
 * Streams instanced objects (trees, rocks, plants) over terrain in camera-centred tiles: seamless blue-noise placement,
 * density / slope / height / clumping rules, pooled levels of detail and octahedral impostors. WebGPU (TSL).
 *
 * @module threejs-scatter
 */
export { Scatter, disposeLayers, resolveLayer } from './scatter.ts'
export type { ScatterInput, ScatterInstance, ScatterLayer, ScatterLayerInput, ScatterLOD, ScatterOptions, ScatterSettings, ScatterStats } from './scatter.ts'
export { DEFAULT_PLACEMENT, INSTANCE_STRIDE, clusterFactor, groupSeed, placeTile } from './placement.ts'
export type { DensityFn, PlacementRules, ScatterCluster } from './placement.ts'
export { poissonDisk } from './poisson.ts'
export { selectLod } from './lod.ts'
export { directionToFrame, frameDirection, octDecode, octEncode } from './octahedral.ts'
export type { Vec3Tuple } from './octahedral.ts'
export { DEFAULT_IMPOSTOR, bakeImpostor } from './impostor.ts'
export type { Impostor, ImpostorOptions } from './impostor.ts'
export { fbm2, hash, hashString, mulberry32, valueNoise2 } from './random.ts'
export { scatterParamsNode } from './nodes.ts'
