import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { FluidSurface, MPMSolver, ParticleSystem, PuddleField, SplashEmitter, WATER_PRESETS } from 'threejs-particles'
import { classOf, createPanel, specOptions } from './panel'
import { panels } from './mpm-water.panel'
import { RAIN, VIEWS, check, releaseDam, height, puddleOptions, splashOptions, streaks, waterConfig, waterGround, waterLoop, waterStage, waterView } from './mpm-water-scene'

// threejs-particles MPM water sandbox: a weakly compressible MLS-MPM fluid on a 4.8 m patch of ground, drawn as a
// screen-space fluid surface. A dam break collapses onto the terrain, a stream runs off a 0.6 m ledge into a plunge
// pool, and rain splashes on the ground (MPM splashes near the camera, streaks in the air) and fills puddles in the
// hollows, which drain and dry when it stops. `?view=dam|fall|rain` picks a camera, `?muddy` the muddy preset,
// `?soak=<minutes>` lets it have rained that long before (puddles already formed), `?rain=0`, `?dam=0` and `?fall=0`
// switch the three parts off, `?pause=<s>` freezes the water at that simulated time. `?check` instead runs a tiny water
// scene on the GPU and on the CPU reference and compares them (recorded as packages/particles/test/fixtures/).
const hud = document.getElementById('hud')!
const params = new URLSearchParams(location.search)
const renderer = new THREE.WebGPURenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.AgXToneMapping
renderer.toneMappingExposure = 1.1
document.body.appendChild(renderer.domElement)
await renderer.init()

async function sandbox() {
  const muddy = params.has('muddy')
  const preset = muddy ? WATER_PRESETS.muddy : WATER_PRESETS.clear
  const view = waterView(params)

  const scene = new THREE.Scene()
  const { sun, skyAvg } = waterStage(renderer, scene)
  // Puddles over the domain, feeding the ground shader through a texture.
  const puddles = new PuddleField(puddleOptions, height)
  const ground = waterGround(puddles, view)
  scene.add(...ground.meshes)

  // The solver: 4.8 × 2.4 × 4.8 m at Δx = 5 cm, open sides (water running off them is retired).
  const mpm = new MPMSolver(renderer, { ...waterConfig(muddy), height })
  mpm.object.visible = false
  scene.add(mpm.object)
  const fluid = new FluidSurface(mpm, { ...preset.surface, envMap: scene.environment })
  scene.add(fluid.object)
  fluid.lighting.set(sun.position.toArray(), sun.color.clone().multiplyScalar(sun.intensity), skyAvg)

  const splash = new SplashEmitter(mpm, splashOptions(view), { height, puddles })
  const soak = Number(params.get('soak') ?? 0)
  if (soak > 0) puddles.update(soak * 60, view.rainRate)

  // Rain in the air, around the camera: a near layer and a far one of thin streaks.
  const rainNear = new ParticleSystem(streaks(...RAIN.near)), rainFar = new ParticleSystem(streaks(...RAIN.far))
  const rain = { object: new THREE.Group() }
  rain.object.add(rainNear.object, rainFar.object)
  scene.add(rain.object)

  const damBreak = () => releaseDam(mpm, view)
  damBreak()

  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.03, 1500)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  const setView = (name: string) => {
    const [p, t] = VIEWS[name] ?? VIEWS.overview
    camera.position.fromArray(p)
    controls.target.fromArray(t)
    controls.update()
  }
  setView(params.get('view') ?? 'overview')

  const gui = createPanel([{
    name: 'threejs-particles', classes: [
      classOf('MPMSolver', mpm, mpm.options, specOptions(panels['threejs-particles'].MPMSolver)),
      classOf('FluidSurface', fluid, fluid.options, specOptions(panels['threejs-particles'].FluidSurface)),
      classOf('SplashEmitter', splash, splash.options, specOptions(panels['threejs-particles'].SplashEmitter)),
      classOf('PuddleField', puddles, puddles.options, specOptions(panels['threejs-particles'].PuddleField)),
    ],
  }], { title: 'threejs-particles · MPM water' })
  const demo = gui.addFolder('demo')
  demo.add(view, 'rain').name('rain')
  demo.add(view, 'rainRate', 0, 80, 0.5).name('rain (mm/h)')
  demo.add(view, 'puddleSpeed', 1, 200, 1).name('puddle fast-forward ×')
  demo.add(view, 'waterfall').name('waterfall')
  demo.add(view, 'flow', 0, 2, 0.05).name('stream speed (m/s)')
  demo.add(view, 'damBreak').name('dam break on reset')
  demo.add({ damBreak }, 'damBreak').name('reset water (dam break)')
  demo.add({ dry: () => puddles.clear() }, 'dry').name('dry the ground')
  demo.add({ v: 'overview' }, 'v', Object.keys(VIEWS)).name('camera').onChange(setView)

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
  })
  Object.assign(window, { mpm, fluid, puddles, splash, rainNear, rainFar, camera, controls, renderer, scene, view, setView, damBreak })

  const pauseAt = Number(params.get('pause') ?? Infinity) // `?pause=<s>` freezes the water at that simulated time (screenshots)
  const { frame, hud: status } = waterLoop(renderer, mpm, splash, puddles, ground, view, pauseAt)
  let last = performance.now(), fps = 60
  renderer.setAnimationLoop(() => {
    const now = performance.now()
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    fps = fps * 0.95 + (1 / Math.max(1e-3, dt)) * 0.05
    controls.update()
    frame(dt, camera, controls.target, { near: rainNear, far: rainFar })
    rainNear.update(renderer, dt, camera)
    rainFar.update(renderer, dt, camera)
    fluid.render(renderer, camera)
    renderer.render(scene, camera)
    hud.textContent = status(fps)
  })
}

if (params.has('check')) hud.textContent = await check(renderer)
else await sandbox()
