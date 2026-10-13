import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EmitterClock, SOURCE_STRIDE, createSourceTable, fillSourceTable, particleRandom, pcg, pickSource, spawnRate } from '../src/emitter.ts'
import { DEFAULT_PARTICLES, CURVE_KEYS, resolveParticleOptions, sanitizeParticleOptions, seedOf } from '../src/options.ts'
import { evalCurve, resampleCurve } from '../src/curves.ts'
import { blackbodyColor, blackbodyRadiance } from '../src/blackbody.ts'
import { bakeNoiseVolume } from '../src/noise.ts'

test('emitter clock: same total time, same particles, however the frames split', () => {
  const run = (dts: number[]) => {
    const c = new EmitterClock(1000)
    const batches = dts.map((dt) => c.step(240, dt))
    return { spawned: c.spawned, head: c.head, batches }
  }
  const even = run(Array(60).fill(1 / 60))
  const uneven = run([0.5, 0.25, 0.125, 0.125])
  assert.equal(even.spawned, 240)
  assert.equal(uneven.spawned, 240)
  assert.equal(even.head, 240)
  // Serials are contiguous: each batch starts where the last ended.
  let next = 0
  for (const b of even.batches) { assert.equal(b.first, next); next += b.count }
})

test('emitter clock: the ring wraps, and a capped frame drops its backlog', () => {
  const c = new EmitterClock(100)
  const b = c.step(1000, 0.15)
  assert.deepEqual(b, { first: 0, slot: 0, count: 100 }) // capped at capacity
  const b2 = c.step(1000, 0.025)
  assert.equal(b2.slot, 0) // wrapped
  assert.equal(b2.count, 25)
  const capped = new EmitterClock(1000)
  assert.equal(capped.step(1000, 1, 64).count, 64)
  assert.equal(capped.step(1000, 0.001, 64).count, 1) // no burst of the 936 dropped
})

test('spawn rate scales with source weight and never overruns the pool', () => {
  assert.equal(spawnRate(10, 3, 1e6, 2), 30)
  assert.equal(spawnRate(10, 1e6, 1000, 2), 500) // 1000 slots / 2 s life
  assert.equal(spawnRate(10, 0, 1000, 2), 0)
})

test('sources: weighted picks follow the weights; overflow keeps the heaviest', () => {
  const src = new Float32Array([
    0, 0, 0, 1, 1, 0, 0, 1,
    5, 0, 0, 0, 1, 0, 0, 1, // zero weight: skipped
    9, 0, 0, 3, 2, 0, 0, 1,
  ])
  const t = fillSourceTable(createSourceTable(8), src)
  assert.equal(t.count, 2)
  assert.equal(t.total, 4)
  assert.equal(t.positions[4], 9)
  assert.equal(t.data[4], 2)
  let picks = [0, 0]
  for (let i = 0; i < 4000; i++) picks[pickSource(t, particleRandom(i, 0, 7))]++
  assert.ok(Math.abs(picks[1] / 4000 - 0.75) < 0.03, `share ${picks[1] / 4000}`)
  const small = fillSourceTable(createSourceTable(1), src)
  assert.equal(small.count, 1)
  assert.equal(small.positions[0], 9) // the heaviest survives
  assert.equal(pickSource(createSourceTable(4), 0.5), -1)
  picks = []
  void SOURCE_STRIDE
  // Motion (velocity, opacity) travels with its source; without it sources are still and opaque.
  assert.deepEqual([...t.motion.subarray(0, 8)], [0, 0, 0, 1, 0, 0, 0, 1])
  const motion = new Float32Array([1, 2, 3, 0.5, 0, 0, 0, 0, 4, 5, 6, 0.25])
  const moving = fillSourceTable(createSourceTable(8), src, undefined, motion)
  assert.deepEqual([...moving.motion.subarray(0, 8)], [1, 2, 3, 0.5, 4, 5, 6, 0.25])
  assert.deepEqual([...fillSourceTable(createSourceTable(1), src, undefined, motion).motion.subarray(0, 4)], [4, 5, 6, 0.25])
  // Refreshing every frame reuses the table's scratch list, and overflow still keeps the heaviest in order.
  const order = small.order
  fillSourceTable(small, src)
  assert.equal(small.order, order)
  const many = new Float32Array(Array.from({ length: 6 }, (_, i) => [i, 0, 0, [1, 5, 2, 5, 3, 0][i], 0, 0, 0, 1]).flat())
  const three = fillSourceTable(createSourceTable(3), many)
  assert.deepEqual([...three.positions.subarray(0, 12)].filter((_, k) => k % 4 === 0), [1, 3, 4])
})

test('per-particle random numbers are seeded, in [0, 1) and well spread', () => {
  assert.equal(particleRandom(12, 3, 99), particleRandom(12, 3, 99))
  assert.notEqual(particleRandom(12, 3, 99), particleRandom(12, 3, 100))
  let sum = 0
  for (let i = 0; i < 10000; i++) {
    const r = pcg(i)
    assert.ok(r >= 0 && r < 1)
    sum += r
  }
  assert.ok(Math.abs(sum / 10000 - 0.5) < 0.02)
  assert.equal(seedOf('fire'), seedOf('fire'))
  assert.notEqual(seedOf(1), seedOf(2))
})

test('lifetime curves: evenly spaced keys, clamped, resampled for the GPU', () => {
  assert.equal(evalCurve([0, 1], 0.5), 0.5)
  assert.equal(evalCurve([0, 1, 0], 0.25), 0.5)
  assert.equal(evalCurve([2], 0.7), 2)
  assert.equal(evalCurve([0, 1], -1), 0)
  assert.equal(evalCurve([0, 1], 2), 1)
  const r = resampleCurve([0, 1, 0])
  assert.equal(r.length, CURVE_KEYS)
  assert.equal(r[0], 0)
  assert.equal(r[CURVE_KEYS - 1], 0)
  for (let i = 0; i <= 20; i++) assert.ok(Math.abs(evalCurve(r, i / 20) - evalCurve([0, 1, 0], i / 20)) < 0.15) // 8 keys can clip a peak between keys
})

test('option sanitizing: bad input from a GUI or URL falls back to safe values', () => {
  const o = resolveParticleOptions({
    capacity: -5, rate: Number.NaN, life: [9, 2], maxPerFrame: 1e9,
    emitter: { shape: 'cube' as never, spread: -1, temperature: [0, -4] },
    curves: { size: [], opacity: [1, 'x' as never, 0], color: ['red', '#ff0000'] },
    render: { shading: 'plasma' as never, blending: 'multiply' as never, shadowSteps: 99, anisotropy: 2 },
  })
  assert.equal(o.capacity, 1)
  assert.equal(o.rate, DEFAULT_PARTICLES.rate)
  assert.deepEqual(o.life, [2, 9])
  assert.equal(o.maxPerFrame, 1)
  assert.equal(o.emitter.shape, 'point')
  assert.equal(o.emitter.spread, 0)
  assert.deepEqual(o.emitter.temperature, [1, 1])
  assert.deepEqual(o.curves.size, DEFAULT_PARTICLES.curves.size)
  assert.deepEqual(o.curves.opacity, [1, 0])
  assert.deepEqual(o.curves.color, ['#ff0000'])
  assert.equal(o.render.shading, 'unlit')
  assert.equal(o.render.blending, 'alpha')
  assert.equal(o.render.shadowSteps, 4)
  assert.equal(o.render.anisotropy, 0.95)
  // Defaults are untouched and already valid.
  assert.deepEqual(sanitizeParticleOptions(structuredClone(DEFAULT_PARTICLES)), DEFAULT_PARTICLES)
  // Prototype keys are ignored.
  const evil = resolveParticleOptions(JSON.parse('{"__proto__": {"polluted": 1}, "rate": 5}'))
  assert.equal(evil.rate, 5)
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
})

test('blackbody: deep red when cool, near-white at the core, radiance ∝ T⁴', () => {
  const red = blackbodyColor(900), orange = blackbodyColor(1300), white = blackbodyColor(6500)
  assert.equal(red[0], 1)
  assert.ok(red[1] < 0.35 && red[2] < 0.05, `900 K ${red}`)
  assert.ok(orange[1] > red[1] && orange[1] < 0.7, `1300 K ${orange}`)
  assert.ok(white[1] > 0.9 && white[2] > 0.85, `6500 K ${white}`)
  assert.ok(Math.abs(blackbodyRadiance(2800, 1400) - 16) < 1e-9)
})

test('noise volume: deterministic, tileable, spans the byte range', () => {
  const n = 16
  const a = bakeNoiseVolume(n, 3, 3, 4), b = bakeNoiseVolume(n, 3, 3, 4)
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, bakeNoiseVolume(n, 4, 3, 4))
  // Tileable: the lattice wraps, so the last texel is close to its neighbour across the seam.
  const at = (x: number, y: number, z: number, c: number) => a[((((z + n) % n) * n + ((y + n) % n)) * n + ((x + n) % n)) * 4 + c]
  let seam = 0, inner = 0
  for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) {
    seam += Math.abs(at(n - 1, y, z, 0) - at(0, y, z, 0))
    inner += Math.abs(at(5, y, z, 0) - at(6, y, z, 0))
  }
  assert.ok(seam < inner * 1.6, `seam ${seam} vs inner ${inner}`)
  let lo = 255, hi = 0
  for (let i = 3; i < a.length; i += 4) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]) }
  assert.ok(hi - lo > 100)
})
