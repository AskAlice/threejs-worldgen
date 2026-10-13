// Lander data for threejs-trees. Schema and conventions: see landing/build.mjs and landing/packages/grass.mjs.
export default {
  short: 'trees',
  name: 'threejs-trees',
  status: 'live',
  accent: '#14453a',
  icon: '<path d=\"M16 2 7 14h4l-6 8h9v8h4v-8h9l-6-8h4z\" fill=\"currentColor\"/>',
  title: 'threejs-trees · Procedural trees, plants and rocks for three.js and React Three Fiber',
  description: 'Procedural trees, shrubs, plants and rocks for three.js and React Three Fiber: 29 species grown by space colonisation, 5 rock presets, wind and weather.',
  pitch: '29 procedural species grown by space colonisation, plus shrubs, flowers, ferns and rocks, with wind and weather.',
  label: 'WebGPU · three.js · React Three Fiber',
  headline: 'Grow a <em>whole forest</em> from a seed.',
  lede: 'Twenty-nine species presets, from spruce to baobab to lily pad, grown branch by branch with no model files. Place one hero tree, or turn a species list into a streaming forest with levels of detail and impostors.',
  hero: { img: 'trees/hero.jpg', alt: 'Oak, beech, maple, birch, spruce, pine, fir and a towering redwood side by side' },
  thumb: 'trees/thumb.jpg',
  demos: [
    { label: 'Forest demo', href: 'scatter.html' },
    { label: 'Species lineup', href: 'scatter.html?lineup' },
  ],
  stats: [['29', 'species presets'], ['5', 'rock presets'], ['10', 'plant generators'], ['4', 'weather inputs']],
  install: 'npm i threejs-trees threejs-scatter three',
  code: {
    heading: 'One tree, or <em>a forest.</em>',
    intro: 'Spread a preset and override what you like. <code>generateTree()</code> returns plain geometries for a hero tree; <code>createVegetationLayers()</code> turns a species list into LOD\'d, impostored layers for <a href="../scatter/">threejs-scatter</a>.',
    three: { src: `
import * as THREE from 'three/webgpu'
import { Scatter } from 'threejs-scatter'
import { createBarkMaterial, createLeafMaterial, createVegetationLayers,
  generateTree, setTreeEnvironment, species } from 'threejs-trees'

// One hero tree
const params = { ...species.oak, height: 18 }
const { trunk, leaves } = generateTree(params, 7)
scene.add(new THREE.Mesh(trunk, createBarkMaterial(params)))
if (leaves) scene.add(new THREE.Mesh(leaves, createLeafMaterial(params)))

// A forest: variants, LODs and impostors per species
const layers = await createVegetationLayers({
  species: [{ name: 'spruce', density: 0.6 }, { name: 'birch', density: 0.2 },
            { name: 'fern', density: 0.5 }, { name: 'boulder', density: 0.1 }],
  renderer, // bakes the impostors
})
Scatter.create({ camera, scene, terrain, layers })
setTreeEnvironment({ windStrength: 0.5, snow: 0.3 })` },
    r3f: { src: `
import { Forest, Tree } from 'threejs-trees/react'

function Valley() {
  const ground = useRef()
  return (
    <>
      <mesh ref={ground} geometry={hills} />
      <Tree species="apple" params={{ fruit: 0.4 }} seed={7} />
      <Forest terrain={ground} seed={3} maxDistance={800}
        species={[{ name: 'spruce', density: 0.7 },
                  { name: 'birch', density: 0.2 }]}
        environment={{ windStrength: 0.4 }} />
    </>
  )
}` },
  },
  features: {
    heading: 'Every tree is <em>grown.</em>',
    intro: 'No model files and no leaf textures: branches, leaves, bark and rocks are all generated from plain JSON parameters and a seed. Every species below is in the lineup demo.',
    rows: [
      { title: 'Twenty-nine species', sub: 'From the boreal north to the tropics.', wide: true, body: 'Conifers, broadleaves, savanna, desert and jungle trees, shrubs and ground cover, each a tuned <code>TreeParams</code> preset. Spread one and override any field: <code>{ ...species.oak, height: 20 }</code>.', chips: ['Oak', 'Beech', 'Maple', 'Birch', 'Spruce', 'Pine', 'Fir', 'Redwood', 'Acacia', 'Baobab', 'Palm', 'Jungle emergent', 'Olive', 'Cypress', 'Mangrove', 'Dead snag', 'Cactus', 'Shrub', 'Dwarf shrub', 'Thorn shrub', 'Fern', 'Reed', 'Apple', 'Berry bush', 'Flowers', 'Tall grass tuft', 'Succulent', 'Bamboo', 'Lily pad'], media: { img: 'trees/species.jpg', alt: 'Every species preset side by side, from oak and redwood to ferns, reeds and lily pads', natural: true } },
      { title: 'Space colonisation', sub: 'Branches that grow toward light.', body: 'Attraction points fill a crown envelope (sphere, cone, column, umbrella, vase and more), and branches grow toward them step by step (Runions et al. 2007). Radii follow the pipe model, so the trunk thickens with every twig it carries.', media: { img: 'trees/branching.jpg', alt: 'Oak, beech and maple: branches grown into their crowns' } },
      { title: 'Shrubs, plants and more', sub: 'Ten generators, not just trees.', body: 'Besides space colonisation there are dedicated generators for palms, cacti, ferns, reeds, flowers, grass tufts, succulents, bamboo and lily pads, with <code>stems</code>, <code>fruit</code> and <code>fruitColors</code> for bushes, berries and blooms.', media: { img: 'trees/plants.jpg', alt: 'Cactus, shrubs, ferns, flowers, grass tufts, succulents and bamboo in a row' } },
      { title: 'Rocks', sub: 'Boulders to pebbles.', body: '<code>generateRock()</code> displaces an icosphere with fBm lumps and Worley facets and cracks, cuts the base flat and grows moss on top. Five presets, from scree to cliff chunks, scatter alongside the trees.', chips: ['Boulder', 'Rock', 'Pebble', 'Scree', 'Cliff chunk'], media: { img: 'trees/rocks.jpg', alt: 'The five rock presets from cliff chunk to pebble' } },
      { title: 'Leaves and bark from code', sub: 'Nothing to download.', body: 'Leaf cards are drawn procedurally per shape: broad, needle, palm, fern and blade. TSL materials add wind, back-lit leaves, bark furrows and birch marks, and shift hue, saturation and crown density per instance.', media: { img: 'trees/forest.jpg', alt: 'Close-up of a generated birch: procedural leaf cards and white, marked bark' } },
      { title: 'A forest in one call', sub: 'Species list in, scatter layers out.', body: '<code>createVegetationLayers()</code> grows a few variants per species, adds a simplified mesh and bakes octahedral impostors, scaled to each species\' size. Pass a <code>density</code> function to drive it from a biome table.', media: { img: 'trees/landscape.jpg', alt: 'Oak, beech, birch and spruce layers streaming over hills, impostors toward the horizon' } },
      { title: 'Weather hooks', sub: 'Wet, snowy, burnt, broken.', body: 'Bark, leaf, fruit and rock materials read <code>wetness</code>, <code>snow</code>, <code>burn</code> and <code>damage</code>: snow settles on upward faces, bark chars along its furrows, leaves scorch and drop, branches break off. Set them globally with <code>setTreeEnvironment()</code> or drive them per material from your own TSL nodes.', media: { stack: [{ img: 'trees/snow.jpg', alt: 'The forest under snow', tag: 'snow' }, { img: 'trees/burn.jpg', alt: 'The forest burnt and damaged', tag: 'burn + damage' }] } },
      { title: 'Made for React too', sub: '&lt;Tree&gt; and &lt;Forest&gt;.', body: '<code>&lt;Tree&gt;</code> places one generated tree with any group props. <code>&lt;Forest&gt;</code> takes every <code>&lt;Scatter&gt;</code> prop plus the vegetation options, bakes impostors with the R3F renderer and picks up the first directional light as the sun.', media: { img: 'trees/hero.jpg', alt: 'A lineup of generated trees' } },
    ],
  },
  final: { heading: 'Plant <em>something.</em>', text: 'Walk the forest or inspect every preset in the lineup demo, or go straight to the API reference.' },
}
