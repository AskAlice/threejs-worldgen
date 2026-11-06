import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pivotBlend, surfaceLift } from '../src/controls.ts'

const R = 60_000

test('pivot blends from the surface focus to the planet centre as the camera rises', () => {
  assert.equal(pivotBlend(0, R), 0)
  assert.equal(pivotBlend(0, 0), 0, 'flat worlds never move the pivot')
  assert.equal(pivotBlend(R * 6, R), 1, 'orbital distance pivots on the centre')
  let previous = 0
  for (let d = 1; d <= R * 3; d *= 1.5) {
    const t = pivotBlend(d, R)
    assert.ok(t >= previous && t <= 1, `monotonic at ${d} m`)
    previous = t
  }
})

test('surface clamp lifts a camera only when it would be below the ground', () => {
  const lift = (height: number, ground: number, clearance: number) => {
    const v = surfaceLift(height, ground, clearance)
    return Math.abs(v - Math.round(v * 1e9) / 1e9) < 1e-9 ? Math.round(v * 1e9) / 1e9 : v
  }
  assert.equal(lift(100, 12, 0.3), 0)
  assert.equal(lift(20, 12, 0.3), 0)
  assert.equal(lift(10, 12, 0.3), 2.3)
  assert.equal(lift(41, 0, 0), 0)
  assert.equal(lift(0, -41, 1), 0, 'above a valley floor: nothing to lift')
  assert.equal(lift(-50, -41, 1), 10, 'below the ground under a valley')
})
