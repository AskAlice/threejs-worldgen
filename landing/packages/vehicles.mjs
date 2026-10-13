// Lander data for threejs-vehicles. Schema and conventions: see landing/build.mjs and landing/packages/grass.mjs.
export default {
  short: 'vehicles',
  name: 'threejs-vehicles',
  status: 'dev',
  accent: '#b0251d',
  icon: '<path d=\"M3 22v-5l3-6c.6-1.2 1.6-2 3-2h12c1.4 0 2.4.8 3 2l3 6h1v5zM8 17h16l-2-5H10z\" fill=\"currentColor\"/><circle cx=\"9\" cy=\"23\" r=\"3.4\" fill=\"currentColor\" stroke=\"#f4f1e8\" stroke-width=\"1.4\"/><circle cx=\"23\" cy=\"23\" r=\"3.4\" fill=\"currentColor\" stroke=\"#f4f1e8\" stroke-width=\"1.4\"/>',
  title: 'threejs-vehicles · Procedural animated vehicles for three.js and React Three Fiber (in development)',
  description: 'In development: seeded, animated vehicles for three.js. Cars, bicycles, trains, boats, carriers, aircraft and rockets on roads, rails, sea and air, instanced.',
  pitch: 'In development: seeded cars, trains, ships, aircraft and rockets that drive, sail, fly and launch, in a few draw calls.',
  label: 'In development · WebGPU · three.js · React Three Fiber',
  headline: 'Traffic for every road, rail, sea and <em>sky.</em>',
  lede: 'threejs-vehicles is in development, but usable today. It generates eleven vehicle types from seeds and parameters and moves whole fleets along road networks, rails, harbour loops, flight paths, launch pads and carrier decks.',
  hero: { img: 'vehicles/hero.jpg', alt: 'Traffic in a town street grid with a train on the railway around it' },
  thumb: 'vehicles/thumb.jpg',
  demos: [{ label: 'three.js demo', href: 'vehicles.html?scene' },
    { label: 'Vehicle gallery', href: 'vehicles.html' }, { label: 'React Three Fiber demo', href: 'vehicles-r3f.html' }],
  stats: [['11', 'vehicle types'], ['5', 'domains, land to space'], ['6', 'route kinds'], ['1', 'material for a whole fleet']],
  install: 'npm i threejs-vehicles three',
  code: {
    heading: 'A whole fleet in <em>one object.</em>',
    intro: 'Describe groups of vehicles as plain JSON, each with a type, a count and a route, and add <code>fleet.object</code> to your scene. Roads come from threejs-city\'s <code>city.graph</code> or any graph of that shape. The API is still settling before the first release, so names may change.',
    three: { src: `
import { Fleet, Vehicle } from 'threejs-vehicles'

const fleet = new Fleet({
  groups: [
    { type: 'car', count: 300, route: { kind: 'roads' } },
    { type: 'train', count: 1, params: { wagons: 8, cargo: 'mixed' }, route: { kind: 'path', points: rail } },
    { type: 'aircraft-carrier', count: 1, route: { kind: 'circle', center: [2000, 0, 1400], radius: 1300 } },
    { type: 'fighter-jet', count: 6, route: { kind: 'host', group: 2 } }, // parked on the deck
    { type: 'rocket', count: 1, route: { kind: 'pad', position: [-200, 0, 700], period: 90 } },
  ],
}, { roads: city.graph })
scene.add(fleet.object)
renderer.setAnimationLoop(() => { fleet.update(); renderer.render(scene, camera) })

fleet.set({ lights: 1, exposure: { snowfall: 1 } }) // headlights on; parked cars collect snow
const bus = new Vehicle({ type: 'car', params: { style: 'bus' }, speed: 8, seed: 3 })` },
    r3f: { src: `
import { Fleet, Vehicle } from 'threejs-vehicles/react'

function Traffic({ graph, night, rain }) {
  return (
    <>
      <Fleet
        roads={graph}
        groups={[
          { type: 'car', count: 300, route: { kind: 'roads' } },
          { type: 'bicycle', count: 30, route: { kind: 'roads' } },
        ]}
        lights={night}
        exposure={{ rain }}
      />
      <group position={[0, 0, 5]}>
        <Vehicle type="car" params={{ style: 'bus' }} speed={6} tint="#c0392b" />
      </group>
    </>
  )
}` },
  },
  features: {
    heading: 'What is <em>working now.</em>',
    intro: 'Every row without a "planned" tag is in the package and in the demos: a gallery of every type, and a live scene with traffic, a train, a harbour, a carrier group, planes overhead and a rocket launch. Planned rows are on the roadmap.',
    rows: [
      { title: 'Eleven vehicle types', sub: 'Bicycles to aircraft carriers.', wide: true, body: 'Low-poly, flat-shaded models built into typed arrays, each type with its own JSON parameters: car style, train wagons and cargo, liner decks and funnels, carrier deck spots, rocket stages and boosters. Wheels spin and steer, fans and propellers turn. The same type, parameters and seed always give the same vehicle.', chips: ['Car', 'Bicycle', 'Train', 'Fishing boat', 'Cruise liner', 'Speedboat', 'Hovercraft', 'Aircraft carrier', 'Airplane', 'Fighter jet', 'Rocket'], media: { img: 'vehicles/gallery.jpg', alt: 'Every vehicle type side by side on a grid, each shown about 9 m long' } },
      { title: 'Routes of every kind', sub: 'Roads, rails, loops and parking.', wide: true, body: 'A fleet is a list of groups, each with a route. On a road network, cars and bikes keep to their lane, pick a seeded turn at each junction and round corners on a curve. Trains pull their wagons along a smoothed path.', chips: ['path', 'circle', 'roads', 'static', 'pad', 'host'], media: { img: 'vehicles/hero.jpg', alt: 'Cars driving a town street grid' } },
      { title: 'Boats on real waves', sub: 'Heave, pitch, roll and wakes.', body: 'Pass the same wave settings as a threejs-water ocean and boats bob on them, sampled under bow, stern and both sides, with a wake behind each hull. Bicycles and speedboats lean into turns.', media: { img: 'vehicles/harbour.jpg', alt: 'Fishing boats and speedboats circling off the shore' } },
      { title: 'Carrier decks', sub: 'Vehicles that carry vehicles.', body: 'A <code>host</code> route parks a group on the deck spots of another group\'s vehicles, so fighter jets ride a carrier as it steams in a circle.', media: { img: 'vehicles/carrier.jpg', alt: 'An aircraft carrier at sea with jets parked on its deck' } },
      { title: 'Rocket launches', sub: 'Countdown, ascent, staging.', body: 'Rockets count down on the pad, lift off on a plume and pitch over in a gravity turn, drop spent stages at set times and launch again every <code>period</code> seconds. The flight is analytic, so any moment can be scrubbed to.', media: { img: 'vehicles/launch.jpg', alt: 'A rocket on its launch pad' } },
      { title: 'A fleet in a few draw calls', sub: 'Instanced, with lights at night.', body: 'Every vehicle is drawn through one <code>InstancedMesh</code> per model part (bodies, wheels, fans, stages) with a single shared material, driven from typed arrays. Raise <code>lights</code> with the sky\'s night value and headlights and windows come on.', media: { img: 'vehicles/night.jpg', alt: 'Town traffic at night with headlights and lit windows' } },
      { title: 'Weather and damage', sub: 'Rain, snow and fire.', body: 'Vehicles get wet in rain and dry off, gather snow when parked and shed it at speed, and catch fire in a wildfire. Badly damaged or burning vehicles on land, rail and sea roll to a stop.', media: { img: 'vehicles/snow.jpg', alt: 'Snow on parked cars in a car park' } },
      { title: 'Networks between settlements', sub: 'Rail lines, shipping lanes and air routes.', planned: true, body: '<code>planRoute()</code> already finds plausible loops on a generated world: deep enough water for a hull, flat ground for rails, safe height for aircraft. Next: rail lines, shipping lanes and flight paths between settlements, with traffic placed by threejs-worldgen.' },
    ],
  },
  final: { heading: 'Get things <em>moving.</em>', text: 'threejs-vehicles is in development: drive every vehicle in the live demos, read the API reference, or follow along on GitHub until the first release.' },
}
