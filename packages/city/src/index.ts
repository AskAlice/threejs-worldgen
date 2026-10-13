/**
 * Procedural settlements for three.js: hamlets to cities where people live, roads grown along a tensor
 * field, blocks, lots and buildings matched to the local climate, procedural TSL facades and road surfaces
 * with weather hooks, and terrain flattened under it all. Works on flat worlds and planets from
 * `threejs-biomes`. Everything derives from `seed` and the world.
 *
 * The settlement planner is a population model on H3's hexagonal hierarchical grid: habitability from the
 * world, central places sized by rank (Zipf), dispersed rural people, land use, night lights and
 * terrain-following road / rail / power networks. `planCities` turns its settlements into cities.
 *
 * @module threejs-city
 */
export * from './polygon.ts'
export * from './site.ts'
export * from './tensor-field.ts'
export * from './graph.ts'
export * from './districts.ts'
export * from './roads.ts'
export * from './blocks.ts'
export * from './lots.ts'
export * from './architecture.ts'
export * from './buildings.ts'
export * from './landmarks.ts'
export * from './farm.ts'
export * from './field-mesh.ts'
export * from './field-material.ts'
export * from './hex.ts'
export * from './population-model.ts'
export * from './population-network.ts'
export * from './population.ts'
export * from './population-map.ts'
export * from './population-overlay.ts'
export * from './placement.ts'
export * from './terrain.ts'
export * from './options.ts'
export * from './plan.ts'
export * from './data.ts'
export * from './mesh-builder.ts'
export * from './building-mesh.ts'
export * from './road-mesh.ts'
export * from './facade-material.ts'
export * from './road-material.ts'
export * from './city.ts'
export * from './settlements.ts'
