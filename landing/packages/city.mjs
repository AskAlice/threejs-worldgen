// Lander data for threejs-city. Schema and conventions: see landing/build.mjs and landing/packages/grass.mjs.
export default {
  short: 'city',
  name: 'threejs-city',
  status: 'live',
  accent: '#3d4f63',
  icon: '<path d=\"M3 28V14h7v14zM12 28V5h8v23zM22 28V11h7v17z\" fill=\"currentColor\"/><path d=\"M14 8h1.6v2H14zM16.6 8h1.6v2h-1.6zM14 12h1.6v2H14zM16.6 12h1.6v2h-1.6zM14 16h1.6v2H14zM16.6 16h1.6v2h-1.6z\" fill=\"#f4f1e8\"/>',
  title: 'threejs-city · Procedural settlements for three.js and React Three Fiber',
  description: 'Procedural hamlets, towns and cities for three.js, planned by a population model on an H3 hex grid: tensor-field roads, blocks, lots, climate-matched buildings and lit TSL facades.',
  pitch: 'Hamlets to cities where people live: a population model plans them, then tensor-field roads, lots, climate-matched buildings and lit facades.',
  label: 'WebGPU · three.js · React Three Fiber',
  headline: 'Grow a <em>whole town</em> from a seed.',
  lede: 'Settlements where people would live, placed and sized by a population model on an H3 hex grid, with roads that follow the terrain, blocks, lots and buildings that match the climate. One call to <code>City.create()</code> or one <code>&lt;City /&gt;</code>, and the ground is flattened under all of it.',
  hero: { img: 'city/hero.jpg', alt: 'Aerial view of a procedural city beside a river' },
  thumb: 'city/thumb.jpg',
  thumbAlt: 'Downtown towers rising from a street grid of houses beside a river',
  demos: [{ label: 'three.js demo', href: 'city.html' }, { label: 'React Three Fiber demo', href: 'city-r3f.html' }, { label: 'Settlement planner demo', href: 'population.html' }, { label: 'Settlement planner R3F demo', href: 'population-r3f.html' }],
  stats: [['~3,600', 'buildings in a 1.5 km city'], ['6', 'size classes'], ['6', 'architectures'], ['0', 'texture assets']],
  install: 'npm i threejs-city threejs-biomes three',
  code: {
    heading: 'Found a town in <em>one call.</em>',
    intro: "Plan where people live on a <code>threejs-biomes</code> world, then build the largest place. The city adds itself to the scene, updates its LOD whenever the scene renders, and registers terrain edits on the world so roads and buildings sit flat.",
    three: { src: `
import { World } from 'threejs-biomes'
import { City, generatePopulation, planCities } from 'threejs-city'

const world = new World({ seed: 11 })
const people = generatePopulation(world, { radius: 10_000 })
const [site] = planCities(people) // largest first

const city = await City.create({
  world, camera, scene,
  center: [site.x, site.z],
  size: site.size,
  radius: site.radius,
  seed: site.seed,
})

city.set({ facade: { night: 1 } })            // lights on
city.set({ weather: { roofs: { snow: 1 } } }) // snow on every roof` },
    r3f: { src: `
import { useWorld } from 'threejs-biomes/react'
import { City } from 'threejs-city/react'

function Town({ night, rain }) {
  const world = useWorld({ seed: 11 })
  return (
    <City
      world={world}
      size="village"
      center={[200, -50]}
      facade={{ night }}
      weather={{ roads: { wetness: rain } }}
    />
  )
}` },
  },
  features: {
    heading: 'Everything a settlement <em>needs.</em>',
    intro: 'Placement, streets, plots, houses and the ground they stand on. Every feature below is live in the demo, and every setting can change at runtime.',
    rows: [
      { title: 'Sited where people live', sub: 'Planned by the population.', body: 'The settlement planner below decides where people live and how many. <code>planCities</code> turns each settlement into a size class and a radius from its head count, and each class builds its own way: farmsteads get a farm and its fields, hamlets a junction, villages a road of houses, towns a main street, cities and metropolises towers. <code>&lt;Settlements&gt;</code> builds them all.', media: { img: 'city/aerial.jpg', alt: 'A town on a river plain, with roads leading out over two bridges' } },
      { title: 'Roads that grow', sub: 'Along a tensor field.', body: 'Arterials grow from the centre and branch into collectors and local streets, following grid patches, a radial centre and the terrain gradient. They avoid water and steep grades, snap to junctions, refuse acute angles and bridge narrow rivers.', media: { img: 'city/roads.jpg', alt: 'A radial town from above: a ring road, arterials and bridges over the river' } },
      { title: 'Three street layouts', sub: 'Grid, radial or organic.', wide: true, body: 'Pick a <code>style</code> or let the size class choose. Each preset tunes the tensor field and road lengths; all of it stays open to override.', chips: ['grid', 'radial', 'organic', 'farmstead', 'hamlet', 'village', 'town', 'city', 'metropolis'], media: { stack: [{ img: 'city/grid.jpg', alt: 'The town laid out as a grid', tag: 'grid' }, { img: 'city/organic.jpg', alt: 'The same town with organic streets', tag: 'organic' }] } },
      { title: 'Blocks, lots and districts', sub: 'Every building has a plot.', body: 'Blocks are faces of the road graph, inset by road and sidewalk, then split into lots that keep street frontage. Downtown, residential, industrial, park and farmland districts set block size, setbacks and floors.', media: { img: 'city/hero.jpg', alt: 'A downtown of towers ringed by blocks of houses on their own lots' } },
      { title: 'Buildings for the climate', sub: 'Six architectures.', wide: true, body: 'Towers, apartment blocks, houses and sheds, with gable, hip, skillion, flat and saw-tooth roofs, chimneys, balconies and stilts. Materials and roofs come from the climate at the centre, or set <code>architecture</code> yourself.', chips: ['temperate', 'cold', 'arid', 'mediterranean', 'tropical', 'wetland'], media: { img: 'city/arid.jpg', alt: 'A town with the arid architecture: flat roofs and rooftop tanks' } },
      { title: 'Procedural facades', sub: 'Windows that light up at night.', body: 'Facades are a TSL shader: window grids, frames, shopfronts and procedural plaster, brick, wood, stone, glass and adobe. Window lights are hashed per window and glow with <code>facade.night</code>, a uniform you can fade every frame.', media: { img: 'city/towers.jpg', alt: 'Looking up at downtown towers: window grids, frames and glass from the facade shader' } },
      { title: 'Weather hooks', sub: 'Wet, snowy, burnt or damaged.', body: 'Walls, roofs and roads each take <code>wetness</code>, <code>snow</code>, <code>burn</code> and <code>damage</code>. Wet roads get puddles, snow stays out of tyre tracks, and <code>setBuildingWeather</code> sets one building on fire.' },
      { title: 'Ground that fits', sub: 'Graded roads, level pads.', body: 'Each road gets a graded profile, and flatten modifiers along roads and under buildings are registered on the world in one batch. Terrain, grass and scatter follow; <code>dispose()</code> removes them.', media: { img: 'city/aerial.jpg', alt: 'Roads and building pads sitting flat on the ground beside a river' } },
      { title: 'Data for everything else', sub: 'Roads, lots and buildings as JSON.', body: '<code>city.data()</code> returns road edges with lanes and speeds, lots with frontage and buildings with entrances. <code>roadAnchors</code> places street lights; <code>graph.shortestPath</code> with <code>routeCost</code> routes cars, bikes and people.', media: { img: 'city/grid.jpg', alt: 'The road graph of a grid town from above' } },
    ],
  },
  sections: [{
    id: 'planner',
    label: 'Settlement planner',
    heading: 'Where people <em>live.</em>',
    intro: 'A population model on H3\'s hexagonal grid, read from the world: habitability, settlements, density, land use and networks, all from a seed, as plain data plus a <code>PopulationOverlay</code> hex map. Everything below except the last row is live in the settlement planner demos.',
    rows: [
      { title: 'Habitability from the world', sub: 'Where people would choose to live.', body: 'Every fine cell reads the <code>threejs-biomes</code> world: biome fertility, gentle slope, a comfortable temperature, and a river valley or coast nearby. Water and avoided biomes (deep ocean, glacier, peaks, volcanic) score zero.', media: { img: 'population/habitability.jpg', alt: 'Habitability map in hexagons, bright along valleys and coasts' } },
      { title: 'Central places', sub: 'Christaller on H3.', body: 'At each tier\'s resolution, cells whose habitability is a local maximum become settlements. Each higher-tier place claims its market area, so towns fall between cities and villages between towns, one H3 resolution (about 7× the area) apart.', media: { img: 'population/lights.jpg', alt: 'Settlements as bright cores spaced across the region, joined by roads' } },
      { title: 'Sized by rank', sub: 'Zipf, then classes.', wide: true, body: 'The r-th settlement gets P₁ / r<sup>zipf</sup> people, scaled so they sum to the urban share of <code>totalPopulation</code>. Its class comes from <code>thresholds</code>; farmland cells may hold a farmstead. Classes map onto city size classes with <code>citySize</code>.', chips: ['metropolis', 'city', 'town', 'village', 'hamlet', 'farmstead'], media: { img: 'population/sandbox.jpg', alt: 'The settlement planner sandbox: extruded density hexagons, a minimap and every option in a panel' } },
      { title: 'Density that fades out', sub: 'Integer people per cell.', body: 'Each settlement spreads its people over nearby cells with a Gaussian of its radius. Rural people fill habitable land, denser along rivers and coasts (<code>corridor</code>) and near towns (<code>ruralDecay</code>). Cell counts are integers that sum to the total.', media: { img: 'population/hero.jpg', alt: 'Extruded density prisms rising over cities' } },
      { title: 'Land use', sub: 'Five classes per cell.', wide: true, body: 'Urban and suburban by density, farmland by habitability, everything else wilderness, plus water from the world. Thresholds live in <code>landUse</code>.', chips: ['urban', 'suburban', 'farmland', 'wilderness', 'water'], media: { img: 'population/landuse.jpg', alt: 'Land-use map: urban cores, suburbs, farmland and wilderness' } },
      { title: 'Night lights', sub: 'Cities seen from orbit.', body: 'Brightness is 1 − exp(−density / <code>lightDensity</code>). <code>nightLights(data, res)</code> returns typed arrays of centres and intensities at any resolution, with <code>sample(x, y, z)</code> for a glow pass or an orbit view.', media: { img: 'population/lights.jpg', alt: 'Night-light map with bright city cores and dim countryside' } },
      { title: 'Roads, rail and power', sub: 'Routed over the terrain.', wide: true, body: 'A spanning tree reaches every settlement, plus gravity-model links where the tree forces a detour. Each link is an A* route over the hex graph, costed by slope and water and cheaper where earlier routes run, so roads merge into trunks. Rail avoids hills harder; power lines span straight.', chips: ['highway', 'road', 'track', 'rail', 'powerline'], media: { img: 'population/networks.jpg', alt: 'Roads winding between settlements and straight power-line spans over density hexagons' } },
      { title: 'Hexagons at every scale', sub: 'Coarser cells are exact sums.', body: 'H3 nests resolutions, so the same people show at 400 m, 3 km or 22 km cells. With <code>resolution: \'auto\'</code> the overlay steps coarser as the camera pulls away; <code>aggregatePopulation(data, res)</code> gives the sums as data. Flat worlds and planets both map onto H3.', media: { img: 'population/hierarchy.jpg', alt: 'Coarse, tall hexagon prisms over the same region' } },
      { title: 'Data and maps without a GPU', sub: 'Plain objects and RGBA.', body: '<code>generatePopulation</code> and <code>generateNetworks</code> are pure and seeded. <code>renderPopulationMap</code> returns RGBA pixels for a minimap, a worker or a test, in the same colours as the overlay.', media: { img: 'population/sandbox.jpg', alt: 'The demo minimap drawn by renderPopulationMap' } },
      { title: 'Traffic from people', sub: 'Sized by who lives where.', planned: true, body: 'Next, the population will size the traffic on each road and railway, from the people at either end.' },
    ],
  }],
  final: { heading: 'Found your <em>town.</em>', text: 'Try every size, layout and weather in the live demo, or go straight to the API reference.' },
}
