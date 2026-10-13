/**
 * Procedural animals for three.js that live where they should: fish schools in rivers and seas matched
 * to water type, temperature and depth, and bird flocks over the biomes they like. Bodies, patterns and
 * swimming/flapping are generated (TSL, no textures); groups spawn deterministically per tile around
 * the camera and move as seeded, fixed-step boids that never leave their habitat. Built on a small
 * generic layer ({@link FaunaLayer}) so more kinds (land herds) slot in with the same placement,
 * streaming and simulation.
 *
 * @module threejs-fauna
 */
export * from './boids.ts'
export * from './placement.ts'
export * from './common.ts'
export * from './fish-species.ts'
export * from './fish-geometry.ts'
export * from './fish-material.ts'
export * from './fish.ts'
export * from './bird-species.ts'
export * from './birds.ts'
export * from './layer.ts'
export * from './fauna.ts'
