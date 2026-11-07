import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FAR_DETAIL_OCTAVES,
  MID_DETAIL_BAND,
  OCTAVE_FULL,
  OCTAVE_ZERO,
  farDetailAt,
  farWeight,
  midWeight,
  octaveWeight
} from '../src/detail.ts'

test('octave weight falls smoothly from one to zero as the pixel footprint grows', () => {
  for (const { wavelength } of FAR_DETAIL_OCTAVES) {
    assert.equal(octaveWeight(wavelength, 0), 1, 'full weight at zero footprint')
    assert.equal(octaveWeight(wavelength, wavelength * OCTAVE_FULL), 1, 'still full at a quarter wavelength')
    assert.equal(octaveWeight(wavelength, wavelength * OCTAVE_ZERO), 0, 'gone at half a wavelength')
    let prev = 1
    for (let i = 1; i <= 200; i++) {
      const w = octaveWeight(wavelength, (wavelength * i) / 100)
      assert.ok(w >= 0 && w <= 1, `weight in range at ${i}% of ${wavelength} m`)
      assert.ok(w <= prev + 1e-12, `weight rose at ${i}% of ${wavelength} m`)
      prev = w
    }
  }
})

test('finer octaves are band-limited before coarser ones', () => {
  const coarse = FAR_DETAIL_OCTAVES[0].wavelength
  const footprint = coarse * 0.4
  const weights = FAR_DETAIL_OCTAVES.map((o) => octaveWeight(o.wavelength, footprint))
  assert.ok(weights[0] > 0, 'the 2.4 km octave still contributes')
  assert.equal(weights[1], 0, '760 m is below the footprint')
  assert.equal(weights[2], 0, '240 m is below the footprint')
})

test('far octave amplitudes are normalised', () => {
  const sum = FAR_DETAIL_OCTAVES.reduce((a, o) => a + o.amplitude, 0)
  assert.ok(Math.abs(sum - 1) < 1e-12, `amplitudes sum to ${sum}`)
})

test('far detail is continuous across a chunk boundary', () => {
  const h = 1e-3
  for (let z = -1000; z <= 1000; z += 211) {
    const a = farDetailAt(4096 - h, 42, z, 5)
    const b = farDetailAt(4096 + h, 42, z, 5)
    assert.ok(Math.abs(a - b) < 1e-4, `jump of ${Math.abs(a - b)} at the 4 km grid line, z ${z}`)
  }

  // The shader builds its coordinate as vertex-local + chunk centre modulo the period. Adjacent
  // chunks must map a shared world vertex to the same coordinate (this is what stops a seam).
  const period = 262_144
  const mod = (v: number, p: number) => ((v % p) + p) % p
  const coord = (world: number, center: number) => world - center + mod(center, period)
  for (const [centerA, size] of [
    [100_000, 4096],
    [-37_000, 8192],
    [200_000, 16_384]
  ]) {
    const centerB = centerA + size
    for (let i = 0; i <= 8; i++) {
      const world = centerA + (size * i) / 8
      assert.equal(coord(world, centerA), coord(world, centerB), `chunk coordinates disagree at ${world}`)
    }
  }
})

test('far detail varies at mid scales and vanishes once the footprint outgrows it', () => {
  const samples = new Set<number>()
  for (let x = 0; x < 20_000; x += 250) samples.add(farDetailAt(x, 30, 1200, 4))
  assert.ok(samples.size > 20, `only ${samples.size} distinct values over 20 km`)

  const coarse = FAR_DETAIL_OCTAVES[0].wavelength
  assert.equal(farDetailAt(1, 2, 3, coarse * OCTAVE_ZERO), 0, 'all octaves band-limited away')
})

test('mid and far opacities sum to one, so the hand-over neither gaps nor doubles', () => {
  const detailDistance = 220
  for (let m = 0; m <= 50_000; m += 37) {
    const sum = midWeight(m, detailDistance) + farWeight(m, detailDistance)
    assert.ok(Math.abs(sum - 1) < 1e-12, `opacities sum to ${sum} at ${m} m`)
  }
  assert.equal(midWeight(detailDistance * MID_DETAIL_BAND.fadeStart, detailDistance), 1)
  assert.equal(midWeight(detailDistance * MID_DETAIL_BAND.fadeEnd, detailDistance), 0)
  assert.equal(farWeight(detailDistance * MID_DETAIL_BAND.fadeEnd, detailDistance), 1)
  assert.equal(farWeight(50_000, detailDistance), 1)
})
