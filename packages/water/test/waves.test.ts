import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWaves, crestSharpness, sampleWaves, MAX_WAVES, type WaveOptions } from '../src/waves.ts'

const options: WaveOptions = { count: 10, seed: 3, amplitude: 0.8, wavelength: [2, 60], direction: [1, 0.4], spread: 0.6, choppiness: 0.8, speed: 1 }

test('waves are deterministic, bounded and never loop', () => {
  const a = createWaves(options)
  assert.deepEqual(a, createWaves(options))
  assert.notDeepEqual(a, createWaves({ ...options, seed: 4 }))
  assert.equal(a.length, 10)
  assert.equal(createWaves({ ...options, count: 99 }).length, MAX_WAVES)
  for (const w of a) {
    const lambda = (2 * Math.PI) / w.k
    assert.ok(lambda >= 2 - 1e-9 && lambda <= 60 + 1e-9)
    assert.ok(Math.abs(Math.hypot(w.dirX, w.dirZ) - 1) < 1e-12)
    assert.ok(w.amplitude <= 0.8 * 1.3 + 1e-9)
  }
  // Σ k·chop ≤ choppiness ≤ 1 → the Gerstner surface never folds over, even for steep seas.
  for (const amplitude of [0.8, 20]) {
    const s = crestSharpness(createWaves({ ...options, amplitude }))
    assert.ok(s <= 0.8 + 1e-9 && s > 0)
  }
  for (const w of a) assert.ok(w.chop <= w.amplitude * 0.8 + 1e-12)
})

test('sampleWaves: height stays within the summed amplitude, normals are unit and upward', () => {
  const waves = createWaves(options)
  const bound = waves.reduce((s, w) => s + w.amplitude, 0)
  for (let i = 0; i < 200; i++) {
    const s = sampleWaves(waves, i * 3.7 - 300, i * 1.3, i * 0.21)
    assert.ok(Math.abs(s.height) <= bound + 1e-9)
    assert.ok(Math.abs(Math.hypot(s.nx, s.ny, s.nz) - 1) < 1e-9)
    assert.ok(s.ny > 0)
  }
})

test('sampleWaves finds the displaced surface point above (x, z)', () => {
  // One wave: check against a brute-force search along the Lagrangian parameter.
  const waves = createWaves({ ...options, count: 1, spread: 0, direction: [1, 0], amplitude: 8, choppiness: 0.9 })
  const w = waves[0]
  const x = 1.234
  const s = sampleWaves(waves, x, 0, 0)
  let best = Infinity, height = 0
  for (let p = x - 2 * w.chop - 1; p < x + 2 * w.chop + 1; p += 1e-5) {
    const err = Math.abs(p + w.chop * Math.cos(w.k * p) - x)
    if (err < best) { best = err; height = w.amplitude * Math.sin(w.k * p) }
  }
  assert.ok(Math.abs(s.height - height) < 1e-3)
  // A phase offset equals shifting time.
  const shifted = sampleWaves(waves, 5, 2, 0, undefined, [-w.omega * 3])
  assert.ok(Math.abs(shifted.height - sampleWaves(waves, 5, 2, 3).height) < 1e-9)
})
