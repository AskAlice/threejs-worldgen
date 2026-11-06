import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import GUI from 'three/addons/libs/lil-gui.module.min.js'
import { Grass, GrassMap, TerrainPainter, presets, type BrushMode, type PresetName } from 'threejs-grass'
import {
  createEnvironment,
  createGroundMaterial,
  createMinimap,
  hills,
  hillsGeometry,
  keepAboveGround,
  paintPath
} from './shared'

// `?embed`: chrome-less background mode used by the landing page (no UI, slow camera drift).
const embed = new URLSearchParams(location.search).has('embed')

const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: location.search.includes('webgl') })
renderer.setPixelRatio(Math.min(devicePixelRatio, embed ? 1 : 1.5))
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)
await renderer.init()

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 5000)
camera.position.set(-4, hills(-4, 10) + 1.7, 10)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(2, hills(2, -6) + 0.6, -6)
controls.enableDamping = true

const env = createEnvironment(renderer, scene, camera)

const terrain = new THREE.Mesh(hillsGeometry(), new THREE.MeshStandardNodeMaterial())
terrain.receiveShadow = true
scene.add(terrain)

// Two white balls rolling through the field push the grass aside.
const balls = [0, 1].map(() => {
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.45, 48, 24),
    new THREE.MeshStandardNodeMaterial({ color: '#f4f4f0', roughness: 0.35 })
  )
  ball.castShadow = true
  scene.add(ball)
  return ball
})

const grassMap = new GrassMap({ size: 300, resolution: 1024 })
paintPath(grassMap)

const grass = await Grass.create({
  camera,
  scene,
  renderer,
  terrain,
  tileSize: 25,
  maxDistance: 200,
  grassMap,
  interactors: balls.map((object) => ({ object, radius: 1.1 }))
})
terrain.material = createGroundMaterial(grass)
Object.assign(window, { demo: { scene, camera, controls, grass, env, renderer } })

// ---- Controls (same set as the R3F demo's leva panel) ----
const gui = new GUI({ title: 'threejs-grass' })
const params = {
  preset: 'kentuckyBluegrass',
  type: 'blades',
  maxDistance: 200,
  interaction: 1,
  windStrength: 0.45,
  windSpeed: 0.8,
  windScale: 0.045,
  windAngle: 20,
  debugLods: false,
  elevation: 28,
  azimuth: 50,
  exposure: 0.6,
  bloom: 0.1
}
const style = { ...presets.kentuckyBluegrass }
const look = gui.addFolder('Grass')
const styleFolder = gui.addFolder('Style')
look.add(params, 'preset', Object.keys(presets)).onChange((name: string) => {
  const preset = name as PresetName
  Object.assign(style, presets[preset])
  styleFolder.controllersRecursive().forEach((c) => c.updateDisplay())
  grass.set({ preset, ...style })
})
look.add(params, 'type', ['blades', 'billboards']).onChange((type: any) => grass.set({ type }))
look.add(params, 'maxDistance', 50, 400, 10).onChange((maxDistance: number) => grass.set({ maxDistance }))
look.add(params, 'interaction', 0, 3).onChange((interactionStrength: number) => grass.set({ interactionStrength }))
const setStyle = () => grass.set({ ...style })
styleFolder.add(style, 'bladeHeight', 0.05, 3, 0.01).name('height').onChange(setStyle)
styleFolder.add(style, 'heightVariation', 0, 1).name('height var.').onFinishChange(setStyle)
styleFolder.add(style, 'bladeWidth', 0.005, 0.2, 0.001).name('width').onChange(setStyle)
styleFolder.add(style, 'density', 5, 150, 1).onFinishChange(setStyle)
styleFolder.add(style, 'curvature', 0, 1).name('droop').onChange(setStyle)
styleFolder.add(style, 'stiffness', 0.2, 3).onChange(setStyle)
styleFolder.add(style, 'clumping', 0, 1).onFinishChange(setStyle)
styleFolder.addColor(style, 'baseColor').name('base').onChange(setStyle)
styleFolder.addColor(style, 'tipColor').name('tip').onChange(setStyle)
styleFolder.add(style, 'patchiness', 0, 1).onChange(setStyle)
styleFolder.add(style, 'translucency', 0, 1.5).onChange(setStyle)
const setWind = () => {
  const a = (params.windAngle * Math.PI) / 180
  grass.set({
    wind: {
      direction: [Math.cos(a), Math.sin(a)],
      strength: params.windStrength,
      speed: params.windSpeed,
      scale: params.windScale
    }
  })
}
const windFolder = gui.addFolder('Wind')
windFolder.add(params, 'windStrength', 0, 1.5).name('strength').onChange(setWind)
windFolder.add(params, 'windSpeed', 0, 3).name('speed').onChange(setWind)
windFolder.add(params, 'windScale', 0.005, 0.3).name('scale').onChange(setWind)
windFolder.add(params, 'windAngle', 0, 360).name('angle').onChange(setWind)
const lodFolder = gui.addFolder('Levels of detail').close()
lodFolder
  .add(params, 'debugLods')
  .name('show LODs')
  .onChange((debugLods: boolean) => grass.set({ debugLods }))
const lods = grass.settings.lods.map((l) => ({ ...l }))
lods.forEach((lod, i) => {
  const f = lodFolder.addFolder(`LOD ${i}`)
  const apply = () => grass.set({ lods: lods.map((l) => ({ ...l })) })
  f.add(lod, 'distance', 0, 400, 1).onFinishChange(apply)
  f.add(lod, 'density', 0, 1, 0.005).onFinishChange(apply)
  f.add(lod, 'segments', 1, 8, 1).onFinishChange(apply)
})
const painter = new TerrainPainter(grass, renderer.domElement, { mode: 'add', radius: 3, strength: 0.3 })
painter.enabled = false
const paintFolder = gui.addFolder('Terrain Painter')
paintFolder
  .add(painter, 'enabled')
  .name('paint (orbit off)')
  .onChange((on: boolean) => (controls.enabled = !on))
paintFolder.add(painter.brush, 'mode', ['add', 'erase', 'raise', 'lower'] satisfies BrushMode[])
paintFolder.add(painter.brush, 'radius', 0.5, 15)
paintFolder.add(painter.brush, 'strength', 0.02, 1)
paintFolder.add({ clear: () => grassMap.fill(0) }, 'clear').name('clear all')
paintFolder.add({ fill: () => grassMap.fill(1) }, 'fill').name('fill all')
paintFolder.add({ reset: () => (grassMap.fill(1), paintPath(grassMap)) }, 'reset').name('reset path')
paintFolder
  .add(
    {
      save: () =>
        Object.assign(document.createElement('a'), { href: grassMap.toDataURL(), download: 'grass-map.png' }).click()
    },
    'save'
  )
  .name('save map')
const lightFolder = gui.addFolder('Lighting').close()
lightFolder.add(params, 'elevation', 2, 89).onFinishChange(() => env.setSun(params.elevation, params.azimuth))
lightFolder.add(params, 'azimuth', 0, 360).onFinishChange(() => env.setSun(params.elevation, params.azimuth))
lightFolder.add(params, 'exposure', 0.2, 1.5).onChange((v: number) => (renderer.toneMappingExposure = v))
lightFolder.add(params, 'bloom', 0, 1).onChange((v: number) => (env.bloomPass.strength.value = v))

const minimap = createMinimap(grassMap)
document.body.appendChild(minimap.canvas)

const hud = document.getElementById('hud')!
const backend = (renderer.backend as any).isWebGPUBackend ? 'WebGPU' : 'WebGL2 fallback'
let frames = 0
let last = performance.now()

if (embed) {
  gui.hide()
  minimap.canvas.remove()
  hud.style.display = 'none'
  controls.enabled = false
  controls.autoRotate = true
  controls.autoRotateSpeed = 0.25
}

let firstFrame = true
const loop = (t: number) => {
  balls.forEach((ball, i) => {
    const a = t * 0.00035 * (i ? -1 : 1) + i * 2
    const r = 4 + i * 2.5
    ball.position.set(2 + Math.cos(a) * r, 0, -6 + Math.sin(a) * r)
    ball.position.y = hills(ball.position.x, ball.position.z) + 0.45
  })
  controls.update()
  // In embed mode, ride over the hills at a steady eye height while auto-rotating.
  if (embed) camera.position.y += (hills(camera.position.x, camera.position.z) + 2 - camera.position.y) * 0.08
  keepAboveGround(camera, hills)
  env.follow(controls.target)
  env.render() // grass updates itself via scene.onBeforeRender
  minimap.update(camera.position)
  frames++
  if (t - last > 500) {
    hud.innerHTML = `${backend} · ${Math.round((frames * 1000) / (t - last))} fps · ${grass.stats.tiles} tiles · ${grass.stats.instances.toLocaleString()} blades · <a href="./r3f.html">R3F demo →</a>`
    frames = 0
    last = t
  }
  if (firstFrame && embed) parent.postMessage('threejs-grass:ready', '*')
  firstFrame = false
}
renderer.setAnimationLoop(loop)

// The landing page pauses the embedded demo while it is scrolled out of view.
addEventListener('message', (e) => {
  if (e.data === 'threejs-grass:pause') renderer.setAnimationLoop(null)
  if (e.data === 'threejs-grass:play') renderer.setAnimationLoop(loop)
})

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})
