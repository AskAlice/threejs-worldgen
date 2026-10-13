// Lander data for threejs-biomes. Schema and conventions: see landing/build.mjs and landing/packages/grass.mjs.
export default {
  short: 'biomes',
  name: 'threejs-biomes',
  status: 'live',
  accent: '#56642a',
  icon: '<path d=\"M1 27 11 9l5 8 4-5 11 15z\" fill=\"currentColor\"/><path d=\"M8 14.5l3 2 2.5-2\" fill=\"none\" stroke=\"#f4f1e8\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>',
  title: 'threejs-biomes · Procedural worlds and planets for three.js and React Three Fiber',
  description: 'Seeded climate, continents, mountains, rivers, volcanoes and 20 blended biomes for three.js, on a flat world or a whole planet, with streaming LOD terrain.',
  pitch: 'Seeded climate, mountains, rivers and 20 blended biomes, on a flat world or a planet, from orbit down to ant scale.',
  label: 'WebGPU · three.js · React Three Fiber',
  headline: 'Whole worlds from <em>one seed.</em>',
  lede: 'Climate, continents, mountain ranges, rivers and volcanoes, sorted into 20 blended biomes on an infinite plane or a whole planet. Streaming terrain takes you from orbit down to the ground an ant walks on.',
  hero: { img: 'biomes/hero.jpg', alt: 'Rivers meandering through a valley between mountain ranges on a generated world' },
  thumb: 'biomes/thumb.jpg',
  demos: [
    { label: 'Planet demo', href: 'terrain.html' },
    { label: 'Flat world demo', href: 'terrain.html?surface=plane' },
  ],
  stats: [['20', 'blended biomes'], ['2', 'surfaces: plane or planet'], ['8', 'world map modes'], ['1 cm', 'to orbit, one camera']],
  install: 'npm i threejs-biomes three',
  code: {
    heading: 'A planet in <em>a few lines.</em>',
    intro: 'Make a <code>World</code> from a seed, hand it to <code>WorldTerrain</code>, and steer with <code>SurfaceControls</code>. Chunks build in workers if you give it one, and every setting can change while it runs.',
    three: { src: `
import { World, WorldTerrain, SurfaceControls } from 'threejs-biomes'

const world = new World({ seed: 'pangaea', surface: 'sphere', radius: 60_000 })
const controls = new SurfaceControls(camera, renderer.domElement, world) // 1 cm … orbit
const terrain = await WorldTerrain.create({ world, camera, scene })

renderer.setAnimationLoop(() => {
  controls.update()
  terrain.setOrigin(controls.origin) // floating origin
  renderer.render(scene, camera)
})

world.biomeAt(120, -40).name               // 'Temperate deciduous forest'
world.set({ mountains: { height: 1600 } }) // live: chunks rebuild` },
    r3f: { src: `
import { useWorld, WorldTerrain } from 'threejs-biomes/react'

function Scene() {
  const world = useWorld({
    seed: 'pangaea',
    mountains: { height: 1200 },
    rivers: { enabled: true },
  })
  return (
    <WorldTerrain
      world={world}
      lodFactor={2.5}
      material={{ debug: 'biomes' }}
    />
  )
}` },
  },
  features: {
    heading: 'Everything a world <em>needs.</em>',
    intro: 'Climate first, then height, then biomes, then ground. Every step is a deterministic function of the seed and a position, so worlds never end and never change behind your back.',
    rows: [
      { title: 'Twenty biomes', sub: 'Blended, never cut.', wide: true, body: 'Each biome has a centre in climate space, and every point blends its nearest few, so forests thin into grassland instead of stopping at a line. The table is plain JSON in <code>BIOMES</code>: edit it or replace it.', chips: ['Deep ocean', 'Beach and coast', 'Temperate grassland', 'Deciduous forest', 'Temperate rainforest', 'Boreal forest (taiga)', 'Tundra', 'Glacier and ice sheet', 'Alpine meadow', 'Mountain peaks', 'Hot desert (erg)', 'Badlands (mesa)', 'Savanna', 'Tropical rainforest', 'Tropical dry forest', 'Mediterranean shrubland', 'Cold steppe', 'Wetland', 'Mangrove', 'Volcanic'], media: { img: 'biomes/biomes.jpg', alt: 'Terrain tinted by biome from high above', tag: "debug: 'biomes'" } },
      { title: 'Climate drives it', sub: 'Temperature, moisture, wind.', body: 'Continentalness, erosion, temperature and moisture fields come first. Temperature falls 6.5 °C per kilometre of height and mountains cast rain shadows, so peaks are cold and their lee sides dry. <code>renderWorldMap</code> draws any field as a top-down map.', media: { img: 'biomes/map.jpg', alt: 'The sandbox with its options panel and a temperature map overlay', tag: 'map overlay' } },
      { title: 'Flat worlds and planets', sub: 'One switch: <code>surface</code>.', body: "An infinite plane for games that think in x and z, or a whole sphere with a real horizon. On a planet, <code>LocalFrame</code> gives any spot a flat <code>(x, z) =&gt; y</code> view, so height-function packages work unchanged.", media: { stack: [{ img: 'biomes/hero.jpg', alt: 'A flat world with rivers and mountains', tag: "surface: 'plane'" }, { img: 'biomes/horizon.jpg', alt: 'The curved horizon of a generated planet', tag: "surface: 'sphere'" }] } },
      { title: 'From orbit to an ant', sub: 'One camera, every scale.', body: '<code>SurfaceControls</code> zooms from 1 cm to orbit with automatic near and far planes. A floating origin keeps the camera near render-space zero, so the ground stays precise at planet scale.', media: { img: 'biomes/orbit.jpg', alt: 'A whole generated planet seen from orbit' } },
      { title: 'Streaming LOD terrain', sub: 'A quadtree that follows the camera.', body: 'A flat grid or a cube-sphere quadtree splits where you look and merges behind you. Skirts hide the seams, noise octaves below a chunk\'s resolution are skipped, and chunks build in Web Workers under a per-frame time budget.', media: { img: 'biomes/lod.jpg', alt: 'Terrain chunks tinted by level of detail', tag: "debug: 'lod'" } },
      { title: 'Shaped by the land', sub: 'Ranges, rivers, volcanoes.', body: 'Ridged mountain ranges, eroded hills, rivers carved toward the sea and rare volcanoes with craters. Biomes shape their own ground too: desert dunes, mesa terraces, tundra hummocks, flat wetlands and glacier crevasses.', media: { img: 'biomes/mountains.jpg', alt: 'Tall mountain ranges above river valleys', tag: 'mountains.height: 1800' } },
      { title: 'Plain data, all live', sub: 'Save it, share it, send it to a worker.', body: 'Every option is JSON. <code>world.set()</code> rebuilds the terrain progressively, and <code>height</code>, <code>biomeAt</code> and <code>sampleAt</code> answer gameplay questions. Data-only <code>modifiers</code> flatten circles and paths, which is how towns level their roads and lots.', media: { img: 'biomes/hero.jpg', alt: 'A generated valley with rivers' } },
      { title: 'Real erosion', sub: 'For bounded maps.', planned: true, body: 'GPU hydraulic erosion baked into a tile and cached, for maps with edges. Infinite worlds keep the cheap eroded noise they use today.' },
    ],
  },
  final: { heading: 'Go make <em>a world.</em>', text: 'Fly from orbit to the ground in the live demo, or go straight to the API reference.' },
}
