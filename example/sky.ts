import * as THREE from 'three/webgpu'
import { pass } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Sky, SolarSystem, Stars, moonPhaseName } from 'threejs-sky'
import { classOf, createPanel } from './panel'

// threejs-sky sandbox: day/night, moon phases, stars, meteors, clouds and labelled altitude shells over
// hills, zoomable from ant scale out past the moon's apogee; plus the same star system from afar.
const renderer = new THREE.WebGPURenderer({ antialias: true, reversedDepthBuffer: true, forceWebGL: location.search.includes('webgl') })
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.shadowMap.enabled = true
document.body.appendChild(renderer.domElement)
await renderer.init()

// ---- Ground scene: rolling hills under the sky ----
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 20000)
camera.position.set(0, 12, 40)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 18, 0)
controls.enableDamping = true
controls.minDistance = 0.02 // ant scale
controls.maxDistance = 2e9 // past the moon's apogee

const height = (x: number, z: number) => Math.sin(x * 0.01) * 12 + Math.cos(z * 0.013) * 9 + Math.sin((x + z) * 0.004) * 30 - 20
const ground = new THREE.PlaneGeometry(6000, 6000, 300, 300).rotateX(-Math.PI / 2)
const pos = ground.attributes.position
for (let i = 0; i < pos.count; i++) pos.setY(i, height(pos.getX(i), pos.getZ(i)))
ground.computeVertexNormals()
const terrain = new THREE.Mesh(ground, new THREE.MeshStandardNodeMaterial({ color: '#4d6b3a', roughness: 0.95 }))
terrain.receiveShadow = true
scene.add(terrain)
const monolith = new THREE.Mesh(new THREE.BoxGeometry(4, 18, 1), new THREE.MeshStandardNodeMaterial({ color: '#d8d4cc', roughness: 0.4 }))
monolith.position.set(0, height(0, 0) + 8, 0)
monolith.castShadow = true
scene.add(monolith)

const sky = await Sky.create({
  renderer, scene, camera,
  clock: { date: '2026-08-12T17:30:00Z', dayLength: 240 },
  observer: { latitude: 47, longitude: 8 },
  shootingStars: { rate: 40, shower: 120 },
  lighting: { fogDensity: 0.0006, autoExposure: true },
  shells: { enabled: true },
})
sky.follow(controls.target)

// ---- System scene: the same star system from afar ----
const systemScene = new THREE.Scene()
systemScene.add(new THREE.AmbientLight(0xffffff, 0.04))
const systemCamera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1, 1e8)
systemCamera.position.set(0, 9e4, 2.4e5)
const systemControls = new OrbitControls(systemCamera, renderer.domElement)
systemControls.enableDamping = true
systemControls.enabled = false
const solar = new SolarSystem({ model: sky.system, exaggerateSizes: 300, origin: 'sun', scale: 1e-6 })
const deepSky = new Stars({ seed: 1, magnitudeLimit: 7.5 })
systemScene.add(solar.object, deepSky.object)

// ---- Post: bloom on the sun, the moon and meteors ----
const makePipeline = (s: THREE.Scene, c: THREE.Camera) => {
  const p = new THREE.RenderPipeline(renderer)
  const color = pass(s, c).getTextureNode('output')
  p.outputNode = color.add(bloom(color, 0.25, 0.4, 2.5))
  return p
}
const pipelines = { ground: makePipeline(scene, camera), system: makePipeline(systemScene, systemCamera) }

// ---- Panel: every Sky and SolarSystem option, grouped by package then class ----
const ui = { view: 'ground' as 'ground' | 'orbit' | 'moon' | 'system', timeOfDay: 18 }
const gui = createPanel([
  {
    name: 'threejs-sky',
    classes: [
      classOf('Sky', sky, sky.settings, {
        skip: ['system', 'frame'],
        ranges: {
          seed: [1, 100, 1], latitude: [-89, 89, 0.5], longitude: [-180, 180, 0.5], timeScale: [0, 100_000, 1], dayLength: [0, 3600, 10], maxStep: [0, 1, 0.01],
          height: [10_000, 300_000, 1000], rayleighScaleHeight: [1000, 30_000, 100], mieScaleHeight: [200, 5000, 50], mie: [0, 4e-5, 1e-7], mieAbsorption: [0, 4e-6, 1e-8],
          mieG: [0, 0.99, 0.01], ozoneCenter: [0, 60_000, 500], ozoneWidth: [1000, 40_000, 500], density: [0, 4, 0.01], sunIntensity: [0, 60, 0.1], airglowBand: [0, 5, 0.05],
          steps: [1, 64, 1], lightSteps: [1, 16, 1], discIntensity: [0, 200, 1], discScale: [0.2, 20, 0.1], skyGlow: [0, 0.2, 0.001],
          magnitudeLimit: [2, 9, 0.1], darkSky: [1e-6, 1e-3, 1e-6], rate: [0, 600, 1], shower: [0, 2000, 10], minElevation: [0, 90, 1],
          fogDensity: [0, 0.005, 0.00005], environmentResolution: [16, 256, 16], exposureKey: [0.05, 1, 0.01],
          coverage: [0, 1, 0.01], amount: [0, 2, 0.01], featureSize: [1000, 100_000, 500], range: [5000, 200_000, 1000], cellSize: [500, 10_000, 100],
          maxSplats: [0, 64_000, 1000], globalSplats: [0, 64_000, 1000], haze: [1000, 300_000, 1000], sortInterval: [1, 30, 1],
          opacity: [0, 1, 0.01], labelSize: [0.005, 0.1, 0.001],
        },
      }),
      classOf('SolarSystem', solar, solar.settings, {
        skip: ['system', 'origin', 'hidden'],
        ranges: { scale: [1e-7, 1e-5, 1e-7], exaggerateSizes: [1, 2000, 1], exaggerateStar: [1, 100, 1], apsisSize: [0.001, 0.03, 0.001], maxDistance: [1e5, 1e8, 1e5], segments: [8, 128, 8], orbitOpacity: [0, 1, 0.01] },
      }),
    ],
  },
])
const sandbox = gui.addFolder('sandbox')
sandbox.add(ui, 'view', ['ground', 'orbit', 'moon', 'system']).onChange(setView)
sandbox.add(ui, 'timeOfDay', 0, 24, 0.05).name('time of day').onChange((h: number) => sky.setTimeOfDay(h))

function setView(view: typeof ui.view) {
  controls.enabled = view !== 'system'
  systemControls.enabled = view === 'system'
  terrain.visible = monolith.visible = view === 'ground'
  // From orbit the sky's average is mostly black space: use a fixed exposure there.
  sky.set({ lighting: { autoExposure: view === 'ground' } })
  if (view !== 'ground') renderer.toneMappingExposure = 0.6
  // Ground: the hills. Orbit: 400 km up, the planet, its limb and the shells. Moon: looking down from past
  // the apogee shell (in the local frame the planet is always right under the camera).
  const at = { ground: [0, 12, 40, 18], orbit: [0, 400_000, 900_000, 0], moon: [0, 1.4e9, 1e7, 0], system: null }[view]
  if (at) { camera.position.set(at[0], at[1], at[2]); controls.target.set(0, at[3], 0) }
}

addEventListener('resize', () => {
  for (const c of [camera, systemCamera]) { c.aspect = innerWidth / innerHeight; c.updateProjectionMatrix() }
  renderer.setSize(innerWidth, innerHeight)
})

const hud = document.getElementById('hud')!
let hudTimer = 0
Object.assign(window, { demo: { sky, solar, scene, camera, renderer, setView: (v: typeof ui.view) => { ui.view = v; setView(v) } } })
const km = (m: number) => (m < 1 ? `${(m * 100).toFixed(1)} cm` : m < 1000 ? `${m.toFixed(1)} m` : `${(m / 1000).toFixed(m < 1e5 ? 1 : 0)} km`)

renderer.setAnimationLoop(() => {
  if (ui.view === 'system') {
    systemControls.update()
    sky.update() // keeps time running
    solar.update(sky.clock.time, systemCamera)
    pipelines.system.render()
  } else {
    controls.update()
    // Ant to apogee: clip planes from the height above the hills under the camera.
    const above = ui.view === 'ground' ? camera.position.y - height(camera.position.x, camera.position.z) : sky.state.altitude
    ;[camera.near, camera.far] = sky.clipPlanes(above)
    camera.updateProjectionMatrix()
    sky.update()
    pipelines.ground.render()
  }
  if (performance.now() - hudTimer > 250) {
    hudTimer = performance.now()
    const s = sky.state
    hud.textContent = [
      sky.clock.date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      `solar time ${s.solarTime.toFixed(2)} h   night ${s.night.toFixed(2)}`,
      `sun  el ${s.sunElevation.toFixed(1)}°  az ${s.sunAzimuth.toFixed(1)}°`,
      `moon el ${s.moonElevation.toFixed(1)}°  ${moonPhaseName(s.moonPhase)} (${(s.moonIllumination * 100).toFixed(0)}% lit)`,
      `${s.layer}, ${km(Math.max(0, s.altitude))} up (Kármán line ${km(sky.layers.karman)})   near ${km(camera.near)} far ${km(camera.far)}`,
      `cloud cover here ${(sky.cloudCover(camera.position.x, 0, camera.position.z) * 100).toFixed(0)}%   exposure ${sky.exposure.toFixed(2)}`,
    ].join('\n')
  }
})
