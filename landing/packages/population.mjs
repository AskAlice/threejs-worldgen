// Lander data for threejs-population. Schema and conventions: see landing/build.mjs and landing/packages/grass.mjs.
export default {
  short: 'population',
  name: 'threejs-population',
  status: 'live',
  accent: '#5e3d91',
  icon: '<path d=\"M16 3l5.2 3v6L16 15l-5.2-3V6zM8 16l5.2 3v6L8 28l-5.2-3v-6zM24 16l5.2 3v6L24 28l-5.2-3v-6z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M16 6.4l2.3 1.3v2.6L16 11.6l-2.3-1.3V7.7z\" fill=\"currentColor\"/>',
  title: 'threejs-population · Population density on an H3 hex grid for three.js',
  description: 'Population density for procedural worlds on an H3 hexagonal grid: central places sized by rank, land use, night lights, and roads, rail and power lines.',
  pitch: 'People for procedural worlds on an H3 hex grid: ranked settlements, land use, night lights and road networks.',
  label: 'H3 · three.js · React Three Fiber',
  headline: 'Signs of <em>life</em>, cell by cell.',
  lede: 'Population density on a hexagonal hierarchical grid, read from your <code>threejs-biomes</code> world. Cities, towns, villages and farmsteads land where people would live, sized by rank and joined by roads, rail and power lines.',
  hero: { img: 'population/hero.jpg', alt: 'Hexagonal population density prisms over a procedural landscape' },
  thumb: 'population/thumb.jpg',
  demos: [{ label: 'three.js demo', href: 'population.html' }],
  stats: [['1.5M', 'people by default'], ['4', 'tiers of central places'], ['5', 'network types'], ['4', 'map modes']],
  install: 'npm i threejs-population threejs-biomes three',
  code: {
    heading: 'Populate a world in <em>two lines.</em>',
    intro: 'Give it a world and a head count. You get settlements, per-cell density, land use and networks as plain data, plus an overlay that draws them as hexagons over the terrain.',
    three: { src: `
import { World } from 'threejs-biomes'
import { Population, PopulationOverlay } from 'threejs-population'

const world = new World({ seed: 'valley' })
const population = new Population(world, {
  totalPopulation: 1_500_000,
  radius: 24_000,
  cellSize: 500,
})

population.data.settlements[0] // { class: 'city', population, position, … }
population.network.edges       // highway, road, track, rail, powerline

const overlay = new PopulationOverlay({ population, camera, mode: 'density' })
scene.add(overlay.object)
renderer.setAnimationLoop(() => { overlay.update(); renderer.render(scene, camera) })` },
    r3f: { src: `
import { useWorld, WorldTerrain } from 'threejs-biomes/react'
import { PopulationOverlay, usePopulation } from 'threejs-population/react'

function Scene() {
  const world = useWorld({ seed: 'valley' })
  const population = usePopulation(world, { totalPopulation: 900_000 })
  return (
    <>
      <WorldTerrain world={world} />
      <PopulationOverlay population={population} mode="lights" extrude={0} />
    </>
  )
}` },
  },
  features: {
    heading: 'Where people <em>live.</em>',
    intro: 'Habitability, settlements, density, land use and networks, all from the world and a seed. Everything below except the last row is live in the demo.',
    rows: [
      { title: 'Habitability from the world', sub: 'Where people would choose to live.', body: 'Every fine cell reads the <code>threejs-biomes</code> world: biome fertility, gentle slope, a comfortable temperature, and a river valley or coast nearby. Water and avoided biomes (deep ocean, glacier, peaks, volcanic) score zero.', media: { img: 'population/habitability.jpg', alt: 'Habitability map in hexagons, bright along valleys and coasts' } },
      { title: 'Central places', sub: 'Christaller on H3.', body: 'At each tier\'s resolution, cells whose habitability is a local maximum become settlements. Each higher-tier place claims its market area, so towns fall between cities and villages between towns, one H3 resolution (about 7× the area) apart.', media: { img: 'population/lights.jpg', alt: 'Settlements as bright cores spaced across the region, joined by roads' } },
      { title: 'Sized by rank', sub: 'Zipf, then classes.', wide: true, body: 'The r-th settlement gets P₁ / r<sup>zipf</sup> people, scaled so they sum to the urban share of <code>totalPopulation</code>. Its class comes from <code>thresholds</code>; farmland cells may hold a farmstead.', chips: ['metropolis', 'city', 'town', 'village', 'hamlet', 'farmstead'], media: { img: 'population/sandbox.jpg', alt: 'The population sandbox: extruded density hexagons, a minimap and every option in a panel' } },
      { title: 'Density that fades out', sub: 'Integer people per cell.', body: 'Each settlement spreads its people over nearby cells with a Gaussian of its radius. Rural people fill habitable land, denser along rivers and coasts (<code>corridor</code>) and near towns (<code>ruralDecay</code>). Cell counts are integers that sum to the total.', media: { img: 'population/hero.jpg', alt: 'Extruded density prisms rising over cities' } },
      { title: 'Land use', sub: 'Five classes per cell.', wide: true, body: 'Urban and suburban by density, farmland by habitability, everything else wilderness, plus water from the world. Thresholds live in <code>landUse</code>.', chips: ['urban', 'suburban', 'farmland', 'wilderness', 'water'], media: { img: 'population/landuse.jpg', alt: 'Land-use map: urban cores, suburbs, farmland and wilderness' } },
      { title: 'Night lights', sub: 'Cities seen from orbit.', body: 'Brightness is 1 − exp(−density / <code>lightDensity</code>). <code>nightLights(data, res)</code> returns typed arrays of centres and intensities at any resolution, with <code>sample(x, y, z)</code> for a glow pass or an orbit view.', media: { img: 'population/lights.jpg', alt: 'Night-light map with bright city cores and dim countryside' } },
      { title: 'Roads, rail and power', sub: 'Routed over the terrain.', wide: true, body: 'A spanning tree reaches every settlement, plus gravity-model links where the tree forces a detour. Each link is an A* route over the hex graph, costed by slope and water and cheaper where earlier routes run, so roads merge into trunks. Rail avoids hills harder; power lines span straight.', chips: ['highway', 'road', 'track', 'rail', 'powerline'], media: { img: 'population/networks.jpg', alt: 'Roads winding between settlements and straight power-line spans over density hexagons' } },
      { title: 'Hexagons at every scale', sub: 'Coarser cells are exact sums.', body: 'H3 nests resolutions, so the same people show at 400 m, 3 km or 22 km cells. With <code>resolution: \'auto\'</code> the overlay steps coarser as the camera pulls away; <code>aggregatePopulation(data, res)</code> gives the sums as data. Flat worlds and planets both map onto H3.', media: { img: 'population/hierarchy.jpg', alt: 'Coarse, tall hexagon prisms over the same region' } },
      { title: 'Data and maps without a GPU', sub: 'Plain objects and RGBA.', body: '<code>generatePopulation</code> and <code>generateNetworks</code> are pure and seeded. <code>renderPopulationMap</code> returns RGBA pixels for a minimap, a worker or a test, in the same colours as the overlay.', media: { img: 'population/sandbox.jpg', alt: 'The demo minimap drawn by renderPopulationMap' } },
      { title: 'Cities and traffic from people', sub: 'Settlements and traffic.', planned: true, body: 'Next, the population will drive the rest of the world: <code>threejs-city</code> settlements at its central places, and traffic sized by the people along each road.' },
    ],
  },
  final: { heading: 'Give your world <em>people.</em>', text: 'Change the head count, the rank-size curve or the map mode in the live demo, or go straight to the API reference.' },
}
