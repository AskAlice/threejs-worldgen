import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { MPMReference, mpmStableStep, resolveMPMOptions } from '../src/mpm-reference.ts'
import { det3, identity3, mpmMaterial, mul3, transpose3 } from '../src/mpm-materials.ts'
import {
  DEFAULT_LAVA, LAVA, LAVA_DEFAULTS, LAVA_PRESETS, lavaCoolingRate, lavaCrust, lavaGlow, lavaHeatSources, lavaSkin, lavaThermalStep, lavaViscosity, lavaYield, resolveLavaOptions,
  type LavaParams,
} from '../src/mpm-lava.ts'

const P: LavaParams = { ...LAVA_DEFAULTS }
const zero = new Array(9).fill(0)
const cpu = LAVA.cpu
const ctx = (F: number[], T: number, p: LavaParams = P, C = zero) => ({ F, J: det3(F), Jp: 1, C, temperature: T, dt: 1e-3, params: p })

test('registered, with defaults, presets that resolve, and a time step bounded by the viscosity cap', () => {
  assert.equal(mpmMaterial('lava'), LAVA)
  const o = resolveMPMOptions({ materials: { lava: LAVA_PRESETS.aa.material } })
  assert.equal(o.materials.lava.viscosity, LAVA_PRESETS.aa.material.viscosity)
  assert.equal(o.materials.lava.activation, LAVA_DEFAULTS.activation)
  assert.ok(mpmStableStep(o) <= o.cellSize ** 2 / (6 * (o.materials.lava.viscosityMax / o.materials.lava.density)) + 1e-15)
  for (const k of ['pahoehoe', 'aa'] as const) assert.deepEqual(resolveLavaOptions(LAVA_PRESETS[k].lava).material, 'lava')
  assert.deepEqual(resolveLavaOptions({ render: { radius: -3, crust: 'red', ropes: 7, iterations: 2.6 } }).render, { ...DEFAULT_LAVA.render, radius: 0.5, ropes: 1, iterations: 3 })
})

test('viscosity: η at the eruption temperature, Arrhenius in 1/T, monotonic, capped', () => {
  assert.ok(Math.abs(lavaViscosity(P.eruption, P) - P.viscosity) < 1e-9)
  const [a, b] = [1400, 1350]
  // ln η(a) − ln η(b) = activation·(1/a − 1/b), below the cap
  assert.ok(Math.abs(Math.log(lavaViscosity(a, P) / lavaViscosity(b, P)) - P.activation * (1 / a - 1 / b)) < 1e-9)
  let prev = 0
  for (let T = 1500; T >= 900; T -= 10) {
    const eta = lavaViscosity(T, P)
    assert.ok(eta >= prev - 1e-9, `rises as it cools (${T} K)`)
    assert.ok(eta <= P.viscosityMax)
    prev = eta
  }
  assert.equal(lavaViscosity(P.solidus - 100, P), P.viscosityMax)
  // Steep: 50 K of cooling at least doubles it.
  assert.ok(lavaViscosity(P.eruption - 50, P) > 2 * P.viscosity)
})

test('crust: 0 molten, 1 at and below the solidus, smooth in between; the yield stress rises with it', () => {
  assert.equal(lavaCrust(P.solidus + P.crustRange + 1, P), 0)
  assert.equal(lavaCrust(P.solidus, P), 1)
  assert.equal(lavaCrust(P.solidus - 200, P), 1)
  assert.ok(Math.abs(lavaCrust(P.solidus + P.crustRange / 2, P) - 0.5) < 1e-12)
  assert.equal(lavaYield(1500, P), P.meltYield)
  assert.equal(lavaYield(P.solidus, P), P.yieldStress)
  assert.ok(Math.abs(lavaYield(P.solidus + P.crustRange / 2, P) - (P.meltYield + P.yieldStress) / 2) < 1e-9)
  // Rest state: no stress in melt or crust.
  for (const T of [1400, 1200]) assert.ok(cpu.stress(ctx(identity3(), T)).every((v) => Math.abs(v) < 1e-9))
  // Viscous stress η(T)·J·(C + Cᵀ), stiffer when cooler.
  const C = [0, 0, 0, 1, 0, 0, 0, 0, 0]
  assert.ok(Math.abs(cpu.stress(ctx(identity3(), 1400, P, C))[3] - lavaViscosity(1400, P)) < 1e-6)
  assert.ok(cpu.stress(ctx(identity3(), 1300, P, C))[3] > cpu.stress(ctx(identity3(), 1400, P, C))[3])
})

test('plasticity: melt keeps at most its yield stress of shear (none: F = J^⅓·I) and tears past 20 % stretch; crust keeps small strains, yields, cracks past its strain', () => {
  const plastic = (F: number[], T: number, p: LavaParams = P) => cpu.plasticity!(ctx(F, T, p)).F!
  const close = (a: number[], b: number[], tol: number) => a.every((v, k) => Math.abs(v - b[k]) < tol)
  const mu = P.youngs / (2 * (1 + P.poisson))
  const shearStress = (F: number[]) => {
    const b = mul3(F, transpose3(F)), tr = (b[0] + b[4] + b[8]) / 3
    return mu * Math.sqrt(b.reduce((a, v, k) => a + (v - (k % 4 === 0 ? tr : 0)) ** 2, 0))
  }
  // Melt without yield strength, compressed and sheared: shear gone, volume kept.
  const F = [0.97, 0.01, 0, 0.05, 0.98, 0, 0, 0.02, 0.99]
  const Fm = plastic(F, 1400, { ...P, meltYield: 0 })
  const s = Math.cbrt(det3(F))
  assert.ok(close(Fm, [s, 0, 0, 0, s, 0, 0, 0, s], 1e-9))
  // Melt with a yield strength: projected to it.
  const Fb = plastic([1, 0, 0, 0.2, 1, 0, 0, 0, 1], 1400)
  assert.ok(Math.abs(shearStress(Fb) - P.meltYield) < P.meltYield * 0.03, `melt: ${shearStress(Fb)}`)
  // Melt is cohesive: a small stretch is kept (it pulls back), a large one tears at 20 %.
  assert.ok(Math.abs(det3(plastic([1.01, 0, 0, 0, 1.01, 0, 0, 0, 1.01], 1400)) - 1.01 ** 3) < 1e-9)
  assert.ok(Math.abs(det3(plastic([1.5, 0, 0, 0, 1, 0, 0, 0, 1], 1400)) - 1.2) < 1e-9)
  // Crust, a small rotation-free shear: b = F·Fᵀ unchanged (elastic).
  const small = [1, 0.001, 0, 0.001, 1, 0, 0, 0, 1]
  const Fc = plastic(small, 1100)
  assert.ok(close(mul3(Fc, transpose3(Fc)), mul3(small, transpose3(small)), 1e-9))
  // Crust, a large shear: projected back to its (higher) yield surface, volume kept.
  const Fy = plastic([1, 0, 0, 0.2, 1, 0, 0, 0, 1], 1100)
  assert.ok(Math.abs(shearStress(Fy) - P.yieldStress) < P.yieldStress * 0.03, `crust: ${shearStress(Fy)}`)
  assert.ok(Math.abs(det3(Fy) - 1) < 1e-9)
  // Crust stretched past its crack strain: capped at 1 + crackStrain (it opens instead of pulling back).
  assert.ok(Math.abs(det3(plastic([1.05, 0, 0, 0, 1, 0, 0, 0, 1], 1100)) - (1 + P.crackStrain)) < 1e-9)
})

test('cooling rate: radiation + convection to air, conduction to ground, over the thermal skin', () => {
  const T = 1400, Ta = P.airTemperature
  const air = P.emissivity * 5.670374e-8 * (T ** 4 - Ta ** 4) + P.convection * (T - Ta)
  const heat = P.density * P.heatCapacity * P.skin
  assert.ok(Math.abs(lavaCoolingRate(T, 1, 0, P) - air / heat) < 1e-9)
  assert.ok(Math.abs(lavaCoolingRate(T, 0, 1, P) - (P.groundConductance * (T - P.groundTemperature)) / heat) < 1e-9)
  assert.equal(lavaCoolingRate(T, 0, 0, P), 0)
  // Tens of K/s at eruption temperatures with the default 4 mm skin (crust within seconds), slower as it cools (T⁴).
  assert.ok(lavaCoolingRate(1420, 1, 0, P) > 10 && lavaCoolingRate(1420, 1, 0, P) < 50)
  assert.ok(lavaCoolingRate(1000, 1, 0, P) < lavaCoolingRate(1400, 1, 0, P) / 2)
  // Visible glow (Wien): 1 at 1400 K, ~1 % at 1100 K.
  assert.equal(lavaGlow(1400), 1)
  assert.ok(lavaGlow(1100) < 0.02 && lavaGlow(1100) > 0.005)
})

test('thermal step on a resting slab: the top layer cools at the surface rate, the interior keeps its heat, the base loses to the ground', () => {
  const p = { ...P, diffusivity: 0 }
  const r = new MPMReference({ capacity: 4096, resolution: [16, 12, 16], cellSize: 0.125, origin: [0, 0, 0], materials: { lava: p } }, () => 0.25)
  r.emit({ center: [1, 0.25 + 0.25, 1], size: [0.375, 0.25, 0.375], temperature: 1400, jitter: 0 })
  const dt = 0.1
  const s = lavaThermalStep(r, dt)
  const d = r.data
  let top = 0, tn = 0, mid = 0, mn = 0, base = 0, bn = 0
  for (let q = 0; q < d.count; q++) {
    const x = d.position[q * 3], y = d.position[q * 3 + 1], z = d.position[q * 3 + 2]
    if (Math.abs(x - 1) > 0.2 || Math.abs(z - 1) > 0.2) continue // away from the sides
    const drop = 1400 - d.temperature[q]
    if (y > 0.7) { top += drop; tn++ }
    else if (y > 0.35 && y < 0.65) { mid += drop; mn++; assert.ok(s.fill[q] > 0.9) }
    else if (y < 0.3) { base += drop; bn++ }
  }
  assert.ok(tn && mn && bn)
  assert.ok(Math.abs(top / tn - dt * lavaCoolingRate(1400, 1, 0, p)) < 1e-6, `top: ${top / tn}`)
  assert.equal(mid / mn, 0)
  assert.ok(Math.abs(base / bn - dt * lavaCoolingRate(1400, 0, 1, p)) < 1e-6, `base: ${base / bn}`)
  // Conduction: a cold particle in hot surroundings warms towards them at rate 4κ/Δx² (exact exponential).
  const q0 = d.count >> 1
  const r2 = new MPMReference(r.options, () => 0.25)
  r2.emit({ center: [1, 0.25 + 0.25, 1], size: [0.375, 0.25, 0.375], temperature: 1400, jitter: 0 })
  r2.options.materials.lava.diffusivity = 1e-3
  r2.data.temperature[q0] = 1000
  lavaThermalStep(r2, 1)
  const relax = 1 - Math.exp((-4 * 1e-3 * 1) / 0.125 ** 2) // 0.23: 1000 K → ~1085 K amid 1400 K
  assert.ok(r2.data.temperature[q0] > 1000 + 300 * relax && r2.data.temperature[q0] < 1000 + 400 * relax, `${r2.data.temperature[q0]}`)
})

// A lobe of lava on a 14° slope, just above the crust band, cooling fast (a 0.5 mm skin crusts it within ~0.5 s), against
// the same lobe held hot.
const lobe = (cool: boolean) => {
  const h = (x: number) => 1 - 0.25 * x
  // No melt yield (it would hold the small lobe still): the crust alone has to stop the front.
  const mat = { ...P, viscosity: 300, viscosityMax: 2000, eruption: 1340, skin: 0.0005, meltYield: 0, yieldStress: 4000 }
  const r = new MPMReference({ capacity: 2048, resolution: [32, 18, 14], cellSize: 0.125, origin: [0, 0, 0], friction: 0.5, maxSpeed: 5, materials: { lava: mat } }, h)
  const spec = { center: [0.8, h(0.8) + 0.33, 0.875] as [number, number, number], size: [0.4, 0.3125, 0.25] as [number, number, number], temperature: 1340 }
  r.emit(spec)
  const d = r.data, n = d.count
  const front = () => { let f = 0; for (let q = 0; q < n; q++) f = Math.max(f, d.position[q * 3]); return f }
  const fronts = [front()]
  let state = lavaThermalStep(r, 0)
  for (let f = 1; f <= 90; f++) {
    const t = r.time
    r.step(1 / 60)
    if (cool) state = lavaThermalStep(r, r.time - t)
    if (f % 30 === 0) fronts.push(front())
  }
  return { r, mat, fronts, state }
}

test('a cooling lobe: the surface crusts, the front slows against a hot control, the molten interior keeps flowing and carries the crust', () => {
  const hot = lobe(false), cool = lobe(true)
  const { r, mat, fronts, state } = cool
  const d = r.data, n = d.count
  let crust = 0, crustFill = 0, melt = 0, meltFill = 0, meltSpeed = 0
  for (let q = 0; q < n; q++) {
    const s = lavaCrust(d.temperature[q], mat)
    if (s > 0.99) { crust++; crustFill += state.fill[q] }
    if (s < 0.01) { melt++; meltFill += state.fill[q]; meltSpeed += Math.hypot(d.velocity[q * 3], d.velocity[q * 3 + 1], d.velocity[q * 3 + 2]) }
  }
  assert.ok(crust > n * 0.2, `crust ${crust}/${n}`)
  assert.ok(melt > n * 0.2, `melt ${melt}/${n}`)
  assert.ok(crustFill / crust < meltFill / melt - 0.1, 'the crust is the outside, the melt the inside')
  // Front advance over the last second: slower than the hot control's.
  const adv = (f: number[]) => f[f.length - 1] - f[f.length - 3]
  assert.ok(adv(fronts) < 0.7 * adv(hot.fronts), `front ${adv(fronts)} vs hot ${adv(hot.fronts)}`)
  // The leading particles are crust.
  const order = Array.from({ length: n }, (_, q) => q).sort((a, b) => d.position[b * 3] - d.position[a * 3]).slice(0, Math.ceil(n * 0.05))
  const frontCrust = order.filter((q) => lavaCrust(d.temperature[q], mat) > 0.5).length / order.length
  assert.ok(frontCrust > 0.8, `front crust fraction ${frontCrust}`)
  // The molten interior keeps flowing (a good share of the hot control's speed), and carries the crust along with it.
  const speed = (data: typeof d, q: number) => Math.hypot(data.velocity[q * 3], data.velocity[q * 3 + 1], data.velocity[q * 3 + 2])
  let hotSpeed = 0, crustSpeed = 0
  for (let q = 0; q < n; q++) {
    hotSpeed += speed(hot.r.data, q) / n
    if (lavaCrust(d.temperature[q], mat) > 0.99) crustSpeed += speed(d, q) / crust
  }
  assert.ok(meltSpeed / melt > 0.25 * hotSpeed, `interior ${meltSpeed / melt} m/s vs hot control ${hotSpeed} m/s`)
  assert.ok(crustSpeed > 0.5 * (meltSpeed / melt), `crust ${crustSpeed} m/s rides on the melt (${meltSpeed / melt} m/s)`)
})

test('deterministic: a lava run (solver + thermal steps) repeats exactly, and particle order does not matter', () => {
  const run = (reverse: boolean) => {
    const h = (x: number) => 0.6 - 0.2 * x
    const r = new MPMReference({ capacity: 512, resolution: [16, 12, 12], cellSize: 0.125, origin: [0, 0, 0], friction: 0.5, maxSpeed: 5, materials: { lava: { ...P, skin: 0.002, viscosityMax: 2000 } } }, h)
    r.emit({ center: [0.75, h(0.75) + 0.25, 0.75], size: [0.25, 0.1875, 0.25], temperature: 1420 })
    if (reverse) {
      // Reverse the slots: same particles, opposite scatter order.
      const d = r.data, n = d.count
      for (const [arr, k] of [[d.position, 3], [d.velocity, 3], [d.affine, 9], [d.deformation, 9], [d.Jp, 1], [d.temperature, 1], [d.material, 1]] as const) {
        const copy = arr.slice()
        for (let q = 0; q < n; q++) for (let c = 0; c < k; c++) (arr as any)[q * k + c] = copy[(n - 1 - q) * k + c]
      }
    }
    for (let f = 0; f < 20; f++) { const t = r.time; r.step(1 / 60); lavaThermalStep(r, r.time - t) }
    return r.data
  }
  const a = run(false), b = run(false), c = run(true)
  assert.deepEqual(a.temperature, b.temperature)
  assert.deepEqual(a.position, b.position)
  const n = a.count
  for (let q = 0; q < n; q++) {
    assert.equal(a.temperature[q], c.temperature[n - 1 - q])
    for (let k = 0; k < 3; k++) assert.equal(a.position[q * 3 + k], c.position[(n - 1 - q) * 3 + k])
  }
})

test('heat sources for haze and sparks: the hot lava particles, glow-weighted, world positions', () => {
  const data = {
    count: 3, position: Float32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2]), velocity: new Float32Array(9), affine: new Float32Array(27), deformation: new Float32Array(27),
    Jp: new Float32Array(3), temperature: Float32Array.from([1400, 900, 1300]), material: Int32Array.from([0, 0, 1]),
  }
  const s = lavaHeatSources(data, [10, 20, 30], { minTemperature: 1000 })
  assert.equal(s.length, 8) // particle 1 is too cold, particle 2 is another material
  assert.deepEqual(Array.from(s.subarray(0, 4)), [10, 20, 30, 1])
  // With surface ages: only surface particles, at their skin temperature (a minute-old skin is far below 1400 K).
  assert.equal(lavaHeatSources(data, [0, 0, 0], { minTemperature: 1000, ages: [0, 5, 5] }).length, 0)
  const aged = lavaHeatSources(data, [0, 0, 0], { minTemperature: 500, ages: [60, 0, 0] })
  assert.equal(aged.length, 8)
  assert.ok(aged[3] < 0.05 && aged[7] < 0.8, `skin glow ${aged[3]}, T ${aged[7] * 1400}`)
  assert.ok(Math.abs(lavaSkin(10) - 0.77) < 0.02 && Math.abs(lavaSkin(60) - 0.64) < 0.02 && Math.abs(lavaSkin(300) - 0.5) < 0.02)
})

// GPU check: example/mpm-lava.html?check runs a tiny lava block (inside the crust band, cooling fast) on the GPU, 1 and 24
// frames of solver substeps plus the thermal step, and records the GPU state here (window.lavaCheck). The CPU reference
// must match within float32 tolerance.
const fixture = new URL('./fixtures/mpm-lava-gpu-step.json', import.meta.url)
test('CPU reference matches a recorded GPU lava run', { skip: !existsSync(fixture) && 'no GPU fixture recorded' }, () => {
  const f = JSON.parse(readFileSync(fixture, 'utf8'))
  for (const run of f.runs) {
    const r = new MPMReference(f.options, (x: number, z: number) => f.slope[0] + f.slope[1] * x + f.slope[2] * z)
    r.emit(f.emit)
    for (let s = 0; s < run.frames; s++) {
      for (let k = 0; k < f.substeps; k++) r.substep(f.dt)
      lavaThermalStep(r, f.dt * f.substeps)
    }
    assert.equal(run.count, r.data.count)
    const check = (name: string, cpuValues: ArrayLike<number>, gpu: number[], tol: number) => {
      let worst = 0
      for (let i = 0; i < gpu.length; i++) worst = Math.max(worst, Math.abs(cpuValues[i] - gpu[i]))
      assert.ok(worst <= tol, `${run.frames} frames, ${name}: max error ${worst} > ${tol}`)
    }
    const one = run.frames === 1
    // float32 GPU vs float64 CPU (measured: ~1e-7 m, ~2e-6 m/s, ~1e-4 K after one frame; ~1e-6 m, ~5e-6 m/s, ~6e-4 K after 24)
    check('position', r.data.position, run.position, one ? 1e-6 : 1e-5)
    check('velocity', r.data.velocity, run.velocity, one ? 2e-5 : 1e-4)
    check('deformation', r.data.deformation, run.deformation, one ? 2e-6 : 1e-5)
    check('temperature', r.data.temperature, run.temperature, one ? 2e-3 : 1e-2)
  }
})
