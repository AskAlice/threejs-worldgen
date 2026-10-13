import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { pass, saturation } from 'three/tsl'
import { World, WorldTerrain, createSample } from 'threejs-biomes'
import TerrainWorker from 'threejs-biomes/worker?worker'
import { Sky } from 'threejs-sky'
import {
  LAVA_GLOW_1400, LAVA_PRESETS, MPMLava, MPMReference, MPMSolver, ParticleLighting, ParticleSystem, lavaCrust, lavaHeatSources, lavaThermalStep, mpmStableStep, resolveMPMOptions,
  type LavaParams, type MPMEmit, type MPMInput,
} from 'threejs-particles'
import { createPanel, classOf, specOptions } from './panel'
import { panels } from './mpm-lava.panel'

// threejs-particles MPM lava sandbox (#74): a vent on the flank of a volcano in a threejs-biomes world pours basalt down
// the slope. The lava cools by radiation, convection and contact with the ground, its viscosity climbs (Arrhenius), a
// crust forms below the solidus, cracks as the molten interior pushes on, and is carried along by it. It glows by
// blackbody colour from its temperature, with heat haze and a few sparks over the hottest lava.
// URL: `?preset=aa` (default pahoehoe), `?night`, `?check` (GPU vs CPU reference, recorded as a test fixture).
const hud = document.getElementById('hud')!
const params = new URLSearchParams(location.search)
const renderer = new THREE.WebGPURenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.AgXToneMapping
renderer.shadowMap.enabled = true
document.body.appendChild(renderer.domElement)
await renderer.init()

if (params.has('check')) await check()
else await sandbox()

async function sandbox() {
  // A volcano: biomes volcanoes are rare cones, so every region gets one here; the vent goes on the gentlest volcanic
  // flank near this one's crater.
  const world = new World({ seed: 7, volcanoes: { chance: 1 } } as any)
  const DX = 0.125, NXZ = 128
  const span = NXZ * DX
  const site = findFlank(world, span, [-4000, 31250])
  // The domain spans the ground's range plus 2 m of lava headroom (particles above the top freeze).
  const ground = Array.from({ length: 33 * 33 }, (_, k) => world.height(site[0] + ((k % 33) / 32 - 0.5) * span, site[1] + (Math.floor(k / 33) / 32 - 0.5) * span))
  const lo = Math.min(...ground), hi = Math.max(...ground)
  const RES: [number, number, number] = [NXZ, Math.min(160, Math.ceil((hi - lo + 2.5) / DX)), NXZ]
  const origin: [number, number, number] = [Math.round((site[0] - span / 2) / DX) * DX, Math.floor(lo - 0.5), Math.round((site[1] - span / 2) / DX) * DX]

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 30000)
  // Ground: the biomes terrain (its LOD reaches centimetres at the camera, on the same heights the solver collides with).
  const terrain = await WorldTerrain.create({ world, camera, scene, createWorker: () => new TerrainWorker(), castShadow: true })
  // Sky over Kīlauea: atmosphere, sun or moon light with shadows, environment light and exposure.
  const sky = await Sky.create({ renderer, scene, camera, observer: { latitude: 19.4, longitude: -155.3 }, clock: { date: '2026-03-04T12:00:00Z', paused: true }, // a day after full moon: a moonlit night
    // Exposure capped like a camera at an eruption: at night it exposes for the lava, not for the dark land around it.
    lighting: { autoExposure: true, exposureRange: [0.25, 0.7] } })
  // The lava as a light source: a few point lights over the brightest clusters of glowing surface (from the read-back).
  const glows = Array.from({ length: 4 }, () => new THREE.PointLight('#ff8a3c', 0, 0, 2))
  scene.add(...glows)

  const presetName = (params.get('preset') === 'aa' ? 'aa' : 'pahoehoe') as keyof typeof LAVA_PRESETS
  const preset = LAVA_PRESETS[presetName]
  const config: MPMInput = {
    capacity: 200000, resolution: RES, cellSize: DX, origin,
    substeps: 2, maxSubsteps: 12, maxSpeed: 5, friction: 0.6,
    materials: { lava: { viscosityMax: 2000, ...preset.material } },
  }
  const mpm = new MPMSolver(renderer, { ...config, height: world.height })
  mpm.object.visible = false
  const lighting = new ParticleLighting()
  // Emission is scaled against a noon sun of intensity 3 (see LavaOptions.render.intensity); the sky's is sunIntensity.
  const emission = sky.dayNight.settings.sunIntensity / 3
  const lava = new MPMLava(mpm, { ...preset.lava, render: { ...preset.lava.render, intensity: emission }, lighting, envMap: scene.environment })
  scene.add(lava.object)
  if (params.has('nolava')) lava.object.visible = false // debug: the scene without the lava surface

  // Heat haze and sparks over the hottest lava (sources refreshed from the read-back; rates are per unit of source weight,
  // i.e. per particle glowing like 1400 K lava).
  const haze = new ParticleSystem({
    capacity: 1500, rate: 0.05, life: [1.2, 2.2], lighting, emitter: { shape: 'sources', size: [0.2, 0.05, 0.2], velocity: [0, 0.8, 0], spread: 0.2 },
    forces: { gravity: 0, drag: 0.5, turbulence: 0.6, turbulenceScale: 1.5, turbulenceSpeed: 0.4 },
    curves: { size: [0.6, 1, 1.4], opacity: [0, 1, 0.6, 0] }, render: { shading: 'haze', blending: 'alpha', size: 1.4, refraction: 0.006, softness: 0.4 },
  })
  const sparks = new ParticleSystem({
    capacity: 400, rate: 0.004, life: [0.6, 1.4], lighting, emitter: { shape: 'sources', size: [0.05, 0, 0.05], velocity: [0, 2.5, 0], spread: 1.2, temperature: [1350, 1450] },
    forces: { gravity: 9.81, cooling: 1.2, drag: 0.3 }, curves: { size: [1], opacity: [0, 1, 1, 0], color: ['#ffffff'] },
    render: { shading: 'spark', blending: 'additive', size: 0.012, stretch: 0.03, intensity: 3, blackbody: true },
  })
  scene.add(haze.object, sparks.object)

  // The vent: near the uphill edge of the domain, pouring downhill.
  const v = vent(world, origin, span)
  const view = { night: params.has('night'), preset: presetName, vent: true, ventSpeed: 0.5, ventRadius: 0.6, follow: false }
  let layerClock = 0
  // One layer of the vent: a half-disc of particles across the downhill direction at the ground (a breakout from the
  // flank), pushed out downhill; a new layer each time the last has moved one particle spacing.
  const emitLayer = () => {
    const h = DX / 2, r = view.ventRadius
    const side = [-v.dir[2], 0, v.dir[0]]
    const pos: number[] = []
    for (let a = -r; a <= r + 1e-6; a += h) for (let b = h / 2; b <= r; b += h) {
      if (a * a + b * b > r * r) continue
      const x = v.at[0] + side[0] * a, z = v.at[2] + side[2] * a
      pos.push(x, world.height(x, z) + b, z)
    }
    return lava.emit({ positions: pos, velocity: [v.dir[0] * view.ventSpeed, -0.1, v.dir[2] * view.ventSpeed] })
  }
  const reset = () => { mpm.clear(); layerClock = 0 }

  // A view across the flow from beside the vent, looking down the flank to the horizon.
  const look = [v.at[0] + v.dir[0] * 2, 0, v.at[2] + v.dir[2] * 2]
  look[1] = world.height(look[0], look[2])
  const cam = [v.at[0] - v.dir[0] * 1 - v.dir[2] * 3, 0, v.at[2] - v.dir[2] * 1 + v.dir[0] * 3]
  camera.position.set(cam[0], Math.max(look[1], world.height(cam[0], cam[2])) + 1.7, cam[2])
  if (params.has('close')) {
    // ?close: about 3 m from the flow, beside the toe a metre and a half below the vent.
    const toe = [v.at[0] + v.dir[0] * 1.5, 0, v.at[2] + v.dir[2] * 1.5]
    toe[1] = world.height(toe[0], toe[2])
    look.splice(0, 3, ...toe)
    const at = [toe[0] - v.dir[2] * 2.4 + v.dir[0] * 1, 0, toe[2] + v.dir[0] * 2.4 + v.dir[2] * 1]
    camera.position.set(at[0], world.height(at[0], at[2]) + 1.4, at[2])
  }
  const controls = new OrbitControls(camera, renderer.domElement)
  // Bloom: the glare of incandescent lava (only what is brighter than white after exposure blooms).
  const pipeline = new THREE.RenderPipeline(renderer)
  const color = pass(scene, camera).getTextureNode('output')
  // AgX's "punchy" look: a saturation lift into the tone mapper, so incandescence stays orange instead of going pastel.
  pipeline.outputNode = saturation(color.add(bloom(color, 0.35, 0.5, 0.6)), 1.35)
  controls.target.set(look[0], look[1] + 0.2, look[2])
  controls.enableDamping = true

  // Day: late morning; night: a moonless hour before midnight (the lava is the light).
  const setDayNight = () => { sky.setTimeOfDay(view.night ? 22.5 : 10.5) }
  sky.update(0)
  setDayNight()
  sky.follow(controls.target)

  const gui = createPanel([{
    name: 'threejs-particles', classes: [
      classOf('MPMSolver', mpm, mpm.options, specOptions(panels['threejs-particles'].MPMSolver)),
      classOf('MPMLava', lava, lava.options, specOptions(panels['threejs-particles'].MPMLava)),
    ],
  }], { title: 'threejs-particles · MPM lava' })
  const demo = gui.addFolder('demo')
  demo.add(view, 'preset', ['pahoehoe', 'aa']).name('preset (pāhoehoe / ʻaʻā)').onChange((k: keyof typeof LAVA_PRESETS) => {
    mpm.set({ materials: { lava: LAVA_PRESETS[k].material } })
    lava.set(LAVA_PRESETS[k].lava)
  })
  demo.add(view, 'night').name('night').onChange(setDayNight)
  demo.add(view, 'vent').name('vent erupting')
  demo.add(view, 'ventSpeed', 0.1, 2, 0.05).name('vent speed (m/s)')
  demo.add(view, 'ventRadius', 0.2, 1.2, 0.01).name('vent radius (m)')
  demo.add(view, 'follow').name('domain follows camera target')
  demo.add({ reset }, 'reset').name('clear the lava')

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
  })

  // Read-back every 1.5 s: haze/spark sources, the lava light, and flow statistics for the HUD.
  const stats = { crust: NaN, molten: NaN, front: NaN, frontSpeed: NaN, interiorSpeed: NaN, hottest: NaN }
  let reading = false, lastRead = performance.now(), lastFront = NaN, lastFrontTime = 0
  const measure = async () => {
    reading = true
    try { await measureNow() } finally { reading = false }
  }
  const measureNow = async () => {
    const d = await mpm.read()
    const S = new Float32Array(await renderer.getArrayBufferAsync(mpm.buffers.state.value))
    const ages = Float32Array.from({ length: d.count }, (_, q) => S[q * 4 + 3]) // surface age, for the skin temperature
    const o = mpm.options.origin, p = mpm.options.materials.lava as LavaParams
    const src = lavaHeatSources(d, o, { minTemperature: 900, max: 1024, ages, airTemperature: p.airTemperature })
    haze.setSources(src)
    sparks.setSources(src)
    let crust = 0, surface = 0, molten = 0, front = -Infinity, interior = 0, hottest = 0, gw = 0
    const c = [0, 0, 0]
    for (let q = 0; q < d.count; q++) {
      const s = lavaCrust(d.temperature[q], p)
      if (ages[q] > 0) { surface++; if (s > 0.5) crust++ } // the surface layer: crusted where it is past the solidus band
      if (s < 0.01) { molten++; interior += Math.hypot(d.velocity[q * 3], d.velocity[q * 3 + 1], d.velocity[q * 3 + 2]) }
      front = Math.max(front, d.position[q * 3] * v.dir[0] + d.position[q * 3 + 2] * v.dir[2])
      hottest = Math.max(hottest, d.temperature[q])
    }
    // A Lambertian emitter of radiance L and area A has intensity L·A: the surface particles' skin glow (the sources'
    // weights sum it) × their splat area, at the shader's emission scale, binned into 1 m cells; the 4 brightest cells
    // get a light each, 0.4 m above their glow-weighted centre.
    const bins = new Map<string, number[]>()
    for (let s = 0; s < src.length; s += 8) {
      const key = `${Math.floor(src[s])},${Math.floor(src[s + 2])}`
      const b = bins.get(key) ?? bins.set(key, [0, 0, 0, 0]).get(key)!
      b[3] += src[s + 3]; for (let a = 0; a < 3; a++) b[a] += src[s + a] * src[s + 3]
      gw += src[s + 3]
    }
    const top = [...bins.values()].sort((a, b) => b[3] - a[3]).slice(0, glows.length)
    glows.forEach((light, k) => {
      const b = top[k]
      light.intensity = b ? LAVA_GLOW_1400 * lava.options.render.intensity * b[3] * (DX / 2) ** 2 : 0
      if (b) light.position.set(b[0] / b[3], b[1] / b[3] + 0.4, b[2] / b[3])
    })
    void c
    const now = mpm.time
    const frontSpeed = Number.isFinite(lastFront) && now > lastFrontTime ? (front - lastFront) / (now - lastFrontTime) : NaN
    lastFront = front; lastFrontTime = now
    Object.assign(stats, { crust: crust / Math.max(1, surface), molten: molten / Math.max(1, d.count), front, frontSpeed, interiorSpeed: interior / Math.max(1, molten), hottest })
  }
  Object.assign(window, { mpm, lava, world, camera, controls, renderer, scene, sky, terrain, lavaStats: stats, view, setDayNight, vent: v })

  let last = performance.now(), fps = 60
  renderer.setAnimationLoop(() => {
    const now = performance.now()
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    fps = fps * 0.95 + (1 / Math.max(1e-3, dt)) * 0.05
    controls.update()
    if (view.follow) mpm.center(controls.target.x, controls.target.y, controls.target.z)
    const step = 1 / 60 // fixed step: deterministic, and slow motion rather than instability when frames drop
    if (view.vent && mpm.count + 200 < mpm.capacity) {
      layerClock += step * view.ventSpeed
      while (layerClock >= DX / 2) { emitLayer(); layerClock -= DX / 2 } // one particle layer per spacing of outflow
    }
    sky.update()
    // The terrain's aerial perspective (when its material has one) follows the sky's sun and horizon colour.
    const aerial = terrain.uniforms as { sunDirection?: { value: THREE.Vector3 }; hazeColor?: { value: THREE.Color } }
    aerial.sunDirection?.value.set(...sky.state.sunDirection)
    const fog = sky.lighting?.fogColor
    if (fog) aerial.hazeColor?.value.setRGB(fog[0], fog[1], fog[2])
    lava.setEnvironment(scene.environment)
    lighting.fromScene(scene)
    lava.uniforms.environmentIntensity.value = scene.environmentIntensity
    renderer.compute([...lava.prepare(step), ...haze.prepare(renderer, step, camera), ...sparks.prepare(renderer, step, camera)])
    lava.render(renderer, camera)
    pipeline.render()
    if (!reading && mpm.time > 0.5 && now - lastRead > 1500) { lastRead = now; void measure() }
    const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)} %` : '…')
    const ms = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)} cm/s` : '…')
    hud.textContent = `${fps.toFixed(0)} fps · ${mpm.count.toLocaleString()} particles · ${mpm.substeps} substeps · t ${mpm.time.toFixed(1)} s · ${view.preset}${view.night ? ' · night' : ''}\n` +
      `surface crusted ${pct(stats.crust)}, particles molten ${pct(stats.molten)} · hottest ${Number.isFinite(stats.hottest) ? stats.hottest.toFixed(0) : '…'} K\n` +
      `front ${ms(stats.frontSpeed)} · molten interior ${ms(stats.interiorSpeed)}${mpm.count + 200 >= mpm.capacity ? ' · pool full: vent paused' : ''}`
  })
}

// The volcanic-biome flank within 1.5 km of `near` whose relief over the domain is closest to 6 m (~20°: lava runs), as a site centre.
function findFlank(world: World, span: number, near: [number, number]): [number, number] {
  const ids = world.options.biomes.map((b) => b.id)
  const s = createSample(8)
  let best: [number, number] = near, bestScore = Infinity
  for (let r = 300; r <= 1500; r += 150) for (let a = 0; a < 24; a++) {
    const x = near[0] + r * Math.cos((a * Math.PI) / 12), z = near[1] + r * Math.sin((a * Math.PI) / 12)
    world.sample(x, z, s)
    if (ids[s.biomes[0]] !== 'volcanic' || s.weights[0] < 0.6 || world.height(x, z) < world.options.seaLevel + 5) continue
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i <= 4; i++) for (let k = 0; k <= 4; k++) {
      const h = world.height(x + (i / 4 - 0.5) * span, z + (k / 4 - 0.5) * span)
      lo = Math.min(lo, h); hi = Math.max(hi, h)
    }
    const score = Math.abs(hi - lo - 6)
    if (score < bestScore) { bestScore = score; best = [x, z] }
  }
  return best
}

// The vent: 2.5 m inside the domain edge, on the side from which the ground falls most steadily through the domain
// centre (the steepest of 24 directions, scored by the lowest drop along the path), pouring towards the centre.
function vent(world: World, origin: [number, number, number], span: number) {
  const c = [origin[0] + span / 2, origin[2] + span / 2]
  const back = span / 2 - 2.5
  let best = { score: -Infinity, dir: [1, 0, 0] }
  for (let a = 0; a < 24; a++) {
    const dir = [Math.cos((a * Math.PI) / 12), 0, Math.sin((a * Math.PI) / 12)]
    let score = Infinity // the smallest drop over any 1 m step along the path: no hollows to pond in
    for (let t = -back; t < back - 2; t += 1) score = Math.min(score, world.height(c[0] + dir[0] * t, c[1] + dir[2] * t) - world.height(c[0] + dir[0] * (t + 1), c[1] + dir[2] * (t + 1)))
    if (score > best.score) best = { score, dir }
  }
  const x = c[0] - best.dir[0] * back, z = c[1] - best.dir[2] * back
  return { at: [x, world.height(x, z), z], dir: best.dir }
}

// GPU vs CPU: a small lava block on a slope, inside the crust band and cooling fast, through 1 and 24 frames of
// 2 substeps plus the thermal step each, on both. Results go to `window.lavaCheck` (recorded as
// packages/particles/test/fixtures/mpm-lava-gpu-step.json).
async function check() {
  const slope: [number, number, number] = [0.6, 0.25, 0.1]
  const height = (x: number, z: number) => slope[0] + slope[1] * x + slope[2] * z
  const options: MPMInput = {
    capacity: 512, resolution: [16, 16, 16], cellSize: 0.125, origin: [0, 0, 0], friction: 0.5, maxSpeed: 5, substeps: 2, maxSubsteps: 2,
    materials: { lava: { viscosity: 300, viscosityMax: 2000, eruption: 1340, skin: 0.0005 } },
  }
  const dt = mpmStableStep(resolveMPMOptions(options))
  const substeps = 2
  const emit: MPMEmit = { center: [1, height(1.1875, 1) + 0.2, 1], size: [0.1875, 0.1875, 0.1875], velocity: [0.3, -0.5, 0.1], material: 'lava', temperature: 1290 }
  const runs = []
  const report: string[] = []
  for (const frames of [1, 24]) {
    const gpu = new MPMSolver(renderer, { ...options, height })
    const lava = new MPMLava(gpu)
    gpu.emit(emit)
    for (let f = 0; f < frames; f++) renderer.compute(lava.prepare(substeps * dt))
    const g = await gpu.read()
    lava.dispose()
    gpu.dispose()
    const cpu = new MPMReference(options, height)
    cpu.emit(emit)
    for (let f = 0; f < frames; f++) {
      for (let s = 0; s < substeps; s++) cpu.substep(dt)
      lavaThermalStep(cpu, substeps * dt)
    }
    const err = (a: ArrayLike<number>, b: ArrayLike<number>) => { let e = 0; for (let i = 0; i < b.length; i++) e = Math.max(e, Math.abs(a[i] - b[i])); return e }
    let crust = 0
    for (let q = 0; q < g.count; q++) crust += lavaCrust(g.temperature[q], cpu.options.materials.lava as LavaParams) > 0.5 ? 1 : 0
    report.push(`${frames} frame(s): max |Δ| position ${err(cpu.data.position, g.position).toExponential(2)}, velocity ${err(cpu.data.velocity, g.velocity).toExponential(2)}, ` +
      `F ${err(cpu.data.deformation, g.deformation).toExponential(2)}, T ${err(cpu.data.temperature, g.temperature).toExponential(2)} K · ${crust}/${g.count} crust`)
    const f32 = (a: ArrayLike<number>) => Array.from(a, (x) => Number(x.toPrecision(8)))
    runs.push({ frames, count: g.count, position: f32(g.position), velocity: f32(g.velocity), deformation: f32(g.deformation), temperature: f32(g.temperature) })
  }
  const result = { options, slope, emit, dt, substeps, runs }
  Object.assign(window, { lavaCheck: result, lavaCheckReport: report })
  hud.textContent = `MPM lava GPU vs CPU reference\n${report.join('\n')}`
}
