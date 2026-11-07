import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SEA_BANDS, seabedWeights } from '../src/seabed.ts'

const steps = 20_000
const span = 220
const depthAt = (i: number) => -10 + (i * span) / steps

test('seabed weights stay a valid blend and dry out above the waterline', () => {
  for (let i = 0; i <= steps; i++) {
    const d = depthAt(i)
    const w = seabedWeights(d)
    assert.ok(
      w.every((x) => x >= 0 && x <= 1),
      `weights in range at ${d} m`
    )
    assert.ok(w[0] + w[1] + w[2] <= 1 + 1e-9, `weights do not overfill at ${d} m`)
  }
  assert.deepEqual(seabedWeights(-1), [0, 0, 0])
  assert.deepEqual(seabedWeights(0), [0, 0, 0])
  assert.deepEqual(seabedWeights(200), [0, 0, 1])
})

test('seabed darkens with depth: shelf weight only falls, abyss weight only rises', () => {
  // Below the shoreline ramp (1.5 m) the tint is fully on, so the bands only shift with depth.
  let prev = seabedWeights(1.5)
  for (let i = 1; i <= steps; i++) {
    const d = depthAt(i)
    if (d < 1.5) continue
    const w = seabedWeights(d)
    assert.ok(w[0] <= prev[0] + 1e-9, `shelf weight rose at ${d} m`)
    assert.ok(w[2] >= prev[2] - 1e-9, `abyss weight fell at ${d} m`)
    prev = w
  }
})

test('seabed bands are distinguishable', () => {
  const shelf = seabedWeights(4)
  assert.ok(shelf[0] > 0.5 && shelf[0] > shelf[1] && shelf[0] > shelf[2], 'shallow shelf is mainly turquoise')
  const slope = seabedWeights((SEA_BANDS.shelf + SEA_BANDS.slope) / 2)
  assert.ok(slope[1] > 0.9, 'mid depth is mainly blue-green')
  assert.ok(Math.abs(slope[1] - shelf[1]) > 0.3 && Math.abs(slope[1] - seabedWeights(200)[1]) > 0.3)
  const abyss = seabedWeights(SEA_BANDS.abyss + 20)
  assert.ok(abyss[2] > 0.99, 'deep ocean is fully dark')
})

test('no step at the band thresholds', () => {
  for (const edge of [0, 1.5, SEA_BANDS.shelf, SEA_BANDS.slope, SEA_BANDS.abyss]) {
    for (let k = 0; k < 3; k++) {
      const jump = Math.abs(seabedWeights(edge + 1e-3)[k] - seabedWeights(edge - 1e-3)[k])
      assert.ok(jump < 5e-3, `weight ${k} jumps ${jump} at ${edge} m`)
    }
  }
  // Sweep the whole ramp: neighbouring samples never jump (the bands are continuous, not quantised).
  let prev = seabedWeights(depthAt(0))
  for (let i = 1; i <= steps; i++) {
    const w = seabedWeights(depthAt(i))
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(w[k] - prev[k]) < 0.02, `discontinuity at ${depthAt(i)} m`)
    prev = w
  }
})

test('jitter shifts the bands without breaking them', () => {
  const flat = seabedWeights(SEA_BANDS.shelf / 2)
  assert.ok(seabedWeights(SEA_BANDS.shelf / 2, 1)[0] < flat[0], 'positive jitter reads deeper')
  assert.ok(seabedWeights(SEA_BANDS.shelf / 2, -1)[0] > flat[0], 'negative jitter reads shallower')
  for (const jitter of [-1, 0, 1]) {
    const w = seabedWeights(6, jitter)
    assert.ok(w.every((x) => x >= 0 && x <= 1))
  }
})
