import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COVERAGE_AA_PIXELS, antiAlias, shoreCoverage } from '../src/material.ts'

/** Largest coverage step between samples `step / 2` apart (fwidth sums both screen axes). */
function maxStep(band: number, step: number): number {
  let worst = 0
  const dx = step / 2
  for (let d = 0; d <= band * 2; d += dx) {
    worst = Math.max(worst, Math.abs(shoreCoverage(d + dx, band) - shoreCoverage(d, band)))
  }
  return worst
}

test('antiAlias: at least the base width, and it grows with the pixel change', () => {
  assert.equal(antiAlias(0.15, 0), 0.15, 'a smooth mask keeps its base width')
  assert.equal(antiAlias(0.15, 1e-4), 0.15, 'near-camera detail stays crisp')
  assert.equal(antiAlias(0.15, 0.2), 0.4, 'two pixels of change per unit step')
  assert.ok(Math.abs(antiAlias(0.15, 0.2, 3) - 0.6) < 1e-9, 'the pixel count is configurable')
  assert.equal(antiAlias(0.15, -1), 0.15, 'a negative change cannot shrink the width')
  assert.ok(antiAlias(0.05, 1) > antiAlias(0.05, 0.1), 'monotone in the screen change')
})

test('shoreCoverage: 0 at the waterline, 1 at the band, monotone in between', () => {
  for (const band of [0.09, 1, 40]) {
    assert.equal(shoreCoverage(0, band), 0)
    assert.equal(shoreCoverage(band, band), 1)
    assert.equal(shoreCoverage(-1, band), 0, 'negative depth stays dry')
    assert.equal(shoreCoverage(2 * band, band), 1)
    let last = 0
    for (let d = 0; d <= band; d += band / 200) {
      const c = shoreCoverage(d, band)
      assert.ok(c >= last && c <= 1, `coverage is monotone at depth ${d}`)
      last = c
    }
    // Half depth is exactly the smoothstep midpoint.
    assert.ok(Math.abs(shoreCoverage(band / 2, band) - 0.5) < 1e-9)
  }
})

test('shoreline: the fade stays anti-aliased at 0.5 m and at 5 km', () => {
  const base = 0.6 * 0.15 // foamWidth 0.6 m → 9 cm of depth
  // fwidth is the depth change across a pixel: a fraction of a millimetre near the camera, metres at 5 km.
  for (const step of [1e-4, 0.02, 5, 200]) {
    const band = antiAlias(base, step)
    assert.ok(band >= base, `a ${step} m/pixel step never thins the base band`)
    assert.ok(maxStep(band, step) <= 0.5, `coverage changes by at most half its range per pixel at ${step} m/pixel`)
  }
  // The near camera is band-limited by the base; the far one by its pixel footprint.
  assert.equal(antiAlias(base, 1e-4), base)
  assert.equal(antiAlias(base, 5), 10)
  assert.ok(antiAlias(base, 5) > base * 50, 'at 5 km the fade widens to cover the pixel')
})

test('shoreline: a jittering depth buffer cannot flicker a pixel on and off', () => {
  // Depth quantises by ±q at the crossing; the fade must stay partial, never snap between 0 and 1.
  const base = 0.09
  const step = 0.5
  const band = antiAlias(base, step)
  assert.ok(shoreCoverage(0.25, band) > 0, 'a pixel just wet is not fully land')
  assert.ok(shoreCoverage(0.25, band) < 0.6, 'and not fully water either')
})

/** Largest change in `shoreCoverage` between two samples exactly one pixel apart. */
function worstPixelStep(band: number, step: number): number {
  let worst = 0
  for (let d = 0; d <= 4 * band; d += step / 64) {
    worst = Math.max(worst, Math.abs(shoreCoverage(d + step, band) - shoreCoverage(d, band)))
  }
  return worst
}

test('shoreCoverage: adjacent pixels never jump more than half the alpha range', () => {
  const base = 0.6 * 0.15
  for (const step of [1e-4, 0.005, 0.02, 0.5, 5, 200]) {
    const band = antiAlias(base, step, COVERAGE_AA_PIXELS)
    const worst = worstPixelStep(band, step)
    assert.ok(worst <= 0.5, `${worst.toFixed(3)} of the range per pixel at ${step} m/pixel`)
  }
})

test('antiAlias: two pixels is too narrow for a smoothstep, four is not', () => {
  // A smoothstep's peak slope is 1.5 / width: a 2-pixel band steps by 0.75 of the range per pixel,
  // which is the hard edge the waterline still showed.
  const base = 0.6 * 0.15
  const step = 1
  assert.ok(worstPixelStep(antiAlias(base, step, 2), step) > 0.5, 'a 2-pixel band steps too far')
  assert.ok(worstPixelStep(antiAlias(base, step, COVERAGE_AA_PIXELS), step) <= 0.5, 'four is enough')
})

test('shoreCoverage: the fade spans at least 4 pixels at every range', () => {
  const base = 0.6 * 0.15
  for (const step of [0.02, 0.5, 5, 200]) {
    const band = antiAlias(base, step, COVERAGE_AA_PIXELS)
    assert.ok(band / step >= COVERAGE_AA_PIXELS - 1e-9, `the ${step} m/pixel fade spans ${(band / step).toFixed(2)} px`)
  }
})
