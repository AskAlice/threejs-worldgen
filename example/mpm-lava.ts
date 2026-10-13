import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { pass, saturation } from 'three/tsl'
import { WorldTerrain } from 'threejs-biomes'
import TerrainWorker from 'threejs-biomes/worker?worker'
import { Sky } from 'threejs-sky'
import { LAVA_PRESETS, MPMLava, MPMSolver, ParticleLighting, ParticleSystem } from 'threejs-particles'
import { createPanel, classOf, specOptions } from './panel'
import { panels } from './mpm-lava.panel'
import { HAZE, SPARKS, check, emitLayer, lavaConfig, lavaInput, lavaScene, lavaStats } from './mpm-lava-scene'

// threejs-particles MPM lava sandbox (#74): a vent on the flank of a volcano in a threejs-biomes world pours basalt down
// the slope. The lava cools by radiation, convection and contact with the ground, its viscosity climbs (Arrhenius), a
// crust forms below the solidus, cracks as the molten interior pushes on, and is carried along by it. It glows by
// blackbody colour from its temperature, with heat haze and a few sparks over the hottest lava.
// URL: `?preset=aa` (default pahoehoe), `?night`, `?check` (GPU vs CPU reference, recorded as a test fixture).
const hud = document.getElementById('hud')!
const params = new URLSearchParams(location.search)
const renderer = new THREE.WebGPURenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.AgXToneMapping
renderer.shadowMap.enabled = true
document.body.appendChild(renderer.domElement)
await renderer.init()

if (params.has('check')) hud.textContent = await check(renderer)
else await sandbox()

async function sandbox() {
  const { world, DX, RES, origin, vent: v, camera: view0 } = lavaScene(params.has('close'))

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 30000)
  // Ground: the biomes terrain (its LOD reaches centimetres at the camera, on the same heights the solver collides with).
  const terrain = await WorldTerrain.create({ world, camera, scene, createWorker: () => new TerrainWorker(), castShadow: true })
  // Sky over Kīlauea: atmosphere, sun or moon light with shadows, environment light and exposure.
  const sky = await Sky.create({ renderer, scene, camera, observer: { latitude: 19.4, longitude: -155.3 }, clock: { date: '2026-03-04T12:00:00Z', paused: true }, // a day after full moon: a moonlit night
    // Exposure capped like a camera at an eruption: at night it exposes for the lava, not for the dark land around it.
    lighting: { autoExposure: true, exposureRange: [0.25, 0.7] } })
  // The lava as a light source: a few point lights over the brightest clusters of glowing surface (from the read-back).
  const glows = Array.from({ length: 4 }, () => new THREE.PointLight('#ff8a3c', 0, 0, 2))
  scene.add(...glows)

  const presetName = (params.get('preset') === 'aa' ? 'aa' : 'pahoehoe') as keyof typeof LAVA_PRESETS
  const mpm = new MPMSolver(renderer, { ...lavaConfig(RES, DX, origin, presetName), height: world.height })
  mpm.object.visible = false
  const lighting = new ParticleLighting()
  const lava = new MPMLava(mpm, { ...lavaInput(presetName), lighting, envMap: scene.environment })
  scene.add(lava.object)
  if (params.has('nolava')) lava.object.visible = false // debug: the scene without the lava surface

  // Heat haze and sparks over the hottest lava.
  const haze = new ParticleSystem({ ...HAZE, lighting })
  const sparks = new ParticleSystem({ ...SPARKS, lighting })
  scene.add(haze.object, sparks.object)

  // The vent: near the uphill edge of the domain, pouring downhill.
  const view = { night: params.has('night'), preset: presetName, vent: true, ventSpeed: 0.5, ventRadius: 0.6, follow: false }
  let layerClock = 0
  const reset = () => { mpm.clear(); layerClock = 0 }

  camera.position.set(...view0.position)
  const controls = new OrbitControls(camera, renderer.domElement)
  // Bloom: the glare of incandescent lava (only what is brighter than white after exposure blooms).
  const pipeline = new THREE.RenderPipeline(renderer)
  const color = pass(scene, camera).getTextureNode('output')
  // AgX's "punchy" look: a saturation lift into the tone mapper, so incandescence stays orange instead of going pastel.
  pipeline.outputNode = saturation(color.add(bloom(color, 0.35, 0.5, 0.6)), 1.35)
  controls.target.set(...view0.target)
  controls.enableDamping = true

  // Day: late morning; night: a moonless hour before midnight (the lava is the light).
  const setDayNight = () => { sky.setTimeOfDay(view.night ? 22.5 : 10.5) }
  sky.update(0)
  setDayNight()
  sky.follow(controls.target)

  const gui = createPanel([{
    name: 'threejs-particles', classes: [
      classOf('MPMSolver', mpm, mpm.options, specOptions(panels['threejs-particles'].MPMSolver)),
      classOf('MPMLava', lava, lava.options, specOptions(panels['threejs-particles'].MPMLava)),
    ],
  }], { title: 'threejs-particles · MPM lava' })
  const demo = gui.addFolder('demo')
  demo.add(view, 'preset', ['pahoehoe', 'aa']).name('preset (pāhoehoe / ʻaʻā)').onChange((k: keyof typeof LAVA_PRESETS) => {
    mpm.set({ materials: { lava: LAVA_PRESETS[k].material } })
    lava.set(LAVA_PRESETS[k].lava)
  })
  demo.add(view, 'night').name('night').onChange(setDayNight)
  demo.add(view, 'vent').name('vent erupting')
  demo.add(view, 'ventSpeed', 0.1, 2, 0.05).name('vent speed (m/s)')
  demo.add(view, 'ventRadius', 0.2, 1.2, 0.01).name('vent radius (m)')
  demo.add(view, 'follow').name('domain follows camera target')
  demo.add({ reset }, 'reset').name('clear the lava')

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
  })

  // Read-back every 1.5 s: haze/spark sources, the lava light, and flow statistics for the HUD.
  const { stats, measure, hud: status } = lavaStats(renderer, mpm, lava, haze, sparks, glows, v)
  let reading = false, lastRead = performance.now()
  Object.assign(window, { mpm, lava, world, camera, controls, renderer, scene, sky, terrain, lavaStats: stats, view, setDayNight, vent: v })

  let last = performance.now(), fps = 60
  renderer.setAnimationLoop(() => {
    const now = performance.now()
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    fps = fps * 0.95 + (1 / Math.max(1e-3, dt)) * 0.05
    controls.update()
    if (view.follow) mpm.center(controls.target.x, controls.target.y, controls.target.z)
    const step = 1 / 60 // fixed step: deterministic, and slow motion rather than instability when frames drop
    if (view.vent && mpm.count + 200 < mpm.capacity) {
      layerClock += step * view.ventSpeed
      while (layerClock >= DX / 2) { emitLayer(lava, world, v, view.ventRadius, view.ventSpeed); layerClock -= DX / 2 } // one particle layer per spacing of outflow
    }
    sky.update()
    // The terrain's aerial perspective (when its material has one) follows the sky's sun and horizon colour.
    const aerial = terrain.uniforms as { sunDirection?: { value: THREE.Vector3 }; hazeColor?: { value: THREE.Color } }
    aerial.sunDirection?.value.set(...sky.state.sunDirection)
    const fog = sky.lighting?.fogColor
    if (fog) aerial.hazeColor?.value.setRGB(fog[0], fog[1], fog[2])
    lava.setEnvironment(scene.environment)
    lighting.fromScene(scene)
    lava.uniforms.environmentIntensity.value = scene.environmentIntensity
    renderer.compute([...lava.prepare(step), ...haze.prepare(renderer, step, camera), ...sparks.prepare(renderer, step, camera)])
    lava.render(renderer, camera)
    pipeline.render()
    if (!reading && mpm.time > 0.5 && now - lastRead > 1500) { lastRead = now; reading = true; void measure().finally(() => (reading = false)) }
    hud.textContent = status(fps, `${view.preset}${view.night ? ' · night' : ''}`)
  })
}
