import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { World, createSample, type LocalFrame } from 'threejs-biomes'
import {
  DEFAULT_LAKES,
  DEFAULT_OCEAN,
  DEFAULT_RIVERS,
  Lakes,
  Ocean,
  Rivers,
  WaterPrepass,
  computeHydrology,
  riverModifiers,
  waterAt
} from 'threejs-water'
import { classOf, createPanel, specOptions } from './panel'
import { panels } from './water.panel'

// Sandbox for threejs-water. `?planet`: a 120 km planet (zoom from the beach to orbit); otherwise a
// flat world at a river mouth. The terrain here is a simple self-contained mesh.
const params = new URLSearchParams(location.search)
const planet = params.has('planet')
const hud = document.getElementById('hud')!

const renderer = new THREE.WebGPURenderer({
  antialias: true,
  logarithmicDepthBuffer: planet,
  forceWebGL: params.has('webgl')
})
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 0.8
document.body.appendChild(renderer.domElement)
await renderer.init()
// Size after init, so the first presented frame is already at the final resolution instead of a
// blurry buffer that snaps to full detail (the device pixel ratio's worth of extra pixels).
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.setSize(innerWidth, innerHeight)

const scene = new THREE.Scene()
scene.background = new THREE.Color('#9cc4e4')
// Aerial haze: the sea, the apron and the sky meet in one horizon, and the far edge of the coarse
// ground never shows. Thins with altitude so the view from orbit stays clear.
scene.fog = new THREE.FogExp2('#9cc4e4', 1 / 4000)
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
// Flat world: a coarse apron carries the same world out past the detailed patch, so the sea never
// shows over empty space (and river tiles built outside the patch still sit on ground).
let apron: THREE.Mesh | null = planet ? null : buildApron()
if (apron) scene.add(apron)

// Look from the land towards the sea.
let seaAngle = 0,
  lowest = Infinity
for (let a = 0; a < 16; a++) {
  const t = (a / 16) * Math.PI * 2
  const h = frame.height(center[0] + Math.cos(t) * 600, center[1] + Math.sin(t) * 600)
  if (h < lowest) {
    lowest = h
    seaAngle = t
  }
}
const up = new THREE.Vector3(...frame.up)
const east = new THREE.Vector3(...frame.east)
const south = new THREE.Vector3(...frame.north).negate()
const local = (x: number, y: number, z: number) =>
  east.clone().multiplyScalar(x).addScaledVector(up, y).addScaledVector(south, z)
const back = [-Math.cos(seaAngle) * 220, -Math.sin(seaAngle) * 220]
camera.up.copy(up)
camera.position.copy(local(back[0], frame.height(center[0] + back[0], center[1] + back[1]) - h0 + 45, back[1]))
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.copy(local(Math.cos(seaAngle) * 60, 2, Math.sin(seaAngle) * 60))
controls.enableDamping = true
controls.maxDistance = planet ? 900_000 : 20_000
sun.position.copy(local(-300, 400, -500))
sun.target.position.set(0, 0, 0)

// Scene readback for the water: depth, view-space normals and colour in one frame. Half resolution
// (a documented quarter of the pixels) keeps the extra opaque pass cheap; toggle it in the GUI.
const prepass = new WaterPrepass({ camera, resolutionScale: 0.5 })
const ocean = await Ocean.create({ camera, scene, renderer, world, sun, origin, prepass })
const rivers = await Rivers.create({ camera, scene, renderer, world, sun, origin, prepass })
let lakes: Lakes | null = null

// A boat moored at the waterline: a hard edge for the water's screen-space reflection to mirror
// (look at `window.boat` from the console, or move the camera close to it).
const boat = new THREE.Group()
boat.name = 'Boat'
const hull = new THREE.Mesh(
  new THREE.BoxGeometry(3.2, 0.9, 1.3),
  new THREE.MeshStandardNodeMaterial({ color: '#b8452e', roughness: 0.6 })
)
const mast = new THREE.Mesh(
  new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6),
  new THREE.MeshStandardNodeMaterial({ color: '#efe9da', roughness: 0.8 })
)
mast.position.y = 2.0
boat.add(hull, mast)
const mooring = local(
  Math.cos(seaAngle) * 46 + Math.cos(seaAngle + Math.PI / 2) * 10,
  0,
  Math.sin(seaAngle) * 46 + Math.sin(seaAngle + Math.PI / 2) * 10
)
boat.position.set(mooring.x, ocean.waterAt(mooring.x, mooring.y, mooring.z).surface[1] + 0.35, mooring.z)
boat.rotation.y = -seaAngle
scene.add(boat)
Object.assign(window, { world, ocean, rivers, scene, camera, renderer, controls, prepass, boat }) // for poking at from the console
const ui = { prepass: true, measure: false }

// Panel: every JSON setting of the ocean, the rivers and the lakes on the shared panel (search, per-class
// reset, share-by-URL).
const spec = panels['threejs-water']
const lakeOptions = structuredClone(DEFAULT_LAKES)
const gui = createPanel([
  {
    name: 'threejs-water',
    classes: [
      classOf('Ocean', ocean, structuredClone(DEFAULT_OCEAN), specOptions(spec.Ocean)),
      classOf('Rivers', rivers, structuredClone(DEFAULT_RIVERS), specOptions(spec.Rivers)),
      // The lakes have no instance until hydrology runs, so their target is the input the next `Lakes`
      // is built with; once it exists, each edit re-applies the whole target (keeping the demo's origin).
      {
        name: 'Lakes',
        target: lakeOptions,
        onChange: () => lakes?.set({ ...lakeOptions, origin, sun }),
        ...specOptions(spec.Lakes)
      }
    ]
  }
])
const sandbox = gui.addFolder('sandbox')
sandbox
  .add(ui, 'prepass')
  .name('depth/normal prepass')
  .onChange((on: boolean) => {
    ocean.setPrepass(on ? prepass : null)
    rivers.setPrepass(on ? prepass : null)
    lakes?.setPrepass(on ? prepass : null)
  })
sandbox
  .add(ui, 'measure')
  .name('measure prepass cost')
  .onChange(() => {
    cost.with = cost.without = cost.nWith = cost.nWithout = 0
    cost.frame = 0
    cost.run = true
  })
if (!planet) sandbox.add({ hydrology: runHydrology }, 'hydrology').name('bounded hydrology (carve rivers, lakes)')

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

// Frame cost, measured from the HUD. The pass is too cheap to see against scene drift, so with
// "measure prepass" on it runs on alternating 60-frame blocks and each block's frame interval is
// averaged; adjacent blocks cancel the scene load drift. With measurement off the pass runs every
// frame, as it should for the shading that reads it.
let lastFrame = 0,
  frameMs = 0,
  prepassMs = 0
const average = (current: number, next: number) => (current ? current * 0.95 + next * 0.05 : next)
const cost = { block: 60, frame: 0, run: true, with: 0, without: 0, nWith: 0, nWithout: 0 }

renderer.setAnimationLoop(() => {
  const frameStart = performance.now()
  let dt = 0
  if (lastFrame) {
    dt = frameStart - lastFrame
    frameMs = average(frameMs, dt)
  }
  lastFrame = frameStart

  cost.frame++
  if (cost.frame % cost.block === 0) cost.run = !cost.run

  controls.update()
  // Keep the moored boat riding the waves, so it (and its reflection at the waterline) stays afloat.
  boat.position.y = ocean.waterAt(boat.position.x, boat.position.y, boat.position.z).surface[1] + 0.35
  // Haze thins with altitude (the sea and the sky meet at the horizon; the apron edge stays hidden).
  ;(scene.fog as THREE.FogExp2).density = 1 / (3000 + Math.max(0, ocean.stats.altitude) * 15)
  const runPass = !!ui.prepass && (!ui.measure || cost.run)
  const beforePrepass = performance.now()
  if (runPass) prepass.update(renderer, scene)
  prepassMs = average(prepassMs, performance.now() - beforePrepass)
  renderer.render(scene, camera)
  if (ui.prepass && ui.measure && dt) {
    if (cost.run) {
      cost.with += dt
      cost.nWith++
    } else {
      cost.without += dt
      cost.nWithout++
    }
  }
  const withMs = cost.nWith ? cost.with / cost.nWith : 0
  const withoutMs = cost.nWithout ? cost.without / cost.nWithout : 0
  const share = cost.nWith && cost.nWithout ? (cost.with / cost.nWith / (cost.without / cost.nWithout) - 1) * 100 : 0
  const o = ocean.stats,
    r = rivers.stats
  const target = controls.target
  const sea = ocean.waterAt(target.x, target.y, target.z)
  const w = waterAt(frame, center[0] + target.dot(east), center[1] + target.dot(south))
  hud.textContent = [
    `altitude ${o.altitude.toFixed(1)} m · rings ${o.innerRadius.toPrecision(2)} m → ${(o.extent / 1000).toFixed(1)} km · ${o.vertices} vertices`,
    `rivers: ${r.meshes}/${r.tiles} tiles with water, ${r.triangles} triangles, ${r.pending} pending`,
    `orbit target: ${sea.depth.toFixed(2)} m below the waves · ${w.kind}${w.kind === 'river' ? ` flowing ${Math.hypot(w.flowX, w.flowZ).toFixed(2)} m/s` : ''}`,
    lakes ? `hydrology: ${lakes.hydrology.lakes.length} lakes, ${lakes.hydrology.rivers.length} rivers` : '',
    ui.prepass
      ? `prepass ${prepassMs.toFixed(2)} ms CPU · frame ${frameMs.toFixed(1)} ms${ui.measure ? ` · pass ${withMs.toFixed(1)} / ${withoutMs.toFixed(1)} ms without (${share >= 0 ? '+' : ''}${share.toFixed(1)}%)` : ''}`
      : `prepass off · frame ${frameMs.toFixed(1)} ms`
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
    const x = center[0] + pos.getX(i),
      z = center[1] + pos.getZ(i)
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
    c.set(
      s.elevation < 1 ? '#c9b98e' : s.temperature < -3 ? '#e8eef2' : s.elevation > 300 ? '#7d756b' : '#55803a'
    ).toArray(colors, i * 3)
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.computeVertexNormals()
  return new THREE.Mesh(geo, ground)
}

/**
 * Coarse ground from just inside the detailed patch edge out to the far plane: a ring mesh sampled
 * from the same frame, dense near the patch and growing with distance. Sampling at a few cells keeps
 * it cheap; its far edge sinks below the sea, where the ocean and the haze cover it.
 */
function buildApron() {
  const segments = 192
  // Reach past the 60 km far plane, so the camera's far clip — not the apron's edge — is the horizon.
  const near = 780,
    far = 150_000
  const rings = Math.max(1, Math.round((segments * Math.log(far / near)) / (Math.PI * 2)))
  const positions = new Float32Array((rings + 1) * segments * 3)
  const colors = new Float32Array((rings + 1) * segments * 3)
  const index: number[] = []
  const s = createSample(8)
  const c = new THREE.Color()
  const p: [number, number, number] = [0, 0, 0]
  const sea = world.options.seaLevel
  for (let i = 0; i <= rings; i++) {
    const r = near * (far / near) ** (i / rings)
    const step = (r * 2 * Math.PI) / segments
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2
      const x = center[0] + Math.cos(a) * r,
        z = center[1] + Math.sin(a) * r
      const h = frame.sample(x, z, s, Math.max(8, step * 2)).elevation
      // Under the detailed patch at the seam (its coarse samples can differ by metres) so it cannot
      // poke through the patch; exact everywhere the patch does not cover; sunk below the sea at the
      // far edge. Confining the seam sink to the patch's square keeps rivers out here on the ground.
      const underPatch = Math.abs(x - center[0]) <= 800 && Math.abs(z - center[1]) <= 800
      const seam = underPatch ? 1 - THREE.MathUtils.smoothstep(r, near, 1135) : 0
      const y = THREE.MathUtils.lerp(h - 2 * seam, sea - 40, THREE.MathUtils.smoothstep(r, far * 0.94, far))
      frame.toWorld(x, y, z, p)
      const k = (i * segments + j) * 3
      positions[k] = p[0] - origin[0]
      positions[k + 1] = p[1] - origin[1]
      positions[k + 2] = p[2] - origin[2]
      if (s.river > 0.2) c.set('#6b5a44')
      else if (h < sea + 1.2) c.set('#d8c79a')
      else if (h < 60) c.set('#5f8a3c')
      else if (h < 250) c.set('#4f6d34')
      else c.set('#7d756b')
      c.toArray(colors, k)
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * segments + j,
        b = i * segments + ((j + 1) % segments)
      index.push(a, b, a + segments, b, b + segments, a + segments)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.setIndex(index)
  geo.computeVertexNormals()
  return new THREE.Mesh(geo, ground)
}

/** Turns the noise rivers off, runs drainage on the patch, carves the rivers and shows the lakes. */
function runHydrology() {
  hud.textContent = 'running hydrology…'
  setTimeout(() => {
    world.set({ rivers: { enabled: false } })
    const region = { x: center[0] - 700, z: center[1] - 700, width: 1400, depth: 1400, cellSize: 8 }
    const hydrology = computeHydrology(world.height, region, {
      seaLevel: world.options.seaLevel,
      riverArea: 60_000,
      minLakeArea: 200
    })
    for (const m of riverModifiers(hydrology, frame)) world.addModifier(m)
    scene.remove(terrain)
    terrain.geometry.dispose()
    terrain = buildTerrain(1600, 192)
    scene.add(terrain)
    // The hydrology turned the world's noise rivers off: resample the apron so its valleys agree.
    if (apron) {
      scene.remove(apron)
      apron.geometry.dispose()
      apron = buildApron()
      scene.add(apron)
    }
    lakes?.dispose()
    lakes = new Lakes({
      ...structuredClone(lakeOptions),
      hydrology,
      frame,
      camera,
      scene,
      sun,
      origin,
      prepass: ui.prepass ? prepass : null
    })
  }, 30)
}
