import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { World, createSample, mulberry32 } from 'threejs-biomes'
import {
  InstanceStates, Lightning, Precipitation, StateField, StateLook, StormDamage, Weather, Wildfire, applyMaterialStatesTo,
} from 'threejs-weathering'
import { uniform } from 'three/tsl'
import { classOf, createPanel } from './panel'

// threejs-weathering sandbox: a 1 km patch of a flat world under seeded weather. Scrub time, change the
// weather, shift-click to start a fire and watch it spread with the wind, scar the ground and regrow.
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: new URLSearchParams(location.search).has('webgl') })
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 0.85
document.body.appendChild(renderer.domElement)
await renderer.init()

const scene = new THREE.Scene()
const sky = new THREE.Color('#9cc4e4'), storm = new THREE.Color('#4b535c')
scene.background = new THREE.Color()
scene.fog = new THREE.FogExp2('#9cc4e4', 0)
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 20_000)
const sun = new THREE.DirectionalLight('#fff1dc', 3)
sun.position.set(-300, 400, -500)
const hemi = new THREE.HemisphereLight('#cfe3ff', '#5a5040', 1)
scene.add(sun, hemi)

const world = new World({ seed: 7 })
// A dry summer: the centre is wet deciduous forest, which at default cover is rarely dry enough to burn.
const weather = new Weather({ seed: 7, fronts: { coverage: -0.5 } }, world)
const SIZE = 1024
const field = new StateField({ size: SIZE, resolution: 128 })
const look = new StateLook()
const clock = { time: 9 * 3600, scale: 60, paused: false }
const shaderTime = uniform(0) // scrubbable animation time for drips and embers

// Terrain: one mesh with vertex colours from the world's ground, weathered by the state field and the fire.
const terrain = buildTerrain(SIZE, 192)
scene.add(terrain)

const fire = new Wildfire({ world, weather, field, center: [0, 0], size: SIZE, cellSize: 8, startTime: clock.time })
scene.add(fire.object)
applyMaterialStatesTo(terrain.material, { ...field.node(), heat: fire.node().heat }, { look, time: shaderTime })

// Trees: two instanced meshes (trunks and crowns), per-instance states picked up from the field.
const trees = buildTrees(900)
scene.add(trees.trunks, trees.crowns)
const treeStates = new InstanceStates(trees.count)
applyMaterialStatesTo(trees.trunks.material, { ...treeStates.node(), heat: 0 }, { look, time: shaderTime, puddles: false })
applyMaterialStatesTo(trees.crowns.material, treeStates.node(), { look, time: shaderTime, foliage: true, puddles: false, streaks: false })
const storms = new StormDamage(weather, { instances: treeStates, positions: trees.positions, field })

const rain = new Precipitation({ weather, camera })
const lightning = new Lightning({ weather, camera, radius: 4000 })
lightning.onStrike((s) => { if (Math.abs(s.x) < SIZE / 2 && Math.abs(s.z) < SIZE / 2) hud.dataset.strike = `${s.x.toFixed(0)}, ${s.z.toFixed(0)}` })
scene.add(rain.object, lightning.object)
Object.assign(window, { world, weather, field, fire, rain, lightning, storms, treeStates, clock, scene, camera }) // for the console

camera.position.set(-260, world.height(-260, 260) + 90, 260)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, world.height(0, 0) + 5, 0)
controls.enableDamping = true
controls.maxDistance = 4000

// Shift-click: ignite where the cursor hits the terrain.
const ray = new THREE.Raycaster(), pointer = new THREE.Vector2()
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!e.shiftKey) return
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
  ray.setFromCamera(pointer, camera)
  const hit = ray.intersectObject(terrain)[0]
  if (hit) fire.ignite(hit.point.x, hit.point.z, 6)
})

// Panel: every option of every class, plus time and a few presets.
const gui = createPanel([
  {
    name: 'threejs-weathering',
    classes: [
      classOf('Weather', weather, weather.options, { skip: ['seed', 'direction'], ranges: { coverage: [-1, 1, 0.01], temperatureOffset: [-30, 30, 0.5], chance: [0, 1, 0.01] } }),
      classOf('Precipitation', rain, rain.options, { skip: ['override', 'seed'] }),
      classOf('Lightning', lightning, lightning.options),
      classOf('Wildfire', fire, { ...fire.options, look: fire.look }, { skip: ['ignitions', 'species', 'grassPresets', 'lines', 'center', 'size', 'cellSize', 'startTime', 'seed'] }),
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

const hud = document.getElementById('hud')!
let last = performance.now()
let treeTick = 0
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  if (!clock.paused) clock.time += dt * clock.scale
  shaderTime.value = clock.time % 3600
  controls.update()

  fire.update(clock.time)
  field.updateFromWeather(weather, clock.time, 3)
  field.update()
  rain.update(clock.time)
  lightning.update(clock.time)
  storms.update(clock.time)
  if (now - treeTick > 250) {
    treeTick = now
    treeStates.sampleField(field, trees.positions, { channels: ['wetness', 'snow'], mode: 'replace' })
    treeStates.sampleField(field, trees.positions, { channels: ['burn'] })
  }

  // Sky darkens under cloud, flashes with lightning; fog from the weather.
  const w = rain.sample
  const bg = scene.background as THREE.Color
  bg.copy(sky).lerp(storm, w.cloudCover * 0.8).lerp(new THREE.Color('#e8eeff'), lightning.flash * 0.6)
  const fog = scene.fog as THREE.FogExp2
  fog.color.copy(bg)
  fog.density = 0.0002 + w.fog * 0.012 + Math.min(1, w.precipitation / 10) * 0.004
  sun.intensity = 3 * (1 - w.cloudCover * 0.8)
  hemi.intensity = 1 + lightning.flash * 2

  renderer.render(scene, camera)

  const s = fire.sim.stats
  const day = Math.floor(clock.time / 86400), hh = Math.floor((clock.time % 86400) / 3600), mm = Math.floor((clock.time % 3600) / 60)
  hud.textContent = `day ${day} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} · ×${clock.scale}
${w.type} ${w.precipitation.toFixed(1)} mm/h · cloud ${(w.cloudCover * 100).toFixed(0)}% · ${w.temperature.toFixed(1)} °C · humidity ${(w.humidity * 100).toFixed(0)}%
wind ${w.windSpeed.toFixed(1)} m/s (gust ${w.gust.toFixed(1)}) · storm ${w.storm.toFixed(2)} · fog ${w.fog.toFixed(2)}${hud.dataset.strike ? ` · last strike ${hud.dataset.strike}` : ''}
fire: ${s.burning} burning · ${s.burnt} burnt · ${s.regrowing} regrowing · ${(s.consumed / 1000).toFixed(0)} t fuel burnt`
})

function buildTerrain(size: number, segments: number) {
  const geo = new THREE.PlaneGeometry(size, size, segments, segments).rotateX(-Math.PI / 2)
  const pos = geo.attributes.position
  const colors = new Float32Array(pos.count * 3)
  const s = createSample(8)
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i)
    world.sample(x, z, s)
    pos.setY(i, s.elevation)
    const { color } = world.ground(s, 0)
    c.setRGB(color[0], color[1], color[2], THREE.SRGBColorSpace)
    colors.set([c.r, c.g, c.b], i * 3)
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.computeVertexNormals()
  return new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.95 }))
}

function buildTrees(count: number) {
  const rand = mulberry32(7)
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.4, 4, 6).translate(0, 2, 0), new THREE.MeshStandardNodeMaterial({ color: '#5a4030', roughness: 0.9 }), count)
  const crowns = new THREE.InstancedMesh(new THREE.ConeGeometry(2.4, 7, 8).translate(0, 7, 0), new THREE.MeshStandardNodeMaterial({ color: '#2f5a2a', roughness: 0.8 }), count)
  const positions = new Float32Array(count * 3)
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3()
  let n = 0
  for (let tries = 0; n < count && tries < count * 10; tries++) {
    const x = (rand() - 0.5) * SIZE * 0.9, z = (rand() - 0.5) * SIZE * 0.9
    const s = world.sample(x, z)
    if (s.waterLevel > s.elevation) continue
    const k = 0.7 + rand() * 0.6
    m.compose(v.set(x, s.elevation, z), q.setFromAxisAngle(v.clone().set(0, 1, 0), rand() * 6.28), sc.set(k, k, k))
    trunks.setMatrixAt(n, m)
    crowns.setMatrixAt(n, m)
    positions.set([x, s.elevation, z], n * 3)
    n++
  }
  trunks.count = crowns.count = n
  trunks.computeBoundingSphere()
  crowns.computeBoundingSphere()
  return { trunks, crowns, positions: positions.subarray(0, n * 3), count: n }
}
