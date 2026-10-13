import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { World, WorldTerrain, renderWorldMap } from 'threejs-biomes'
import TerrainWorker from 'threejs-biomes/worker?worker'
import { Population, PopulationOverlay, renderPopulationMap, resolvePopulationOptions, type PopulationInput, type PopulationMapOptions, type PopulationOptions } from 'threejs-city'
import { classOf, createPanel, specOptions, type PanelClass } from './panel'
import { panels } from './population.panel'
import { patch } from './options-gui'

// threejs-city's settlement planner: a flat world with its people, settlements and networks. Every option of
// Population, PopulationOverlay and the 2D map is in the shared panel (population.panel.ts lists the few left out,
// and why), with share-by-URL. Population changes regenerate (batched while you drag).
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
const spec = panels['threejs-city']
const mapOptions = structuredClone(spec.renderPopulationMap.target!)
function drawMap() {
  const n = 256, size = population.options.radius * 2
  const base = renderWorldMap(world, { center: population.options.center, size, resolution: n })
  const { hexResolution, ...rest } = mapOptions as Partial<PopulationMapOptions>
  const top = renderPopulationMap(population.data, { ...rest, hexResolution: (hexResolution ?? -1) < 0 ? null : hexResolution, resolution: n }, population.network, overlay.options.style)
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

// Population regenerates on change: batch the changes made while dragging.
let pending: PopulationInput = {}
let timer: ReturnType<typeof setTimeout> | undefined
const populationInput = {
  set(change: PopulationInput) {
    pending = resolvePopulationOptions(change, pending as PopulationOptions) // deep merge
    clearTimeout(timer)
    timer = setTimeout(() => { const p = pending; pending = {}; population.set(p) }, 200)
  },
}
const { origin: _origin, ...overlayView } = overlay.options
const overlayTarget = { ...structuredClone(overlayView), resolution: overlay.options.resolution === 'auto' ? -1 : overlay.options.resolution }
const overlayClass: PanelClass = {
  name: 'PopulationOverlay',
  target: overlayTarget,
  ...specOptions(spec.PopulationOverlay),
  onChange: (path, value) => {
    if (path[0] === 'resolution') overlay.set({ resolution: (value as number) < 0 ? 'auto' : (value as number) })
    else if (path[0] === 'style') { overlay.set({ style: { [path[1]]: structuredClone(overlayTarget.style[path[1] as keyof typeof overlayTarget.style]) } }); drawMap() } // style merges one level deep
    else overlay.set(patch(path, value))
  },
}
createPanel([{
  name: 'threejs-city',
  classes: [
    classOf('Population', populationInput, population.options, specOptions(spec.Population)),
    overlayClass,
    { name: 'renderPopulationMap', target: mapOptions, onChange: drawMap, ...specOptions(spec.renderPopulationMap) },
  ],
}], { title: 'threejs-city · settlement planner' })

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
