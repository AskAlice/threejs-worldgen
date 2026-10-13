import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { det3, identity3, mul3, transpose3, type Mat3 } from '../src/mpm-materials.ts'
import { MPMReference, mpmEmitPositions, mpmStableStep, resolveMPMOptions, type MPMCollider } from '../src/mpm-reference.ts'
import { svd3 } from '../src/mpm-svd.ts'
import { ICE_DENSITY, SNOW, SNOW_JP_RANGE, SNOW_PRESETS, snowLame, type SnowParams } from '../src/mpm-snow.ts'

// Seeded uniform numbers in [-1, 1).
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1
  }
}
const diag = (a: number, b: number, c: number): Mat3 => [a, 0, 0, 0, b, 0, 0, 0, c]
const rotation = (axis: number[], angle: number): Mat3 => {
  const l = Math.hypot(axis[0], axis[1], axis[2]), [x, y, z] = axis.map((v) => v / l), c = Math.cos(angle), s = Math.sin(angle), k = 1 - c
  return [c + x * x * k, y * x * k + z * s, z * x * k - y * s, x * y * k - z * s, c + y * y * k, z * y * k + x * s, x * z * k + y * s, y * z * k - x * s, c + z * z * k]
}
const maxAbs = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])))
const norm = (a: number[]) => Math.sqrt(a.reduce((s, v) => s + v * v, 0))

function checkSvd(A: Mat3, label: string, tol = 1e-12) {
  const { U, S, V } = svd3(A)
  const R = mul3(mul3(U, diag(S[0], S[1], S[2])), transpose3(V))
  const scale = Math.max(norm(A), 1e-300)
  assert.ok(maxAbs(R, A) <= tol * scale + 1e-300, `${label}: reconstruction error ${maxAbs(R, A)}`)
  assert.ok(maxAbs(mul3(transpose3(U), U), identity3()) < 1e-12, `${label}: U not orthonormal`)
  assert.ok(maxAbs(mul3(transpose3(V), V), identity3()) < 1e-12, `${label}: V not orthonormal`)
  assert.ok(Math.abs(det3(U) - 1) < 1e-12 && Math.abs(det3(V) - 1) < 1e-12, `${label}: U, V must be rotations`)
  assert.ok(S[0] >= S[1] - 1e-12 * scale && S[1] >= Math.abs(S[2]) - 1e-12 * scale, `${label}: unsorted ${S}`)
  assert.ok(S[0] >= 0 && S[1] >= 0, `${label}: negative ${S}`)
  if (det3(A) < -1e-12 * scale ** 3) assert.ok(S[2] < 0, `${label}: det < 0 must give S[2] < 0`)
  return { U, S, V }
}

test('SVD: random matrices reconstruct to float64 precision, U and V rotations, S sorted', () => {
  const r = rng(72)
  for (let i = 0; i < 2000; i++) {
    const scale = 10 ** (r() * 4)
    checkSvd(Array.from({ length: 9 }, () => r() * scale), `random #${i}`, 1e-12)
  }
  // Near the identity (what snow plasticity sees): singular values within 1e-13 of the exact ones.
  for (let i = 0; i < 500; i++) {
    const s = [1 + 0.03 * r(), 1 + 0.03 * r(), 1 + 0.03 * r()]
    const A = mul3(mul3(rotation([r(), r(), r() + 1e-3], 3 * r()), diag(s[0], s[1], s[2])), transpose3(rotation([r() + 1e-3, r(), r()], 3 * r())))
    const { S } = checkSvd(A, `near identity #${i}`)
    assert.ok(maxAbs(S, [...s].sort((a, b) => b - a)) < 1e-13, `near identity #${i}: ${S} vs ${s}`)
  }
})

test('SVD: degenerate and special matrices', () => {
  const Q = rotation([1, 2, 3], 0.7), P = rotation([-2, 1, 0.5], 2.1)
  const cases: [string, Mat3][] = [
    ['zero', new Array(9).fill(0)],
    ['identity', identity3()],
    ['diagonal unsorted', diag(0.5, 3, 2)],
    ['diagonal with negatives', diag(-2, 1, -3)],
    ['reflection', diag(1, 1, -1)],
    ['rotated reflection', mul3(mul3(Q, diag(2, 1, -0.5)), transpose3(P))],
    ['repeated singular values', mul3(mul3(Q, diag(2, 2, 1)), transpose3(P))],
    ['all equal (scaled rotation)', mul3(Q, diag(3, 3, 3))],
    ['rank 2', mul3(mul3(Q, diag(3, 1, 0)), transpose3(P))],
    ['rank 1', [1, 2, 3, 2, 4, 6, -1, -2, -3]],
    ['nearly singular', mul3(mul3(Q, diag(1, 1e-3, 1e-9)), transpose3(P))],
    ['tiny scale', mul3(mul3(Q, diag(3e-9, 2e-9, 1e-9)), transpose3(P))],
    ['huge scale', mul3(mul3(Q, diag(3e15, 2e15, 1e15)), transpose3(P))],
    ['shear', [1, 0, 0, 5, 1, 0, 0, 0, 1]],
  ]
  for (const [label, A] of cases) {
    const { U, S, V } = checkSvd(A, label, 1e-11)
    assert.ok([...U, ...S, ...V].every(Number.isFinite), `${label}: non-finite`)
  }
  const z = svd3(new Array(9).fill(0))
  assert.deepEqual(z.U, identity3())
  assert.deepEqual(z.V, identity3())
  assert.deepEqual(z.S.map(Math.abs), [0, 0, 0])
  const rk2 = svd3(mul3(mul3(Q, diag(3, 1, 0)), transpose3(P)))
  assert.ok(maxAbs(rk2.S, [3, 1, 0]) < 1e-12, `rank 2 singular values ${rk2.S}`)
})

const ctx = (F: Mat3, Jp: number, params: SnowParams) => ({ F, J: det3(F), Jp, C: new Array(9).fill(0), temperature: 268, dt: 1e-3, params })

test('plasticity: singular values clamp to [1 − θc, 1 + θs] and Jp takes the difference', () => {
  const p = SNOW_PRESETS.packed
  const Q = rotation([0.3, 1, -0.2], 0.9), P = rotation([1, -0.4, 0.8], -1.3)
  const s = [1.1, 0.9, 1.002] // stretched past θs, compressed past θc, elastic
  const F = mul3(mul3(Q, diag(s[0], s[1], s[2])), transpose3(P))
  const r = SNOW.cpu.plasticity!(ctx(F, 0.8, p))
  const clamped = [1 + p.stretch, 1 - p.compression, 1.002]
  const expected = mul3(mul3(Q, diag(clamped[0], clamped[1], clamped[2])), transpose3(P))
  assert.ok(maxAbs(r.F!, expected) < 1e-12, `clamped F off by ${maxAbs(r.F!, expected)}`)
  assert.ok(Math.abs(r.Jp! - (0.8 * (s[0] * s[1] * s[2])) / (clamped[0] * clamped[1] * clamped[2])) < 1e-12)
  // Inside the elastic range nothing changes.
  const Fe = mul3(mul3(Q, diag(1.005, 0.98, 1)), transpose3(P))
  const e = SNOW.cpu.plasticity!(ctx(Fe, 0.9, p))
  assert.ok(maxAbs(e.F!, Fe) < 1e-12)
  assert.ok(Math.abs(e.Jp! - 0.9) < 1e-12)
  // Crushing compacts (Jp < 1), stretching loosens (Jp > 1), both bounded.
  assert.ok(SNOW.cpu.plasticity!(ctx(diag(0.7, 0.7, 0.7), 1, p)).Jp! < 1)
  assert.ok(SNOW.cpu.plasticity!(ctx(diag(1.3, 1, 1), 1, p)).Jp! > 1)
  assert.equal(SNOW.cpu.plasticity!(ctx(diag(100, 100, 100), 5, p)).Jp, SNOW_JP_RANGE[1])
  // The return mapping moves volume between F and Jp but keeps the total det F · Jp.
  const r2 = rng(5)
  for (let i = 0; i < 200; i++) {
    const G = mul3(mul3(rotation([r2(), r2(), r2() + 1e-3], 3 * r2()), diag(1 + 0.2 * r2(), 1 + 0.2 * r2(), 1 + 0.2 * r2())), transpose3(rotation([r2() + 1e-3, r2(), r2()], 3 * r2())))
    const Jp0 = 0.7 + 0.3 * Math.abs(r2()), q = SNOW.cpu.plasticity!(ctx(G, Jp0, p))
    if (q.Jp! < SNOW_JP_RANGE[1]) assert.ok(Math.abs(det3(q.F!) * q.Jp! - det3(G) * Jp0) < 1e-12, `volume #${i}`)
  }
  // Compaction stops at maxDensity: Jp ≥ ρ / maxDensity, and the remaining squeeze stays elastic in F.
  const floor = p.density / p.maxDensity
  const crushed = SNOW.cpu.plasticity!(ctx(diag(0.7, 0.7, 0.7), 0.65, p))
  assert.ok(Math.abs(crushed.Jp! - floor) < 1e-12, `Jp ${crushed.Jp} vs floor ${floor}`)
  assert.ok(det3(crushed.F!) < (1 - p.compression) ** 3, 'the rest of the compression must stay elastic')
  assert.ok(Math.abs(det3(crushed.F!) * crushed.Jp! - 0.343 * 0.65) < 1e-12)
  assert.ok(p.maxDensity <= ICE_DENSITY)
})

test('stress: zero at rest and under pure rotation (corotated), symmetric, hardening exp(ξ(1 − Jp)) capped', () => {
  const p = { ...SNOW_PRESETS.packed, maxHardening: 1e9 }
  const tau = (F: Mat3, Jp: number, params = p) => SNOW.cpu.stress(ctx(F, Jp, params))
  assert.ok(tau(identity3(), 1).every((v) => Math.abs(v) < 1e-9))
  assert.ok(tau(rotation([1, 2, 3], 1.1), 1).every((v) => Math.abs(v) < 1e-9), 'rotation must be stress free')
  // Uniform stretch s: τ = 2μ(s − 1)s·I + λ(J − 1)J·I
  const s = 1.01, F = diag(s, s, s), J = s ** 3
  const { mu, lambda } = snowLame(p)
  const t1 = tau(F, 1)
  assert.ok(Math.abs(t1[0] - (2 * mu * (s - 1) * s + lambda * (J - 1) * J)) < 1e-6 * t1[0])
  // Symmetric for a general F.
  const G = [1.01, 0.02, -0.01, 0.03, 0.99, 0.015, -0.02, 0.01, 1.005]
  const tg = tau(G, 1)
  assert.ok(maxAbs(tg, transpose3(tg)) < 1e-8 * norm(tg))
  // Hardening: compacted snow (Jp < 1) is stiffer by exp(ξ(1 − Jp)), loosened snow softer, capped at maxHardening.
  for (const Jp of [0.9, 0.95, 1.05, 1.2]) {
    const ratio = tau(G, Jp)[0] / tg[0]
    assert.ok(Math.abs(ratio - Math.exp(p.hardening * (1 - Jp))) < 1e-9, `Jp ${Jp}: ×${ratio}`)
  }
  const capped = { ...p, maxHardening: 2 }
  assert.ok(Math.abs(tau(G, 0.5, capped)[0] / tg[0] - 2) < 1e-9)
})

test('time step: snow sound speed assumes fully hardened snow', () => {
  for (const preset of Object.values(SNOW_PRESETS)) {
    const { mu, lambda } = snowLame(preset)
    assert.ok(Math.abs(SNOW.soundSpeed(preset) - Math.sqrt(((lambda + 2 * mu) * preset.maxHardening) / preset.density)) < 1e-9)
  }
  const o = resolveMPMOptions({ cellSize: 0.1, materials: { snow: SNOW_PRESETS.powder } })
  assert.ok(Math.abs(mpmStableStep(o) - (o.cfl * 0.1) / (o.maxSpeed + SNOW.soundSpeed(SNOW_PRESETS.powder))) < 1e-15)
})

test('colliders: inward velocity relative to the collider removed, moving colliders push, particles pushed out', async () => {
  const { collideMPM, packMPMColliders } = await import('../src/mpm-reference.ts')
  const packed = new Float64Array(8 * 12)
  const sphere: MPMCollider = { a: [11, 2, 0], radius: 0.5, friction: 0 }
  assert.equal(packMPMColliders([sphere], [10, 0, 0], 0.5, packed), 1)
  assert.deepEqual(Array.from(packed.subarray(0, 12)), [1, 2, 0, 0.5, 1, 2, 0, 0, 0, 0, 0, 0]) // local, b = a
  const v = [0, -1, 0.5], x = [1, 2.4, 0]
  collideMPM(packed, 1, x, v) // above the centre, moving down into it: the downward part goes
  assert.deepEqual(v, [0, 0, 0.5])
  const out = [0, 1, 0]
  collideMPM(packed, 1, [1, 2.4, 0], out) // separating: free
  assert.deepEqual(out, [0, 1, 0])
  const far = [0, -1, 0]
  collideMPM(packed, 1, [1, 2.6, 0], far) // outside: untouched
  assert.deepEqual(far, [0, -1, 0])
  // A capsule moving down at 2 m/s drives material under it down with it; push moves a point to its surface.
  packMPMColliders([{ a: [0, 1, -1], b: [0, 1, 1], radius: 0.2, velocity: [0, -2, 0], friction: 0 }], [0, 0, 0], 0.5, packed)
  const w = [0, 0, 0], p = [0, 0.9, 0.7]
  collideMPM(packed, 1, p, w, true)
  assert.ok(Math.abs(w[1] + 2) < 1e-12 && Math.abs(p[1] - 0.8) < 1e-12, `${w} ${p}`)
})

// A snow column on flat ground, pressed by a wide piston (a 3 m sphere) and released: it compacts (Jp < 1) and keeps
// the compaction once unloaded, without spreading sideways. The same column with plasticity off springs back.
function pressColumn(params: SnowParams) {
  const G = 0.2, X = 0.6
  const r = new MPMReference({ capacity: 1024, resolution: [12, 16, 12], cellSize: 0.1, origin: [0, 0, 0], maxSubsteps: 32, friction: 0.5, materials: { snow: params } }, () => G)
  r.emit({ center: [X, G + 0.3, X], size: [0.15, 0.3, 0.15], material: 'snow', jitter: 0 })
  const d = r.data, n = d.count
  const stats = () => {
    let top = -Infinity, spread = 0, Jp = 0, low = Infinity
    for (let q = 0; q < n; q++) {
      top = Math.max(top, d.position[q * 3 + 1] - G)
      low = Math.min(low, d.position[q * 3 + 1] - G)
      spread = Math.max(spread, Math.abs(d.position[q * 3] - X), Math.abs(d.position[q * 3 + 2] - X))
      Jp += d.Jp[q] / n
    }
    return { top, spread, Jp, low }
  }
  for (let f = 0; f < 12; f++) r.step(1 / 60)
  const rest = stats()
  const R = 3
  let y = G + rest.top + R + 0.01
  for (let f = 0; f < 18; f++) { // 0.3 s at 0.4 m/s: 11 cm into a 0.58 m column
    r.colliders = [{ a: [X, y, X], radius: R, velocity: [0, -0.4, 0] }]
    r.step(1 / 60)
    y -= 0.4 / 60
  }
  const pressed = stats()
  for (let f = 0; f < 9; f++) { // lift off
    r.colliders = [{ a: [X, y, X], radius: R, velocity: [0, 1, 0] }]
    r.step(1 / 60)
    y += 1 / 60
  }
  r.colliders = []
  for (let f = 0; f < 18; f++) r.step(1 / 60)
  return { rest, pressed, released: stats() }
}

test('a snow column compacts under load and keeps its shape plastically; elastic snow springs back', () => {
  const snow = pressColumn(SNOW_PRESETS.packed)
  assert.ok(snow.pressed.top < snow.rest.top - 0.08, `pressed ${snow.pressed.top} from ${snow.rest.top}`)
  assert.ok(snow.released.top < snow.rest.top - 0.07, `sprang back to ${snow.released.top} (rest ${snow.rest.top})`)
  assert.ok(snow.released.Jp < 0.92, `mean Jp ${snow.released.Jp}: no compaction recorded`)
  assert.ok(snow.released.spread < snow.rest.spread + 0.02, `spread from ${snow.rest.spread} to ${snow.released.spread}`)
  assert.ok(snow.released.low > -1e-6, 'below the ground')
  const elastic = pressColumn({ ...SNOW_PRESETS.packed, compression: 0.99, stretch: 100 })
  assert.ok(Math.abs(elastic.released.Jp - 1) < 1e-12)
  assert.ok(elastic.released.top > elastic.rest.top - 0.04, `elastic column stayed at ${elastic.released.top} (rest ${elastic.rest.top})`)
})

test('deterministic: snow with a collider gives the same result in any particle order, run after run', () => {
  const run = (reverse: boolean) => {
    const r = new MPMReference({ capacity: 512, resolution: [12, 12, 12], cellSize: 0.1, origin: [0, 0, 0], materials: { snow: SNOW_PRESETS.powder } }, () => 0.2)
    const pos = mpmEmitPositions({ center: [0.6, 0.4, 0.6], size: [0.2, 0.2, 0.2] }, 0.1, 3)
    const order = Array.from({ length: pos.length / 3 }, (_, i) => (reverse ? pos.length / 3 - 1 - i : i))
    r.emit({ positions: order.flatMap((i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]), material: 'snow' })
    r.colliders = [{ a: [0.55, 0.65, 0.5], b: [0.65, 0.65, 0.7], radius: 0.08, velocity: [0, -1.5, 0] }]
    for (let s = 0; s < 12; s++) r.substep(1 / 600)
    return { r, order }
  }
  const a = run(false), b = run(true), c = run(false)
  assert.deepEqual(a.r.grid, b.r.grid)
  assert.deepEqual(a.r.data.deformation, c.r.data.deformation)
  assert.deepEqual(a.r.data.Jp, c.r.data.Jp)
  let compacted = 0
  for (let i = 0; i < a.order.length; i++) {
    const j = b.order.indexOf(i)
    for (let k = 0; k < 3; k++) assert.equal(a.r.data.position[i * 3 + k], b.r.data.position[j * 3 + k])
    assert.equal(a.r.data.Jp[i], b.r.data.Jp[j])
    if (a.r.data.Jp[i] < 1) compacted++
  }
  assert.ok(compacted > 0, 'the capsule should have compacted some snow')
})

// The GPU check: example/mpm-snow.html?check runs a tiny snow scene with a moving capsule on the GPU and records its
// state here (1 and 24 substeps); the CPU reference must match within float32 tolerance. Re-record by running the
// check page and saving `window.snowCheck` here.
const fixture = new URL('./fixtures/mpm-snow-gpu-step.json', import.meta.url)
test('CPU reference matches a recorded GPU snow step', { skip: !existsSync(fixture) && 'no GPU fixture recorded' }, () => {
  const f = JSON.parse(readFileSync(fixture, 'utf8'))
  for (const run of f.runs) {
    const r = new MPMReference(f.options, (x: number, z: number) => f.slope[0] + f.slope[1] * x + f.slope[2] * z)
    r.emit(f.emit)
    r.colliders = f.colliders
    for (let s = 0; s < run.substeps; s++) r.substep(f.dt)
    const check = (name: string, cpu: ArrayLike<number>, gpu: number[], tol: number) => {
      let worst = 0
      for (let i = 0; i < gpu.length; i++) worst = Math.max(worst, Math.abs(cpu[i] - gpu[i]))
      assert.ok(worst <= tol, `${run.substeps} substeps, ${name}: max error ${worst} > ${tol}`)
    }
    assert.equal(run.count, r.data.count)
    const one = run.substeps === 1
    check('position', r.data.position, run.position, one ? 1e-6 : 5e-5)
    check('velocity', r.data.velocity, run.velocity, one ? 1e-4 : 2e-3)
    check('deformation', r.data.deformation, run.deformation, one ? 1e-5 : 2e-4)
    check('Jp', r.data.Jp, run.Jp, one ? 1e-5 : 2e-4)
  }
})

test('friction map: a weak patch releases the snow on it while the rest of the slope holds', () => {
  const slope = (x: number) => 1.2 - Math.tan((32 * Math.PI) / 180) * x // 32° down +x
  const r = new MPMReference({ capacity: 2048, resolution: [24, 20, 12], cellSize: 0.1, origin: [0, 0, 0], friction: 1.2, materials: { snow: SNOW_PRESETS.packed } }, (x) => slope(x))
  const pos: number[] = []
  // Two parts with a fracture between them, 3 cells wide (no shared grid nodes: MPM bonds anything closer).
  for (let x = 0.325; x < 1.9; x += 0.05) for (let z = 0.225; z < 0.95; z += 0.05) for (let y = 0.025; y < 0.15; y += 0.05) if (x < 0.8 || x > 1.1) pos.push(x, slope(x) + y, z)
  r.emit({ positions: pos, material: 'snow' })
  const d = r.data, n = d.count
  const meanX = (sel: (x: number) => boolean) => { let s = 0, k = 0; for (let p = 0; p < n; p++) if (sel(pos[p * 3])) { s += d.position[p * 3]; k++ } return s / k }
  const upper0 = meanX((x) => x < 0.9), lower0 = meanX((x) => x >= 1.1)
  assert.equal(r.frictionMap[0], 1)
  r.setFriction((x) => (x >= 0.95 ? 0.05 : 1)) // the lower part sits on a weak layer
  for (let f = 0; f < 24; f++) r.step(1 / 60)
  const upper = meanX((x) => x < 0.9) - upper0, lower = meanX((x) => x >= 1.1) - lower0
  assert.ok(lower > 0.1 && lower > 5 * Math.abs(upper), `the released part moved ${lower} m, the held part ${upper} m`)
  assert.ok(upper < 0.05, `the held part moved ${upper} m`)
  assert.equal(r.setFriction(null).frictionMap[5], 1)
})
