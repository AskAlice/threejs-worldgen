import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { createHeightSampler, raycastHeight, slopeAt, type HeightFn } from 'threejs-heightfield'
import { createPanel, specOptions } from './panel'
import { panels } from './heightfield.panel'

// threejs-heightfield sandbox: the two sources it supports, a height function (used as-is) and meshes baked into a
// heightfield, sampled on a grid of instanced markers coloured by slopeAt, with raycastHeight under the pointer.
// Every parameter default of the package is in the shared panel (heightfield.panel.ts), with share-by-URL.
const hud = document.getElementById('hud')!
const renderer = new THREE.WebGPURenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.ACESFilmicToneMapping
document.body.appendChild(renderer.domElement)
await renderer.init()

const scene = new THREE.Scene()
scene.background = new THREE.Color('#9cb8cc')
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.5, 5000)
camera.position.set(150, 110, 150)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
const sun = new THREE.DirectionalLight('#fff1dc', 2.6)
sun.position.set(80, 140, 40)
scene.add(sun, new THREE.HemisphereLight('#cfe3ff', '#5a5040', 1.1))

const SIZE = 200 // the sampled square, metres
// Rolling hills with a steep ridge along z at x = 30.
const hills: HeightFn = (x, z) => 8 * Math.sin(x * 0.045) * Math.cos(z * 0.038) + 3 * Math.sin((x + 2 * z) * 0.09) + 14 * Math.exp(-(((x - 30) / 12) ** 2))

function surface(size: number, segments: number) {
  const geo = new THREE.PlaneGeometry(size, size, segments, segments).rotateX(-Math.PI / 2)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) pos.setY(i, hills(pos.getX(i), pos.getZ(i)))
  geo.computeVertexNormals()
  return geo
}
const ground = new THREE.MeshStandardNodeMaterial({ color: '#7d8659', roughness: 0.95 })
const stone = new THREE.MeshStandardNodeMaterial({ color: '#a59d90', roughness: 0.85 })

// Function source: drawn as a mesh, sampled straight from `hills`.
const fnSource = new THREE.Mesh(surface(SIZE, 160), ground)
// Mesh source: a 140 m patch (NaN outside it), a rotated block on it and an arch over it (the highest surface wins).
const meshSource = new THREE.Group()
const block = new THREE.Mesh(new THREE.BoxGeometry(18, 12, 30), stone)
block.position.set(-35, hills(-35, 10) + 3, 10)
block.rotation.y = 0.6
const arch = new THREE.Mesh(new THREE.TorusGeometry(22, 2.5, 12, 48, Math.PI), stone)
arch.position.set(-5, hills(-5, -40), -40)
meshSource.add(new THREE.Mesh(surface(140, 140), ground), block, arch)
scene.add(fnSource, meshSource)

const spec = panels['threejs-heightfield']
const sampler = structuredClone(spec.createHeightSampler.target!)
const slopeOptions = structuredClone(spec.slopeAt.target!)
const ray = structuredClone(spec.raycastHeight.target!)
const view = { source: 'mesh', markers: 96, showSource: true }

// Markers: one instanced sphere per grid sample, at the sampled height, hidden where the sampler gives NaN.
const markerGeometry = new THREE.SphereGeometry(0.45, 8, 6)
const markerMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.5 })
let markers: THREE.InstancedMesh | null = null
let sample: HeightFn = hills
let bakeMs = 0, hits = 0

// Re-bakes the sampler: only the source and createHeightSampler's options change it.
function build() {
  const t0 = performance.now()
  sample = createHeightSampler(view.source === 'mesh' ? meshSource : hills, sampler.maxResolution)
  bakeMs = performance.now() - t0
  showSource()
  placeMarkers()
  cast()
}

function showSource() {
  fnSource.visible = view.showSource && view.source === 'function'
  meshSource.visible = view.showSource && view.source === 'mesh'
}

// slopeAt is NaN where one of its probes falls off the baked patch (near its edge): no slope there, not a guess.
function slope(x: number, z: number): number | null {
  const s = slopeAt(sample, x, z, slopeOptions.e)
  return Number.isFinite(s) ? s : null
}

function placeMarkers() {
  const n = view.markers
  if (markers?.count !== n * n) {
    if (markers) { scene.remove(markers); markers.dispose() }
    markers = new THREE.InstancedMesh(markerGeometry, markerMaterial, n * n)
    scene.add(markers)
  }
  const m = new THREE.Matrix4(), c = new THREE.Color()
  hits = 0
  for (let j = 0, k = 0; j < n; j++) {
    for (let i = 0; i < n; i++, k++) {
      const x = (i / (n - 1) - 0.5) * SIZE, z = (j / (n - 1) - 0.5) * SIZE
      const y = sample(x, z)
      if (y !== y) { markers.setMatrixAt(k, m.makeScale(0, 0, 0)); continue }
      hits++
      markers.setMatrixAt(k, m.makeTranslation(x, y + 0.3, z))
      const s = slope(x, z) // rise / run: 1 = 45°
      markers.setColorAt(k, s === null ? c.set('#8a8a8a') : c.setHSL(0.33 * (1 - Math.min(1, s)), 0.75, 0.45)) // grey: no slope
    }
  }
  markers.instanceMatrix.needsUpdate = true
  if (markers.instanceColor) markers.instanceColor.needsUpdate = true
  markers.computeBoundingSphere()
  showHud()
}

// raycastHeight under the pointer.
const cursor = new THREE.Mesh(new THREE.SphereGeometry(1.4, 16, 12), new THREE.MeshStandardNodeMaterial({ color: '#ffffff', emissive: '#ff5a1f' }))
cursor.visible = false
scene.add(cursor)
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2(0, 0)
let hit: THREE.Vector3 | null = null, castUs = 0
function cast() {
  camera.updateMatrixWorld()
  raycaster.setFromCamera(pointer, camera)
  const t0 = performance.now()
  hit = raycastHeight(sample, raycaster.ray.origin, raycaster.ray.direction, ray.maxDistance, ray.step)
  castUs = (performance.now() - t0) * 1000
  cursor.visible = !!hit
  if (hit) cursor.position.copy(hit)
  showHud()
}
renderer.domElement.addEventListener('pointermove', (e) => {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
  cast()
})

function showHud() {
  const source = view.source === 'mesh' ? `mesh baked at maxResolution ${sampler.maxResolution} in ${bakeMs.toFixed(1)} ms` : 'height function (used as-is; maxResolution only applies to meshes)'
  const s = hit ? slope(hit.x, hit.z) : null
  const at = hit ? `hit (${hit.x.toFixed(1)}, ${hit.y.toFixed(2)}, ${hit.z.toFixed(1)}) · slope ${s?.toFixed(2) ?? '—'}` : 'no hit'
  hud.textContent = `threejs-heightfield — ${source}
${hits.toLocaleString()} / ${(view.markers ** 2).toLocaleString()} samples on terrain (NaN elsewhere)
raycastHeight: ${at} · ${castUs.toFixed(0)} µs`
}

createPanel([
  {
    name: 'threejs-heightfield',
    classes: [
      { name: 'createHeightSampler', target: sampler, onChange: build, ...specOptions(spec.createHeightSampler) },
      { name: 'slopeAt', target: slopeOptions, onChange: placeMarkers, ...specOptions(spec.slopeAt) },
      { name: 'raycastHeight', target: ray, onChange: cast, ...specOptions(spec.raycastHeight) },
    ],
  },
  { name: 'sandbox', classes: [{
    name: 'view', target: view, choices: { source: ['function', 'mesh'] }, ranges: { markers: [8, 256, 1] },
    // Only a new source re-bakes; markers re-place on the same sampler, showSource only toggles the meshes.
    onChange: ([key]) => (key === 'source' ? build() : key === 'markers' ? placeMarkers() : showSource()),
  }] },
], { title: 'threejs-heightfield' })
build()

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})
renderer.setAnimationLoop(() => {
  controls.update()
  renderer.render(scene, camera)
})
Object.assign(globalThis, { sample: () => sample, scene, camera }) // for poking at it from the console
