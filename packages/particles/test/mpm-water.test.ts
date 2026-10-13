import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { MPMReference, groundAt, mpmEmitPositions, mpmTimeStep, resolveMPMOptions, type MPMEmit } from '../src/mpm-reference.ts'
import { det3 } from '../src/mpm-materials.ts'
import { PuddleField, SplashEmitter, WATER, WATER_MIN_J, WATER_PRESETS, waterPressure } from '../src/mpm-water.ts'

const zero = new Array(9).fill(0)
const cpu = (J: number, C = zero, params = WATER.defaults) => {
  const s = Math.cbrt(J)
  return WATER.cpu.stress({ F: [s, 0, 0, 0, s, 0, 0, 0, s], J, Jp: 1, C, temperature: 293, dt: 1e-3, params })
}

test('equation of state: p = K(J^−γ − 1), zero at rest, pushes back under compression, no tension', () => {
  const p = WATER.defaults
  assert.equal(waterPressure(1, p), 0)
  assert.ok(Math.abs(waterPressure(0.95, p) - p.bulk * (0.95 ** -7 - 1)) < 1e-9)
  assert.ok(waterPressure(0.9, p) > waterPressure(0.95, p) && waterPressure(0.95, p) > 0) // stiffer the more it is squeezed
  assert.equal(waterPressure(1.3, p), 0) // expansion is free
  assert.equal(waterPressure(0.1, p), waterPressure(WATER_MIN_J, p)) // crushed: clamped, finite
  // Small compression: p ≈ K·γ·(1 − J), so the sound speed is √(Kγ/ρ).
  assert.ok(Math.abs(waterPressure(1 - 1e-6, p) / 1e-6 - p.bulk * p.gamma) / (p.bulk * p.gamma) < 1e-4)
  assert.equal(WATER.soundSpeed(p), Math.sqrt((p.bulk * p.gamma) / p.density))
})

test('stress: isotropic pressure −J·p·I, no shear stiffness, viscosity from C', () => {
  const tau = cpu(0.97)
  const iso = -0.97 * waterPressure(0.97, WATER.defaults)
  assert.ok(Math.abs(tau[0] - iso) < 1e-9 && tau[4] === tau[0] && tau[8] === tau[0])
  assert.ok([1, 2, 3, 5, 6, 7].every((k) => tau[k] === 0))
  // A sheared F at J = 1 carries no stress (a fluid has no shape to return to).
  const sheared = WATER.cpu.stress({ F: [1, 0, 0, 0.4, 1, 0, 0, 0, 1], J: 1, Jp: 1, C: zero, temperature: 293, dt: 1e-3, params: WATER.defaults })
  assert.ok(sheared.every((v) => v === 0))
  // Shear flow (C = ∇v with dvx/dy = 2): τxy = μ·J·2.
  const C = [0, 0, 0, 2, 0, 0, 0, 0, 0]
  const visc = cpu(1, C)
  assert.ok(Math.abs(visc[3] - WATER.defaults.viscosity * 2) < 1e-12 && visc[1] === visc[3])
})

test('plasticity: F reset to J^(1/3)·I with J clamped to [min, 1]', () => {
  const run = (F: number[]) => WATER.cpu.plasticity!({ F, J: det3(F), Jp: 1, C: zero, temperature: 293, dt: 1e-3, params: WATER.defaults }).F!
  const squeezed = run([0.9, 0.1, 0, 0, 1, 0, 0, 0.2, 0.95])
  assert.ok(Math.abs(det3(squeezed) - 0.9 * 0.95) < 1e-9)
  assert.equal(squeezed[1], 0)
  assert.equal(squeezed[0], squeezed[4])
  assert.ok(Math.abs(det3(run([1.3, 0, 0, 0, 1, 0, 0, 0, 1])) - 1) < 1e-12) // no stored expansion
  assert.ok(Math.abs(det3(run([0.2, 0, 0, 0, 1, 0, 0, 0, 1])) - WATER_MIN_J) < 1e-12)
})

test('presets: clear and muddy are valid water parameters; muddy is heavier, more viscous and turbid', () => {
  for (const preset of Object.values(WATER_PRESETS)) {
    const o = resolveMPMOptions({ materials: { water: preset.material } })
    assert.deepEqual(o.materials.water, preset.material)
  }
  const { clear, muddy } = WATER_PRESETS
  assert.ok(muddy.material.density > clear.material.density && muddy.material.viscosity > clear.material.viscosity)
  assert.ok((muddy.surface.turbidity ?? 0) > 10 * (clear.surface.turbidity ?? 0))
  // Time step at a splash-scale grid: Δx = 5 cm stays within 8 substeps at 60 fps.
  const step = mpmTimeStep(resolveMPMOptions({ cellSize: 0.05, maxSpeed: 6, materials: { water: clear.material } }), 1 / 60)
  assert.ok(step.substeps <= 8 && step.dt * step.substeps > 1 / 60 - 1e-9, `${step.substeps} substeps`)
})

// Volume measured on the grid: Σ min(m_node / m_rest, 1)·Δx³ equals mass/density unless water is squeezed above rest
// density somewhere, so it drops exactly by the compacted share. Also Σ J·V0 over the particles.
function volumes(r: MPMReference) {
  const dx = r.options.cellSize, rest = r.options.materials.water.density / 1000
  let grid = 0
  for (let i = 3; i < r.grid.length; i += 4) grid += Math.min(1, r.grid[i] / rest)
  let J = 0
  for (let p = 0; p < r.data.count; p++) J += det3(Array.from(r.data.deformation.subarray(p * 9, p * 9 + 9)))
  const V0 = r.data.count * (dx / 2) ** 3
  return { grid: (grid * dx ** 3) / V0, J: (J * (dx / 2) ** 3) / V0 }
}

const bumpy = (x: number, z: number) => 0.25 + 0.04 * Math.sin(x * 2.1) * Math.cos(z * 1.7) + 0.03 * x

test('dam break onto terrain: the column collapses and runs out, conserving volume within 3 %', () => {
  const r = new MPMReference({ capacity: 2048, resolution: [22, 12, 8], cellSize: 0.1, origin: [0, 0, 0], maxSpeed: 6, friction: 0.05, materials: { water: {} } }, bumpy)
  r.emit({ center: [0.45, 0.55, 0.4], size: [0.2, 0.2, 0.2] })
  const d = r.data, n = d.count
  let worst = 1, worstJ = 0, lowest = Infinity
  for (let f = 1; f <= 90; f++) {
    r.step(1 / 60)
    const v = volumes(r)
    worst = Math.min(worst, v.grid)
    worstJ = Math.max(worstJ, Math.abs(v.J - 1))
    // Never below the collider surface (bilinear between the node columns' heights).
    for (let p = 0; p < n; p++) lowest = Math.min(lowest, d.position[p * 3 + 1] - groundAt(r.heights, 22, 8, 0.1, d.position[p * 3], d.position[p * 3 + 2])[0])
  }
  let front = 0
  for (let p = 0; p < n; p++) front = Math.max(front, d.position[p * 3])
  assert.ok(front > 1.5, `the front only reached x = ${front}`)
  assert.ok(worst > 0.97, `grid volume fell to ${worst} of the column's`)
  assert.ok(worstJ < 0.03, `Σ J·V0 off by ${worstJ}`)
  assert.ok(lowest > -1e-6, `a particle went ${-lowest} m below the ground`)
})

test('hydrostatic rest: a still pool in a bowl stays still and level', () => {
  const c = 0.6, bowl = (x: number, z: number) => 0.25 + 1.5 * ((x - c) ** 2 + (z - c) ** 2)
  const r = new MPMReference({ capacity: 2048, resolution: [12, 12, 12], cellSize: 0.1, origin: [0, 0, 0], maxSpeed: 6, friction: 0.5, materials: { water: {} } }, bowl)
  const lattice = mpmEmitPositions({ center: [c, 0.35, c], size: [0.45, 0.2, 0.45], jitter: 0 }, 0.1, 1)
  const pos: number[] = []
  for (let i = 0; i < lattice.length; i += 3) if (lattice[i + 1] > bowl(lattice[i], lattice[i + 2]) && lattice[i + 1] < 0.45) pos.push(lattice[i], lattice[i + 1], lattice[i + 2])
  r.emit({ positions: pos })
  const d = r.data, n = d.count
  const surface = () => {
    const tops = new Map<number, number>()
    for (let p = 0; p < n; p++) {
      const key = Math.floor(d.position[p * 3] / 0.1) * 100 + Math.floor(d.position[p * 3 + 2] / 0.1)
      tops.set(key, Math.max(tops.get(key) ?? -Infinity, d.position[p * 3 + 1]))
    }
    const t = [...tops.values()], mean = t.reduce((a, b) => a + b, 0) / t.length
    return { mean, spread: Math.sqrt(t.reduce((a, b) => a + (b - mean) ** 2, 0) / t.length) }
  }
  for (let f = 0; f < 60; f++) r.step(1 / 60) // settle the start (it begins unloaded and compresses ~1 % under its own weight)
  const before = surface()
  for (let f = 0; f < 120; f++) r.step(1 / 60)
  const after = surface()
  let speed = 0
  for (let p = 0; p < n; p++) speed = Math.max(speed, Math.hypot(d.velocity[p * 3], d.velocity[p * 3 + 1], d.velocity[p * 3 + 2]))
  assert.ok(speed < 0.02, `still moving at ${speed} m/s`)
  assert.ok(Math.abs(after.mean - before.mean) < 0.005, `level moved ${after.mean - before.mean} m`)
  assert.ok(after.spread < 0.015, `surface not level: ±${after.spread} m`)
})

test('deterministic: the same water scene twice gives identical state; splashes too', () => {
  const run = () => {
    const r = new MPMReference({ capacity: 2048, resolution: [16, 12, 12], cellSize: 0.1, origin: [0, 0, 0], maxSpeed: 6, friction: 0.1, materials: { water: {} } }, bumpy)
    r.emit({ center: [0.5, 0.6, 0.6], size: [0.15, 0.15, 0.15], velocity: [1, 0, 0] })
    const puddles = new PuddleField({ resolution: [16, 12], cellSize: 0.1, origin: [0, 0] }, bumpy)
    const rain = new SplashEmitter(r, { rain: 30, splashes: 4, radius: 0.4, center: [0.8, 0.6] }, { height: bumpy, puddles })
    for (let f = 0; f < 20; f++) { rain.update(1 / 60); r.step(1 / 60) }
    return { r, puddles }
  }
  const a = run(), b = run()
  assert.ok(a.r.data.count > 216, 'splashes were emitted')
  assert.deepEqual(a.r.data.position, b.r.data.position)
  assert.deepEqual(a.r.data.velocity, b.r.data.velocity)
  assert.deepEqual(a.puddles.depth, b.puddles.depth)
})

test('splashes: seeded impacts independent of the frame split, crowns on puddles, low scatter on dry ground', () => {
  const sink = () => {
    const emits: MPMEmit[] = []
    return { emits, options: { cellSize: 0.05, seed: 1 }, emit: (s: MPMEmit) => (emits.push(s), s.positions!.length / 3) }
  }
  const a = sink(), b = sink()
  const ea = new SplashEmitter(a, { rain: 10, splashes: 3, radius: 1 }), eb = new SplashEmitter(b, { rain: 10, splashes: 3, radius: 1 })
  for (let i = 0; i < 6; i++) ea.update(0.1)
  for (let i = 0; i < 36; i++) eb.update(1 / 60)
  assert.ok(Math.abs(ea.spawned - 10 * 3 * Math.PI * 0.6) < 1, `${ea.spawned} splashes`) // rain × splashes × area × time
  const flat = (e: { emits: MPMEmit[] }) => e.emits.flatMap((s) => Array.from(s.positions!))
  const n = Math.min(ea.spawned, eb.spawned)
  assert.ok(Math.abs(ea.spawned - eb.spawned) <= 1 && n > 50)
  // Same impacts in the same order, whatever the frame split (each splash is the same 3 dry particles here).
  assert.deepEqual(flat(a).slice(0, n * 9), flat(b).slice(0, n * 9))
  for (const s of a.emits) {
    assert.equal(s.tag, 1)
    for (let p = 0; p < s.positions!.length / 3; p++) {
      const vx = s.velocities![p * 3], vy = s.velocities![p * 3 + 1], vz = s.velocities![p * 3 + 2]
      assert.ok(vy > 0 && Math.hypot(vx, vz) > vy * 0.8, 'dry ground: low, wide droplets')
    }
  }
  // On a puddle: a crown plus a central jet.
  const wet = sink()
  const puddles = new PuddleField({ resolution: [8, 8], cellSize: 0.5, origin: [-2, -2] })
  puddles.depth.fill(0.01)
  const ew = new SplashEmitter(wet, { rain: 10, splashes: 3, radius: 1, particles: [3, 6] }, { puddles })
  ew.update(0.2)
  const s = wet.emits[0]
  assert.equal(s.positions!.length / 3, 6 * ew.spawned)
  assert.ok(ew.impacts.every((i) => i.wet && Math.abs(i.y - 0.01) < 1e-9))
  assert.ok(s.velocities![5 * 3 + 1] > s.velocities![1] && s.velocities![5 * 3] === 0, 'the jet goes straight up, above the crown')
})

test('puddles: rain gathers in low spots, conserves water, and drains and dries when it stops', () => {
  // A bowl in a field whose edges are all higher: nothing leaves, so the water is exactly the rain.
  const bowl = (x: number, z: number) => 0.3 * ((x - 1) ** 2 + (z - 1) ** 2)
  const f = new PuddleField({ resolution: [20, 20], cellSize: 0.1, origin: [0, 0], flowSpeed: 0.2, infiltration: 0, evaporation: 0, wetTime: 5, dryTime: 20 }, bowl)
  const rain = 360 // mm/h = 0.1 mm/s
  f.update(30, rain)
  const fallen = (rain / 3.6e6) * f.time * 4 // m³ over the 2 × 2 m field
  assert.ok(Math.abs(f.volume() - fallen) / fallen < 1e-4, `volume ${f.volume()} vs rain ${fallen}`)
  const centre = f.sample(1, 1).depth, rim = f.sample(0.15, 1).depth
  assert.ok(centre > 0.01 && centre > 5 * rim, `centre ${centre} m, rim ${rim} m`)
  assert.equal(f.sample(1, 1).wetness, 1)
  const deep = f.depth.reduce((a, b) => Math.max(a, b), 0)
  assert.ok(deep === f.depth[10 * 20 + 9] || deep === f.depth[9 * 20 + 10] || deep === f.depth[10 * 20 + 10] || deep === f.depth[9 * 20 + 9], 'deepest at the bottom')
  // Rain off, soaking in: the puddle shrinks to nothing, then the surface dries.
  f.set({ infiltration: 1000 })
  const v0 = f.volume()
  f.update(10)
  assert.ok(f.volume() < v0)
  for (let i = 0; i < 40; i++) f.update(10)
  assert.equal(f.volume(), 0)
  const w = f.sample(1, 1).wetness
  f.update(60)
  assert.ok(f.sample(1, 1).wetness < w * 0.1)
  // Runoff: on a slope falling out of the field the water leaves at the low edge.
  const slope = new PuddleField({ resolution: [16, 4], cellSize: 0.1, origin: [0, 0], infiltration: 0, evaporation: 0 }, (x) => -0.2 * x)
  slope.update(20, rain)
  assert.ok(slope.volume() < (rain / 3.6e6) * slope.time * 1.6 * 0.4 * 0.5)
})

// The GPU check: example/mpm-water.html?check runs the same tiny water scene on the GPU and on the CPU reference and
// records the GPU state here (one substep and 24 substeps of a 0.75 m block of water thrown onto a slope, with
// per-particle velocities), and the reference must match within float32 tolerance.
const fixture = new URL('./fixtures/mpm-water-gpu-step.json', import.meta.url)
test('CPU reference matches a recorded GPU water step', { skip: !existsSync(fixture) && 'no GPU fixture recorded' }, () => {
  const f = JSON.parse(readFileSync(fixture, 'utf8'))
  for (const run of f.runs) {
    const r = new MPMReference(f.options, (x: number, z: number) => f.slope[0] + f.slope[1] * x + f.slope[2] * z)
    r.emit(f.emit)
    for (let s = 0; s < run.substeps; s++) r.substep(f.dt)
    const check = (name: string, cpuValues: ArrayLike<number>, gpu: number[], tol: number) => {
      let worst = 0
      for (let i = 0; i < gpu.length; i++) worst = Math.max(worst, Math.abs(cpuValues[i] - gpu[i]))
      assert.ok(worst <= tol, `${run.substeps} substeps, ${name}: max error ${worst} > ${tol}`)
    }
    assert.equal(run.count, r.data.count)
    const one = run.substeps === 1
    check('position', r.data.position, run.position, one ? 1e-6 : 5e-5)
    check('velocity', r.data.velocity, run.velocity, one ? 1e-4 : 1e-3)
    check('affine', r.data.affine, run.affine, one ? 1e-3 : 1e-2)
    check('deformation', r.data.deformation, run.deformation, one ? 1e-6 : 1e-4)
  }
})
