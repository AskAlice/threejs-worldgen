import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import GUI from 'three/addons/libs/lil-gui.module.min.js'
import { World, WorldTerrain, renderWorldMap } from 'threejs-biomes'
import TerrainWorker from 'threejs-biomes/worker?worker'
import { Population, PopulationOverlay, renderPopulationMap, type PopulationInput, type PopulationMode } from 'threejs-population'
import { addOptions, patch } from './options-gui'

// threejs-population sandbox: a flat world with its people, settlements and networks; every option live.
const renderer = new THREE.WebGPURenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)
await renderer.init()

const scene = new THREE.Scene()
scene.background = new THREE.Color('#0d1424')
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 1, 400_000)
camera.position.set(0, 26_000, 30_000)
const sun = new THREE.DirectionalLight('#fff1dc', 2.5) // Object3D.position is read-only, so set it rather than assign it
sun.position.set(1, 2, 1)
scene.add(new THREE.HemisphereLight('#cfe3ff', '#4a4030', 1.2), sun)

const world = new World({ seed: 1 })
const terrain = await WorldTerrain.create({ world, camera, scene, createWorker: () => new TerrainWorker() })
const population = new Population(world)
const overlay = new PopulationOverlay({ population, camera })
scene.add(overlay.object)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true

const hud = document.getElementById('hud')!
const map = (document.getElementById('map') as HTMLCanvasElement).getContext('2d')!
const ui = { map: 'density' as PopulationMode }
function drawMap() {
  const n = 256, size = population.options.radius * 2
  const base = renderWorldMap(world, { center: population.options.center, size, resolution: n })
  const top = renderPopulationMap(population.data, { mode: ui.map, resolution: n }, population.network)
  for (let i = 0; i < base.length; i += 4) {
    const a = top[i + 3] ? 0.75 : 0
    for (let k = 0; k < 3; k++) base[i + k] = base[i + k] * (1 - a) + top[i + k] * a
  }
  map.putImageData(new ImageData(base, n), 0, 0)
  const count: Record<string, number> = {}
  for (const s of population.data.settlements) count[s.class] = (count[s.class] ?? 0) + 1
  hud.textContent = `${population.data.total.toLocaleString()} people · H3 res ${population.data.resolution} (${population.data.cellEdge.toFixed(0)} m)\n` +
    Object.entries(count).map(([k, v]) => `${v} ${k}`).join(' · ') + `\n${population.network.edges.length} network links`
}
population.onChange(drawMap)
drawMap()

const gui = new GUI({ title: 'threejs-population' })
gui.add(ui, 'map', ['density', 'landUse', 'lights', 'habitability']).onChange(drawMap)
let pending: ReturnType<typeof setTimeout> | undefined
addOptions(gui.addFolder('Population'), structuredClone(population.options) as Record<string, any>, (path, value) => {
  clearTimeout(pending)
  pending = setTimeout(() => population.set(patch(path, value) as PopulationInput), 200)
}, { skip: ['location', 'center', 'fertility', 'avoid'], ranges: { ruralShare: [0, 1, 0.01], zipf: [0.5, 2, 0.01], levels: [1, 4, 1], jitter: [0, 1, 0.01], hamletChance: [0, 1, 0.01], farmsteadChance: [0, 1, 0.01], water: [0, 1, 0.01] } })
const overlayOptions = structuredClone(overlay.options) as Record<string, any>
overlayOptions.resolution = -1 // −1 = auto in this panel
addOptions(gui.addFolder('Overlay'), overlayOptions, (path, value) => {
  if (path[0] === 'resolution') overlay.set({ resolution: (value as number) < 0 ? 'auto' : (value as number) })
  else overlay.set(patch(path, value))
}, { skip: ['origin', 'densityRamp', 'lightRamp', 'habitabilityRamp'], choices: { mode: ['density', 'landUse', 'lights', 'habitability'] }, ranges: { resolution: [-1, 10, 1], opacity: [0, 1, 0.01], gap: [0, 0.5, 0.01] } })

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})
renderer.setAnimationLoop(() => {
  controls.update()
  terrain.update()
  overlay.update()
  renderer.render(scene, camera)
})
Object.assign(window, { world, population, overlay, terrain })
