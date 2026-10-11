// Lander data for threejs-water. Schema and conventions: see landing/build.mjs and landing/packages/grass.mjs.
export default {
  short: 'water',
  name: 'threejs-water',
  status: 'live',
  accent: '#1d5b8f',
  icon: '<path d=\"M3 12c3-3 5-3 8 0s5 3 8 0 5-3 8 0M3 19c3-3 5-3 8 0s5 3 8 0 5-3 8 0M3 26c3-3 5-3 8 0s5 3 8 0 5-3 8 0\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>',
  title: 'threejs-water · Oceans, rivers and lakes for three.js and React Three Fiber',
  description: 'WebGPU oceans, rivers and lakes for three.js and React Three Fiber: Gerstner waves, foam, refraction, flowing rivers, real drainage and lakes, from the beach to orbit.',
  pitch: 'Oceans, rivers and lakes in WebGPU: one-draw-call seas from the beach to orbit, flowing rivers and real drainage.',
  label: 'WebGPU · three.js · React Three Fiber',
  headline: 'Water from the <em>beach to orbit.</em>',
  lede: 'An ocean that is one draw call at every altitude, rivers that flow downhill, and lakes that fill to their spill level. Drop it on a <code>threejs-biomes</code> world, flat or planet, or use it on its own for a plain sea.',
  hero: { img: 'water/hero.jpg', alt: 'Waves rolling onto a sandy coast at a river mouth' },
  thumb: 'water/thumb.jpg',
  demos: [
    { label: 'three.js demo', href: 'water.html' },
    { label: 'Planet demo', href: 'water.html?planet' },
  ],
  stats: [['1', 'draw call for the sea'], ['16', 'Gerstner waves, max'], ['~330', 'rings, beach to horizon'], ['3', 'kinds of water']],
  install: 'npm i threejs-water threejs-biomes three',
  code: {
    heading: 'Fill the sea with <em>one call.</em>',
    intro: 'Give it your camera, scene, renderer and world. The ocean takes its sea level and planet radius from the world, the rivers stream in around the camera, and both update themselves whenever the scene renders.',
    three: { src: `
import { World } from 'threejs-biomes'
import { Ocean, Rivers } from 'threejs-water'

const world = new World({ seed: 'coast' })

const ocean = await Ocean.create({
  camera, scene, renderer, // WebGPURenderer
  world, sun,
  waves: { amplitude: 0.8, direction: [0, 1] },
  whitecaps: 0.6,
})
const rivers = await Rivers.create({ camera, scene, renderer, world, sun, maxDistance: 2000 })

// Buoyancy: depth below the waves and the surface normal.
const { depth, normal } = ocean.waterAt(boat.position.x, boat.position.y, boat.position.z)` },
    r3f: { src: `
import { Water } from 'threejs-water/react'

function Coast({ world, sun }) {
  return (
    <Water
      world={world}
      sun={sun}
      ocean={{ waves: { amplitude: 0.8 }, deepColor: '#06283a' }}
      rivers={{ maxDistance: 2000, flowSpeed: 1.4 }}
    />
  )
}` },
  },
  features: {
    heading: 'Every kind of <em>water.</em>',
    intro: 'A sea that covers everything below sea level, rivers along the valleys, and lakes where the ground holds water. Every feature below is live in the demo.',
    rows: [
      { title: 'One ocean, every altitude', sub: 'From an ant on the beach to orbit.', body: 'The sea is a camera-centred grid of concentric rings: dense under the camera, sparse at the horizon, and rescaled with the camera\'s height. It is one mesh and one draw call whether you stand in the surf or look at a whole hemisphere.', media: { img: 'water/rings.jpg', alt: 'The ocean stretching from the shore to the horizon' } },
      { title: 'Planets too', sub: 'The same sea, bent onto a sphere.', body: 'On a planet the grid is built in the tangent plane under the camera and bent onto the sea sphere in the vertex shader, clamped at the horizon. Wave phases are computed in float64, so the water stays smooth millions of metres from the origin.', media: { img: 'water/planet.jpg', alt: 'A 120 km planet seen from orbit with its ocean' } },
      { title: 'Gerstner waves', sub: 'A wind sea you can tune.', body: 'Up to 16 Gerstner waves summed around a wind direction, with tunable amplitude, wavelength range, spread, choppiness and speed. Per-pixel wave normals and drifting ripples add detail, and fade out before they alias.', chips: ['amplitude', 'wavelength', 'direction', 'spread', 'choppiness', 'speed'], media: { img: 'water/storm.jpg', alt: 'Tall, choppy waves with whitecaps' } },
      { title: 'Light through water', sub: 'Shallow to deep, clear to dark.', body: 'Depth-based absorption fades from <code>shallowColor</code> to <code>deepColor</code>, the bottom refracts through the surface, and Fresnel reflections pick up the sky or an <code>environment</code> map. A GGX glint follows the sun.', media: { img: 'water/shallows.jpg', alt: 'Clear shallow water over sand turning blue offshore' } },
      { title: 'Foam', sub: 'Shorelines, whitecaps and rapids.', body: 'Foam gathers where the water gets shallow at the shore, on the sharpest wave crests (<code>whitecaps</code>), and in river rapids where the flow gets fast. One <code>foam</code> setting scales all three.', media: { img: 'water/foam.jpg', alt: 'White foam along the shoreline' } },
      { title: 'Rivers that flow', sub: 'Streamed along the world\'s rivers.', body: 'River surfaces are built in camera-centred tiles under a per-frame time budget. Flow follows the slope of the surface, so flow-mapped ripples and rapids foam move downstream, faster where it is steep.', media: { img: 'water/river.jpg', alt: 'A river winding through green land to the sea' } },
      { title: 'Real drainage', sub: 'Lakes at their spill level, rivers by catchment.', body: '<code>computeHydrology</code> fills depressions (Priority-Flood+ε), routes flow downhill (D8), accumulates catchment area, and returns rivers that widen downstream and lakes at their spill level. <code>riverModifiers</code> carves the rivers into the world and <code>Lakes</code> draws them.', media: { img: 'water/lakes.jpg', alt: 'Carved rivers and lakes from the bounded hydrology' } },
      { title: 'Queries for gameplay', sub: 'Buoyancy, swimming and splashes.', body: '<code>ocean.waterAt(x, y, z)</code> returns the wavy surface, depth and normal under a point. <code>waterAt(world, x, z)</code> says whether it is sea or river, with level, depth and flow velocity. Pure functions, no GPU readback.', media: { img: 'water/sandbox.jpg', alt: 'The demo with its control panel and live water readout', tag: 'three.js demo' } },
      { title: 'Made for React too', sub: '&lt;Ocean&gt;, &lt;Rivers&gt;, &lt;Lakes&gt; and &lt;Water&gt;.', body: 'Every setting is a prop and live; removing a prop reverts it. <code>&lt;Water&gt;</code> draws a world\'s ocean and rivers at once, and refs give you the underlying classes for <code>waterAt</code> and stats.' },
    ],
  },
  final: { heading: 'Go <em>jump in.</em>', text: 'Fly from the beach to orbit in the live demos, or go straight to the API reference.' },
}
