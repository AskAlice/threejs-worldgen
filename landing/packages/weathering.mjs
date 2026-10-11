// Lander data for threejs-weathering. Schema and conventions: see landing/build.mjs and landing/packages/grass.mjs.
export default {
  short: 'weathering',
  name: 'threejs-weathering',
  status: 'live',
  accent: '#a5420f',
  icon: '<path d=\"M9 19a6 6 0 0 1 .6-12A8 8 0 0 1 25 9a5 5 0 0 1-1 10z\" fill=\"currentColor\"/><path d=\"M17 17l-5 7h4l-2 6 7-9h-4l2-4z\" fill=\"currentColor\"/>',
  title: 'threejs-weathering · Weather, wildfires and weathered materials for three.js',
  description: 'Seeded weather for three.js and React Three Fiber: rain, snow, wind and lightning, wildfires that spread and regrow, and wet, snowy, burnt and damaged materials.',
  pitch: 'Seeded rain, snow, wind and lightning, wildfires that spread and regrow, and wet, snowy, burnt and damaged materials.',
  label: 'WebGPU · three.js · React Three Fiber',
  headline: 'Weather that <em>leaves a mark.</em>',
  lede: 'Fronts, rain, snow, gusts and thunderstorms over your world, wildfires that spread with fuel, wind and slope, and one material-state layer that makes everything wet, snowy, burnt or damaged. Scrub time backwards or forwards and the same seed always gives the same sky.',
  hero: { img: 'weathering/hero.jpg', alt: 'A wildfire front burning through a conifer forest, smoke drifting downwind' },
  thumb: 'weathering/thumb.jpg',
  demos: [{ label: 'three.js demo', href: 'weathering.html' }],
  stats: [['4', 'material states'], ['24k', 'raindrops, one draw call'], ['27', 'fuel models'], ['3', 'draw calls per wildfire']],
  install: 'npm i threejs-weathering threejs-biomes three',
  code: {
    heading: 'Weather in <em>a few lines.</em>',
    intro: 'Give the weather a <code>threejs-biomes</code> world and a time. Rain, lightning and fire read it; a state field turns it into wet, snowy and burnt ground that any node material can wear.',
    three: { src: `
import { Weather, StateField, Precipitation, Lightning, Wildfire,
  applyMaterialStatesTo } from 'threejs-weathering'

const weather = new Weather({ seed: 'storm', wind: { speed: 9 } }, world)
const field = new StateField({ size: 1024 })
const rain = new Precipitation({ weather, camera })
const lightning = new Lightning({ weather, camera })
const fire = new Wildfire({ world, weather, field, size: 1024 })
scene.add(rain.object, lightning.object, fire.object)
applyMaterialStatesTo(terrain.material, { ...field.node(), heat: fire.node().heat })

// each frame
fire.update(time); rain.update(time); lightning.update(time)
field.updateFromWeather(weather, time); field.update()` },
    r3f: { src: `
import { Weather, Precipitation, Lightning, Wildfire } from 'threejs-weathering/react'

function Sky({ world }) {
  return (
    <Weather world={world} timeScale={60} field={{ size: 1024 }}>
      <Precipitation />
      <Lightning onStrike={(s) => console.log('strike', s.x, s.z)} />
      <Wildfire size={1024} ignitions={[[0, 0, 10, 4]]} />
    </Weather>
  )
}` },
  },
  features: {
    heading: 'Every kind of <em>weather.</em>',
    intro: 'All of it is seeded and a pure function of time, so it scrubs, replays and matches across machines. Everything below runs in the demo.',
    rows: [
      { title: 'Weather systems', sub: 'Fronts that drift with the wind.', body: 'Cloud masses drift along the prevailing wind and change shape over hours. Cover, rain, wind, humidity and fog come from the world\'s climate at each point, so deserts stay dry, rainforests stay wet and mountains get snow. Ask for any place and time with <code>weather.at(x, z, time)</code>.', media: { img: 'weathering/rain.jpg', alt: 'Rain over a forested hill, with the sampled weather in the demo HUD', tag: 'three.js demo' } },
      { title: 'Rain, sleet and snow', sub: 'Particles around the camera.', body: '24,000 rain streaks and 16,000 snowflakes in one instanced draw call each, placed in the vertex shader. Density follows the rate, slant follows the wind, splash rings land on the ground, and temperature decides rain, sleet or snow.', media: { stack: [{ img: 'weathering/rain-close.jpg', alt: 'Rain slanting in the wind through fog over a forest', tag: 'rain' }, { img: 'weathering/snow.jpg', alt: 'Snow falling on snow-covered trees and ground', tag: 'snow' }] } },
      { title: 'Thunderstorms and lightning', sub: 'Strikes you can look up in advance.', body: 'Storm cells grow and die with their own showers, outflow gusts and strike rates. <code>weather.strikes()</code> lists every strike in a box and time window, and <code>Lightning</code> draws them as branching, flickering bolts with a flash. Subscribe with <code>onStrike</code> for thunder.', media: { img: 'weathering/lightning.jpg', alt: 'A branching lightning bolt over a wet valley in the rain' } },
      { title: 'Wildfires', sub: 'Fuel, moisture, wind and slope.', body: 'A cellular fire after Rothermel: spread comes from grass, shrub and tree fuel read off the biome scatter tables, fuel moisture from recent rain, wind along the front and slope. Water, rock, snow, roads and firebreaks stop it, and lightning starts new fires.', media: { img: 'weathering/fire.jpg', alt: 'A fire front with flames and smoke spreading through a conifer forest' } },
      { title: 'Burn scars and regrowth', sub: 'Grass in weeks, trees in decades.', body: 'Cells go unburnt, burning, burnt, regrowing. The scar is written into the state field, so ground and trees char where the fire passed. Grass returns in a month, shrubs in two years, forest in twenty, and regrown land can burn again.', media: { img: 'weathering/burnt.jpg', alt: 'A blackened burn scar across a hillside above unburnt forest' } },
      { title: 'Wet, snowy, burnt, damaged', sub: 'One material layer for everything.', wide: true, body: 'Four states, each 0 to 1. <code>applyMaterialStatesTo()</code> adds them to any node material: wet darkens and glosses, with puddles and drip streaks; snow settles on upward faces; burn scorches, chars, strips leaves and glows; damage cracks and dents. Props, vehicles and fauna wear the same states.', chips: ['wetness', 'snow', 'burn', 'damage', 'heat', 'puddles', 'drip streaks', 'sparkle', 'embers', 'cut-outs'], media: { stack: [{ img: 'weathering/states-wet.jpg', alt: 'Wet ground with puddles shining under a lightning flash', tag: 'wet' }, { img: 'weathering/states-burn.jpg', alt: 'Glowing, scorched ground and leafless trees inside a fire', tag: 'burn' }] } },
      { title: 'State fields and instances', sub: 'A map of what happened where.', body: 'A <code>StateField</code> is a low-resolution world map of the four states that shaders and CPU code both read. It fills with wetness and snow from the weather on a time budget, and with scars from fire. <code>InstanceStates</code> gives each tree, rock or building its own.', media: { img: 'weathering/snow-field.jpg', alt: 'Snow cover from the state field on hills and trees, the valley floor still clear' } },
      { title: 'Storm damage', sub: 'Gales that leave their mark.', body: '<code>StormDamage</code> adds damage wherever gusts pass a threshold, tick by tick, so a gale leaves the same marks every time. <code>applyDamage()</code> does the same for impacts, explosions and falling trees.' },
      { title: 'Made for React too', sub: 'A &lt;Weather&gt; tree.', body: '<code>&lt;Weather&gt;</code> owns the clock and the state field; <code>&lt;Precipitation&gt;</code>, <code>&lt;Lightning&gt;</code> and <code>&lt;Wildfire&gt;</code> drive themselves from it. <code>useWeatherSample(x, z)</code> reads the weather anywhere for your own UI.', media: { img: 'weathering/sandbox.jpg', alt: 'The weathering sandbox with its control panel and weather HUD during a lightning flash', tag: 'three.js demo' } },
    ],
  },
  final: { heading: 'Check the <em>forecast.</em>', text: 'Scrub time, call up a storm and start a fire in the live demo, or go straight to the API reference.' },
}
