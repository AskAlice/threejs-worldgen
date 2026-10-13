// Shared <head> SEO tags for every page on the site: the landing pages (landing/build.mjs), the built demo pages
// (post-processed by landing/build.mjs) and the TypeDoc pages (scripts/typedoc-seo.mjs).
export const SITE = 'https://askalice.github.io/threejs-worldgen/'
export const GITHUB = 'https://github.com/AskAlice/threejs-worldgen'
export const SITE_NAME = 'threejs-worldgen'
export const OG = { width: 1200, height: 630 } // every card in landing/media/og/ (see landing/og.mjs)

// Package order on the homepage (landing/build.mjs) and in the README cards (landing/readme-cards.mjs) follows the
// pipeline: ground, then what grows on it, then people, then the sky. threejs-heightfield sits under all of them.
export const ORDER = ['heightfield', 'biomes', 'water', 'scatter', 'trees', 'grass', 'city', 'props', 'vehicles', 'fauna', 'weathering', 'sky']

// Search titles and descriptions for the built demo pages (post-processed by landing/build.mjs): file -> [package short,
// title, description]. The short also places a demo in the docs map (landing/readme-cards.mjs) when no lander lists it.
export const DEMOS = {
  'demos.html': [null, 'Live demos · threejs-worldgen procedural worlds for three.js', 'Every threejs-worldgen live demo in one place: WebGPU sandboxes for procedural terrain, biomes, water, forests, grass, cities, traffic, wildlife, weather and sky.'],
  'index.html': ['grass', 'threejs-grass demo · Infinite WebGPU grass for three.js', 'Live three.js WebGPU demo of threejs-grass: infinite, terrain-aware grass with wind, interaction, 12 presets, LOD tiles and a terrain painter.'],
  'r3f.html': ['grass', 'threejs-grass React Three Fiber demo · WebGPU grass in R3F', 'The threejs-grass <Grass /> component in React Three Fiber: infinite WebGPU grass on procedural terrain with wind, presets and a live control panel.'],
  'terrain.html': ['biomes', 'threejs-biomes demo · Procedural terrain, biomes and planets in three.js', 'Live WebGPU sandbox for threejs-biomes: seeded climate, 20 blended biomes, mountains and rivers, and streaming LOD terrain from the ground to a planet.'],
  'scatter.html': ['scatter', 'Procedural forest demo · threejs-scatter and threejs-trees for three.js', 'Stream a procedural forest over terrain in three.js: blue-noise placement of trees, rocks and plants with LODs and impostors, and 29 tree species.'],
  'water.html': ['water', 'threejs-water demo · Oceans, lakes and rivers in three.js WebGPU', 'Live WebGPU sandbox for threejs-water: ocean waves, foam and shallows, lakes and carved rivers with drainage-basin hydrology on procedural terrain.'],
  'city.html': ['city', 'threejs-city demo · Procedural cities and road networks in three.js', 'Live sandbox for threejs-city: procedural settlements with road networks, blocks, lots and buildings that flatten the terrain beneath them.'],
  'population.html': ['city', 'threejs-city settlement planner demo · Population density on an H3 hex grid', 'Live sandbox for the settlement planner of threejs-city: population density, land use, settlement hierarchy and road networks on a hexagonal H3 grid over procedural terrain.'],
  'props.html': ['props', 'threejs-props demo · Procedural street and countryside props for three.js', 'Live sandbox for threejs-props: procedural street lights, traffic lights, power lines, fences, signs and mailboxes placed along generated roads.'],
  'vehicles.html': ['vehicles', 'threejs-vehicles demo · Procedural traffic, trains and boats in three.js', 'Live sandbox for threejs-vehicles: procedural animated cars, bicycles, trains, boats and aircraft on generated road, rail and water networks.'],
  'fauna.html': ['fauna', 'threejs-fauna demo · Procedural fish schools and bird flocks in three.js', 'Live sandbox for threejs-fauna: procedural fish schools, bird flocks and wildlife that live in the biomes and waters that suit them.'],
  'weathering.html': ['weathering', 'threejs-weathering demo · Rain, snow, lightning and wildfire in three.js', 'Live WebGPU sandbox for threejs-weathering: rain, snow, wind and lightning, wildfires that spread and regrow, and wet, snowy and burnt materials.'],
  'world.html': [null, 'Combined world demo · threejs-worldgen procedural world in three.js', 'Every threejs-worldgen package in one WebGPU scene: procedural terrain and biomes, water, forests, grass, cities, traffic, wildlife, weather and sky.'],
  'gallery.html': [null, 'Asset gallery · threejs-worldgen procedural assets for three.js', 'Browse the procedural assets of threejs-worldgen side by side: trees, plants, rocks, buildings, props, vehicles and animals, generated in three.js.'],
  'particles.html': ['particles', 'threejs-particles demo · GPU particle systems for three.js WebGPU', 'Live sandbox for threejs-particles: compute-shader particle pools with seeded emitters, forces and lifetime curves, plus lit smoke, flames and sparks.'],
  'mpm.html': ['particles', 'threejs-particles MPM sandbox · Real-time material point method on WebGPU', 'Live sandbox for the threejs-particles MLS-MPM solver: a soft block dropped onto procedural terrain, simulated entirely in WebGPU compute with terrain collision and pluggable materials.'],
  'mpm-snow.html': ['particles', 'threejs-particles MPM snow sandbox · Footprints and avalanches on WebGPU', 'Live sandbox for the threejs-particles MPM snow model: boots and wheels pressing tracks into fresh powder, and a slab avalanche breaking away down a gully, simulated in WebGPU compute.'],
  'mpm-water.html': ['particles', 'threejs-particles MPM water sandbox · Dam break, waterfall and rain on WebGPU', 'Live sandbox for the threejs-particles MPM fluid: a dam break, a stream falling into a plunge pool and rain filling puddles on terrain, drawn as a screen-space water surface.'],
  'mpm-lava.html': ['particles', 'threejs-particles MPM lava sandbox · Cooling, crusting lava flows on WebGPU', 'Live sandbox for the threejs-particles MPM lava: basalt pouring down a volcano flank, cooling, thickening and crusting over, glowing by blackbody colour from its temperature.'],
  'heightfield.html': ['heightfield', 'threejs-heightfield sandbox · Height lookup, slope and ray-marching', 'Live WebGPU sandbox for threejs-heightfield: a height function and meshes baked into heightfields, sampled on a grid coloured by slope, with ray-marching under the pointer.'],
  'city-r3f.html': ['city', 'threejs-city React Three Fiber demo · Procedural cities in R3F', 'The threejs-city <City> component in React Three Fiber: a procedural settlement on a threejs-biomes world, with every option as a live leva control.'],
  'props-r3f.html': ['props', 'threejs-props React Three Fiber demo · Street and road props in R3F', 'The threejs-props <Props> and <RoadPath> components in React Three Fiber: instanced street lights, fences, signs and power lines along roads, with live controls.'],
  'vehicles-r3f.html': ['vehicles', 'threejs-vehicles React Three Fiber demo · Procedural traffic in R3F', 'The threejs-vehicles <Vehicle> and <Fleet> components in React Three Fiber: a gallery of every vehicle type and live traffic on a street grid, with planes overhead.'],
  'population-r3f.html': ['city', 'threejs-city settlement planner in React Three Fiber · H3 population maps', 'usePopulation and the <PopulationOverlay> hex map of the threejs-city settlement planner in React Three Fiber: density, land use and night lights, with every option live.'],
  'fauna-r3f.html': ['fauna', 'threejs-fauna React Three Fiber demo · Fish schools and bird flocks in R3F', 'The threejs-fauna <Fish> and <Fauna> components in React Three Fiber: all 12 fish species side by side, then fish schools and bird flocks at a river mouth.'],
  'sky.html': ['sky','threejs-sky demo · Day/night cycle, clouds and stars in three.js', 'Live sandbox for threejs-sky: a day/night cycle with sun and moon phases, clouds, the Milky Way, shooting stars and a Keplerian solar system.'],
}

/** Alt text for a lander image that is either the hero (`hero.alt`) or the thumbnail (`thumbAlt`); undefined if unset. */
export const imgAlt = (p, img) => img === p.hero?.img ? p.hero.alt : p.thumbAlt

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
export const plain = (html) => String(html).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** Canonical, robots, Open Graph and Twitter tags. `url` and `image` are absolute; `themeColor` is optional. */
export function seoTags({ title, description, url, image, imageAlt, type = 'website', themeColor }) {
  const m = (attr, k, v) => `<meta ${attr}="${k}" content="${esc(v)}" />`
  return [
    m('name', 'description', description),
    `<link rel="canonical" href="${esc(url)}" />`,
    m('name', 'robots', 'index, follow, max-image-preview:large'),
    themeColor && m('name', 'theme-color', themeColor),
    m('property', 'og:type', type),
    m('property', 'og:site_name', SITE_NAME),
    m('property', 'og:locale', 'en_US'),
    m('property', 'og:title', title),
    m('property', 'og:description', description),
    m('property', 'og:url', url),
    m('property', 'og:image', image),
    m('property', 'og:image:width', OG.width),
    m('property', 'og:image:height', OG.height),
    m('property', 'og:image:alt', imageAlt),
    m('name', 'twitter:card', 'summary_large_image'),
    m('name', 'twitter:title', title),
    m('name', 'twitter:description', description),
    m('name', 'twitter:image', image),
    m('name', 'twitter:image:alt', imageAlt),
  ].filter(Boolean).join('\n  ')
}

/** A JSON-LD <script>; `<` is escaped so text can never close the tag. */
export const jsonLd = (data) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', ...data }).replace(/</g, '\\u003c')}</script>`
