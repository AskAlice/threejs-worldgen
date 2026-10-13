// Lander data for threejs-scatter. Schema and conventions: see landing/build.mjs and landing/packages/grass.mjs.
export default {
  short: 'scatter',
  name: 'threejs-scatter',
  status: 'live',
  accent: '#5d6b1f',
  icon: '<g fill=\"currentColor\"><circle cx=\"6\" cy=\"7\" r=\"3\"/><circle cx=\"17\" cy=\"5\" r=\"2.2\"/><circle cx=\"26\" cy=\"9\" r=\"3\"/><circle cx=\"11\" cy=\"16\" r=\"2.4\"/><circle cx=\"22\" cy=\"18\" r=\"3.2\"/><circle cx=\"5\" cy=\"25\" r=\"2.2\"/><circle cx=\"15\" cy=\"26\" r=\"3\"/><circle cx=\"27\" cy=\"27\" r=\"2.2\"/></g>',
  title: 'threejs-scatter · Streaming instanced scatter for three.js and React Three Fiber',
  description: 'Scatter trees, rocks and anything else over terrain for three.js and React Three Fiber: seamless blue-noise tiles, pooled instancing, LODs and octahedral impostors.',
  pitch: 'Trees, rocks, anything: seamless blue-noise tiles streamed around the camera, pooled instancing, LODs and impostors.',
  label: 'WebGPU · three.js · React Three Fiber',
  headline: 'Put a <em>million things</em> on the map.',
  lede: 'Give it a mesh per level of detail and a few placement rules; it streams instances over your terrain in camera-centred tiles. Placement is a pure function of <code>seed</code> and position, and draw calls stay flat however far the world goes.',
  hero: { img: 'scatter/hero.jpg', alt: 'A mixed forest of oak, beech, birch and spruce running over rolling hills to the horizon' },
  thumb: 'scatter/thumb.jpg',
  thumbAlt: 'A mixed forest of conifers and broadleaf trees running to a hazy ridge',
  demos: [{ label: 'three.js demo', href: 'scatter.html' }],
  stats: [['~25k', 'instances in the demo'], ['82', 'draw calls for all of them'], ['8×8', 'impostor views per object'], ['4 ms', 'build budget per frame']],
  install: 'npm i threejs-scatter three',
  code: {
    heading: 'Layers in, <em>world</em> out.',
    intro: 'A layer is one kind of object: where it may grow and what to draw at each distance. Hand <code>Scatter.create()</code> a camera, a terrain and a list of layers; with <code>scene</code> given it updates itself every frame.',
    three: { src: `
import { Scatter, bakeImpostor } from 'threejs-scatter'

const far = await bakeImpostor(renderer, rock, { frames: 8, size: 512 })

const scatter = Scatter.create({
  camera, scene,
  terrain: (x, z) => height(x, z), // or a terrain mesh
  seed: 7,
  layers: [{
    name: 'boulder',
    spacing: 12,                     // metres between instances
    density: (x, z) => rockiness(x, z),
    maxSlope: 1.5, align: 1, scale: [0.6, 2],
    cluster: { scale: 80, threshold: 0.5, strength: 0.8 },
    lods: [{ distance: 120, geometry: rock.geometry, material: rock.material }],
    impostor: { distance: 600, geometry: far.geometry, material: far.material },
  }],
})` },
    r3f: { src: `
import { Scatter } from 'threejs-scatter/react'

function Rocks({ geometry, material }) {
  const ground = useRef()
  const scatter = useRef() // ScatterImpl: query(), stats
  return (
    <>
      <mesh ref={ground} geometry={hills} />
      <Scatter ref={scatter} terrain={ground} seed={7}
        maxDistance={400}
        layers={[{ name: 'rock', spacing: 8, maxSlope: 1,
          lods: [{ distance: 150, geometry, material }] }]} />
    </>
  )
}` },
  },
  features: {
    heading: 'The engine under the <em>forest.</em>',
    intro: 'Placement, streaming, instancing, levels of detail and impostors, for whatever you scatter. The trees in these shots come from <a href="../trees/">threejs-trees</a>; every feature is live in the demo.',
    rows: [
      { title: 'Seamless blue noise', sub: 'Even spacing, no seams, any build order.', body: 'One jittered candidate per grid cell, then a few elimination rounds keep the points that beat their neighbours within <code>spacing</code>. Each tile evaluates a margin around itself, so neighbouring tiles agree exactly, whichever was built first.', media: { img: 'scatter/placement.jpg', alt: 'Looking straight down on evenly spaced trees with clumps and clearings' } },
      { title: 'Placement rules', sub: 'It grows where it should.', body: 'Per layer: a <code>density</code> number or <code>(x, z)</code> field such as a biome weight, slope and height ranges, and <code>cluster</code> noise for patches and clearings. Layers in one <code>group</code> share a point set and never overlap.', media: { img: 'scatter/rules.jpg', alt: 'Broadleaf and conifer stands mixing over rolling ground' } },
      { title: 'Streams around the camera', sub: 'Tiles in, tiles out.', body: 'The world is cut into <code>tileSize</code> tiles generated nearest-first within a per-frame <code>buildBudget</code>, out to <code>maxDistance</code>. Leave and come back and every instance is where it was.', media: { img: 'scatter/streaming.jpg', alt: 'A forest that ends at the streaming distance around the camera' } },
      { title: 'Pooled instancing', sub: 'Draw calls stay flat.', body: 'Each layer and level of detail is one pooled instanced mesh shared by every tile, so the count of draw calls does not grow with the world. Pools start at 1100 instances and grow with headroom. The HUD shows tiles, instances, drawn and meshes live.', media: { img: 'scatter/sandbox.jpg', alt: 'The demo at ground level with its HUD and option panel', tag: 'demo sandbox' } },
      { title: 'Octahedral impostors', sub: 'Thousands of trees for the price of quads.', body: '<code>bakeImpostor()</code> renders any object from <code>frames × frames</code> directions into colour and normal atlases. The impostor picks the nearest view in TSL and is lit live by the scene, so the far forest keeps its shape and its shading.', media: { stack: [{ img: 'scatter/impostors.jpg', alt: 'The far forest drawn with impostors', tag: 'impostors' }, { img: 'scatter/no-impostors.jpg', alt: 'The same view drawn with simplified meshes all the way out', tag: 'meshes only' }] } },
      { title: 'Levels of detail', sub: 'No popping back and forth.', body: 'Mesh levels nearest first, then the impostor. An instance has to cross a <code>lodHysteresis</code> band to switch level, and levels are only re-sorted after the camera moves <code>refreshDistance</code>. Far levels can skip shadows with <code>castShadow: false</code>.', media: { img: 'scatter/lods.jpg', alt: 'Trees from close-up meshes to distant impostors in one view' } },
      { title: 'Per-instance variation', sub: 'No two the same.', body: 'Random yaw, scale range, <code>tilt</code>, <code>sink</code> and terrain <code>align</code>, plus a <code>colorVariation</code> brightness tint. <code>scatterParamsNode()</code> hands every material the per-instance yaw, tint and a random number in TSL for colour shifts and the like.', media: { img: 'scatter/variation.jpg', alt: 'Close-up of trees, shrubs and ferns with varied size and colour' } },
      { title: 'Ask where things are', sub: 'Gameplay and collision.', body: '<code>scatter.query(x, z, radius)</code> returns the instances near a point: layer, position, scale, yaw. It recomputes placement, so it works for tiles that are not even loaded. The placement functions are pure and exported for workers.', media: { img: 'scatter/placement.jpg', alt: 'Evenly spaced trees seen from above' } },
      { title: 'Made for React too', sub: 'A declarative &lt;Scatter&gt;.', body: 'Props are the options, the camera defaults to the R3F camera and <code>terrain</code> takes a mesh, a ref or a height function. Prop changes rebuild only what changed. <code>ref</code> gives you the instance for <code>query</code> and <code>stats</code>.', media: { img: 'scatter/hero.jpg', alt: 'A forest over rolling hills' } },
    ],
  },
  final: { heading: 'Fill the <em>world.</em>', text: 'Fly over the forest in the live demo, or go straight to the API reference.' },
}
