// Lander data for threejs-grass. Schema: see landing/build.mjs. HTML is allowed in headline, lede, sub, body, intro and
// final text; media paths are relative to site/media/ (sources: media/ and landing/media/); demo hrefs are relative to demo/.
export default {
  short: 'grass',
  name: 'threejs-grass',
  status: 'live',
  accent: '#1f5a35',
  icon: '<path d="M6 28C7 18 9 10 13 4c-1 8-1 15 1 24zM14 28c1-9 4-17 10-23-3 8-4 15-3 23zM2 28c2-6 3-10 6-14-1 5-1 9 0 14zM22 28c1-5 3-9 7-12-2 4-3 8-2 12z" fill="currentColor"/>',
  title: 'threejs-grass · Infinite WebGPU grass for three.js and React Three Fiber',
  description: 'Infinite, terrain-aware WebGPU grass for three.js and React Three Fiber: tiled LOD streaming, 12 presets, wind, interaction, grass maps and a terrain painter.',
  pitch: 'Infinite, terrain-aware WebGPU grass: 12 presets, four LODs, wind, interaction and a terrain painter.',
  label: 'WebGPU · three.js · React Three Fiber',
  headline: 'A field guide to <em>infinite</em> grass.',
  lede: 'Dense, terrain-aware grass that streams around your camera. Wind, interaction, grass maps and a terrain painter, from one call to <code>Grass.create()</code> or one <code>&lt;Grass /&gt;</code>.',
  hero: { img: 'hero.jpg', alt: 'A dense meadow on rolling hills', embed: { src: '?embed', title: 'Live grass demo', ns: 'threejs-grass' } },
  thumb: 'hero.jpg',
  demos: [
    { label: 'three.js demo', href: 'index.html' },
    { label: 'React Three Fiber demo', href: 'r3f.html' },
  ],
  stats: [['~700k', 'blades on screen'], ['12', 'grass presets'], ['4', 'levels of detail'], ['1', 'function call']],
  install: 'npm i threejs-grass three',
  code: {
    heading: 'Plant it with <em>one call.</em>',
    intro: "Give it your camera, scene, renderer and terrain. Tiles stream in around the camera, LODs thin out the far field, and it updates itself every frame. There's no giant mesh to build and no shader code to write.",
    three: { src: `
import { Grass } from 'threejs-grass'

const grass = await Grass.create({
  camera,
  scene,
  renderer,     // WebGPURenderer
  terrain,      // mesh or (x, z) => y
  tileSize: 25,
  maxDistance: 200,
})` },
    r3f: { src: `
import { Grass } from 'threejs-grass/react'

function Field() {
  const terrain = useRef()
  return (
    <>
      <mesh ref={terrain} geometry={hills} />
      <Grass terrain={terrain} preset="tallFescue" />
    </>
  )
}` },
  },
  features: {
    heading: 'Everything a field <em>needs.</em>',
    intro: 'Realistic or stylized, a backyard lawn or a savanna that runs to the horizon. Every feature below is live in the demo.',
    rows: [
      { title: 'Infinite grass', sub: 'A field that follows the camera.', body: 'The world is cut into tiles that stream in and out around the camera, so grass covers as much ground as you can see without one enormous mesh. Placement is deterministic: leave and come back, and every blade is where you left it.', media: { img: 'terrain.jpg', alt: 'Grass covering rolling hills to the horizon' } },
      { title: 'Built for performance', sub: 'Hundreds of thousands of blades, in real time.', body: 'Each tile is split into cells that hold only as many blades as their distance needs. Blades thin out one by one, tiles are frustum-culled, and rebuilds run on a per-frame time budget, so camera moves stay smooth.', media: { img: 'demo-threejs.jpg', alt: 'The demo running with its control panel and frame-rate counter' } },
      { title: 'Twelve presets', sub: 'Real species and stylized worlds.', wide: true, body: 'Start from grass modelled on real species, or from a stylized look, then override any field: height, width, droop, clumping, colours, translucency.', chips: ['Kentucky Bluegrass', 'Perennial Ryegrass', 'Tall Fescue', 'Bermuda', 'Zoysia', 'St. Augustine', 'Buffalo', 'Fine Fescue', 'Toon Meadow', 'Golden Savanna', 'Autumn Haze', 'Frostbite'], media: { img: 'presets.jpg', alt: 'All twelve presets side by side', natural: true } },
      { title: 'Blades or billboards', sub: 'Two ways to grow a field.', body: "Geometric blades for close-ups, or billboard tufts (camera-facing cards cut into strands in the shader) to cover huge areas cheaply. Switching is one setting: <code>type: 'billboards'</code>.", media: { stack: [{ img: 'hero.jpg', alt: 'Geometric grass blades', tag: 'blades' }, { img: 'billboards.jpg', alt: 'Billboard grass tufts', tag: 'billboards' }] } },
      { title: 'Natural wind', sub: 'Gusts you can watch roll across.', body: 'Scrolling gusts plus a travelling ripple, with tunable direction, strength, noise scale and speed, from a light breeze to a storm. Bent blades catch the light, so the wind is visible.', media: { video: 'wind.mp4', poster: 'hero.jpg', alt: 'Wind gusts rolling across a meadow' } },
      { title: 'Interaction', sub: 'Grass that gets out of the way.', body: 'Register characters, vehicles or anything else with an influence radius. Up to 16 objects push blades aside as they move through the field.', media: { video: 'interaction.mp4', poster: 'grass-map.jpg', alt: 'Objects pushing grass aside as they move' } },
      { title: 'Terrain aware', sub: 'It grows where your ground is.', body: 'Pass any mesh or group and it is baked into a heightfield automatically, or pass a height function for procedural, endless worlds. Grass follows slopes and skips ground that is too steep.', media: { img: 'grass-map.jpg', alt: 'Grass following rolling terrain beside a dirt path' } },
      { title: 'Grass maps &amp; painting', sub: 'Paths, clearings and patterns.', body: 'A grass map controls where grass grows and how tall it gets, with naturally tapering edges. Paint it right on your terrain with add, erase, raise and lower brushes, then save it as a PNG.', media: { video: 'painter.mp4', poster: 'painter.jpg', alt: 'Painting grass onto terrain with a brush' } },
      { title: 'Four levels of detail', sub: 'Detail where it counts.', body: 'Each LOD sets a distance, a density and a blade geometry. Density interpolates smoothly between them, and remaining blades widen to keep coverage. <code>debugLods</code> shows them while you tune.', media: { img: 'lods.jpg', alt: 'The field tinted by level of detail' } },
      { title: 'Light that feels real', sub: 'Translucency, sheen and shadows.', body: 'Blades glow when back-lit by the sun, pick up a tinted sheen, darken at the roots, cast and receive shadows, and vary in colour across the field.', media: { img: 'tall-grass.jpg', alt: 'Tall grass back-lit by a low sun' } },
      { title: 'Made for React too', sub: 'A declarative &lt;Grass&gt; component.', body: 'Every setting is a prop, refs work as terrain and interactors, and the painter is a single prop. Fully typed, with every export documented with three.js and R3F examples.', media: { img: 'r3f-demo.jpg', alt: 'The React Three Fiber demo with its control panel', tag: 'React Three Fiber demo' } },
    ],
  },
  final: { heading: 'Go touch <em>grass.</em>', text: 'Try every feature in the live demos, or go straight to the API reference.' },
}
