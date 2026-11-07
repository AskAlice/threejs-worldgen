import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_APPEARANCE,
  FILTER_KEEP_PIXELS,
  SLOPE_VARIANCE_SCALE,
  WHITECAP_THRESHOLD,
  createWaterUniforms,
  detailFilter,
  roughnessFromVariance,
  whitecapFoam,
  whitecapThreshold
} from '../src/material.ts'
import { createWaves, waveJacobian, crestSharpness, type WaveOptions } from '../src/waves.ts'

const sea: WaveOptions = {
  count: 12,
  seed: 1,
  amplitude: 0.45,
  wavelength: [0.6, 42],
  direction: [1, 0.35],
  spread: 0.55,
  choppiness: 0.75,
  speed: 1
}

test('detailFilter: resolved detail is untouched, sub-pixel detail is gone, and distance alone never blurs near detail', () => {
  // A feature many pixels wide is kept in full, however far away it is: only the ratio matters.
  assert.equal(detailFilter(10, 0.001), 1)
  assert.equal(detailFilter(10, 0.2), 1, '10 m across 50 px')
  assert.equal(detailFilter(1, 1e-3), 1, 'near-camera detail keeps its full slope')
  assert.equal(detailFilter(1, 10), 0, '0.1 px across: filtered out')
  // Scale invariance: the same wave at the same pixel footprint filters identically.
  for (const [w, f] of [
    [2, 0.5],
    [0.6, 7]
  ])
    assert.ok(Math.abs(detailFilter(w, f) - detailFilter(w * 4, f * 4)) < 1e-12)
  // The transition is where the constants say, and it is smooth (no ring or hard cut at distance).
  const gone = detailFilter(FILTER_KEEP_PIXELS[0], 1),
    kept = detailFilter(FILTER_KEEP_PIXELS[1], 1)
  assert.ok(gone < 1e-9 && kept > 1 - 1e-9, '3 px removes, 7 px keeps')
  let previous = 0,
    biggestStep = 0
  for (let span = 0; span <= 12; span += 0.01) {
    const value = detailFilter(span, 1)
    assert.ok(value >= previous - 1e-12, 'never falls as the feature gets bigger on screen')
    biggestStep = Math.max(biggestStep, Math.abs(value - previous))
    previous = value
  }
  assert.ok(biggestStep < 0.01, `an easing transition, not a cut (${biggestStep})`)
})

test('detailFilter: any wave shorter than the keep threshold is gone, so nothing aliases at the horizon', () => {
  // A default sea at 1 px/m: the shortest waves are sub-pixel and must contribute no slope at all.
  const waves = createWaves(sea)
  for (const w of waves) {
    const wavelength = (2 * Math.PI) / w.k
    if (wavelength < FILTER_KEEP_PIXELS[0]) assert.equal(detailFilter(wavelength, 1), 0)
  }
})

test('roughnessFromVariance: roughness² and the lost slope variance add in quadrature, capped at 1', () => {
  assert.equal(roughnessFromVariance(0.06, 0), 0.06, 'no lost slopes = the setting')
  const slope = 0.02
  assert.ok(Math.abs(roughnessFromVariance(0.06, slope) - Math.sqrt(0.06 ** 2 + SLOPE_VARIANCE_SCALE * slope)) < 1e-12)
  assert.ok(roughnessFromVariance(0.06, slope) > 0.06, 'sub-pixel slopes widen the glint')
  assert.ok(roughnessFromVariance(0.06, slope * 2) > roughnessFromVariance(0.06, slope), 'monotone')
  assert.equal(roughnessFromVariance(0.5, 100), 1, 'clamped')
  assert.equal(roughnessFromVariance(-1, -1), 0, 'negative input cannot make a negative roughness')
})

test('whitecaps: the setting sets the fold threshold, and the mask starts exactly there', () => {
  assert.equal(whitecapThreshold(1), WHITECAP_THRESHOLD.base)
  assert.equal(whitecapThreshold(0), WHITECAP_THRESHOLD.base + WHITECAP_THRESHOLD.range)
  assert.ok(whitecapThreshold(0.6) < whitecapThreshold(0.3), 'a higher setting breaks at milder crests')
  const steep = crestSharpness(createWaves(sea))
  const cut = whitecapThreshold(0.3)
  assert.equal(whitecapFoam(cut, 0.3, steep), 0, 'no foam at the threshold')
  assert.ok(whitecapFoam(cut + 0.05, 0.3, steep) > 0, 'foam above it')
})

test('whitecaps: a breaking crest leaves a fading trail and cannot flicker off in one frame', () => {
  const waves = createWaves(sea)
  const steep = crestSharpness(waves)
  const lifetime = 0.35,
    decay = 0.5,
    frame = 1 / 60
  const fold = (x: number, z: number, t: number) => 1 - waveJacobian(waves, x, z, t)
  const cut = whitecapThreshold(0.3)
  // Find a point and moment where the default sea really breaks, then watch that point as crests pass.
  let x = 0,
    z = 0
  search: for (let i = 0; i < 10; i++)
    for (let j = 0; j < 10; j++)
      for (let t = 0; t < 4; t += 0.05)
        if (fold(i * 0.7, j * 0.9, t) > cut + 0.06) {
          x = i * 0.7
          z = j * 0.9
          break search
        }
  assert.ok(fold(x, z, 0) > -1, 'the search ran')
  assert.ok(
    (() => {
      for (let t = 0; t < 4; t += 0.05) if (fold(x, z, t) > cut + 0.06) return true
      return false
    })(),
    'the default sea does break somewhere'
  )
  const mask = (t: number) =>
    Math.max(whitecapFoam(fold(x, z, t), 0.3, steep), whitecapFoam(fold(x, z, t - lifetime), 0.3, steep) * decay)
  let biggestStep = 0
  for (let t = 0; t < 4; t += frame) biggestStep = Math.max(biggestStep, Math.abs(mask(t + frame) - mask(t)))
  assert.ok(biggestStep < 0.35, `foam fades instead of blinking (${biggestStep.toFixed(3)} per frame)`)
  // The trail only ever adds foam: a crest that has just relaxed keeps some of its coverage.
  let justBroke = -1
  for (let t = 0; t < 4; t += frame) if (fold(x, z, t) > cut + 0.06 && mask(t + lifetime) > 0) justBroke = t
  assert.ok(justBroke >= 0, 'foam persists one lifetime after the crest that made it')
})

test('uniforms: a material built from fresh uniforms already has the default look (no setup frame)', () => {
  const u = createWaterUniforms()
  const same = (actual: number, expected: number, what: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-12, `${what}: ${actual} != ${expected}`)
  same(u.roughness.value, DEFAULT_APPEARANCE.roughness, 'roughness')
  same(u.refraction.value, DEFAULT_APPEARANCE.refraction, 'refraction')
  same(u.foamWidth.value, DEFAULT_APPEARANCE.foamWidth, 'foamWidth')
  same(u.detail.value, DEFAULT_APPEARANCE.detail, 'detail')
  same(u.detailScale.value, DEFAULT_APPEARANCE.detailScale, 'detailScale')
  same(u.detailSpeed.value, DEFAULT_APPEARANCE.detailSpeed, 'detailSpeed')
  for (let i = 0; i < 3; i++) same(u.absorption.value.getComponent(i), DEFAULT_APPEARANCE.absorption[i], 'absorption')
  // Colours too: a fresh material is the sea, not a black mirror.
  assert.equal(u.skyColor.value.getHexString(), '6e9fd6')
  assert.equal(u.horizonColor.value.getHexString(), 'cfe0ee')
  assert.equal(u.scatterColor.value.getHexString(), '0b3247')
  assert.equal(u.foamColor.value.getHexString(), 'f3f7f8')
})
