import * as THREE from 'three/webgpu'
import { Fn, attribute, instancedBufferAttribute, modelWorldMatrix, pass, positionWorld, uniform, vec4 } from 'three/tsl'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { World, WorldTerrain, createSample } from 'threejs-biomes'
import TerrainWorker from 'threejs-biomes/worker?worker'
import type { Scatter } from 'threejs-scatter'
import type { VegetationSpecies } from 'threejs-trees'
import { Sky } from 'threejs-sky'
import { Lightning, Precipitation, StateField, StateLook, StormDamage, Weather, Wildfire, applyMaterialStatesTo } from 'threejs-weathering'
import { classOf, createPanel } from './panel'
import { keepAboveGround } from './shared'

// threejs-weathering sandbox: a 1 km patch of a threejs-biomes world (its streaming terrain and material), a
// threejs-trees forest placed by the biomes, and a threejs-sky sun, atmosphere and fog, under seeded weather.
// Scrub time, change the weather, shift-click to start a fire and watch it spread with the wind, scar the
// ground and regrow. ?webgl forces WebGL 2 (no GPU particles there); ?notrees skips the forest, ?noimpostors
// skips baking far-tree impostors, ?nowater skips the rivers and sea.
const params = new URLSearchParams(location.search)
const hud = document.getElementById('hud')!
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl') })
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.AgXToneMapping
renderer.shadowMap.enabled = true
document.body.appendChild(renderer.domElement)
await renderer.init()

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 30_000)
const world = new World({ seed: 7 })
const height = (x: number, z: number) => world.height(x, z)

// A dry summer: the centre is wet deciduous forest, which at default cover is rarely dry enough to burn.
const weather = new Weather({ seed: 7, fronts: { coverage: -0.5 } }, world)
const SIZE = 1024
const field = new StateField({ size: SIZE, resolution: 128 })
const look = new StateLook()
const clock = { time: 13 * 3600, scale: 60, paused: false }
const shaderTime = uniform(0) // scrubbable animation time for drips and embers

camera.position.set(-260, height(-260, 260) + 90, 260)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, height(0, 0) + 5, 0)
controls.enableDamping = true
controls.maxDistance = 4000

hud.textContent = 'building terrain and sky…'
const terrain = await WorldTerrain.create({ world, camera, scene, createWorker: () => new TerrainWorker(), castShadow: true })
const sky = await Sky.create({ renderer, scene, camera, world, clock: { date: '2026-07-20T12:00:00Z', paused: true }, observer: { latitude: 44, longitude: 0 }, lighting: { autoExposure: true },
  // Fire weather: a few fair-weather cumulus, no cirrus, little stratus (the weather sets the coverage).
  clouds: { cirrus: { amount: 0 }, stratus: { amount: 0.15 } } })
sky.follow(controls.target)

const fire = new Wildfire({
  world, weather, field, renderer, camera, center: [0, 0], size: SIZE, cellSize: 8, startTime: clock.time,
  look: { haze: { enabled: true }, bloom: { enabled: true } },
})
scene.add(fire.object)

// The ground: the terrain's own material, weathered by the state field (wet, snow) and the fire (char, ash, glow).
const fireNodes = fire.node()
const fieldNodes = field.node()
applyMaterialStatesTo(terrain.material, { wetness: fieldNodes.wetness, snow: fieldNodes.snow, ...fireNodes }, { look, time: shaderTime, streaks: false })

// The forest: threejs-trees species where the biomes say they grow, wet / snowy / burnt / damaged from the same states.
const species: VegetationSpecies[] = [
  { name: 'oak', density: 0.32, group: 'broadleaf', cluster: { scale: 120, threshold: 0.45, strength: 0.9 } },
  { name: 'beech', density: 0.26, group: 'broadleaf', cluster: { scale: 120, threshold: 0.45, strength: 0.9 } },
  { name: 'maple', density: 0.22, group: 'broadleaf', cluster: { scale: 100, threshold: 0.5, strength: 0.8 } },
  { name: 'fir', density: 0.3, cluster: { scale: 160, threshold: 0.55, strength: 1 } },
  { name: 'shrub', density: 0.3, cluster: { scale: 40, threshold: 0.5, strength: 0.7 } },
  { name: 'fern', density: 0.45, cluster: { scale: 25, threshold: 0.45, strength: 0.8 } },
  { name: 'boulder', density: 0.12 },
  { name: 'rock', density: 0.15 },
]
const sample = createSample(8)
const best: Record<string, number> = {}
for (const b of world.options.biomes) for (const e of b.scatter) best[e.species] = Math.max(best[e.species] ?? 0, e.probability)
const biomeDensity = (name: string, x: number, z: number) => {
  world.sample(x, z, sample)
  if (sample.waterLevel > sample.elevation - 0.3) return 0
  let d = 0
  for (let k = 0; k < sample.count; k++) {
    const e = world.options.biomes[sample.biomes[k]].scatter.find((s) => s.species === name)
    if (e) d += sample.weights[k] * e.probability
  }
  return Math.min(1, d / (best[name] || 1))
}
// One burn value per tree: sampled at the instance's origin, not per vertex (threejs-trees drops whole leaf cards
// by comparing burn with a per-card random, so a value that varies across one card would tear it).
const origins = new WeakMap<THREE.BufferAttribute, THREE.InstancedInterleavedBuffer>()
const instanceOriginXZ = Fn((builder: any) => {
  const object = builder.object
  // Impostors carry their position in an instanced attribute; mesh levels in the instance matrix.
  if (builder.geometry?.hasAttribute('scatterPosition')) return modelWorldMatrix.mul(vec4(attribute('scatterPosition', 'vec4').xyz, 1)).xz
  const im = object?.instanceMatrix as THREE.InstancedBufferAttribute | undefined
  if (!im || im.array.length === 0) return positionWorld.xz
  let ib = origins.get(im)
  if (!ib) origins.set(im, (ib = new THREE.InstancedInterleavedBuffer(im.array, 16, 1)))
  const data = ib
  let seen = -1
  const sync = uniform(0).onObjectUpdate(() => {
    if (im.version !== seen) { seen = im.version; data.needsUpdate = true }
    return 0
  })
  return modelWorldMatrix.mul(vec4((instancedBufferAttribute(data as any, 'vec3', 16, 12) as any).add(sync), 1)).xz
})
let scatter: Scatter | null = null
let setTreeEnvironment: typeof import('threejs-trees').setTreeEnvironment | null = null
if (!params.has('notrees')) {
  hud.textContent = 'growing trees…'
  // Loaded on demand, so ?notrees runs without the forest packages.
  const [{ Scatter, disposeLayers }, trees] = await Promise.all([import('threejs-scatter'), import('threejs-trees')])
  setTreeEnvironment = trees.setTreeEnvironment
  const layers = await trees.createVegetationLayers({
    species, variants: 2, seed: 7, simplifiedDetail: 0.35, castShadow: true, renderer: params.has('noimpostors') ? null : renderer, density: biomeDensity,
    weather: { wetness: fieldNodes.wetness, snow: fieldNodes.snow, burn: fire.node(instanceOriginXZ() as any).burn, damage: fieldNodes.damage },
  })
  scatter = Scatter.create({ camera, scene, terrain: height, layers, seed: 7, maxDistance: 1400 })
  addEventListener('beforeunload', () => { scatter?.dispose(); disposeLayers(layers) })
}
// Water: threejs-water rivers and sea (on demand; ?nowater skips them).
if (!params.has('nowater')) {
  const { Ocean, Rivers } = await import('threejs-water')
  await Ocean.create({ camera, scene, renderer, world, sun: sky.sun })
  await Rivers.create({ camera, scene, renderer, world, sun: sky.sun })
}
const storms = new StormDamage(weather, { field })

const rain = new Precipitation({ weather, camera })
const lightning = new Lightning({ weather, camera, radius: 4000 })
lightning.onStrike((s) => { if (Math.abs(s.x) < SIZE / 2 && Math.abs(s.z) < SIZE / 2) hud.dataset.strike = `${s.x.toFixed(0)}, ${s.z.toFixed(0)}` })
scene.add(rain.object, lightning.object)

// Post: the fire's optional bloom on the scene pass. Minimal on purpose, so a shared pipeline can replace it.
const pipeline = new THREE.RenderPipeline(renderer)
const buildPipeline = () => {
  pipeline.outputNode = fire.bloom(pass(scene, camera).getTextureNode('output'))
  pipeline.needsUpdate = true
}
buildPipeline()
Object.assign(window, { world, weather, field, fire, rain, lightning, storms, clock, scene, camera, controls, renderer, pipeline, sky, terrain, scatter }) // for the console

// Shift-click: ignite where the cursor ray meets the ground (marched against the world's height).
const ray = new THREE.Raycaster(), pointer = new THREE.Vector2(), at = new THREE.Vector3()
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!e.shiftKey) return
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
  ray.setFromCamera(pointer, camera)
  for (let d = 0; d < 6000; d += 2) {
    at.copy(ray.ray.direction).multiplyScalar(d).add(ray.ray.origin)
    if (at.y <= height(at.x, at.z)) { fire.ignite(at.x, at.z, 6); break }
  }
})

// Panel: every option of every class, plus time and a few presets.
const gui = createPanel([
  {
    name: 'threejs-weathering',
    classes: [
      classOf('Weather', weather, weather.options, { skip: ['seed', 'direction'], ranges: { coverage: [-1, 1, 0.01], temperatureOffset: [-30, 30, 0.5], chance: [0, 1, 0.01] } }),
      classOf('Precipitation', rain, rain.options, { skip: ['override', 'seed'] }),
      classOf('Lightning', lightning, lightning.options),
      {
        ...classOf('Wildfire', fire, { ...fire.options, look: fire.look }, { skip: ['ignitions', 'species', 'grassPresets', 'lines', 'center', 'size', 'cellSize', 'startTime', 'seed', 'resolution'] }),
        onChange: (path, value) => {
          fire.set(path.reduceRight<any>((v, k) => ({ [k]: v }), value))
          if (path.join('.') === 'look.bloom.enabled') buildPipeline()
        },
      },
      classOf('StateLook', look, look.options),
      classOf('StormDamage', storms, storms.options),
    ],
  },
])
const sandbox = gui.addFolder('sandbox')
sandbox.add(clock, 'scale', 0, 3600, 1).name('time scale (s per s)')
sandbox.add(clock, 'paused')
sandbox.add(clock, 'time', 0, 30 * 86400, 60).name('time (scrub)').listen()
const preset = (input: Parameters<Weather['set']>[0]) => () => weather.set(input)
sandbox.add({ clear: preset({ fronts: { coverage: -0.8 }, temperatureOffset: 0 }) }, 'clear')
sandbox.add({ rain: preset({ fronts: { coverage: 0.9 }, temperatureOffset: 0 }) }, 'rain')
sandbox.add({ snow: preset({ fronts: { coverage: 0.9 }, temperatureOffset: -16 }) }, 'snow')
sandbox.add({ thunderstorm: preset({ fronts: { coverage: 0.2 }, temperatureOffset: 12, storms: { chance: 1 } }) }, 'thunderstorm')
sandbox.add({ gale: preset({ wind: { speed: 28, gustiness: 0.8 } }) }, 'gale')
sandbox.add({ 'ignite centre': () => fire.ignite(0, 0, 10) }, 'ignite centre')

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

let last = performance.now()
let fps = 60
let skyHour = -1, skyCloud = -1, skyFog = -1, slow = 0
const tint: [number, number, number] = [1, 1, 1]
const tintColor = new THREE.Color()
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = Math.min(0.1, (now - last) / 1000)
  fps = fps * 0.95 + (1 / Math.max(1e-3, dt)) * 0.05
  last = now
  if (!clock.paused) clock.time += dt * clock.scale
  shaderTime.value = clock.time % 3600
  controls.update()
  keepAboveGround(camera, height, 2)

  field.updateFromWeather(weather, clock.time, 3)
  field.update()
  rain.update(clock.time)
  lightning.update(clock.time)
  storms.update(clock.time)
  scatter?.update()

  // Sky time follows the sandbox clock; clouds and fog follow the weather (throttled: they rebuild a little).
  const w = rain.sample
  const hour = (clock.time % 86400) / 3600
  if (Math.abs(hour - skyHour) > 0.01) { sky.setTimeOfDay(hour); skyHour = hour }
  if (now - slow > 2000) {
    slow = now
    const cover = Math.round(w.cloudCover * 20) / 20, fog = Math.round((0.00015 + w.fog * 0.01 + Math.min(1, w.precipitation / 10) * 0.003) * 1e5) / 1e5
    if (cover !== skyCloud) { sky.set({ clouds: { coverage: cover } }); skyCloud = cover }
    if (fog !== skyFog) { sky.set({ lighting: { fogDensity: fog } }); skyFog = fog }
  }
  sky.update(0)
  // The fire lights its smoke with the clear sun (its own self-shadowing does the rest)...
  fire.update(clock.time, 8, dt)
  // ...then the plume dims and reddens the sun for everything under it, where you look.
  fire.sunTransmittance(controls.target.x, controls.target.z, tint)
  sky.sun.color.multiply(tintColor.setRGB(0.4 + 0.6 * tint[0], 0.4 + 0.6 * tint[1], 0.4 + 0.6 * tint[2]))
  setTreeEnvironment?.({ sun: sky.sun, windStrength: Math.min(1.5, w.windSpeed / 12) })

  pipeline.render()

  const s = fire.sim.stats
  const day = Math.floor(clock.time / 86400), hh = Math.floor(hour), mm = Math.floor((clock.time % 3600) / 60)
  hud.textContent = `${fps.toFixed(0)} fps · day ${day} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} · ×${clock.scale}
${w.type} ${w.precipitation.toFixed(1)} mm/h · cloud ${(w.cloudCover * 100).toFixed(0)}% · ${w.temperature.toFixed(1)} °C · humidity ${(w.humidity * 100).toFixed(0)}%
wind ${w.windSpeed.toFixed(1)} m/s (gust ${w.gust.toFixed(1)}) · storm ${w.storm.toFixed(2)} · fog ${w.fog.toFixed(2)}${hud.dataset.strike ? ` · last strike ${hud.dataset.strike}` : ''}
fire: ${s.burning} burning · ${s.burnt} burnt · ${s.regrowing} regrowing · ${(s.consumed / 1000).toFixed(0)} t fuel burnt · smoke ${(fire.uniforms.smokeOcclusion.value * 100).toFixed(0)}%`
})
