import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Corn, Grass } from 'threejs-grass'
import { classOf, createPanel, specOptions } from './panel'
import { panels } from './corn.panel'
import { FIELDS, SUN, TRACTOR_RADIUS, createTractor, driveTractor, farm, farmGeometry, farmGrassMap, predrive, view } from './corn-shared'
import { createEnvironment, createGroundMaterial, keepAboveGround } from './shared'

// Sandbox for threejs-grass corn: three fields (mature, harvested, young) in a grass meadow, and a box tractor
// driving laps through the mature field, flattening a track. `?view=2|20|200|path` picks a camera; `?t=` the
// tractor's start time in seconds (its track so far is flattened on load).
const params = new URLSearchParams(location.search)
const hud = document.getElementById('hud')!

const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl') })
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)
await renderer.init()

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 5000)
const start = view(params.get('view') ?? '20')
camera.position.set(...start.position)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(...start.target)
controls.enableDamping = true
const env = createEnvironment(renderer, scene, camera)
;(scene.fog as THREE.FogExp2).density = 0.0011 // clear farmland air, so the fields read from 200 m up
env.setSun(...SUN)

const terrain = new THREE.Mesh(farmGeometry(), new THREE.MeshStandardNodeMaterial())
terrain.receiveShadow = true
scene.add(terrain)

const tractor = createTractor()
scene.add(tractor)
const t0 = Number(params.get('t') ?? 50)
driveTractor(tractor, t0)

const grass = await Grass.create({ camera, scene, renderer, terrain: farm, grassMap: farmGrassMap(), maxDistance: 120, preset: 'perennialRyegrass', bladeHeight: 0.35, patchiness: 0.12 })
terrain.material = createGroundMaterial(grass)

const corns = await Promise.all(FIELDS.map(({ field, input }, i) => Corn.create({
  camera, scene, renderer, terrain: farm, fields: [field], ...input,
  interactors: i === 0 ? [{ object: tractor, radius: TRACTOR_RADIUS }] : [],
})))
predrive(corns[0], t0)

// Panel: every Corn option per field, plus the field's row direction and spacing (the farm planner's input).
const spec = panels['threejs-grass']
const json = (c: Corn) => {
  const { fields: _f, interactors: _i, sun: _s, ...rest } = c.settings
  return rest
}
const tractorParams = { speed: 1, radius: TRACTOR_RADIUS }
createPanel([{
  name: 'threejs-grass',
  classes: [
    ...corns.map((c, i) => classOf(`Corn: ${FIELDS[i].name}`, c, json(c), specOptions(spec.Corn))),
    ...corns.map((c, i) => classOf(`Field: ${FIELDS[i].name}`, { set: (p: object) => c.set({ fields: [{ ...c.settings.fields[0], ...p }] }) },
      { rowDirection: FIELDS[i].field.rowDirection, rowSpacing: FIELDS[i].field.rowSpacing }, { ranges: { rowDirection: [-Math.PI, Math.PI, 0.01], rowSpacing: [0.4, 1.5, 0.01] } })),
    classOf('Tractor', { set: (p: Partial<typeof tractorParams>) => {
      Object.assign(tractorParams, p)
      corns[0].set({ interactors: [{ object: tractor, radius: tractorParams.radius }] })
    } }, { ...tractorParams }, { ranges: { speed: [0, 5], radius: [0.3, 3] } }),
    classOf('Flattened', { set: () => corns.forEach((c) => c.clearFlattened()) }, { clear: false }),
  ],
}], { title: 'threejs-grass · corn' })

const setView = (name: string) => {
  const v = view(name)
  camera.position.set(...v.position)
  controls.target.set(...v.target)
}
Object.assign(window, { demo: { scene, camera, controls, corns, grass, tractor, env, renderer, setView, ready: false } })
const backend = (renderer.backend as any).isWebGPUBackend ? 'WebGPU' : 'WebGL2 fallback'
let frames = 0
let total = 0
let last = performance.now()
let time = t0
let prev = performance.now()
renderer.setAnimationLoop((now: number) => {
  time += ((now - prev) / 1000) * tractorParams.speed
  prev = now
  driveTractor(tractor, time)
  controls.update()
  keepAboveGround(camera, farm, 0.5)
  env.follow(controls.target)
  env.render()
  frames++
  if (++total === 30) (window as any).demo.ready = true
  if (now - last > 500) {
    const plants = corns.reduce((n, c) => n + c.stats.plants, 0)
    hud.innerHTML = `${backend} · ${Math.round((frames * 1000) / (now - last))} fps · ${plants.toLocaleString()} corn plants · ${grass.stats.instances.toLocaleString()} grass blades · <a href="./corn-r3f.html">R3F demo →</a>`
    frames = 0
    last = now
  }
})

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})
