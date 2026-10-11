// Lander data for threejs-city. Schema and conventions: see landing/build.mjs and landing/packages/grass.mjs.
export default {
  short: 'city',
  name: 'threejs-city',
  status: 'live',
  accent: '#3d4f63',
  icon: '<path d=\"M3 28V14h7v14zM12 28V5h8v23zM22 28V11h7v17z\" fill=\"currentColor\"/><path d=\"M14 8h1.6v2H14zM16.6 8h1.6v2h-1.6zM14 12h1.6v2H14zM16.6 12h1.6v2h-1.6zM14 16h1.6v2H14zM16.6 16h1.6v2h-1.6z\" fill=\"#f4f1e8\"/>',
  title: 'threejs-city · Procedural settlements for three.js and React Three Fiber',
  description: 'Procedural hamlets, towns and cities for three.js: tensor-field roads, blocks, lots, climate-matched buildings, TSL facades with night lights and weather hooks.',
  pitch: 'Hamlets to cities where the land suits them: tensor-field roads, lots, climate-matched buildings and lit facades.',
  label: 'WebGPU · three.js · React Three Fiber',
  headline: 'Grow a <em>whole town</em> from a seed.',
  lede: 'Settlements placed where the land suits them, with roads that follow the terrain, blocks, lots and buildings that match the climate. One call to <code>City.create()</code> or one <code>&lt;City /&gt;</code>, and the ground is flattened under all of it.',
  hero: { img: 'city/hero.jpg', alt: 'Aerial view of a procedural city beside a river' },
  thumb: 'city/thumb.jpg',
  demos: [{ label: 'three.js demo', href: 'city.html' }],
  stats: [['~3,600', 'buildings in a 1.5 km city'], ['4', 'size classes'], ['6', 'architectures'], ['0', 'texture assets']],
  install: 'npm i threejs-city threejs-biomes three',
  code: {
    heading: 'Found a town in <em>one call.</em>',
    intro: "Find a good site on a <code>threejs-biomes</code> world, then build there. The city adds itself to the scene, updates its LOD whenever the scene renders, and registers terrain edits on the world so roads and buildings sit flat.",
    three: { src: `
import { World } from 'threejs-biomes'
import { City, findSettlements } from 'threejs-city'

const world = new World({ seed: 11 })
const region = { minX: -5000, minZ: -5000, maxX: 5000, maxZ: 5000 }
const [site] = findSettlements(world, world.frame, region)

const city = await City.create({
  world, camera, scene,
  center: [site.x, site.z],
  size: site.size,
  radius: site.radius,
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
      { title: 'Sited like a real town', sub: 'Where the land suits it.', body: '<code>findSettlements</code> scores the world for flat ground near a river or coast, a temperate climate and a good biome. The best sites become settlements sized by importance, so hamlets are common and cities rare.', media: { img: 'city/aerial.jpg', alt: 'A town on a river plain, with roads leading out over two bridges' } },
      { title: 'Roads that grow', sub: 'Along a tensor field.', body: 'Arterials grow from the centre and branch into collectors and local streets, following grid patches, a radial centre and the terrain gradient. They avoid water and steep grades, snap to junctions, refuse acute angles and bridge narrow rivers.', media: { img: 'city/roads.jpg', alt: 'A radial town from above: a ring road, arterials and bridges over the river' } },
      { title: 'Three street layouts', sub: 'Grid, radial or organic.', wide: true, body: 'Pick a <code>style</code> or let the size class choose. Each preset tunes the tensor field and road lengths; all of it stays open to override.', chips: ['grid', 'radial', 'organic', 'hamlet', 'village', 'town', 'city'], media: { stack: [{ img: 'city/grid.jpg', alt: 'The town laid out as a grid', tag: 'grid' }, { img: 'city/organic.jpg', alt: 'The same town with organic streets', tag: 'organic' }] } },
      { title: 'Blocks, lots and districts', sub: 'Every building has a plot.', body: 'Blocks are faces of the road graph, inset by road and sidewalk, then split into lots that keep street frontage. Downtown, residential, industrial, park and farmland districts set block size, setbacks and floors.', media: { img: 'city/hero.jpg', alt: 'A downtown of towers ringed by blocks of houses on their own lots' } },
      { title: 'Buildings for the climate', sub: 'Six architectures.', wide: true, body: 'Towers, apartment blocks, houses and sheds, with gable, hip, skillion, flat and saw-tooth roofs, chimneys, balconies and stilts. Materials and roofs come from the climate at the centre, or set <code>architecture</code> yourself.', chips: ['temperate', 'cold', 'arid', 'mediterranean', 'tropical', 'wetland'], media: { img: 'city/arid.jpg', alt: 'A town with the arid architecture: flat roofs and rooftop tanks' } },
      { title: 'Procedural facades', sub: 'Windows that light up at night.', body: 'Facades are a TSL shader: window grids, frames, shopfronts and procedural plaster, brick, wood, stone, glass and adobe. Window lights are hashed per window and glow with <code>facade.night</code>, a uniform you can fade every frame.', media: { img: 'city/towers.jpg', alt: 'Looking up at downtown towers: window grids, frames and glass from the facade shader' } },
      { title: 'Weather hooks', sub: 'Wet, snowy, burnt or damaged.', body: 'Walls, roofs and roads each take <code>wetness</code>, <code>snow</code>, <code>burn</code> and <code>damage</code>. Wet roads get puddles, snow stays out of tyre tracks, and <code>setBuildingWeather</code> sets one building on fire.' },
      { title: 'Ground that fits', sub: 'Graded roads, level pads.', body: 'Each road gets a graded profile, and flatten modifiers along roads and under buildings are registered on the world in one batch. Terrain, grass and scatter follow; <code>dispose()</code> removes them.', media: { img: 'city/aerial.jpg', alt: 'Roads and building pads sitting flat on the ground beside a river' } },
      { title: 'Data for everything else', sub: 'Roads, lots and buildings as JSON.', body: '<code>city.data()</code> returns road edges with lanes and speeds, lots with frontage and buildings with entrances. <code>roadAnchors</code> places street lights; <code>graph.shortestPath</code> with <code>routeCost</code> routes cars, bikes and people.', media: { img: 'city/grid.jpg', alt: 'The road graph of a grid town from above' } },
    ],
  },
  final: { heading: 'Found your <em>town.</em>', text: 'Try every size, layout and weather in the live demo, or go straight to the API reference.' },
}
