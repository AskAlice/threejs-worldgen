// Lander data for threejs-fauna. Schema and conventions: see landing/build.mjs and landing/packages/grass.mjs.
export default {
  short: 'fauna',
  name: 'threejs-fauna',
  status: 'live',
  accent: '#0f6466',
  icon: '<path d=\"M3 16c4-6 11-8 17-5l8-5-2 10 2 10-8-5c-6 3-13 1-17-5z\" fill=\"currentColor\"/><circle cx=\"9\" cy=\"14.5\" r=\"1.6\" fill=\"#f4f1e8\"/>',
  title: 'threejs-fauna · Procedural fish schools and bird flocks for three.js',
  description: 'Procedural animals for three.js and React Three Fiber: fish schools matched to water, depth and temperature, bird flocks over their biomes. No textures or models.',
  pitch: 'Procedural fish schools and bird flocks that live where they should, with no textures or models.',
  label: 'WebGPU · three.js · React Three Fiber',
  headline: 'Animals that live <em>where they should.</em>',
  lede: 'Fish schools in rivers and seas, matched to water type, temperature and depth, and bird flocks over the biomes they like. Bodies, patterns, swimming and wing beats are all generated, and every group is a seeded flock that never leaves its habitat.',
  hero: { img: 'fauna/hero.jpg', alt: 'Twelve procedural fish species swimming side by side' },
  thumb: 'fauna/thumb.jpg',
  demos: [
    { label: 'Fish gallery', href: 'fauna.html' },
    { label: 'Fish and birds in a world', href: 'fauna.html?world' },
  ],
  stats: [['12', 'fish species'], ['4', 'bird species'], ['0', 'textures or models'], ['1', 'InstancedMesh per species']],
  install: 'npm i threejs-fauna threejs-biomes three',
  code: {
    heading: 'Stock a world in <em>one call.</em>',
    intro: 'Give it your camera, scene, renderer and a <code>threejs-biomes</code> world. Groups spawn in tiles around the camera, nearest first, on a per-frame time budget, and update whenever the scene renders.',
    three: { src: `
import { World } from 'threejs-biomes'
import { Fauna, Fish } from 'threejs-fauna'

const world = new World({ seed: 1 })
const fauna = await Fauna.create({ camera, scene, renderer, world, seed: 7 })
fauna.set({
  birds: { density: 8 },
  fish: { species: { shark: { habitat: { weight: 0 } } } },
  predators: [{ object: camera, radius: 3 }],  // fish scatter from the camera
})

const nemo = await Fish.create({ scene, renderer, preset: 'clownfish', seed: 3 })
nemo.set({ speed: 2, species: { pattern: { stripes: { count: 4 } } } })` },
    r3f: { src: `
import { Fauna, Fish } from 'threejs-fauna/react'

function Wildlife({ world }) {
  return (
    <>
      <Fauna world={world} seed={7} birds={{ density: 6 }} fish={{ density: 250 }} />
      <group position={[0, 1, 0]}>
        <Fish preset="tang" speed={1.5} />
      </group>
    </>
  )
}` },
  },
  features: {
    heading: 'Life in the <em>water and the air.</em>',
    intro: 'Every animal is generated from a few numbers and a seed. Everything below is live in the two demos.',
    rows: [
      { title: 'Twelve fish species', sub: 'Rivers, reefs, cold seas and open water.', wide: true, body: 'Freshwater, warm reef, cold sea and large open-water species, each plain JSON in <code>FISH_SPECIES</code>. Edit one live or pass new ones through <code>species</code>. Every fish varies its size, girth, hue and pattern from the seed.', chips: ['Trout', 'Carp', 'Perch', 'Pike', 'Clownfish', 'Tang', 'Parrotfish', 'Cod', 'Herring', 'Mackerel', 'Tuna', 'Shark'], media: { img: 'fauna/gallery.jpg', alt: 'The gallery demo: all twelve species, with the live species editor open', tag: 'gallery demo' } },
      { title: 'Generated bodies', sub: 'No textures, no models.', body: 'The body is lofted from superellipse sections along a spine and is watertight. Tails can be forked, lunate, rounded or truncate; dorsal, anal, pectoral and pelvic fins are two-sided sheets. Bars, stripes, spots, countershading and iridescence are drawn in the shader.', media: { img: 'fauna/fish-close.jpg', alt: 'Close-up of procedural perch with fins and painted bars' } },
      { title: 'Swimming', sub: 'A wave that runs to the tail.', body: 'Vertex animation on one <code>InstancedMesh</code> per species: a travelling wave that grows toward the tail, its beat set by speed, its phase integrated on the CPU so speed changes never jump. Turning bends the body and the paired fins flutter.' },
      { title: 'Schools that stay in the water', sub: 'Placed by water type, temperature and depth.', body: 'Species are picked per spot from river or sea, temperature and depth. Each school is a seeded boids flock inside a small grid of its water, keeping clear of the bed and the surface so no fin breaks the water. Add <code>predators</code> and they scatter.', media: { img: 'fauna/school.jpg', alt: 'A school of perch swimming over a riverbed' } },
      { title: 'Bird flocks', sub: 'Gulls, crows, swallows and vultures.', body: 'Flocks stream around the camera over the biomes each species likes: gulls over coasts, crows over forests and fields, swallows over meadows, vultures over savanna. Wings flap with a bend toward the tip, glide by turns and bank into curves.', media: { img: 'fauna/birds.jpg', alt: 'A flock of swallows flying over the sea' } },
      { title: 'Streaming and scale', sub: 'Tiles around the camera, anywhere.', body: 'Groups spawn per tile, nearest first, within a <code>buildBudget</code> of milliseconds per frame. Far groups are drawn but not simulated. Matrices are relative to an anchor near the camera, so it works on planets and with a floating <code>origin</code>.', media: { img: 'fauna/world.jpg', alt: 'The world demo at a river mouth, with school and flock counts and its control panel', tag: 'world demo' } },
      { title: 'Seeded, never random', sub: 'The same seed, the same fish.', body: 'Placement and flocking come from the seed, the tile and the world, in fixed simulation steps. Leave and come back, and the same schools are where they were. The tests check every fish stays between the bed and the surface of the real world.' },
      { title: 'Weathered animals', sub: 'Wet, snowy, burnt, damaged.', body: '<code>states</code> takes the shared material states of <code>threejs-weathering</code>. Birds darken when wet and whiten on top in snow; burnt and damaged fish darken and dull.' },
      { title: 'Land wildlife', sub: 'Herds on the ground.', planned: true, body: 'Deer, cattle and other herds that graze where the biomes suit them. <code>FaunaLayer</code> is the slot: species, habitat, mesh, material and animation, with placement, streaming and boids shared.' },
      { title: 'Thousands per school', sub: 'Boids on the GPU.', planned: true, body: 'Boids run on the CPU today, which is deterministic and fine for hundreds per group. The next step is a WebGPU compute pass with storage buffers and a grid neighbour search for schools in the thousands.' },
    ],
  },
  final: { heading: 'Go <em>fish.</em>', text: 'Browse every species in the gallery, follow schools and flocks through a world, or go straight to the API reference.' },
}
