import * as THREE from 'three/webgpu'
import {
  Fn, cos, dot, exp, float, floor, fract, fwidth, max, mix, normalGeometry, normalMap, positionWorld, sin, smoothstep, texture, transformNormalToView, uniform,
  vec2, vec3, normalize, length, positionLocal,
} from 'three/tsl'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  FluidSurface, MPMReference, MPMSolver, ParticleSystem, PuddleField, SplashEmitter, WATER_PRESETS, groundAt, type MPMEmit, type MPMInput,
} from 'threejs-particles'
import { classOf, createPanel, specOptions } from './panel'
import { panels } from './mpm-water.panel'

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

// ---- terrain: rolling ground falling gently towards +z, a few hollows, and a 0.6 m ledge with a channel and plunge pool ----

/** z of the ledge face at x: an irregular earth bank, not a straight wall. */
const lip = (x: number) => -1.1 + 0.1 * Math.sin(1.3 * x + 0.4) + 0.04 * Math.sin(3.7 * x + 1.1)
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))
const dip = (x: number, z: number, cx: number, cz: number, r: number, d: number) => -d * Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (r * r))
function height(x: number, z: number): number {
  // (the face is sharpest where the stream leaves it, so the jet springs clear rather than sliding down a slope)
  const L = lip(x), width = 0.16 + 0.06 * Math.sin(2.3 * x) - 0.09 * Math.exp(-((x - 0.6) ** 2) / 0.08)
  const ledge = (0.62 - 0.05 * Math.cos(1.7 * (x - 0.6))) * smooth((L - z) / width + 0.5) // lowest where the stream crosses
  const roll = 0.04 * Math.sin(0.9 * x + 0.3) * Math.cos(0.7 * z) + 0.015 * Math.sin(2.1 * x - 1.3 * z + 0.7) + 0.008 * Math.sin(5.3 * x + 3.1 * z)
  const hollows = dip(x, z, -0.45, 1.05, 0.38, 0.07) + dip(x, z, 1.15, 1.35, 0.3, 0.06) + dip(x, z, 0.25, 1.85, 0.26, 0.045) + dip(x, z, -1.5, 1.7, 0.4, 0.05)
  const plunge = dip(x, z, 0.6, lip(0.6) + 0.28, 0.3, 0.16) - dip(x, z, 0.1, lip(0.6) + 0.42, 0.28, 0.07) // and a low berm on its far side
  // A groove on the plateau that notches the lip (ending at the top of the face, so the face below is no chute).
  const channel = -0.07 * Math.exp(-((x - 0.6) ** 2) / 0.012) * smooth((L + 0.02 - z) / 0.08 + 0.5)
  // The stream leaves the plunge pool in a shallow meandering bed running off the near edge.
  const bed = -0.13 * Math.exp(-((x - 0.6 - 0.22 * Math.sin(1.4 * z + 0.9)) ** 2) / 0.012) * smooth((z - lip(0.6) - 0.5) / 0.3)
  return roll - 0.05 * z + ledge + hollows + plunge + channel + bed
}

async function sandbox() {
  const muddy = params.has('muddy')
  const preset = muddy ? WATER_PRESETS.muddy : WATER_PRESETS.clear
  const DX = 0.05, RES: [number, number, number] = [96, 48, 96]
  const span = RES[0] * DX
  const origin: [number, number, number] = [-span / 2, -0.45, -span / 2]

  const scene = new THREE.Scene()
  // Overcast sky: a gradient dome (background) prefiltered into the environment everything reflects.
  const skyUniforms = { zenith: uniform(new THREE.Color('#8e9aa7')), horizon: uniform(new THREE.Color('#d3d8dc')), below: uniform(new THREE.Color('#6d6f6c')), intensity: uniform(1.35) }
  const dome = new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false }))
  {
    const m = dome.material as THREE.MeshBasicNodeMaterial
    const dir = normalize(positionLocal)
    m.colorNode = mix(mix(skyUniforms.horizon, skyUniforms.below, smoothstep(0, -0.25, dir.y)), skyUniforms.zenith, smoothstep(0.02, 0.9, dir.y).pow(0.8)).mul(skyUniforms.intensity)
    m.fog = false
  }
  const skyScene = new THREE.Scene()
  skyScene.add(dome)
  const pmrem = new THREE.PMREMGenerator(renderer)
  const env = pmrem.fromScene(skyScene, 0, 0.1, 1000)
  skyScene.remove(dome)
  scene.add(dome)
  scene.environment = env.texture
  scene.fog = new THREE.Fog('#c9cfd3', 18, 120)
  const sun = new THREE.DirectionalLight('#f1efe9', 0.9) // the sun behind thin overcast: soft, mostly from above
  sun.position.set(-3, 9, 4)
  scene.add(sun)

  // Puddles over the domain (same cells as the solver's node columns), feeding the ground shader through a texture.
  const puddles = new PuddleField({ resolution: [RES[0], RES[2]], cellSize: DX, origin: [origin[0], origin[2]], flowSpeed: 0.05, infiltration: 6, evaporation: 0.4, wetTime: 30, dryTime: 240 }, height)
  const N = RES[0] * RES[2]
  const soil = new Float32Array(N), stream = new Float32Array(N)
  for (let k = 0; k < RES[2]; k++) for (let i = 0; i < RES[0]; i++) {
    const x = origin[0] + (i + 0.5) * DX, z = origin[2] + (k + 0.5) * DX, s = 0.15
    // Hollows collect water and fine sediment, so they are bare soil (concave ground; the Laplacian of the terrain).
    const lap = (height(x + s, z) + height(x - s, z) + height(x, z + s) + height(x, z - s) - 4 * height(x, z)) / (s * s)
    soil[k * RES[0] + i] = smooth((lap - 0.4) / 1.8)
    // Where the stream runs, falls and splashes: always wet.
    const channel = Math.exp(-((x - 0.6) ** 2) / 0.008) * smooth((-0.3 - z) / 0.3) + Math.exp(-((x - 0.6 - 0.22 * Math.sin(1.4 * z + 0.9)) ** 2) / 0.015) * smooth((z + 0.4) / 0.3)
    const pool = Math.exp(-((x - 0.6) ** 2 + (z - lip(0.6) - 0.28) ** 2) / 0.25)
    stream[k * RES[0] + i] = Math.min(1, channel + pool)
  }
  const puddleData = new Uint16Array(N * 4)
  const puddleTex = new THREE.DataTexture(puddleData, RES[0], RES[2], THREE.RGBAFormat, THREE.HalfFloatType)
  puddleTex.magFilter = puddleTex.minFilter = THREE.LinearFilter
  const uploadPuddles = () => {
    const h = THREE.DataUtils.toHalfFloat
    // R: water level (world metres; the shore is where it meets the terrain, per pixel), carried four cells into dry
    // ground so the shoreline follows the terrain's own contour rather than the cell grid. G: wetness, B: bare soil,
    // A: depth (or, in those carried cells, the neighbouring depth, so the shader knows water is near).
    const { depth: dep, ground: gr } = puddles, nx = RES[0], nz = RES[2]
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      const c = k * nx + i
      let level = gr[c] + dep[c], near = dep[c]
      if (dep[c] < 0.0005) {
        // The level of the nearest wet cell (not the highest: a neighbouring puddle may stand higher).
        let best = Infinity
        for (let dk = -4; dk <= 4; dk++) for (let di = -4; di <= 4; di++) {
          const ii = i + di, kk = k + dk, d2 = di * di + dk * dk
          if (ii < 0 || kk < 0 || ii >= nx || kk >= nz || d2 >= best) continue
          const n = kk * nx + ii
          if (dep[n] >= 0.0005) { best = d2; level = gr[n] + dep[n]; near = dep[n] }
        }
      }
      puddleData[c * 4] = h(level)
      puddleData[c * 4 + 1] = h(Math.max(puddles.wetness[c], stream[c] * view.streamWet))
      puddleData[c * 4 + 2] = h(soil[c])
      puddleData[c * 4 + 3] = h(near)
    }
    puddleTex.needsUpdate = true
  }

  const view = { rain: params.get('rain') !== '0', rainRate: 14, puddleSpeed: 20, waterfall: params.get('fall') !== '0', flow: 1.3, damBreak: params.get('dam') !== '0', streamWet: 1 }
  const time = uniform(0), rainAmount = uniform(1), outsideWet = uniform(0)
  const ground = groundMaterial(puddleTex, origin, span, time, rainAmount, outsideWet)
  scene.add(terrainMesh(-6, 6, 0.05, ground, 0), terrainMesh(-90, 90, 1, ground, -0.03))

  // The solver: 4.8 × 2.4 × 4.8 m at Δx = 5 cm, open sides (water running off them is retired).
  const config: MPMInput = {
    capacity: 65536, resolution: RES, cellSize: DX, origin, maxSpeed: 6, friction: 0.05, walls: false, substeps: 2, maxSubsteps: 10,
    materials: { water: preset.material },
  }
  const mpm = new MPMSolver(renderer, { ...config, height })
  mpm.object.visible = false
  scene.add(mpm.object)
  const fluid = new FluidSurface(mpm, { ...preset.surface, envMap: scene.environment })
  scene.add(fluid.object)
  const skyAvg = new THREE.Color('#b9c2ca').multiplyScalar(skyUniforms.intensity.value)
  fluid.lighting.set(sun.position.toArray(), sun.color.clone().multiplyScalar(sun.intensity), skyAvg)

  const splash = new SplashEmitter(mpm, { rain: view.rainRate, splashes: 3, radius: 1.6, center: [0.3, 1.1] }, { height, puddles })
  const soak = Number(params.get('soak') ?? 0)
  if (soak > 0) puddles.update(soak * 60, view.rainRate)

  // Rain in the air, around the camera: thin streaks motion-blurred over a 1/60 s shutter (streak = speed × shutter), a
  // near layer and a far one; sizes and terminal speeds vary (bigger drops fall faster), and distant streaks thin out and
  // dim to sub-pixel width instead of aliasing (spark shading).
  const streaks = (capacity: number, life: number, size: number, opacity: number) => new ParticleSystem({
    capacity, rate: 0, life: [life * 0.85, life * 1.15], seed: capacity,
    emitter: { shape: 'box', position: [0, 5, 0], size: [3, 0.3, 3], velocity: [0.5, -7.5, 0.2], spread: 1.4 },
    forces: { gravity: 0, drag: 0, turbulence: 0 },
    curves: { size: [1], opacity: [0, 1, 1, 1, 0.5], color: ['#d6dce1'] },
    render: { shading: 'spark', blending: 'alpha', size, sizeRandom: [0.5, 1.8], stretch: 1 / 60, opacity, softness: 0.05, detail: 0 },
  })
  const rainNear = streaks(6000, 0.9, 0.0011, 0.45), rainFar = streaks(16000, 1.7, 0.0013, 0.3)
  const rain = { object: new THREE.Group() }
  rain.object.add(rainNear.object, rainFar.object)
  scene.add(rain.object)

  // Dam break: a 0.5 × 0.6 × 0.5 m column of water released on the ground.
  const damCentre = (): [number, number, number] => {
    const x = -1.3, z = 0.25
    let top = -Infinity
    for (const a of [-0.25, 0, 0.25]) for (const b of [-0.25, 0, 0.25]) top = Math.max(top, height(x + a, z + b))
    return [x, top + 0.3 + 0.01, z]
  }
  const damBreak = () => {
    mpm.clear()
    if (view.damBreak) mpm.emit({ center: damCentre(), size: [0.25, 0.3, 0.25] })
  }
  damBreak()

  // Waterfall: a sheet of water fed into the channel on the plateau, one particle layer at a time.
  let fallClock = 0
  const feed = (dt: number) => {
    if (!view.waterfall || view.flow <= 0) return
    fallClock += dt
    const layer = DX / 2 / view.flow
    const z = -2.2
    while (fallClock >= layer) {
      fallClock -= layer
      const emit: MPMEmit = { center: [0.6, height(0.6, z) + 0.04, z], size: [0.06, 0.035, DX / 4], velocity: [0, 0, view.flow], jitter: 0.4 }
      mpm.emit(emit)
    }
  }

  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.03, 1500)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  const views: Record<string, [number[], number[]]> = {
    overview: [[2.9, 2.0, 3.6], [-0.2, 0.15, -0.1]],
    dam: [[-0.15, 0.6, 1.55], [-1.25, 0.22, 0.2]],
    fall: [[1.5, 0.95, 0.4], [0.6, 0.2, -0.85]],
    rain: [[-0.05, 0.38, 1.85], [-0.47, -0.12, 1.03]],
  }
  const setView = (name: string) => {
    const [p, t] = views[name] ?? views.overview
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
  demo.add({ v: 'overview' }, 'v', Object.keys(views)).name('camera').onChange(setView)

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
  })
  Object.assign(window, { mpm, fluid, puddles, splash, rainNear, rainFar, camera, controls, renderer, scene, view, setView, damBreak })

  const pauseAt = Number(params.get('pause') ?? Infinity) // `?pause=<s>` freezes the water at that simulated time (screenshots)
  const fwd3 = new THREE.Vector3()
  let last = performance.now(), fps = 60, frames = 0, splashes = 0, splashRate = 0
  renderer.setAnimationLoop(() => {
    const now = performance.now()
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    fps = fps * 0.95 + (1 / Math.max(1e-3, dt)) * 0.05
    controls.update()
    const step = 1 / 60 // fixed: deterministic, slow motion rather than instability when frames drop
    const rate = view.rain ? view.rainRate : 0
    // The splash area follows the camera target (the near field), kept on the domain.
    const lim = span / 2 - splash.options.radius
    splash.set({ rain: rate, center: [Math.max(-lim, Math.min(lim, controls.target.x)), Math.max(-lim, Math.min(lim, controls.target.z))] })
    if (mpm.time < pauseAt) splashes += splash.update(step)
    if (view.puddleSpeed > 1) puddles.update(step * (view.puddleSpeed - 1), rate)
    if (mpm.time < pauseAt) {
      feed(step)
      renderer.compute([...mpm.prepare(step), ...splash.prepare()])
    }
    // The rain volumes follow the camera (a near box around it, a far one ahead of it).
    camera.getWorldDirection(fwd3)
    rainNear.set({ rate: rate * 230, emitter: { position: [camera.position.x + fwd3.x * 1.5, camera.position.y + 3.5, camera.position.z + fwd3.z * 1.5], size: [2.5, 0.3, 2.5] } })
    rainFar.set({ rate: rate * 700, emitter: { position: [camera.position.x + fwd3.x * 10, camera.position.y + 7, camera.position.z + fwd3.z * 10], size: [11, 0.5, 11] } })
    rainNear.update(renderer, dt, camera)
    rainFar.update(renderer, dt, camera)
    time.value += dt
    rainAmount.value = Math.min(1, rate / 15)
    let w = 0
    for (let c = 0; c < N; c += 37) w += puddles.wetness[c]
    outsideWet.value = w / Math.ceil(N / 37)
    if (++frames % 2 === 0) uploadPuddles()
    if (frames % 60 === 0) { splashRate = splashes; splashes = 0 }
    fluid.render(renderer, camera)
    renderer.render(scene, camera)
    let deepest = 0
    for (let c = 0; c < N; c++) deepest = Math.max(deepest, puddles.depth[c])
    hud.textContent = `${fps.toFixed(0)} fps · ${mpm.count.toLocaleString()} particle slots · ${mpm.substeps} substeps · t ${mpm.time.toFixed(1)} s\n` +
      `rain ${rate} mm/h · ${splashRate} splashes/s · puddles ${(puddles.volume() * 1000).toFixed(1)} L, deepest ${(deepest * 1000).toFixed(1)} mm`
  })
}

// Ground: CC0 forest-floor texture (two scales against tiling), bare soil in hollows, dark rock on the steep face,
// darkening and gloss with wetness, and standing water from the puddle field: dark, mirror-smooth, flat, rippled by rain.
function groundMaterial(puddleTex: THREE.Texture, origin: number[], span: number, time: any, rainAmount: any, outsideWet: any) {
  const loader = new THREE.TextureLoader()
  const load = (file: string, srgb: boolean) => {
    const t = loader.load(`cc0/forrest_ground_01/${file}`)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.anisotropy = 16
    if (srgb) t.colorSpace = THREE.SRGBColorSpace
    return t
  }
  const diff = load('forrest_ground_01_diff_1k.jpg', true), nor = load('forrest_ground_01_nor_gl_1k.jpg', false), arm = load('forrest_ground_01_arm_1k.jpg', false)
  const m = new THREE.MeshStandardNodeMaterial()
  const P = positionWorld
  const uvA = P.xz.div(1.7)
  const uvB = vec2(P.x.mul(0.8).sub(P.z.mul(0.6)), P.x.mul(0.6).add(P.z.mul(0.8))).div(4.3)
  // Triplanar on the steep bank (top-down projection would smear it), two scales against tiling on the ground.
  const G = normalize(normalGeometry) // the terrain mesh is untransformed: world space
  const n4 = G.abs().pow(4)
  const nw = n4.div(n4.x.add(n4.y).add(n4.z))
  // (mip-biased: the litter of twigs on the floor texture would read as stripes on a vertical face)
  const side = texture(diff, P.zy.div(1.1)).bias(float(1)).rgb.mul(nw.x).add(texture(diff, P.xy.div(1.1)).bias(float(1)).rgb.mul(nw.z))
  const base = mix(texture(diff, uvA).rgb, texture(diff, uvB).rgb, 0.3).mul(nw.y).add(side)
  const lum = dot(base, vec3(0.2126, 0.7152, 0.0722))
  const tuv = P.xz.sub(vec2(origin[0], origin[2])).div(span)
  const inside = smoothstep(0, 0.01, tuv.x).mul(smoothstep(1, 0.99, tuv.x)).mul(smoothstep(0, 0.01, tuv.y)).mul(smoothstep(1, 0.99, tuv.y))
  const pd = texture(puddleTex, tuv)
  // Water over this pixel: the (flat) puddle level minus the terrain here, so the shoreline follows the ground at pixel
  // detail; only where the field has water nearby.
  const near = smoothstep(0.0002, 0.0008, pd.w).mul(inside)
  const depthPx = pd.x.sub(P.y)
  const depth = max(depthPx, 0).mul(near)
  const wet = mix(outsideWet, pd.y, inside)
  const soil = pd.z.mul(inside)
  const steep = smoothstep(0.3, 0.65, float(1).sub(G.y))
  // Standing water: a crisp shoreline (one pixel wide by fwidth), a soaked fringe of soil just above it, and the meniscus
  // where the water climbs the bank.
  const fwd = max(fwidth(depthPx), 1e-5)
  const water = smoothstep(fwd.negate(), fwd, depthPx.sub(0.0004)).mul(near)
  const fringe = smoothstep(-0.015, -0.001, depthPx).mul(near).mul(float(1).sub(water))
  const meniscus = smoothstep(fwd.negate(), fwd, depthPx.sub(0.0004)).mul(smoothstep(fwd.add(0.0009), fwd.negate().add(0.0009), depthPx)).mul(near)
  let albedo: any = mix(base, vec3(0.5, 0.39, 0.29).mul(lum.mul(2.4)), soil.mul(0.85))
  albedo = mix(albedo, vec3(0.42, 0.32, 0.24).mul(lum.mul(1.5)), steep) // exposed earth on the bank
  albedo = albedo.mul(mix(float(1), float(0.5), wet)).mul(mix(float(1), float(0.62), fringe)) // water in the pores: darker
  // Puddles on soil are turbid: the bottom fades out within a centimetre into muddy water.
  albedo = mix(albedo, mix(vec3(0.055, 0.045, 0.035), albedo.mul(0.45), exp(depth.div(-0.007))), water)
  m.colorNode = albedo
  // (the AO/roughness map is top-down too: faded out on the bank, where it would streak)
  m.roughnessNode = mix(mix(mix(mix(texture(arm, uvA).g, float(0.85), steep), mix(float(0.32), float(0.6), steep), wet), float(0.14), fringe), float(0.03), water)
  m.metalnessNode = float(0)
  m.aoNode = mix(texture(arm, uvA).r, float(1), max(steep, water)) // (under water the litter's crevices are gone too)
  // Rain ripples on standing water: rings expanding from random points in 16 cm cells (two offset layers), fading out
  // with distance by fwidth before they could alias.
  const ripple = Fn(() => {
    const p = P.xz
    const g = vec2(0).toVar()
    const fade = smoothstep(0.006, 0.002, fwidth(p.x))
    for (const [cell, off, speed] of [[0.16, 0, 1], [0.21, 0.37, 1.31]] as const) {
      const q = p.div(cell).add(off)
      const id = floor(q)
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const c = id.add(vec2(i, j))
        const h1 = fract(sin(dot(c, vec2(127.1, 311.7))).mul(43758.5453))
        const h2 = fract(sin(dot(c, vec2(269.5, 183.3))).mul(43758.5453))
        const h3 = fract(sin(dot(c, vec2(419.2, 371.9))).mul(43758.5453))
        const age = fract(time.mul(speed * 1.4).add(h3))
        const d = q.sub(c.add(vec2(h1, h2).mul(0.7).add(0.15))).mul(cell)
        const r = length(d)
        const R = age.mul(0.11)
        const x = r.sub(R)
        const env = exp(x.mul(x).mul(-2500)).mul(float(1).sub(age).pow(2))
        const slope = cos(x.mul(Math.PI * 2 / 0.022)).mul(env).mul(0.2)
        g.addAssign(d.div(max(r, 1e-4)).mul(slope))
      }
    }
    return g.mul(fade).mul(rainAmount)
  })()
  // The meniscus rises up the bank: its normal leans towards the water, more steeply than the ground's.
  const menNormal = normalize(vec3(G.x.mul(5), G.y, G.z.mul(5)))
  const flat = transformNormalToView(normalize(mix(vec3(ripple.x.negate(), 1, ripple.y.negate()), menNormal, meniscus.mul(0.5))))
  const textured = normalMap(texture(nor, uvA), vec2(0.8))
  const geometric = transformNormalToView(G)
  m.normalNode = normalize((mix as any)((mix as any)(textured, geometric, steep), flat, water))
  return m
}

// A terrain grid from `lo` to `hi` (both axes, world metres) at `step`, from the height function, lowered by `drop`.
function terrainMesh(lo: number, hi: number, step: number, material: THREE.Material, drop: number) {
  const n = Math.round((hi - lo) / step) + 1
  const pos = new Float32Array(n * n * 3), nrm = new Float32Array(n * n * 3)
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
    const x = lo + i * step, z = lo + k * step, e = Math.min(step, 0.05)
    const hx = (height(x + e, z) - height(x - e, z)) / (2 * e), hz = (height(x, z + e) - height(x, z - e)) / (2 * e)
    const l = Math.hypot(hx, 1, hz)
    pos.set([x, height(x, z) + drop, z], (k * n + i) * 3)
    nrm.set([-hx / l, 1 / l, -hz / l], (k * n + i) * 3)
  }
  const index = new Uint32Array((n - 1) * (n - 1) * 6)
  let q = 0
  for (let k = 0; k < n - 1; k++) for (let i = 0; i < n - 1; i++) {
    const a = k * n + i
    index.set([a, a + n, a + 1, a + 1, a + n, a + n + 1], q)
    q += 6
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  geo.setIndex(new THREE.BufferAttribute(index, 1))
  geo.computeBoundingSphere()
  return new THREE.Mesh(geo, material)
}

// GPU vs CPU: a 0.75 m block of water thrown onto a slope with per-particle velocities, one substep and 24 substeps on
// both; the results go to `window.mpmWaterCheck` (recorded as packages/particles/test/fixtures/mpm-water-gpu-step.json).
async function check() {
  const slope: [number, number, number] = [0.6, 0.25, 0.1]
  const h = (x: number, z: number) => slope[0] + slope[1] * x + slope[2] * z
  const dt = 1 / 120
  const options: MPMInput = { capacity: 512, resolution: [16, 16, 16], cellSize: 0.25, origin: [0, 0, 0], friction: 0.3, substeps: 1, maxSubsteps: 1, materials: { water: {} } }
  const velocities = Array.from({ length: 216 * 3 }, (_, k) => {
    const i = Math.floor(k / 3)
    return [0.5 + 0.3 * Math.sin(i * 0.7), -2 + 0.5 * Math.cos(i * 1.3), 0.3 * Math.sin(i * 0.31)][k % 3]
  })
  const emit: MPMEmit = { center: [2, h(2.375, 2) + 0.425, 2], size: [0.375, 0.375, 0.375], velocities }
  const runs = []
  const report: string[] = []
  for (const substeps of [1, 24]) {
    const gpu = new MPMSolver(renderer, { ...options, height: h })
    gpu.emit(emit)
    for (let s = 0; s < substeps; s++) gpu.step(dt)
    const g = await gpu.read()
    gpu.dispose()
    const cpu = new MPMReference(options, h)
    cpu.emit(emit)
    for (let s = 0; s < substeps; s++) cpu.substep(dt)
    const err = (a: ArrayLike<number>, b: ArrayLike<number>) => { let e = 0; for (let i = 0; i < b.length; i++) e = Math.max(e, Math.abs(a[i] - b[i])); return e }
    report.push(`${substeps} substep(s): max |Δ| position ${err(cpu.data.position, g.position).toExponential(2)}, velocity ${err(cpu.data.velocity, g.velocity).toExponential(2)}, ` +
      `C ${err(cpu.data.affine, g.affine).toExponential(2)}, F ${err(cpu.data.deformation, g.deformation).toExponential(2)}`)
    const lowest = Math.min(...Array.from({ length: g.count }, (_, p) => g.position[p * 3 + 1] - groundAt(cpu.heights, 16, 16, 0.25, g.position[p * 3], g.position[p * 3 + 2])[0]))
    report.push(`  GPU lowest particle vs ground ${lowest.toExponential(2)} m`)
    const f32 = (a: ArrayLike<number>) => Array.from(a, (v) => Number(v.toPrecision(8)))
    runs.push({ substeps, count: g.count, position: f32(g.position), velocity: f32(g.velocity), affine: f32(g.affine), deformation: f32(g.deformation) })
  }
  const result = { options, slope, emit, dt, runs }
  Object.assign(window, { mpmWaterCheck: result, mpmWaterCheckReport: report })
  hud.textContent = `MPM water GPU vs CPU reference\n${report.join('\n')}`
}

if (params.has('check')) await check()
else await sandbox()
