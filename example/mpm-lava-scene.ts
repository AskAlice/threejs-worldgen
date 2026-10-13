import * as THREE from 'three/webgpu'
import { World, createSample } from 'threejs-biomes'
import { DEFAULT_LIGHTING } from 'threejs-sky'
import {
  LAVA_GLOW_1400, LAVA_PRESETS, MPMLava, MPMReference, MPMSolver, lavaCrust, lavaHeatSources, lavaThermalStep, mpmStableStep, resolveMPMOptions,
  type LavaInput, type LavaParams, type MPMEmit, type MPMInput, type ParticleInput, type ParticleSystem,
} from 'threejs-particles'

// The scene of the MPM lava sandboxes (mpm-lava.ts and mpm-lava-r3f.tsx): a vent on the flank of a volcano in a
// threejs-biomes world, the solver and lava settings, the vent's outflow, the heat haze and sparks, the read-back
// statistics, and the GPU vs CPU check behind `?check`.

/** A vent: where it is (world) and the downhill direction it pours in. */
export interface Vent { at: number[]; dir: number[] }

/**
 * The world (biomes volcanoes are rare cones, so every region gets one here), the solver domain on the gentlest volcanic
 * flank near this one's crater (its ground's range plus 2 m of lava headroom: particles above the top freeze), the
 * vent, and the camera: across the flow from beside the vent, looking down the flank to the horizon (`close`: about
 * 3 m from the flow, beside the toe a metre and a half below the vent).
 */
export function lavaScene(close: boolean) {
  const world = new World({ seed: 7, volcanoes: { chance: 1 } } as any)
  const DX = 0.125, NXZ = 128
  const span = NXZ * DX
  const site = findFlank(world, span, [-4000, 31250])
  const ground = Array.from({ length: 33 * 33 }, (_, k) => world.height(site[0] + ((k % 33) / 32 - 0.5) * span, site[1] + (Math.floor(k / 33) / 32 - 0.5) * span))
  const lo = Math.min(...ground), hi = Math.max(...ground)
  const RES: [number, number, number] = [NXZ, Math.min(160, Math.ceil((hi - lo + 2.5) / DX)), NXZ]
  const origin: [number, number, number] = [Math.round((site[0] - span / 2) / DX) * DX, Math.floor(lo - 0.5), Math.round((site[1] - span / 2) / DX) * DX]
  const v = vent(world, origin, span)
  const look = [v.at[0] + v.dir[0] * 2, 0, v.at[2] + v.dir[2] * 2]
  look[1] = world.height(look[0], look[2])
  const cam = [v.at[0] - v.dir[0] * 1 - v.dir[2] * 3, 0, v.at[2] - v.dir[2] * 1 + v.dir[0] * 3]
  let position: [number, number, number] = [cam[0], Math.max(look[1], world.height(cam[0], cam[2])) + 1.7, cam[2]]
  if (close) {
    const toe = [v.at[0] + v.dir[0] * 1.5, 0, v.at[2] + v.dir[2] * 1.5]
    toe[1] = world.height(toe[0], toe[2])
    look.splice(0, 3, ...toe)
    const at = [toe[0] - v.dir[2] * 2.4 + v.dir[0] * 1, 0, toe[2] + v.dir[0] * 2.4 + v.dir[2] * 1]
    position = [at[0], world.height(at[0], at[2]) + 1.4, at[2]]
  }
  const target: [number, number, number] = [look[0], look[1] + 0.2, look[2]]
  return { world, DX, RES, origin, span, vent: v, camera: { position, target } }
}

/** The solver settings for a preset. */
export function lavaConfig(RES: [number, number, number], DX: number, origin: [number, number, number], preset: keyof typeof LAVA_PRESETS): MPMInput {
  return {
    capacity: 200000, resolution: RES, cellSize: DX, origin,
    substeps: 2, maxSubsteps: 12, maxSpeed: 5, friction: 0.6,
    materials: { lava: { viscosityMax: 2000, ...LAVA_PRESETS[preset].material } },
  }
}

/**
 * The lava's settings for a preset. Emission is scaled against a noon sun of intensity 3 (see
 * LavaOptions.render.intensity); the sky's is its lighting's sunIntensity.
 */
export function lavaInput(preset: keyof typeof LAVA_PRESETS): LavaInput {
  const lava = LAVA_PRESETS[preset].lava
  return { ...lava, render: { ...lava.render, intensity: DEFAULT_LIGHTING.sunIntensity / 3 } }
}

// Heat haze and sparks over the hottest lava (sources refreshed from the read-back; rates are per unit of source weight,
// i.e. per particle glowing like 1400 K lava).
export const HAZE: ParticleInput = {
  capacity: 1500, rate: 0.05, life: [1.2, 2.2], emitter: { shape: 'sources', size: [0.2, 0.05, 0.2], velocity: [0, 0.8, 0], spread: 0.2 },
  forces: { gravity: 0, drag: 0.5, turbulence: 0.6, turbulenceScale: 1.5, turbulenceSpeed: 0.4 },
  curves: { size: [0.6, 1, 1.4], opacity: [0, 1, 0.6, 0] }, render: { shading: 'haze', blending: 'alpha', size: 1.4, refraction: 0.006, softness: 0.4 },
}
export const SPARKS: ParticleInput = {
  capacity: 400, rate: 0.004, life: [0.6, 1.4], emitter: { shape: 'sources', size: [0.05, 0, 0.05], velocity: [0, 2.5, 0], spread: 1.2, temperature: [1350, 1450] },
  forces: { gravity: 9.81, cooling: 1.2, drag: 0.3 }, curves: { size: [1], opacity: [0, 1, 1, 0], color: ['#ffffff'] },
  render: { shading: 'spark', blending: 'additive', size: 0.012, stretch: 0.03, intensity: 3, blackbody: true },
}

/**
 * One layer of the vent: a half-disc of particles (radius `radius` m) across the downhill direction at the ground (a
 * breakout from the flank), pushed out downhill at `speed` m/s. The sandboxes emit a new layer each time the last has
 * moved one particle spacing.
 */
export function emitLayer(lava: MPMLava, world: World, v: Vent, radius: number, speed: number) {
  const h = lava.solver.options.cellSize / 2, r = radius
  const side = [-v.dir[2], 0, v.dir[0]]
  const pos: number[] = []
  for (let a = -r; a <= r + 1e-6; a += h) for (let b = h / 2; b <= r; b += h) {
    if (a * a + b * b > r * r) continue
    const x = v.at[0] + side[0] * a, z = v.at[2] + side[2] * a
    pos.push(x, world.height(x, z) + b, z)
  }
  return lava.emit({ positions: pos, velocity: [v.dir[0] * speed, -0.1, v.dir[2] * speed] })
}

/**
 * Read-back of the lava (every 1.5 s in the sandboxes): heat haze and spark sources over the hottest lava, a light over
 * each of the brightest clusters of glowing surface (`glows`), and flow statistics for the HUD (`hud(fps, label)`).
 */
export function lavaStats(renderer: THREE.WebGPURenderer, mpm: MPMSolver, lava: MPMLava, haze: ParticleSystem, sparks: ParticleSystem, glows: THREE.PointLight[], v: Vent) {
  const DX = mpm.options.cellSize
  const stats = { crust: NaN, molten: NaN, front: NaN, frontSpeed: NaN, interiorSpeed: NaN, hottest: NaN }
  let lastFront = NaN, lastFrontTime = 0
  const measure = async () => {
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
  const hud = (fps: number, label: string) => {
    const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)} %` : '…')
    const ms = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)} cm/s` : '…')
    return `${fps.toFixed(0)} fps · ${mpm.count.toLocaleString()} particles · ${mpm.substeps} substeps · t ${mpm.time.toFixed(1)} s · ${label}\n` +
      `surface crusted ${pct(stats.crust)}, particles molten ${pct(stats.molten)} · hottest ${Number.isFinite(stats.hottest) ? stats.hottest.toFixed(0) : '…'} K\n` +
      `front ${ms(stats.frontSpeed)} · molten interior ${ms(stats.interiorSpeed)}${mpm.count + 200 >= mpm.capacity ? ' · pool full: vent paused' : ''}`
  }
  return { stats, measure, hud }
}

// The volcanic-biome flank within 1.5 km of `near` whose relief over the domain is closest to 6 m (~20°: lava runs), as a site centre.
export function findFlank(world: World, span: number, near: [number, number]): [number, number] {
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
export function vent(world: World, origin: [number, number, number], span: number): Vent {
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
export async function check(renderer: THREE.WebGPURenderer): Promise<string> {
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
  return `MPM lava GPU vs CPU reference\n${report.join('\n')}`
}
