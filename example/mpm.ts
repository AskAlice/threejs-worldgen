import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { MPMSolver } from 'threejs-particles'
import { createPanel, classOf, specOptions } from './panel'
import { panels } from './mpm.panel'
import { buildTerrain, check, jellyScene, jellyStats } from './mpm-scene'

// threejs-particles MPM sandbox: an MLS-MPM jelly block dropped onto biomes terrain, bouncing and settling.
// Every solver option is in the shared panel (mpm.panel.ts); the demo folder re-drops the block. The pool holds
// 46³ ≈ 97k particles: `?block=46` drops that many (the performance case; a 7 m jelly that wobbles for a long
// time, as explicit viscosity damps a block's slowest mode by only ~1/(cells across)), the default 24 (3.6 m)
// settles in seconds. `?drop=` sets the drop height. `?check` instead runs a tiny scene on the GPU and on the CPU
// reference and compares them.
const hud = document.getElementById('hud')!
const params = new URLSearchParams(location.search)
const renderer = new THREE.WebGPURenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.AgXToneMapping
document.body.appendChild(renderer.domElement)
await renderer.init()

if (params.has('check')) hud.textContent = await check(renderer)
else await sandbox()

async function sandbox() {
  const { world, DX, RES, span, origin, config, dropAt } = jellyScene()

  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#9db8d3')
  scene.fog = new THREE.Fog('#9db8d3', 40, 280)
  const sun = new THREE.DirectionalLight('#fff1dc', 3)
  sun.position.set(-40, 60, 25)
  scene.add(sun, new THREE.HemisphereLight('#cfe3ff', '#5a5040', 1))
  scene.add(buildTerrain(world, origin, DX, RES[0], 60))
  // Backdrop: coarse terrain out to the fog, a little lower so the exact patch above always wins.
  const far = buildTerrain(world, [origin[0] - 300, origin[1], origin[2] - 300], 3, 200 + Math.round(span / 3), 0)
  far.position.y = -0.3
  scene.add(far)

  const view = { block: Number(params.get('block') ?? 24), dropHeight: Number(params.get('drop') ?? 1), follow: false }
  const mpm = new MPMSolver(renderer, { ...config, height: world.height })
  scene.add(mpm.object)

  const center = () => dropAt(view.block, view.dropHeight)
  const drop = () => {
    mpm.clear()
    const half = (view.block * DX) / 4 // `block` particles per edge at Δx/2 spacing
    mpm.emit({ center: center(), size: [half, half, half] })
  }
  drop()

  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 2000)
  const c0 = center(), edge = (view.block * DX) / 2
  camera.position.set(c0[0] + 2.2 * edge, c0[1] + edge, c0[2] + 2.5 * edge)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.target.set(c0[0], c0[1] - view.dropHeight - edge * 0.3, c0[2])
  controls.enableDamping = true

  const gui = createPanel([{ name: 'threejs-particles', classes: [classOf('MPMSolver', mpm, mpm.options, specOptions(panels['threejs-particles'].MPMSolver))] }], { title: 'threejs-particles · MPM' })
  const demo = gui.addFolder('demo')
  demo.add(view, 'block', 8, Math.round(Math.cbrt(mpm.capacity)), 1).name('block (particles per edge)')
  demo.add(view, 'dropHeight', 0, 8, 0.1).name('drop height (m)')
  demo.add(view, 'follow').name('domain follows camera target')
  demo.add({ drop }, 'drop').name('drop the block')

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
  })
  Object.assign(window, { mpm, world, camera, controls, renderer, scene })

  const { stats, measure, hud: status } = jellyStats(mpm, world)
  let reading = false, lastRead = 0
  Object.assign(window, { mpmStats: stats })

  let last = performance.now(), fps = 60
  renderer.setAnimationLoop(() => {
    const now = performance.now()
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    fps = fps * 0.95 + (1 / Math.max(1e-3, dt)) * 0.05
    controls.update()
    if (view.follow) mpm.center(controls.target.x, controls.target.y, controls.target.z)
    mpm.step(1 / 60) // fixed step: deterministic, and slow motion rather than instability when frames drop
    renderer.render(scene, camera)
    if (!reading && now - lastRead > 2000) { lastRead = now; reading = true; void measure().finally(() => (reading = false)) }
    hud.textContent = status(fps)
  })
}
