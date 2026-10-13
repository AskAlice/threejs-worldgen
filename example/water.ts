import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import GUI from 'three/addons/libs/lil-gui.module.min.js'
import { World, createSample, type LocalFrame } from 'threejs-biomes'
import { DEFAULT_OCEAN, DEFAULT_RIVERS, Lakes, Ocean, Rivers, computeHydrology, riverModifiers, waterAt } from 'threejs-water'
import { addOptions, patch } from './options-gui'

// Sandbox for threejs-water. `?planet`: a 120 km planet (zoom from the beach to orbit); otherwise a
// flat world at a river mouth. The terrain here is a simple self-contained mesh.
const params = new URLSearchParams(location.search)
const planet = params.has('planet')
const hud = document.getElementById('hud')!

const renderer = new THREE.WebGPURenderer({ antialias: true, logarithmicDepthBuffer: planet, forceWebGL: params.has('webgl') })
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 0.8
document.body.appendChild(renderer.domElement)
await renderer.init()

const scene = new THREE.Scene()
scene.background = new THREE.Color('#9cc4e4')
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, planet ? 0.05 : 0.1, planet ? 3e6 : 60_000)
const sun = new THREE.DirectionalLight('#fff1dc', 3)
scene.add(sun, sun.target, new THREE.HemisphereLight('#cfe3ff', '#5a5040', 1.1))

const world = new World(planet ? { seed: 1, surface: 'sphere', radius: 120_000 } : { seed: 1 })
const frame: LocalFrame = world.frame
// A river mouth in seed 1's flat world (found by scanning for river water within 1.5 km of the sea).
const center: [number, number] = planet ? [0, 0] : [-10400, 6200]
const h0 = Math.max(0, frame.height(center[0], center[1]))
const origin = frame.toWorld(center[0], h0, center[1]) // floating origin: render-space zero sits on the coast

const ground = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.95 })
let terrain = buildTerrain(1600, planet ? 128 : 192)
scene.add(terrain)
const planetMesh = planet ? buildPlanet() : null
if (planetMesh) scene.add(planetMesh)

// Look from the land towards the sea.
let seaAngle = 0, lowest = Infinity
for (let a = 0; a < 16; a++) {
  const t = (a / 16) * Math.PI * 2
  const h = frame.height(center[0] + Math.cos(t) * 600, center[1] + Math.sin(t) * 600)
  if (h < lowest) { lowest = h; seaAngle = t }
}
const up = new THREE.Vector3(...frame.up)
const east = new THREE.Vector3(...frame.east)
const south = new THREE.Vector3(...frame.north).negate()
const local = (x: number, y: number, z: number) => east.clone().multiplyScalar(x).addScaledVector(up, y).addScaledVector(south, z)
const back = [-Math.cos(seaAngle) * 220, -Math.sin(seaAngle) * 220]
camera.up.copy(up)
camera.position.copy(local(back[0], frame.height(center[0] + back[0], center[1] + back[1]) - h0 + 45, back[1]))
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.copy(local(Math.cos(seaAngle) * 60, 2, Math.sin(seaAngle) * 60))
controls.enableDamping = true
controls.maxDistance = planet ? 900_000 : 20_000
sun.position.copy(local(-300, 400, -500))
sun.target.position.set(0, 0, 0)

const ocean = await Ocean.create({ camera, scene, renderer, world, sun, origin })
const rivers = await Rivers.create({ camera, scene, renderer, world, sun, origin })
let lakes: Lakes | null = null
Object.assign(window, { world, ocean, rivers, scene, camera, controls }) // for poking at from the console

// GUI: every JSON setting of the ocean and the rivers.
const gui = new GUI({ title: 'threejs-water' })
const oceanOptions = structuredClone({ ...DEFAULT_OCEAN, sun: null, environment: null }) as Record<string, any>
for (const k of ['sun', 'environment', 'origin', 'seaLevel', 'radius']) delete oceanOptions[k]
addOptions(gui.addFolder('Ocean'), oceanOptions, (path, value) => ocean.set(patch(path, value)), {
  ranges: { amplitude: [0, 4], count: [0, 16, 1], choppiness: [0, 1], spread: [0, 1], speed: [0, 4], whitecaps: [0, 1], segments: [16, 256, 1], range: [1e3, 1e8], visibility: [0.1, 40], refraction: [0, 0.2], roughness: [0.01, 1], foam: [0, 1], detail: [0, 1.5], altitudeFactor: [0.001, 0.2], innerRadius: [0.001, 1] },
})
const riverOptions = structuredClone({ ...DEFAULT_RIVERS, sun: null, environment: null }) as Record<string, any>
for (const k of ['sun', 'environment', 'origin']) delete riverOptions[k]
const riverFolder = gui.addFolder('Rivers')
addOptions(riverFolder, riverOptions, (path, value) => rivers.set(patch(path, value)), { ranges: { resolution: [8, 96, 1], expand: [0, 6, 1], tileSize: [32, 512, 1] } })
riverFolder.close()
if (!planet) {
  gui.add({ hydrology: runHydrology }, 'hydrology').name('bounded hydrology (carve rivers, lakes)')
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

renderer.setAnimationLoop(() => {
  controls.update()
  renderer.render(scene, camera)
  const o = ocean.stats, r = rivers.stats
  const target = controls.target
  const sea = ocean.waterAt(target.x, target.y, target.z)
  const w = waterAt(frame, center[0] + target.dot(east), center[1] + target.dot(south))
  hud.textContent = [
    `altitude ${o.altitude.toFixed(1)} m · rings ${o.innerRadius.toPrecision(2)} m → ${(o.extent / 1000).toFixed(1)} km · ${o.vertices} vertices`,
    `rivers: ${r.meshes}/${r.tiles} tiles with water, ${r.triangles} triangles, ${r.pending} pending`,
    `orbit target: ${sea.depth.toFixed(2)} m below the waves · ${w.kind}${w.kind === 'river' ? ` flowing ${Math.hypot(w.flowX, w.flowZ).toFixed(2)} m/s` : ''}`,
    lakes ? `hydrology: ${lakes.hydrology.lakes.length} lakes, ${lakes.hydrology.rivers.length} rivers` : '',
  ].join('\n')
})

/** A square terrain patch around `center` in the frame, in render space, coloured by height. */
function buildTerrain(size: number, segments: number) {
  const geo = new THREE.PlaneGeometry(size, size, segments, segments).rotateX(-Math.PI / 2)
  const pos = geo.attributes.position
  const colors = new Float32Array(pos.count * 3)
  const s = createSample(8)
  const c = new THREE.Color()
  const p: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < pos.count; i++) {
    const x = center[0] + pos.getX(i), z = center[1] + pos.getZ(i)
    const h = frame.sample(x, z, s, (size / segments) * 2).elevation
    frame.toWorld(x, h, z, p)
    pos.setXYZ(i, p[0] - origin[0], p[1] - origin[1], p[2] - origin[2])
    if (s.river > 0.2) c.set('#6b5a44')
    else if (h < world.options.seaLevel + 1.2) c.set('#d8c79a')
    else if (h < 60) c.set('#5f8a3c')
    else if (h < 250) c.set('#4f6d34')
    else c.set('#7d756b')
    c.toArray(colors, i * 3)
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.computeVertexNormals()
  return new THREE.Mesh(geo, ground)
}

/** The whole planet, coarse, for the view from orbit. */
function buildPlanet() {
  const geo = new THREE.IcosahedronGeometry(1, 40)
  const pos = geo.attributes.position
  const colors = new Float32Array(pos.count * 3)
  const s = createSample(8)
  const R = world.options.radius
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const d = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize()
    world.sampleAt(d.x * R, d.y * R, d.z * R, s, 2000)
    // Sink it a little so the detailed patch wins where they overlap.
    const r = R + s.elevation - 15
    pos.setXYZ(i, d.x * r - origin[0], d.y * r - origin[1], d.z * r - origin[2])
    c.set(s.elevation < 1 ? '#c9b98e' : s.temperature < -3 ? '#e8eef2' : s.elevation > 300 ? '#7d756b' : '#55803a').toArray(colors, i * 3)
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.computeVertexNormals()
  return new THREE.Mesh(geo, ground)
}

/** Turns the noise rivers off, runs drainage on the patch, carves the rivers and shows the lakes. */
function runHydrology() {
  hud.textContent = 'running hydrology…'
  setTimeout(() => {
    world.set({ rivers: { enabled: false } })
    const region = { x: center[0] - 700, z: center[1] - 700, width: 1400, depth: 1400, cellSize: 8 }
    const hydrology = computeHydrology(world.height, region, { seaLevel: world.options.seaLevel, riverArea: 60_000, minLakeArea: 200 })
    for (const m of riverModifiers(hydrology, frame)) world.addModifier(m)
    scene.remove(terrain)
    terrain.geometry.dispose()
    terrain = buildTerrain(1600, 192)
    scene.add(terrain)
    lakes?.dispose()
    lakes = new Lakes({ hydrology, frame, camera, scene, sun, origin })
  }, 30)
}
