import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { DEFAULT_MPM, MPMReference, MPM_FIXED, bakeMPMHeights, mpmEmitPositions, mpmStableStep, mpmTimeStep, projectFriction, resolveMPMOptions, toFixed } from '../src/mpm-reference.ts'
import { JELLY, det3, identity3, lame, mpmMaterial, mul3, transpose3 } from '../src/mpm-materials.ts'

const small = { capacity: 4096, resolution: [24, 24, 24] as [number, number, number], cellSize: 0.25, origin: [0, 0, 0] as [number, number, number] }

test('options: defaults, sanitizing, and a materials input replaces the list', () => {
  const o = resolveMPMOptions({ resolution: [4, 1000, 33.4], cfl: 7, materials: { jelly: { youngs: 5000 }, nope: { x: 1 } } as any })
  assert.deepEqual(o.resolution, [8, 160, 33])
  assert.equal(o.cfl, 1)
  assert.deepEqual(Object.keys(o.materials), ['jelly'])
  assert.equal(o.materials.jelly.youngs, 5000)
  assert.equal(o.materials.jelly.density, JELLY.defaults.density)
  assert.deepEqual(resolveMPMOptions({}).materials, DEFAULT_MPM.materials)
  assert.ok(mpmMaterial('jelly'))
})

test('time step: dt ≤ cfl·Δx/(maxSpeed + c) and Δx²/(6ν), at least `substeps`, capped at `maxSubsteps`', () => {
  const o = resolveMPMOptions({})
  const c = JELLY.soundSpeed(o.materials.jelly as any), nu = JELLY.viscosity!(o.materials.jelly as any)
  assert.equal(mpmStableStep(o), Math.min((o.cfl * o.cellSize) / (o.maxSpeed + c), o.cellSize ** 2 / (6 * nu)))
  const a = mpmTimeStep(o, 1 / 60)
  assert.equal(a.substeps, 2) // the default jelly runs 2 substeps at 60 fps
  assert.ok(a.dt <= mpmStableStep(o) && Math.abs(a.dt * 2 - 1 / 60) < 1e-12)
  const stiff = resolveMPMOptions({ materials: { jelly: { youngs: 1e8 } } })
  const b = mpmTimeStep(stiff, 1 / 60)
  assert.equal(b.substeps, stiff.maxSubsteps) // capped: runs slow rather than unstable
  assert.equal(b.dt, mpmStableStep(stiff))
  assert.equal(mpmTimeStep(resolveMPMOptions({ materials: { jelly: { viscosity: 3000 } } }), 1 / 60).substeps, 5) // viscous: Δx²/(6ν) = 3.5 ms
})

test('fixed point: round half up, saturating', () => {
  assert.equal(toFixed(1), MPM_FIXED)
  assert.equal(toFixed(-0.5 / MPM_FIXED), 0)
  assert.equal(toFixed(1e9), 2147483647)
  assert.equal(toFixed(-1e9), -2147483648)
})

test('jelly: zero stress at rest, CPU matrices agree with the formulas', () => {
  const p = { ...JELLY.defaults }
  const zero = JELLY.cpu.stress({ F: identity3(), J: 1, Jp: 1, C: new Array(9).fill(0), temperature: 293, dt: 0.01, params: p })
  assert.ok(zero.every((v) => Math.abs(v) < 1e-9))
  // Uniform stretch s: τ = μ(s² − 1)I + λ ln(s³) I
  const s = 1.1, F = [s, 0, 0, 0, s, 0, 0, 0, s]
  const { mu, lambda } = lame(p.youngs, p.poisson)
  const tau = JELLY.cpu.stress({ F, J: det3(F), Jp: 1, C: new Array(9).fill(0), temperature: 293, dt: 0.01, params: p })
  assert.ok(Math.abs(tau[0] - (mu * (s * s - 1) + lambda * Math.log(s ** 3))) < 1e-6)
  assert.equal(tau[1], 0)
  const A = [1, 2, 3, 4, 5, 6, 7, 8, 10]
  assert.deepEqual(transpose3(transpose3(A)), A)
  assert.equal(det3(mul3(A, A)), det3(A) ** 2)
})

test('emission: a seeded lattice of Δx/2 spacing (8 per cell), deterministic', () => {
  const a = mpmEmitPositions({ center: [1, 2, 3], size: [0.5, 0.5, 0.5] }, 0.25, 7)
  assert.equal(a.length / 3, 512) // 1 m box, 0.125 m spacing: 8³
  assert.deepEqual(a, mpmEmitPositions({ center: [1, 2, 3], size: [0.5, 0.5, 0.5] }, 0.25, 7))
  assert.notDeepEqual(a, mpmEmitPositions({ center: [1, 2, 3], size: [0.5, 0.5, 0.5] }, 0.25, 8))
  const ball = mpmEmitPositions({ shape: 'sphere', center: [0, 0, 0], size: [0.5, 0, 0], jitter: 0 }, 0.25, 1)
  assert.ok(ball.length / 3 > 200 && ball.length / 3 < 300) // ≈ π/6 of 512
})

test('one substep of a lone particle: v += g·dt, C stays 0, x += dt·v (APIC reproduces translation)', () => {
  const r = new MPMReference(small)
  r.emit({ positions: [3.03, 3.11, 2.97], velocity: [1, -2, 0.5] })
  const dt = 1 / 120
  r.substep(dt)
  const v = r.data.velocity, x = r.data.position
  const expect = [1, -2 - 9.81 * dt, 0.5]
  for (let a = 0; a < 3; a++) assert.ok(Math.abs(v[a] - expect[a]) < 1e-4, `v${a} ${v[a]}`) // fixed-point bound
  for (let a = 0; a < 3; a++) assert.ok(Math.abs(x[a] - ([3.03, 3.11, 2.97][a] + dt * expect[a])) < 1e-6)
  for (let k = 0; k < 9; k++) assert.ok(Math.abs(r.data.affine[k]) < 1e-3, `C${k} ${r.data.affine[k]}`)
})

test('free fall with no boundaries: Δ momentum = M·g·t', () => {
  const r = new MPMReference({ ...small, walls: false })
  r.emit({ center: [3, 4, 3], size: [0.5, 0.375, 0.5], velocity: [0.5, 0, -0.25] })
  const p0 = r.momentum(), M = r.mass()
  for (let f = 0; f < 30; f++) r.step(1 / 60)
  const p1 = r.momentum()
  const t = r.time
  for (let a = 0; a < 3; a++) {
    const expected = M * r.options.gravity[a] * t
    assert.ok(Math.abs(p1[a] - p0[a] - expected) < 1e-4 * M * 9.81 * t + 1e-9, `axis ${a}: ${p1[a] - p0[a]} vs ${expected}`)
  }
})

test('deterministic: particle order does not change the result (fixed-point P2G is order-independent)', () => {
  const run = (reverse: boolean) => {
    const r = new MPMReference({ ...small, capacity: 512 })
    const pos = mpmEmitPositions({ center: [3, 3, 3], size: [0.5, 0.5, 0.5] }, 0.25, 3)
    const order = Array.from({ length: pos.length / 3 }, (_, i) => (reverse ? pos.length / 3 - 1 - i : i))
    r.emit({ positions: order.flatMap((i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]), velocity: [0, -3, 1] })
    for (let s = 0; s < 10; s++) r.substep(1 / 120)
    return { r, order }
  }
  const a = run(false), b = run(true)
  assert.deepEqual(a.r.grid, b.r.grid)
  for (let i = 0; i < a.order.length; i++) {
    const j = b.order.indexOf(i)
    for (let k = 0; k < 3; k++) assert.equal(a.r.data.position[i * 3 + k], b.r.data.position[j * 3 + k])
  }
})

test('terrain: Coulomb projection removes the inward part, sticks under the friction cone', () => {
  assert.deepEqual(projectFriction([1, 2, 0], [0, 1, 0], 0.5), [1, 2, 0]) // separating: free
  assert.deepEqual(projectFriction([0.1, -1, 0], [0, 1, 0], 0.5), [0, 0, 0]) // inside the cone: stick
  const v = projectFriction([2, -1, 0], [0, 1, 0], 0.5)
  assert.ok(Math.abs(v[0] - 1.5) < 1e-12 && v[1] === 0)
  const slip = projectFriction([2, -1, 0], [0, 1, 0], 0)
  assert.deepEqual(slip, [2, 0, 0])
})

test('a jelly block dropped on sloped terrain comes to rest, never below the ground', () => {
  const slope = (x: number, z: number) => 0.6 + 0.25 * x + 0.1 * z // 15° in x
  const r = new MPMReference({ ...small, resolution: [24, 20, 24], friction: 0.8 }, slope)
  r.emit({ center: [3.5, slope(3.875, 2) + 0.375 + 0.15, 2], size: [0.375, 0.375, 0.375] }) // 15 cm above the uphill edge
  const n = r.data.count, d = r.data
  let lowest = Infinity, maxSpeed = 0
  for (let f = 0; f < 210; f++) {
    r.step(1 / 60)
    maxSpeed = 0
    for (let p = 0; p < n; p++) {
      lowest = Math.min(lowest, d.position[p * 3 + 1] - slope(d.position[p * 3], d.position[p * 3 + 2]))
      maxSpeed = Math.max(maxSpeed, Math.hypot(d.velocity[p * 3], d.velocity[p * 3 + 1], d.velocity[p * 3 + 2]))
    }
  }
  assert.ok(lowest >= -1e-5, `a particle went ${-lowest} m below the ground`)
  assert.ok(maxSpeed < 0.05, `still moving at ${maxSpeed} m/s after 3.5 s`)
  let gap = Infinity, cx = 0
  for (let p = 0; p < n; p++) {
    gap = Math.min(gap, d.position[p * 3 + 1] - slope(d.position[p * 3], d.position[p * 3 + 2]))
    cx += d.position[p * 3] / n
  }
  assert.ok(gap < 0.05, `resting ${gap} m above the ground`)
  assert.ok(Math.abs(cx - 3.5) < 0.5, `slid to x = ${cx}`)
})

test('height bake: node columns relative to origin, no ground without a function', () => {
  const o = { resolution: [8, 8, 8] as [number, number, number], cellSize: 0.5, origin: [10, 2, -4] as [number, number, number] }
  const h = bakeMPMHeights((x, z) => x + z, o)
  assert.equal(h[0], 10 - 4 - 2)
  assert.equal(h[8 * 1 + 3], 10 + 1.5 - 4 + 0.5 - 2)
  assert.equal(bakeMPMHeights(null, o)[5], Math.fround(-1e30))
})

// The GPU check: example/mpm.html?check runs the same tiny scene on the GPU and records its state here
// (one substep and 24 substeps, a 0.75 m block thrown onto a slope), and the reference must match within
// float32 tolerance. Re-record by running the check page and saving `window.mpmCheck` here.
const fixture = new URL('./fixtures/mpm-gpu-step.json', import.meta.url)
test('CPU reference matches a recorded GPU step', { skip: !existsSync(fixture) && 'no GPU fixture recorded' }, () => {
  const f = JSON.parse(readFileSync(fixture, 'utf8'))
  for (const run of f.runs) {
    const r = new MPMReference(f.options, (x: number, z: number) => f.slope[0] + f.slope[1] * x + f.slope[2] * z)
    r.emit(f.emit)
    for (let s = 0; s < run.substeps; s++) r.substep(f.dt)
    const check = (name: string, cpu: ArrayLike<number>, gpu: number[], tol: number) => {
      let worst = 0
      for (let i = 0; i < gpu.length; i++) worst = Math.max(worst, Math.abs(cpu[i] - gpu[i]))
      assert.ok(worst <= tol, `${run.substeps} substeps, ${name}: max error ${worst} > ${tol}`)
    }
    assert.equal(run.count, r.data.count)
    // float32 GPU vs float64 CPU (measured: ~1e-7 m and ~1e-6 m/s after one substep, ~1e-6 m and ~1e-5 m/s after 24)
    const one = run.substeps === 1
    check('position', r.data.position, run.position, one ? 1e-6 : 2e-5)
    check('velocity', r.data.velocity, run.velocity, one ? 5e-5 : 2e-4)
    check('affine', r.data.affine, run.affine, one ? 5e-4 : 2e-3)
    check('deformation', r.data.deformation, run.deformation, one ? 1e-6 : 5e-5)
  }
})
