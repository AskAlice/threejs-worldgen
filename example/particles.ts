import * as THREE from 'three/webgpu'
import { pass } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { ParticleGrid, ParticleLighting, ParticleSystem } from 'threejs-particles'
import { classOf, createPanel, specOptions } from './panel'
import { FLAMES, GRID, SMOKE, SPARKS, panels } from './particles.panel'

// threejs-particles sandbox: a bonfire from three GPU systems (blackbody flames, lit smoke with a plume grid,
// spark streaks) on a plain ground. Every option of every system is in the panel (particles.panel.ts lists the few
// left out, and why), with share-by-URL.
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
const grid = new ParticleGrid(GRID)
const flames = new ParticleSystem({ ...FLAMES, lighting })
const smoke = new ParticleSystem({ ...SMOKE, lighting, grid })
const sparks = new ParticleSystem({ ...SPARKS, lighting, grid })
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

const spec = panels['threejs-particles']
createPanel([{
  name: 'threejs-particles',
  classes: [
    classOf('flames', flames, flames.options, specOptions(spec.flames)),
    classOf('smoke', smoke, smoke.options, specOptions(spec.smoke)),
    classOf('sparks', sparks, sparks.options, specOptions(spec.sparks)),
    classOf('grid', grid, grid.options, specOptions(spec.grid)),
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
