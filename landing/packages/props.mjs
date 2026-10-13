// Lander data for threejs-props. Schema and conventions: see landing/build.mjs and landing/packages/grass.mjs.
export default {
  short: 'props',
  name: 'threejs-props',
  status: 'dev',
  accent: '#45474d',
  icon: '<path d=\"M10 29V7c0-3 3-4 6-4h7M23 3v3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M19 6h8l-1.5 4h-5z\" fill=\"currentColor\"/><path d=\"M6 29h8\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>',
  title: 'threejs-props · Procedural street and countryside props and road surfaces for three.js (in development)',
  description: 'In development: seeded street and countryside props for three.js. Street lights, power lines, mailboxes, signs, fences and road surfaces, instanced and weather-aware.',
  pitch: 'In development: street lights, power lines, mailboxes, fences and road surfaces, placed along your roads and drawn instanced.',
  label: 'In development · WebGPU · three.js · React Three Fiber',
  headline: 'The small things that make a street <em>lived in.</em>',
  lede: 'threejs-props is in development, but usable today: <code>decorateRoads()</code> lines a road network with street lights, signs, mailboxes, power poles and fences, and <code>Props</code> draws them all as instanced meshes. Every prop is seeded, so each one looks different but rebuilds the same.',
  hero: { img: 'props/hero.jpg', alt: 'A town junction lined with street lights, traffic lights, bins and hydrants, pylons in the distance' },
  thumb: 'props/thumb.jpg',
  thumbAlt: 'A crossroads with traffic lights and street lights on open ground, power pylons in the distance',
  demos: [{ label: 'three.js demo', href: 'props.html' }, { label: 'React Three Fiber demo', href: 'props-r3f.html' }],
  stats: [['14', 'prop kinds'], ['32', 'styles across them'], ['4', 'road surfaces'], ['1', 'mesh per shape and material']],
  install: 'npm i threejs-props threejs-biomes three',
  code: {
    heading: 'Decorate a road in <em>one call.</em>',
    intro: 'Hand <code>decorateRoads()</code> a road network (threejs-city\'s <code>city.graph</code>, or plain nodes and edges) and a world, and it returns plain JSON placements. <code>Props</code> turns them into instanced meshes. The API is still settling before the first release, so names may change.',
    three: { src: `
import { Props, RoadPath, decorateRoads, planPowerLine } from 'threejs-props'
import { World } from 'threejs-biomes'

const world = new World({ seed: 7 })
const placements = [
  ...decorateRoads(roads, world, { seed: 7, mailboxes: { style: 'eu' } }),
  ...planPowerLine([[-500, 300], [550, 420]], world, { spacing: 260 }),
]
const props = await Props.create({ scene, placements })

new RoadPath({ scene, height: world.height, points: [[0, 0], [80, 30], [200, 20]],
  width: 5, surface: { surface: 'gravel' } })

props.set({ night: 1, states: { wetness: 0.7 } }) // lamps on, everything wet
props.states.set(3, { damage: 1 })                 // prop 3 leans over` },
    r3f: { src: `
import { useMemo } from 'react'
import { Props, RoadPath, decorateRoads } from 'threejs-props/react'

function Street({ roads, world, night, rain }) {
  const placements = useMemo(() => decorateRoads(roads, world, { seed: 7 }), [roads, world])
  return (
    <>
      <Props placements={placements} night={night} states={{ wetness: rain }} />
      <RoadPath points={[[0, 0], [60, 20], [140, 10]]} height={world.height} width={4}
        surface={{ surface: 'dirt', states: { wetness: rain } }} />
    </>
  )
}` },
  },
  features: {
    heading: 'What is <em>working now.</em>',
    intro: 'Every row without a "planned" tag is in the package and in the demo: a town junction, a gravel road with a power line, pylons across the fields and a gallery of every prop. Planned rows are on the roadmap.',
    rows: [
      { title: 'Fourteen prop kinds', sub: 'From mailboxes to transmission pylons.', wide: true, body: 'Thirty-two styles in all: US and EU mailboxes, wood or concrete poles, cobra-head or post street lights, picket, rail, adobe and stone fences, five road signs and more. Each column in the gallery is a new seed: size, colour and detail change, and the same seed always rebuilds the same prop.', chips: ['Mailbox (US)', 'Mailbox (EU)', 'Power pole', 'Transmission pylon', 'Street light', 'Fence', 'Road sign', 'Bench', 'Bin', 'Fire hydrant', 'Traffic light', 'Bus stop', 'Hay bale', 'Well'], media: { img: 'props/gallery.jpg', alt: 'Rows of every prop kind and style, three seeds each' } },
      { title: 'Streets that furnish themselves', sub: 'Lights, hydrants, signals and signs.', body: '<code>decorateRoads()</code> spaces street lights, hydrants, bins, benches and bus stops along urban sidewalks, puts traffic lights, stop signs and name signs at junctions, and keeps junctions clear. Props never stand in water, on the carriageway or on each other.', media: { img: 'props/hero.jpg', alt: 'A decorated town junction with street lights and traffic lights' } },
      { title: 'Country roads', sub: 'Poles, mailboxes, fences and hay.', body: 'Rural roads get a power line down one side, mailboxes at lot frontages, fence runs and hay bales in the fields. Styles follow the biome: adobe walls and wells in dry country, stone in the mountains, rails in the taiga.', media: { img: 'props/rural.jpg', alt: 'A gravel road with power poles, a rail fence and hay bales' } },
      { title: 'Power lines that sag', sub: 'Real catenary cables.', body: 'Poles and pylons that share a <code>line</code> id are strung together with cables that hang in a true catenary. <code>planPowerLine()</code> spaces pylons along a route between two places and slides them out of water.', media: { img: 'props/pylons.jpg', alt: 'A line of transmission pylons crossing open fields' } },
      { title: 'Road surfaces', sub: 'Asphalt, cobblestone, gravel and dirt.', body: 'A TSL road material with lane markings, worn tyre tracks, cracks and patches, cobblestones, gravel, and rutted dirt with potholes and a grassy crown. <code>RoadPath</code> drapes it on the terrain as a ribbon with curbs and sidewalks or sloped verges; threejs-city\'s roads can adopt it too.', media: { stack: [{ img: 'props/hero.jpg', alt: 'Asphalt roads with markings and sidewalks', tag: 'asphalt' }, { img: 'props/rural.jpg', alt: 'A gravel road and a dirt track', tag: 'gravel and dirt' }] } },
      { title: 'Lamps and signals', sub: 'Street lights at night, traffic lights on a cycle.', body: 'Street lamps glow as night falls, driven by a number or a TSL node such as the sky\'s night value. Traffic lights cycle red, amber and green with a per-light phase, every <code>trafficCycle</code> seconds.', media: { img: 'props/night.jpg', alt: 'Street lights and traffic lights glowing at a junction at night' } },
      { title: 'Weather and damage', sub: 'Wet, snowy, burnt, leaning.', body: 'Each prop has its own threejs-weathering state, so storms and fires work on props directly. Wet props darken and shine, snow settles on top and weighs the cables down, burnt props char, and damaged poles, lights and signs lean over.', media: { img: 'props/storm.jpg', alt: 'A rural road under snow: poles leaning after a storm, cables sagging under ice' } },
      { title: 'Instanced from unit shapes', sub: 'One mesh per shape and material.', body: 'Props are assembled from eight unit shapes and eleven shared materials. Every part of every prop is drawn through one <code>InstancedMesh</code> per shape and material, tinted per instance from typed arrays: the demo draws 230 props as 2,460 instances in 26 instanced meshes.', media: { img: 'props/sandbox.jpg', alt: 'The props sandbox with its weather panel and a draw-call counter', tag: 'three.js demo' } },
      { title: 'Props across a generated world', sub: 'Placed by threejs-worldgen.', planned: true, body: 'Each prop already carries a placement rule (mailboxes near lots, pylons on links between settlements, street lights on urban sidewalks). Next: threejs-worldgen decorates every generated city and road with them and offers them in the asset gallery.' },
    ],
  },
  final: { heading: 'Furnish your <em>streets.</em>', text: 'threejs-props is in development: try every prop in the live demo, read the API reference, or follow along on GitHub until the first release.' },
}
