import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foamTrail, shoreFoam, whitecapFoam } from '../src/material.ts'
import { createWaves, crestSharpness, waveJacobian, type WaveOptions } from '../src/waves.ts'

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

test('waveJacobian: flat water is 1, steep crests squeeze it toward 0, the capped sea never folds', () => {
  assert.equal(waveJacobian([], 3, -7), 1, 'no waves = undistorted surface')
  const waves = createWaves({ ...sea, count: 1, direction: [1, 0], spread: 0, amplitude: 8, choppiness: 1 })
  const w = waves[0]
  // One wave: det J = 1 − chop·k·sin(ph) exactly.
  for (const x of [0, 1.3, 9.7, -4.2]) {
    const expected = 1 - w.chop * w.k * Math.sin(w.k * x)
    assert.ok(Math.abs(waveJacobian(waves, x, 0) - expected) < 1e-9)
  }
  // A full-choppiness sea stays positive: the Gerstner cap exists so the surface never folds over.
  const steep = createWaves({ ...sea, amplitude: 60, choppiness: 1 })
  let min = Infinity
  for (let i = 0; i < 60; i++)
    for (let j = 0; j < 60; j++) min = Math.min(min, waveJacobian(steep, i * 1.7, j * 1.9, i * 0.31))
  assert.ok(min > 0, `a capped sea never folds (min det ${min})`)
  assert.ok(min < 0.6, 'but its crests really are squeezed')
})

test('whitecapFoam: open water is foam-free, only squeezed crests break, and the setting and the sea both raise it', () => {
  const steepness = crestSharpness(createWaves(sea))
  // Flat water (fold 0) never foams, at any setting or wind.
  for (const whitecaps of [0, 0.3, 0.6, 1]) {
    for (const steep of [0, 0.3, 1]) assert.equal(whitecapFoam(0, whitecaps, steep), 0)
  }
  // No whitecaps = no whitecaps; calm water cannot foam however high the setting.
  assert.equal(whitecapFoam(1, 0, steepness), 0)
  assert.equal(whitecapFoam(1, 1, 0.05), 0, 'a glassy sea never breaks')
  // A genuinely squeezed crest (> 0.5 of its area gone) does.
  const crest = whitecapFoam(0.5, 0.3, steepness)
  assert.ok(crest > 0.5 && crest <= 1)
  // Monotone in all three.
  assert.ok(whitecapFoam(0.22, 0.6, steepness) > whitecapFoam(0.22, 0.3, steepness), 'more whitecaps = more foam')
  assert.ok(whitecapFoam(0.32, 0.3, steepness) > whitecapFoam(0.25, 0.3, steepness), 'steeper crest = more foam')
  assert.ok(whitecapFoam(0.3, 0.3, 0.8) > whitecapFoam(0.3, 0.3, 0.3), 'a windier sea breaks earlier')
})

test('whitecapFoam: a default sea breaks on a few percent of its area, not across the surface', () => {
  const waves = createWaves(sea)
  const steepness = crestSharpness(waves)
  let wet = 0,
    n = 0
  for (let i = 0; i < 300; i++)
    for (let j = 0; j < 300; j++) {
      const fold = 1 - waveJacobian(waves, i * 0.3, j * 0.3)
      wet += whitecapFoam(fold, 0.3, steepness)
      n++
    }
  const coverage = wet / n
  assert.ok(coverage > 0.001, `the sea does break somewhere (${(coverage * 100).toFixed(2)}%)`)
  assert.ok(coverage < 0.06, `but open water stays clear (${(coverage * 100).toFixed(2)}%)`)
})

test('shoreFoam: concentrated at the waterline, gone by foamWidth, never spread out to sea', () => {
  const width = 0.6
  assert.ok(shoreFoam(0, width, 0) >= 0.54, 'foam at the waterline')
  assert.ok(shoreFoam(width, width, 1) < 0.05, 'almost nothing at the band edge')
  assert.equal(shoreFoam(3 * width, width, 1), 0, 'and nothing in open water')
  assert.equal(shoreFoam(-1, width, 1), 0, 'dry ground has no foam')
  let last = 1
  for (let d = 0; d <= width; d += width / 100) {
    const f = shoreFoam(d, width, 0.5)
    assert.ok(f <= last + 1e-9, 'monotone falloff')
    last = f
  }
  // Noise thins the band but cannot add foam outside it, and the far end of the band is mostly gone.
  assert.equal(shoreFoam(1.5 * width, width, 1), 0)
  assert.ok(shoreFoam(width / 2, width, 1) < 0.75 * shoreFoam(0, width, 1))
  assert.ok(shoreFoam(width * 0.85, width, 1) < 0.2 * shoreFoam(0, width, 1))
})

test('shoreFoam: a near-flat shelf does not foam; a real bank does', () => {
  const width = 0.6
  // Same shallow depth over two beds: the flat floodplain stays dry, the 5% bank foams.
  assert.equal(shoreFoam(0.2, width, 1, 0, 0.001), 0, 'no bank, no foam')
  assert.ok(shoreFoam(0.2, width, 1, 0, 0.05) > 0.2, 'a bank foams')
  assert.equal(
    shoreFoam(0.2, width, 1, 0, Infinity),
    shoreFoam(0.2, width, 1),
    'an omitted slope keeps the ungated result'
  )
  assert.ok(shoreFoam(0.3, width, 1, 0, 0.02) > shoreFoam(0.3, width, 1, 0, 0.008), 'foam rises with the bank')
  assert.ok(shoreFoam(0.3, width, 1, 0, 0.5) <= shoreFoam(0.3, width, 1) + 1e-12, 'a steep bank is not over-foamed')
})

test('shoreFoam: a band thinner than a pixel at range is dimmed, not a hard ring', () => {
  const width = 0.6
  // 12 m of shoreline depth per pixel at aerial range: the whole 0.6 m band is a tenth of a pixel
  // wide. Capping the ramp's widening (the old 0.35) still left a full-strength sub-pixel edge — the
  // hard white ring on the aerial terrain view. Dimming by pixel coverage removes it.
  const step = 12
  const lpp = step / width
  let peak = 0
  let worst = 0
  for (let d = 0; d <= 2 * width; d += step / 8) {
    const f = shoreFoam(d, width, 1, 0, Infinity, lpp)
    peak = Math.max(peak, f)
    worst = Math.max(worst, Math.abs(shoreFoam(d + step, width, 1, 0, Infinity, lpp) - f))
  }
  assert.ok(peak < 0.1, `a sub-pixel band is dimmed (peak ${peak.toFixed(3)})`)
  assert.ok(worst <= 0.5, `and never steps the full range (${worst.toFixed(3)})`)
})

test('shoreFoam: a band a few pixels wide keeps its strength and its edge', () => {
  const width = 0.6
  assert.equal(shoreFoam(0, width, 1, 0, Infinity, 1e-4), shoreFoam(0, width, 1), 'a crisp band is unchanged')
  const step = 3 // metres of depth per pixel at 2.5 km
  const f = (d: number) => shoreFoam(d, width, 1, 0, Infinity, step / width)
  assert.ok(f(0) > 0.2, 'a resolvable band keeps its strength')
  let worst = 0
  for (let d = 0; d <= 2 * width; d += step / 8) {
    worst = Math.max(worst, Math.abs(f(d + step) - f(d)))
  }
  assert.ok(worst <= 0.5, `no adjacent-pixel jump above half the range (${worst.toFixed(3)})`)
})

test('foamTrail: a crest leaves a fading trail, then no foam at all', () => {
  assert.equal(foamTrail(0.8, 0), 0.8, 'the current crest is not reduced')
  assert.equal(foamTrail(0, 1), 0.5, 'a crest one lifetime ago has faded')
  assert.ok(foamTrail(0, 1, 0.3) < foamTrail(0, 1, 0.5), 'the decay is configurable')
  assert.ok(foamTrail(0.9, 1) > foamTrail(0.4, 1), 'a strong current crest dominates a faded trail')
  assert.equal(foamTrail(0, 0), 0, 'past the lifetime there is no lagged sample and no foam')
})
