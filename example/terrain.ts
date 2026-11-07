import * as THREE from 'three/webgpu'
import {
  World,
  WorldTerrain,
  SurfaceControls,
  renderWorldMap,
  createSample,
  type LocalFrame,
  type MapMode,
  type WorldInput
} from 'threejs-biomes'
import TerrainWorker from 'threejs-biomes/worker?worker'
import { Lakes, Ocean, Rivers, WaterPrepass, computeHydrology } from 'threejs-water'
import { patch } from './options-gui'
import { classOf, createPanel } from './panel'

// threejs-biomes sandbox: every World and terrain option live, flat world or planet, ant to orbit.
const params = new URLSearchParams(location.search)
const planet = params.get('surface') !== 'plane'

const renderer = new THREE.WebGPURenderer({
  antialias: true,
  reversedDepthBuffer: true,
  forceWebGL: params.has('webgl')
})
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 0.9
document.body.appendChild(renderer.domElement)
await renderer.init()
// Size after init, so the first presented frame is already at the final resolution.
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.setSize(innerWidth, innerHeight)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 1e7)

const worldInput: WorldInput = planet ? { seed: 7, surface: 'sphere', radius: 60_000 } : { seed: 7 }
const world = new World(worldInput)

const controls = new SurfaceControls(camera, renderer.domElement, world, { distance: planet ? 9000 : 2500 })
const terrain = await WorldTerrain.create({
  world,
  camera,
  scene,
  createWorker: () => new TerrainWorker(),
  origin: controls.origin
})

// Light: a fixed sun in world space (so moving around a planet goes through day and night).
const sunDir = new THREE.Vector3(0.6, 0.55, 0.35).normalize()
const sun = new THREE.DirectionalLight('#fff3e0', 3)
sun.position.copy(sunDir)
scene.add(sun, new THREE.HemisphereLight('#bcd4ff', '#4a4030', 0.9))
const skyDay = new THREE.Color('#9ec3e6'),
  space = new THREE.Color('#02030a')
scene.background = new THREE.Color()
scene.fog = new THREE.FogExp2(skyDay.getHex(), 0)

// The sea, from the water package: it reads sea level and radius from the world every frame and follows
// the camera, so it works on the flat world and on the 60 km planet alike.
// Scene readback for the water (depth, view-space normals, colour). Half resolution: the pass draws
// the visible terrain once more at a quarter of the pixels.
const prepass = new WaterPrepass({ camera, resolutionScale: 0.5 })
const ocean = await Ocean.create({
  camera,
  scene,
  renderer,
  world,
  sun,
  origin: controls.origin,
  skyColor: '#9ec3e6',
  horizonColor: '#dfeaf2',
  scatterColor: '#0b3247',
  prepass
})

// The world's own rivers (the network the biome map's `rivers` mode draws), streamed around the camera
// in tiles. Same world, same floating origin as the terrain and the sea, so a river meets the coast the
// terrain draws, at the level the world sampled.
const rivers = await Rivers.create({
  camera,
  scene,
  renderer,
  world,
  sun,
  origin: controls.origin,
  maxDistance: 3000,
  prepass
})

// Lakes come from drainage-basin hydrology on a patch around the focus. Hydrology is a bounded-map
// solver, so the patch is a fixed window (2 km, 8 m cells) that follows the focus, not the whole world.
const LAKE_REGION = 2048
const LAKE_CELL = 8
let lakes: Lakes | null = null
const lakePatch = { focus: null as number[] | null, version: -1, pending: false }

Object.assign(window, { world, terrain, controls, renderer, camera, scene, ocean, rivers, prepass })

// UI.
const hud = document.getElementById('hud')!
const mapCanvas = document.getElementById('map') as HTMLCanvasElement
const mapCtx = mapCanvas.getContext('2d')!
const modes: MapMode[] = [
  'biomes',
  'height',
  'temperature',
  'moisture',
  'continentalness',
  'erosion',
  'rivers',
  'ground'
]
const ui = { surface: planet ? 'sphere' : 'plane', map: 'biomes' as MapMode, mapSize: 40_000, fog: true }
let mapDirty = true

let pending: ReturnType<typeof setTimeout> | undefined
const worldOptions = structuredClone(world.options) as Record<string, any>
const terrainOptions = structuredClone(terrain.options) as Record<string, any>
delete terrainOptions.origin
const gui = createPanel([
  {
    name: 'threejs-biomes',
    classes: [
      {
        name: 'World',
        target: worldOptions,
        // Debounced: a world change rebuilds every chunk.
        onChange: (path, value) => {
          clearTimeout(pending)
          pending = setTimeout(() => {
            world.set(patch(path, value) as WorldInput)
            mapDirty = true
          }, 150)
        },
        skip: ['biomes', 'modifiers', 'curve', 'colors', 'windDirection', 'surface', 'origin'],
        ranges: {
          radius: [5000, 6_371_000, 1000],
          seaLevel: [-200, 200, 1],
          threshold: [0, 1, 0.01],
          landBias: [-0.6, 0.6, 0.01],
          chance: [0, 1, 0.01],
          warp: [0, 1, 0.01],
          sharpness: [0.5, 4, 0.1],
          blend: [0.05, 0.6, 0.01],
          maxBiomes: [1, 8, 1]
        }
      },
      {
        name: 'WorldTerrain',
        target: terrainOptions,
        onChange: (path, value) => terrain.set(patch(path, value)),
        ranges: {
          resolution: [9, 65, 8],
          lodFactor: [0.5, 6, 0.1],
          lodMargin: [0, 0.4, 0.01],
          minChunkSize: [0.25, 64, 0.25],
          viewDistance: [1000, 100_000, 500],
          buildBudget: [1, 30, 1],
          skirt: [0, 0.2, 0.005]
        },
        choices: { debug: ['none', 'biomes', 'lod', 'splat'] },
        skip: ['jobsPerWorker', 'keepAlive']
      },
      classOf('SurfaceControls', controls, controls.options, {
        ranges: { minDistance: [0.005, 10, 0.005], maxElevation: [0.1, 1.57, 0.01], minElevation: [0, 1, 0.01] }
      })
    ]
  }
])
const sandbox = gui.addFolder('sandbox')
sandbox
  .add(ui, 'surface', ['plane', 'sphere'])
  .name('surface (reloads)')
  .onChange((v: string) => {
    location.search = `?surface=${v === 'sphere' ? 'sphere' : 'plane'}`
  })
sandbox.add(ui, 'map', modes).onChange(() => (mapDirty = true))
sandbox.add(ui, 'mapSize', 2000, 200_000, 1000).onChange(() => (mapDirty = true))
sandbox.add(ui, 'fog')

addEventListener('keydown', (e) => {
  if (e.key === 'm') {
    ui.map = modes[(modes.indexOf(ui.map) + 1) % modes.length]
    mapDirty = true
    gui.controllersRecursive().forEach((c) => c.updateDisplay())
  }
})
/**
 * Solves the drainage of a patch around `focus` and draws its lakes at their spill level. Deferred so
 * the pan that triggers it does not stutter on the solve. The world's own noise rivers are already
 * carved and levelled by `world`, so `Rivers` draws those; drawing the hydrology rivers too would put a
 * second, uncarved channel next to them.
 */
function requestLakes(focus: readonly number[]) {
  lakePatch.pending = true
  lakePatch.focus = [focus[0], focus[1], focus[2]]
  setTimeout(() => {
    lakePatch.pending = false
    lakePatch.version = world.version
    // A flat world's region is in world x/z; on a planet, a tangent frame centred on the focus, so the
    // sampled heights (and the lake levels) are that frame's local y.
    const frame = planet ? frameAtFocus(focus) : world.frame
    const half = LAKE_REGION / 2
    const x = planet ? -half : focus[0] - half
    const z = planet ? -half : focus[2] - half
    // On a planet the frame's local y is a tangent plane, so pass the sphere's gravity: the sea then
    // follows the geoid and flow curves toward the centre instead of treating a scalar level as flat.
    const gravity = planet ? { radius: world.options.radius } : undefined
    const hydrology = computeHydrology(
      frame.height,
      { x, z, width: LAKE_REGION, depth: LAKE_REGION, cellSize: LAKE_CELL },
      { seaLevel: world.options.seaLevel, gravity }
    )
    if (lakes) lakes.setHydrology(hydrology, frame)
    else lakes = new Lakes({ hydrology, frame, camera, scene, sun, origin: controls.origin, prepass, rivers: false })
    Object.assign(window, { lakes })
  }, 50)
}

/** The local frame centred on a planet focus point (lat/lon of the focus's base point). */
function frameAtFocus(focus: readonly number[]): LocalFrame {
  const len = Math.hypot(focus[0], focus[1], focus[2]) || 1
  const deg = 180 / Math.PI
  return world.frameAt(Math.asin(focus[1] / len) * deg, Math.atan2(focus[0], focus[2]) * deg)
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

const sample = createSample()
let frames = 0,
  fps = 0,
  lastFps = performance.now()
let lastMapFocus = [Infinity, Infinity, Infinity]

renderer.setAnimationLoop(() => {
  controls.update()
  terrain.setOrigin(controls.origin)
  ocean.setOrigin(controls.origin)
  rivers.setOrigin(controls.origin)
  lakes?.setOrigin(controls.origin)
  // Keep the lake patch around the focus: re-run the drainage when the focus leaves its inner half,
  // or when the world changes. Only while close enough to see a lake (it is a ~0.5 s solve).
  if (controls.distance < LAKE_REGION * 1.5 && !lakePatch.pending) {
    const [fx, fy, fz] = controls.focus
    if (
      lakePatch.version !== world.version ||
      !lakePatch.focus ||
      Math.hypot(fx - lakePatch.focus[0], fy - lakePatch.focus[1], fz - lakePatch.focus[2]) > LAKE_REGION * 0.25
    )
      requestLakes(controls.focus)
  }

  // Sky fades to space with altitude; fog thins out with it.
  const alt = controls.altitude
  const thin = THREE.MathUtils.smoothstep(Math.log10(alt + 1), 3.3, 4.6)
  ;(scene.background as THREE.Color).copy(skyDay).lerp(space, thin)
  const fog = scene.fog as THREE.FogExp2
  fog.color.copy(scene.background as THREE.Color)
  fog.density = ui.fog ? (1 - thin) * Math.min(0.002, 2 / Math.max(500, controls.distance * 8)) : 0

  prepass.update(renderer, scene)
  renderer.render(scene, camera)

  // HUD.
  frames++
  const now = performance.now()
  if (now - lastFps > 500) {
    fps = (frames * 1000) / (now - lastFps)
    frames = 0
    lastFps = now
  }
  const f = controls.focus
  world.sampleAt(f[0], f[1], f[2], sample)
  const biome = world.options.biomes[sample.biomes[0]].name
  const s = terrain.stats
  const sea = ocean.waterAt(0, 0, 0) // render-space zero is the focus, so this is the sea under it
  const fmt = (m: number) =>
    m < 1 ? `${(m * 100).toFixed(1)} cm` : m < 1000 ? `${m.toFixed(1)} m` : `${(m / 1000).toFixed(2)} km`
  hud.textContent = `${fps.toFixed(0)} fps · camera ${fmt(controls.distance)} from focus, ${fmt(alt)} above ground
${biome} · ${sample.temperature.toFixed(1)} °C · moisture ${sample.moisture.toFixed(2)} · elevation ${sample.elevation.toFixed(1)} m
chunks ${s.visible} drawn / ${s.cached} cached · ${s.building} building · ${s.queued} queued · depth ${s.deepest} · ${(s.triangles / 1e6).toFixed(2)} M tris
sea ${sea.depth >= 0 ? `${fmt(sea.depth)} deep` : `${fmt(-sea.depth)} above the waterline`} at the focus · camera ${fmt(ocean.stats.altitude)} above sea level
rivers ${rivers.stats.meshes}/${rivers.stats.tiles} tiles · ${lakes ? `${lakes.hydrology.lakes.length} lakes` : 'lakes…'}`

  // Map overlay around the focus (redrawn when the focus moves far or settings change).
  const moved = Math.hypot(f[0] - lastMapFocus[0], f[1] - lastMapFocus[1], f[2] - lastMapFocus[2]) > ui.mapSize * 0.05
  if (mapDirty || moved) {
    mapDirty = false
    lastMapFocus = [...f]
    const deg = 180 / Math.PI
    const frame = planet
      ? world.frameAt(Math.asin(f[1] / Math.hypot(...f)) * deg, Math.atan2(f[0], f[2]) * deg)
      : world.frame
    const px = renderWorldMap(
      world,
      { mode: ui.map, center: planet ? [0, 0] : [f[0], f[2]], size: ui.mapSize, resolution: 128 },
      frame
    )
    const img = new ImageData(px, 128)
    createImageBitmap(img).then((bmp) => {
      mapCtx.imageSmoothingEnabled = false
      mapCtx.drawImage(bmp, 0, 0, 256, 256)
    })
  }
})
