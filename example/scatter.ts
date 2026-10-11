// Forest demo for threejs-scatter + threejs-trees.
//   scatter.html          a mixed forest streaming around the camera (impostors far away)
//   scatter.html?lineup   every species preset and rock preset side by side
//   add &webgl to force the WebGL2 backend, &noimpostors to skip impostor baking
import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Scatter, disposeLayers, type ScatterLayer } from 'threejs-scatter'
import {
  createBarkMaterial, createFruitMaterial, createLeafMaterial, createRockMaterial, createVegetationLayers, generateRock, generateTree, rocks, setTreeEnvironment, species,
  type SpeciesName, type VegetationSpecies,
} from 'threejs-trees'
import { patch } from './options-gui'
import { classOf, createPanel, type PanelClass } from './panel'
import { createEnvironment, createGroundMaterial, hills, hillsGeometry, keepAboveGround } from './shared'

const params = new URLSearchParams(location.search)
const lineup = params.has('lineup')
const hud = document.getElementById('hud')!

const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl') })
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)
await renderer.init()

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 5000)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
const env = createEnvironment(renderer, scene, camera)
const height = lineup ? () => 0 : hills

const ground = new THREE.Mesh(lineup ? new THREE.PlaneGeometry(1200, 1200).rotateX(-Math.PI / 2) : hillsGeometry(2400, 480), createGroundMaterial())
ground.receiveShadow = true
scene.add(ground)

let scatter: Scatter | null = null
let vegetation: PanelClass | null = null

if (lineup) {
  // Every species in a row (plus rocks), for inspecting the presets.
  const names = Object.keys(species) as SpeciesName[]
  let x = 0
  for (const name of names) {
    const p = species[name]
    const tree = generateTree(p, 1)
    const width = tree.bounds.max.x - tree.bounds.min.x
    x += width / 2 + 2
    // One single-material mesh per part: a material array would share one shadow render object between parts.
    const plant = new THREE.Group()
    const materials = [createBarkMaterial(p), createLeafMaterial(p), createFruitMaterial(p)]
    ;[tree.trunk, tree.leaves, tree.fruit].forEach((g, i) => {
      if (!g) return
      const part = new THREE.Mesh(g, materials[i])
      part.castShadow = part.receiveShadow = true
      plant.add(part)
    })
    plant.position.set(x, 0, 0)
    scene.add(plant)
    x += width / 2 + 2
  }
  let rx = 0
  for (const p of Object.values(rocks)) {
    rx += p.size + 2
    const rock = new THREE.Mesh(generateRock(p, 3), createRockMaterial())
    rock.position.set(rx, 0, 18)
    rock.castShadow = rock.receiveShadow = true
    scene.add(rock)
  }
  camera.position.set(x / 2, 30, 90)
  controls.target.set(x / 2, 10, 0)
} else {
  camera.position.set(0, hills(0, 30) + 6, 30)
  controls.target.set(0, hills(0, 0) + 5, 0)
  const set: VegetationSpecies[] = [
    { name: 'oak', density: 0.35, group: 'broadleaf', cluster: { scale: 120, threshold: 0.45, strength: 0.9 } },
    { name: 'beech', density: 0.25, group: 'broadleaf', cluster: { scale: 120, threshold: 0.45, strength: 0.9 } },
    { name: 'birch', density: 0.2, group: 'broadleaf', cluster: { scale: 90, threshold: 0.5, strength: 0.8 } },
    { name: 'spruce', density: 0.6, cluster: { scale: 160, threshold: 0.55, strength: 1 } },
    { name: 'shrub', density: 0.25, cluster: { scale: 40, threshold: 0.5, strength: 0.7 } },
    { name: 'fern', density: 0.5, cluster: { scale: 25, threshold: 0.45, strength: 0.8 } },
    { name: 'boulder', density: 0.15 },
    { name: 'rock', density: 0.2 },
  ]
  // Every createVegetationLayers option in the panel; a change regenerates (and re-bakes) all layers.
  const veg = {
    seed: 3, variants: 3, simplifiedDetail: 0.35, castShadow: true, impostors: !params.has('noimpostors'),
    impostor: { mode: 'octahedral', frames: 8, size: 512, hemisphere: true, alphaTest: 0.5 },
    density: Object.fromEntries(set.map((s) => [s.name, s.density])) as Record<string, number>,
  }
  const build = async () => {
    const t = performance.now()
    const layers = await createVegetationLayers({
      species: set.map((s) => ({ ...s, density: veg.density[s.name] })), variants: veg.variants, seed: veg.seed, simplifiedDetail: veg.simplifiedDetail,
      castShadow: veg.castShadow, renderer: veg.impostors ? renderer : null, impostor: veg.impostor as VegetationImpostor,
    })
    console.log(`vegetation layers: ${(performance.now() - t).toFixed(0)} ms`)
    return layers
  }
  let layers: ScatterLayer[] = await build()
  scatter = Scatter.create({ camera, scene, terrain: hills, layers, seed: 3, maxDistance: 900 })
  let queue = Promise.resolve()
  let pending: ReturnType<typeof setTimeout> | undefined
  const rebuild = () => {
    clearTimeout(pending)
    pending = setTimeout(() => {
      queue = queue.then(async () => {
        hud.textContent = 'regenerating trees…'
        const next = await build()
        scatter!.set({ layers: next })
        disposeLayers(layers)
        layers = next
      })
    }, 300)
  }
  vegetation = {
    name: 'createVegetationLayers', target: veg, onChange: rebuild,
    ranges: { seed: [1, 100, 1], variants: [1, 6, 1], simplifiedDetail: [0.05, 1, 0.05], frames: [2, 16, 1], size: [128, 2048, 128], alphaTest: [0, 1, 0.01], ...Object.fromEntries(set.map((s) => [s.name, [0, 1, 0.01]])) },
    choices: { mode: ['octahedral', 'billboard'] },
  }
  addEventListener('beforeunload', () => {
    scatter?.dispose()
    disposeLayers(layers)
  })
}
type VegetationImpostor = NonNullable<Parameters<typeof createVegetationLayers>[0]['impostor']>

// `&cam=x,y,z,tx,ty,tz` sets the view (handy for screenshots).
const cam = params.get('cam')?.split(',').map(Number)
if (cam?.length === 6) {
  camera.position.set(cam[0], cam[1], cam[2])
  controls.target.set(cam[3], cam[4], cam[5])
}

const environment = { windStrength: 0.35, windSpeed: 1, wetness: 0, snow: 0, burn: 0, damage: 0 }
setTreeEnvironment(environment)
const unit: [number, number, number] = [0, 1, 0.01]
const classes: PanelClass[] = [
  { name: 'TreeEnvironment', target: environment, onChange: (path, value) => setTreeEnvironment(patch(path, value)), ranges: { windStrength: [0, 1.5, 0.01], windSpeed: [0, 3, 0.01], wetness: unit, snow: unit, burn: unit, damage: unit } },
]
if (vegetation) classes.push(vegetation)
const panelPackages = [{ name: 'threejs-trees', classes }]
if (scatter) {
  const { layers: _layers, ...settings } = scatter.settings
  panelPackages.unshift({
    name: 'threejs-scatter',
    classes: [classOf('Scatter', scatter, settings, {
      ranges: { seed: [1, 100, 1], tileSize: [16, 256, 8], maxDistance: [100, 2000, 10], buildBudget: [0.5, 20, 0.5], lodHysteresis: [0, 0.5, 0.01], refreshDistance: [0.1, 20, 0.1] },
    })],
  })
}
const gui = createPanel(panelPackages)
const sunParams = { elevation: 28, azimuth: 50 }
const sandbox = gui.addFolder('sandbox')
sandbox.add(sunParams, 'elevation', 2, 85).onChange(() => env.setSun(sunParams.elevation, sunParams.azimuth))
sandbox.add(sunParams, 'azimuth', 0, 360).onChange(() => env.setSun(sunParams.elevation, sunParams.azimuth))

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

Object.assign(window, { demo: { scene, camera, controls, scatter, renderer } })
let last = performance.now()
let fps = 60
renderer.setAnimationLoop(() => {
  const now = performance.now()
  fps = fps * 0.95 + (1000 / Math.max(1, now - last)) * 0.05
  last = now
  controls.update()
  keepAboveGround(camera, height, 1)
  env.follow(controls.target)
  setTreeEnvironment({ sun: env.sun })
  scatter?.update()
  env.render()
  const s = scatter?.stats
  hud.textContent = s
    ? `${fps.toFixed(0)} fps · tiles ${s.tiles} · instances ${s.instances} · drawn ${s.visible} · meshes ${s.meshes}`
    : `${fps.toFixed(0)} fps · ${Object.keys(species).length} species, ${Object.keys(rocks).length} rocks`
})
