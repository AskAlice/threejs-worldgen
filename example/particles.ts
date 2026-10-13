import * as THREE from 'three/webgpu'
import { pass } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { ParticleGrid, ParticleLighting, ParticleSystem } from 'threejs-particles'
import { classOf, createPanel } from './panel'

// threejs-particles sandbox: a bonfire from three GPU systems (blackbody flames, lit smoke with a plume grid,
// spark streaks) on a plain ground. Every option of every system is in the panel.
const hud = document.getElementById('hud')!
const renderer = new THREE.WebGPURenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.AgXToneMapping
document.body.appendChild(renderer.domElement)
await renderer.init()

const scene = new THREE.Scene()
scene.background = new THREE.Color('#8fb1d6')
scene.fog = new THREE.FogExp2('#8fb1d6', 0.004)
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 2000)
camera.position.set(14, 6, 18)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 4, 0)
controls.enableDamping = true
const sun = new THREE.DirectionalLight('#fff1dc', 3)
sun.position.set(-30, 40, -20)
scene.add(sun, new THREE.HemisphereLight('#cfe3ff', '#4a4030', 0.8))
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshStandardNodeMaterial({ color: '#5d5446', roughness: 0.95 }))
scene.add(ground)

const lighting = new ParticleLighting()
// Heat (channel 0) rises and drifts with the wind; smoke density (channel 1) shadows the smoke.
const grid = new ParticleGrid({ resolution: [24, 32, 24], min: [-30, 0, -30], size: [90, 120, 60], wind: [2, 0, 0], rise: 3 })
const flames = new ParticleSystem({
  capacity: 1500, rate: 160, life: [0.6, 1.2], lighting,
  emitter: { shape: 'disc', size: [1.2, 0, 0], velocity: [0, 1.5, 0], spread: 0.5, temperature: [1750, 2100] },
  forces: { buoyancy: 0.3, ambientTemperature: 300, cooling: 1.2, wind: [2, 0, 0], drag: 2.5, turbulence: 6, turbulenceScale: 1.2, turbulenceSpeed: 1.5 },
  curves: { size: [0.6, 1, 0.8, 0.5], opacity: [0, 1, 0.8, 0], color: ['#ffffff'] },
  render: { shading: 'flame', blending: 'additive', size: 1.1, aspect: 2.6, stretch: 0.1, intensity: 0.45, blackbody: true, softness: 0.4 },
})
const smoke = new ParticleSystem({
  capacity: 2500, rate: 45, life: [12, 20], lighting, grid,
  emitter: { shape: 'disc', position: [0, 2, 0], size: [1, 0, 0], velocity: [0, 1.5, 0], spread: 0.4, temperature: [450, 520] },
  forces: { buoyancy: 0.25, ambientTemperature: 290, cooling: 0.08, wind: [2, 0, 0], windShear: 0.8, drag: 0.4, turbulence: 0.8, turbulenceScale: 6, turbulenceSpeed: 0.1, gridLift: 1.5 },
  curves: { size: [0.4, 1, 1.8, 2.6, 3.2], opacity: [0, 0.8, 0.7, 0.4, 0], color: ['#ffffff'] },
  render: { shading: 'smoke', blending: 'alpha', sort: true, size: 3.5, opacity: 0.7, softness: 1.5, albedo: ['#d6d3ce', '#3b322b'] },
})
const sparks = new ParticleSystem({
  capacity: 1500, rate: 120, life: [1.5, 4], lighting, grid,
  emitter: { shape: 'disc', size: [1, 0, 0], velocity: [0, 4, 0], spread: 3, temperature: [1300, 1600] },
  forces: { gravity: 3, buoyancy: 0.04, cooling: 0.4, wind: [2, 0, 0], drag: 0.8, turbulence: 8, turbulenceScale: 2, turbulenceSpeed: 0.8, gridLift: 1 },
  curves: { size: [1], opacity: [0, 1, 1, 0], color: ['#ffffff'] },
  render: { shading: 'spark', blending: 'additive', size: 0.03, stretch: 0.06, intensity: 5, blackbody: true },
})
smoke.object.renderOrder = 1
flames.object.renderOrder = 2
sparks.object.renderOrder = 3
scene.add(smoke.object, flames.object, sparks.object)
const heat = grid.splat(flames, 0, (p) => p.temperature.sub(400).max(0).div(1200).mul(0.02)) // heat per second
const cell = grid.cellSize()
const density = grid.splat(smoke, 1, (p) => p.size.mul(p.size).mul(p.size).mul(0.2 / (cell.x * cell.y * cell.z)).mul(p.t.oneMinus()))
const fireLight = new THREE.PointLight('#ff8a3a', 40, 60, 1.6)
fireLight.position.set(0, 2, 0)
scene.add(fireLight)

const pipeline = new THREE.RenderPipeline(renderer)
const color = pass(scene, camera).getTextureNode('output')
pipeline.outputNode = color.add(bloom(color, 0.2, 0.3, 1.5))

createPanel([{
  name: 'threejs-particles',
  classes: [
    classOf('flames', flames, flames.options, { skip: ['capacity', 'shading', 'blending', 'sort', 'shadowSteps', 'lightSteps', 'seed'] }),
    classOf('smoke', smoke, smoke.options, { skip: ['capacity', 'shading', 'blending', 'sort', 'shadowSteps', 'lightSteps', 'seed'] }),
    classOf('sparks', sparks, sparks.options, { skip: ['capacity', 'shading', 'blending', 'sort', 'shadowSteps', 'lightSteps', 'seed'] }),
    classOf('grid', grid, grid.options, { skip: ['resolution'] }),
  ],
}], { title: 'threejs-particles' })

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})
Object.assign(window, { flames, smoke, sparks, grid, camera, controls, renderer, scene })

let last = performance.now(), fps = 60, t = 0
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  t += dt
  fps = fps * 0.95 + (1 / Math.max(1e-3, dt)) * 0.05
  controls.update()
  lighting.fromScene(scene)
  // One batched submission: emit + update for each system, the splats (P2G), then the grid resolve.
  renderer.compute([...flames.prepare(renderer, dt, camera), ...smoke.prepare(renderer, dt, camera), ...sparks.prepare(renderer, dt, camera), heat, density, ...grid.resolvePasses(dt)])
  smoke.sort(renderer)
  fireLight.intensity = 40 * (1 + 0.2 * Math.sin(t * 13) + 0.1 * Math.sin(t * 23 + 1))
  pipeline.render()
  hud.textContent = `${fps.toFixed(0)} fps · ${flames.capacity + smoke.capacity + sparks.capacity} particle slots`
})
