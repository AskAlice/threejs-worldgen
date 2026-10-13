import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { MPMSnowSurface, MPMSolver, SNOW_PRESETS } from 'threejs-particles'
import { classOf, createPanel, specOptions } from './panel'
import { panels } from './mpm-snow.panel'
import { Walker, check, snowScene, snowStage, type SceneName } from './mpm-snow-scene'

// threejs-particles MPM snow sandbox (Stomakhin et al. 2013 snow on the MLS-MPM core), two scenes:
// - `?scene=footprints` (default): 0.35 m of fresh powder on rolling ground (Δx = 0.07 m, ~97k particles); a walker
//   (a boot-shaped sole of four capsules per foot) or a pair of wheels crosses it and leaves footprints or tracks.
// - `?scene=avalanche`: a 38° slope in a late-season gully, a 0.55 m pack of snow above a snow-covered runout (Δx =
//   0.2 m, ~88k particles). "release" collapses the weak layer under an irregular slab (its bed friction drops, the
//   snow around it holds): the slab breaks away at a jagged crown, runs out and piles as debris at the foot.
// The particles are hidden; MPMSnowSurface draws them as a lit snow cover that blends into static snow outside the
// simulated domain. `?check` instead runs a tiny snow scene on the GPU and the CPU reference and compares them.
const hud = document.getElementById('hud')!
const params = new URLSearchParams(location.search)
const renderer = new THREE.WebGPURenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.AgXToneMapping
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap // soft through `shadow.radius`
document.body.appendChild(renderer.domElement)
await renderer.init()

async function sandbox(name: SceneName) {
  const preset = params.get('preset')
  const { spec, config, surface: surfaceOptions, reset: lay, release: letGo, stats } = snowScene(name, preset)

  const scene = new THREE.Scene()
  renderer.toneMappingExposure = spec.exposure
  snowStage(renderer, scene, spec)

  // The solver: snow only, a terrain collider, hidden particles drawn as a snow surface.
  const mpm = new MPMSolver(renderer, { ...config, height: spec.ground })
  mpm.object.visible = false
  scene.add(mpm.object)
  const surface = new MPMSnowSurface(renderer, mpm, surfaceOptions)
  scene.add(surface.object)

  const view = {
    preset: (preset && Object.hasOwn(SNOW_PRESETS, preset) ? preset : name === 'avalanche' ? 'packed' : 'powder') as string,
    walker: 'boots' as 'boots' | 'wheels',
    showWalker: true,
    showParticles: false,
    walkSpeed: 1.1,
    sink: 0.22,
    releaseFriction: 0.2,
  }
  const walker = new Walker(spec)
  scene.add(walker.object)
  let walkStart = Infinity
  const reset = () => {
    lay(mpm)
    walkStart = name === 'footprints' ? mpm.time + 0.6 : Infinity // let the cover settle first
  }
  const walk = () => { walkStart = mpm.time }
  const release = () => letGo(mpm, view.releaseFriction)
  reset()

  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 6000)
  camera.position.fromArray(spec.camera)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.target.fromArray(spec.target)
  controls.enableDamping = true

  const gui = createPanel([{
    name: 'threejs-particles',
    classes: [
      classOf('MPMSolver', mpm, mpm.options, specOptions(panels['threejs-particles'].MPMSolver)),
      classOf('MPMSnowSurface', surface, surface.options, specOptions(panels['threejs-particles'].MPMSnowSurface)),
    ],
  }], { title: 'threejs-particles · MPM snow' })
  const demo = gui.addFolder('demo')
  demo.add({ scene: name }, 'scene', ['footprints', 'avalanche']).name('scene (reloads)').onChange((s: string) => { location.search = `?scene=${s}` })
  demo.add(view, 'preset', Object.keys(SNOW_PRESETS)).name('snow preset (reloads)').onChange((p: string) => { location.search = `?scene=${name}&preset=${p}` })
  demo.add(view, 'showParticles').name('show particles').onChange((v: boolean) => { mpm.object.visible = v })
  demo.add({ reset }, 'reset').name('reset the snow')
  if (name === 'footprints') {
    demo.add(view, 'walker', ['boots', 'wheels']).name('walker')
    demo.add(view, 'walkSpeed', 0.3, 3, 0.05).name('speed (m/s)')
    demo.add(view, 'sink', 0.05, 0.33, 0.01).name('sinks in (m)')
    demo.add(view, 'showWalker').name('show walker')
    demo.add({ walk }, 'walk').name('walk across')
  } else {
    demo.add(view, 'releaseFriction', 0, 1.2, 0.01).name('bed friction after release')
    demo.add({ release }, 'release').name('release the slab')
  }

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
  })

  Object.assign(window, { mpm, surface, camera, controls, renderer, scene, view, walk, release, reset, snowStats: () => stats(renderer, mpm, surface, walker), walkerPrints: walker.prints, groundAt: spec.ground })

  let last = performance.now(), fps = 60
  renderer.setAnimationLoop(() => {
    const now = performance.now()
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    fps = fps * 0.95 + (1 / Math.max(1e-3, dt)) * 0.05
    controls.update()
    const t = mpm.time - walkStart
    mpm.setColliders(name === 'footprints' && t >= 0 ? walker.colliders(t, view.walker, view.walkSpeed, view.sink) : [])
    walker.object.visible = view.showWalker && t >= 0 && walker.active
    mpm.step(1 / 60) // fixed step: deterministic, and slow motion rather than instability when frames drop
    surface.update()
    renderer.render(scene, camera)
    hud.textContent = `${fps.toFixed(0)} fps · ${mpm.count.toLocaleString()} snow particles · ${mpm.substeps} substeps · t ${mpm.time.toFixed(1)} s\n` +
      (name === 'footprints' ? `${view.walker === 'boots' ? 'footprints' : 'tracks'}: "walk across" in the panel; ?scene=avalanche for the slope` : `"release the slab" in the panel (bed friction ${mpm.options.friction.toFixed(2)})`)
  })
}

if (params.has('check')) hud.textContent = await check(renderer)
else await sandbox(params.get('scene') === 'avalanche' ? 'avalanche' : 'footprints')
