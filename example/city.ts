import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { World } from 'threejs-biomes'
import { City, mergeOptions, SETTLEMENT_SIZES, type CityInput } from 'threejs-city'
import { Props } from 'threejs-props'
import { classOf, createPanel, specOptions } from './panel'
import { demoSites, panels, siteInput } from './city.panel'
import { worldGround } from './world-ground'

// threejs-city demo: a settlement placed by the settlement planner (generatePopulation, then planCities) on a
// threejs-biomes world, on a simple terrain mesh sampled from world.frame (rebuilt whenever the city flattens the
// ground). Every City option is in the shared panel (city.panel.ts lists the few it leaves out, and why), with
// share-by-URL. The class picker (`size`, keys 1–6) moves to a settlement of that class: a farmstead with its fields,
// a hamlet at a junction, a village along its road, a town with a main street, a city, a metropolis.
// Keys (they drive the panel): 1–6 class · R new seed · N night · W wet · S snow · B burn · D damage · G layout

const hud = document.getElementById('hud')!
const renderer = new THREE.WebGPURenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.shadowMap.enabled = true
document.body.appendChild(renderer.domElement)
await renderer.init()

const scene = new THREE.Scene()
const day = new THREE.Color('#9cc4e4'), night = new THREE.Color('#0b1020')
scene.background = day.clone()
scene.fog = new THREE.Fog(day.clone(), 1500, 9000)
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1, 30000)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
const sun = new THREE.DirectionalLight('#fff1dc', 3)
sun.castShadow = true
sun.shadow.mapSize.set(4096, 4096)
Object.assign(sun.shadow.camera, { left: -900, right: 900, top: 900, bottom: -900, near: 10, far: 6000 })
const sky = new THREE.HemisphereLight('#cfe3ff', '#5a5040', 1.2)
scene.add(sun, sun.target, sky)

const world = new World({ seed: 11 })
const best = demoSites(world)
let site = best('town')

// Terrain: a grid around the city, coloured by the world's ground mix; water from waterLevel.
const terrainMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.95 })
const waterMaterial = new THREE.MeshStandardNodeMaterial({ color: '#3a6f8f', roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.85 })
const terrain = new THREE.Mesh(new THREE.BufferGeometry(), terrainMaterial)
const water = new THREE.Mesh(new THREE.BufferGeometry(), waterMaterial)
terrain.receiveShadow = true
scene.add(terrain, water)

function buildTerrain(cx: number, cz: number, size: number) {
  const geo = worldGround(world, [cx, cz], size, 256)
  terrain.geometry.dispose(); water.geometry.dispose()
  terrain.geometry = geo.terrain; water.geometry = geo.water
}

let input: CityInput = {} // everything changed in the panel, kept when a new size moves the city to another site
let city!: City
let rebuild = 0
world.onChange(() => (rebuild = performance.now() + 50)) // the city added/removed flatten modifiers
// Only ever called from `queue` (or before it exists), so regenerations never overlap.
async function place() {
  city?.dispose()
  city = await City.create({ world, camera, scene, size: 'town', ...mergeOptions(siteInput(site), input) })
  const r = city.plan!.radius
  buildTerrain(site.x, site.z, r * 3.2)
  rebuild = 0
  const y = world.height(site.x, site.z)
  controls.target.set(site.x, y, site.z)
  camera.position.set(site.x + r * 0.9, y + r * 0.7, site.z + r * 1.1)
  sun.position.set(site.x + 1500, y + 2500, site.z + 800)
  sun.target.position.set(site.x, y, site.z)
  Object.assign(globalThis, { city, camera, controls, world }) // for poking at it from the console
}
await place()

// A farm's hay bales and pasture fences, through threejs-props (rebuilt whenever the plan changes). Its tractor spot
// (`plan.farm.vehicleSpots`) waits for threejs-vehicles' tractor; its corn fields (`crop: 'corn'`) for threejs-grass corn.
let props: Props | null = null
let propsPlan: unknown = null
function farmProps() {
  if (city.plan === propsPlan) return
  propsPlan = city.plan
  props?.dispose()
  props = null
  const farm = city.plan?.farm
  if (!farm?.props.length) return
  props = new Props({ placements: farm.props })
  city.local.add(props.object)
}

// Panel changes are batched (a layout change regenerates the city); a new size picks that size's best site.
// Flushes run one at a time on `queue`: changes made while a new city is being placed stay pending and land on the
// new city once it's ready (a city placed from `input` already has them; set() merges, so re-applying is harmless).
let pending: CityInput = {}
let timer: ReturnType<typeof setTimeout> | undefined
let queue = Promise.resolve()
function flush() {
  queue = queue.then(async () => {
    const p = pending
    pending = {}
    if (!Object.keys(p).length) return
    if (p.size) { site = best(input.size!); await place() } else city.set(p)
  }).catch((e) => console.error(e))
}
const cityInput = {
  set(change: CityInput) {
    input = mergeOptions(input, change)
    pending = mergeOptions(pending, change)
    clearTimeout(timer)
    timer = setTimeout(flush, 100)
  },
}
const cityClass = classOf('City', cityInput, city.options, specOptions(panels['threejs-city'].City))
const gui = createPanel([{ name: 'threejs-city', classes: [cityClass] }], { title: 'threejs-city' })
// Sets an option through its panel control, so keys update the panel and the shared URL too.
function setOption(path: string[], value: unknown) {
  const parent = path.slice(0, -1).reduce((o, k) => o[k], cityClass.target)
  gui.controllersRecursive().find((c) => c.object === parent && c.property === path.at(-1))?.setValue(value)
}

const styles = ['auto', 'grid', 'radial', 'organic']
let fade: number | null = null // N: night fades towards this, then lands in the panel
addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.closest('input, textarea, select')) return // typing in the panel
  const k = e.key.toLowerCase()
  const t = cityClass.target
  const size = SETTLEMENT_SIZES[Number(k) - 1]
  if (size) setOption(['size'], size)
  if (k === 'r') setOption(['seed'], (Number(t.seed) || 0) + 1)
  if (k === 'g') setOption(['style'], styles[(styles.indexOf(t.style) + 1) % styles.length])
  if (k === 'n') fade = (fade ?? city.options.facade.night) > 0.5 ? 0 : 1 // mid-fade: turn back
  const toggle = { w: 'wetness', s: 'snow', b: 'burn', d: 'damage' } as const
  if (k in toggle) {
    const key = toggle[k as keyof typeof toggle]
    const v = t.weather.walls[key] ? 0 : key === 'burn' || key === 'damage' ? 0.6 : 1
    for (const group of ['walls', 'roofs', 'roads']) setOption(['weather', group, key], v)
  }
})
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

renderer.setAnimationLoop(() => {
  controls.update()
  farmProps()
  if (rebuild && performance.now() > rebuild && city.plan) { rebuild = 0; buildTerrain(site.x, site.z, city.plan.radius * 3.2) }
  if (fade !== null) {
    const n = city.options.facade.night, next = n + (fade - n) * 0.05
    if (Math.abs(fade - next) < 0.002) { setOption(['facade', 'night'], fade); fade = null }
    else city.set({ facade: { night: next } }) // only while fading: uniforms only, no regeneration
  }
  const nightValue = city.options.facade.night
  ;(scene.background as THREE.Color).copy(day).lerp(night, nightValue)
  ;(scene.fog as THREE.Fog).color.copy(scene.background as THREE.Color)
  sun.intensity = 3 * (1 - nightValue) + 0.05
  sky.intensity = 1.2 * (1 - nightValue * 0.85)
  const s = city.stats
  const farm = city.plan?.farm
  const crops = farm ? farm.fields.reduce<Record<string, number>>((m, f) => ((m[f.crop] = (m[f.crop] ?? 0) + 1), m), {}) : null
  hud.textContent = `threejs-city — ${city.options.size} (${city.plan?.architecture ?? '…'}, ${city.plan?.style ?? '…'})
${s.buildings} buildings · ${s.roadKm.toFixed(1)} km roads · ${s.bridges} bridges · pop ≈ ${s.population.toLocaleString()}
${crops ? `${Object.entries(crops).map(([k, n]) => `${n} ${k}`).join(' · ')} · tractor ${farm!.vehicleSpots[0]?.working ? 'working' : 'parked'}\n` : ''}${s.detailed} at full detail · generated in ${s.generationMs.toFixed(0)} ms
1–6 class · R seed · G layout · N night · W wet · S snow · B burn · D damage`
  renderer.render(scene, camera)
})
