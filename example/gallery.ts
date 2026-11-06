import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import GUI from 'three/addons/libs/lil-gui.module.min.js'
import { World } from 'threejs-biomes'
import { propAssets } from 'threejs-props'
import { vehicleAssets } from 'threejs-vehicles'
import { AssetRegistry, defaults, placeAsset, planSpawns, type AssetDef, type AssetFilter, type SpawnPlan } from 'threejs-worldgen'
import { addOptions, type Choices, type Ranges } from './options-gui'
import { worldGround } from './world-ground'

// threejs-worldgen gallery: every registered asset (props and vehicles) in a fuzzy-searchable list,
// filtered by category, kind and package, with its JSON parameters editable. Click the ground to place
// the selected asset, snapped and seeded; "spawn" scatters the current matches around the view. The
// same world seed and the same click always give the same instance; "save" writes the placements as JSON.
const url = new URLSearchParams(location.search)
const seed = Number(url.get('seed') ?? 7)
const hud = document.getElementById('hud')!
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const search = $<HTMLInputElement>('search')
const results = $<HTMLDivElement>('results')
const params = $<HTMLDivElement>('params')

const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: url.has('webgl') })
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.shadowMap.enabled = true
document.body.appendChild(renderer.domElement)
await renderer.init()

const scene = new THREE.Scene()
const sky = new THREE.Color('#9cc4e4')
scene.background = sky.clone()
scene.fog = new THREE.Fog(sky.clone(), 400, 1800)
const pmrem = new THREE.PMREMGenerator(renderer)
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
scene.environmentIntensity = 0.45
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.2, 4000)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
const sun = new THREE.DirectionalLight('#fff1dc', 3)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
Object.assign(sun.shadow.camera, { left: -160, right: 160, top: 160, bottom: -160, near: 1, far: 900 })
scene.add(sun, sun.target, new THREE.HemisphereLight('#cfe3ff', '#5a5040', 1.1))

// A flat stretch of coastal grassland, the same one the props sandbox uses.
const world = new World({ seed })
const frame = world.frame
const C: [number, number] = [-3000, 2000]
const ground = worldGround(world, [C[0], C[1] + 150], 1400, 200)
const terrain = new THREE.Mesh(ground.terrain, new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.95 }))
terrain.receiveShadow = true
const water = new THREE.Mesh(ground.water, new THREE.MeshStandardNodeMaterial({ color: '#3a6f8f', roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.85 }))
scene.add(terrain, water)
camera.position.set(C[0] + 90, world.height(C[0], C[1]) + 55, C[1] + 90)
controls.target.set(C[0], world.height(C[0], C[1]), C[1])

const registry = new AssetRegistry().register(...propAssets(), ...vehicleAssets())
const filter: AssetFilter = {}
const placed: SpawnPlan[] = []
const objects = new Set<THREE.Object3D>()
let selected: AssetDef | undefined
let overrides: Record<string, unknown> = {}
let paramsGui: GUI | undefined

// The dropdowns list what the registry actually has.
const fill = (select: HTMLSelectElement, values: string[]) => {
  for (const value of [...new Set(values)].sort()) select.add(new Option(value, value))
  select.onchange = () => {
    filter.category = category.value || undefined
    filter.surface = (kind.value || undefined) as AssetFilter['surface']
    filter.package = packageOf.value || undefined
    render()
  }
}
const category = $<HTMLSelectElement>('category')
const kind = $<HTMLSelectElement>('kind')
const packageOf = $<HTMLSelectElement>('package')
fill(category, registry.list().map((a) => a.category))
fill(kind, ['ground', 'water', 'underwater', 'air', 'shore'])
fill(packageOf, registry.list().map((a) => a.package))
search.oninput = () => render()
document.getElementById('scatter')!.onclick = () => void spawn()
document.getElementById('save')!.onclick = save
document.getElementById('clear')!.onclick = clear
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

function render() {
  const found = registry.search(search.value.trim(), 80, filter)
  results.replaceChildren(...found.map(({ asset }) => {
    const button = document.createElement('button')
    button.className = asset === selected ? 'on' : ''
    button.append(asset.name, Object.assign(document.createElement('small'), { textContent: `${asset.category} · ${asset.package} · ${asset.placement.surface}` }))
    button.onclick = () => select(asset)
    return button
  }))
  hud.textContent = `${found.length}/${registry.list().length} assets · ${placed.length} placed` +
    (selected ? `\n${selected.name} selected: click the ground to place` : '\nselect an asset to place it')
}

function select(asset: AssetDef) {
  selected = asset
  overrides = defaults(asset)
  paramsGui?.destroy()
  params.replaceChildren()
  const fields = Object.entries(asset.params)
  if (fields.length) {
    paramsGui = new GUI({ container: params, width: 284, title: `${asset.name} parameters` })
    const ranges: Ranges = {}
    const choices: Choices = {}
    for (const [key, p] of fields) {
      if (p.type === 'number') ranges[key] = [p.min, p.max, p.step]
      if (p.type === 'choice') choices[key] = p.options
    }
    addOptions(paramsGui, overrides, () => {}, { ranges, choices })
  } else paramsGui = undefined
  render()
}

async function place(x: number, z: number) {
  if (!selected) return
  const result = await placeAsset(registry, selected.id, world, frame, x, z, `${seed}:${placed.length}`, overrides)
  if (!result) {
    hud.textContent = `${selected.name} doesn't fit there: it needs ${selected.placement.surface}`
    return
  }
  scene.add(result.object)
  objects.add(result.object)
  placed.push(result.plan)
  render()
}

async function spawn() {
  const ids = registry.search(search.value.trim(), 80, filter).map((m) => m.asset.id)
  if (!ids.length) return
  const plans = planSpawns(registry, world, frame, controls.target.x, controls.target.z, 140, 24, `${seed}:${placed.length}:spawn`, { ids })
  for (const plan of plans) {
    const object = await registry.create(plan.id, plan.id === selected?.id ? overrides : {}, plan.seed)
    object.position.set(plan.x, plan.y, plan.z)
    object.rotation.y = plan.yaw
    scene.add(object)
    objects.add(object)
    placed.push(plan)
  }
  render()
}

function save() {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ seed: world.options.seed, assets: placed }, null, 2)], { type: 'application/json' }))
  a.download = `worldgen-gallery-${world.options.seed}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

function clear() {
  for (const object of objects) object.removeFromParent() // shortcut: geometry stays; fine for a sandbox, dispose if it ever runs long
  objects.clear()
  placed.length = 0
  render()
}

// Click (not orbit-drag) the terrain to place; the ray hit is already in frame coordinates.
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
let down: [number, number] = [0, 0]
renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY] })
renderer.domElement.addEventListener('pointerup', (e) => {
  if (Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
  raycaster.setFromCamera(pointer, camera)
  const hit = raycaster.intersectObject(terrain, false)[0]
  if (hit) void place(hit.point.x, hit.point.z)
})

render()
await spawn()
renderer.setAnimationLoop(() => {
  controls.update()
  renderer.render(scene, camera)
})
