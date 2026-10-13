/**
 * GPU particle systems for three.js WebGPU: fixed-capacity pools in storage buffers, emitted, moved and
 * depth-sorted by TSL compute passes, drawn with one instanced draw each. Seeded emitters (point, box,
 * disc, sphere or weighted sources the CPU refreshes cheaply), gravity, temperature-driven buoyancy,
 * wind, drag and curl-noise turbulence, lifetime curves, an optional coarse particle/grid field,
 * built-in shading for lit volumetric smoke, blackbody flames, spark streaks and heat haze, and a
 * real-time MLS-MPM solver with terrain collision and a pluggable material registry.
 *
 * @module threejs-particles
 */
export * from './options.ts'
export * from './emitter.ts'
export * from './curves.ts'
export * from './blackbody.ts'
export * from './noise.ts'
export * from './grid.ts'
export * from './system.ts'
export * from './mpm-materials.ts'
export * from './mpm-reference.ts'
export * from './mpm.ts'
