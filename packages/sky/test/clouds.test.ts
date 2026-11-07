import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cloudDensity, cloudPhase, cloudShape, coverageThreshold, sunTransmittance } from '../src/clouds.ts'

test('cloud shape: flat base that thins into a rounded top', () => {
  assert.equal(cloudShape(0), 0)
  assert.ok(cloudShape(0.03) > 0.5) // sharp base, not a soft fade
  assert.ok(cloudShape(0.5) > cloudShape(0.8))
  assert.ok(cloudShape(0.8) > cloudShape(0.95))
  assert.equal(cloudShape(1), 0)
})

test('cloud density falls with height and rises with coverage', () => {
  const n = 0.6
  const dense = coverageThreshold(0.8) // more coverage = lower threshold
  const sparse = coverageThreshold(0.2)
  assert.ok(dense < sparse)
  assert.ok(cloudDensity(n, dense, 0.2) > cloudDensity(n, sparse, 0.2))
  assert.ok(cloudDensity(n, dense, 0.2) > cloudDensity(n, dense, 0.7))
  assert.ok(cloudDensity(n, dense, 0.7) > cloudDensity(n, dense, 0.95))
  assert.equal(cloudDensity(0.3, dense, 0.2), 0) // clear sky
})

test('cloud phase peaks forward', () => {
  const forward = cloudPhase(1),
    side = cloudPhase(0),
    back = cloudPhase(-1)
  assert.ok(forward > side)
  assert.ok(side > back)
  assert.ok(forward > 10 * side)
})

test('sun transmittance falls from the top of the deck to its base', () => {
  const density = (h: number) => 0.2 + 0.8 * h
  const opts = { density, elevation: 0.6 }
  const low = shadow(0.05, opts)
  const mid = shadow(0.5, opts)
  const high = shadow(0.9, opts)
  assert.ok(high > mid && mid > low, 'higher in the cloud is brighter')
  assert.ok(high / low > 5, 'the base is visibly darker than the top')
})

test('the sun march spans the whole slab above the sample', () => {
  // Four taps from the base must reach the top: transmittance = exp(-extinction * depth).
  const depth = 2800,
    extinction = 0.0035
  const t = sunTransmittance(0, () => 1, { depth, extinction, taps: 4 })
  assert.ok(Math.abs(t - Math.exp(-extinction * depth)) < 1e-9)
})

/** Transmittance from fractional height `f`, normalised so the test reads in one place. */
function shadow(f: number, o: { density: (h: number) => number; elevation: number }): number {
  return sunTransmittance(f, o.density, { depth: 1200, extinction: 0.004, sunUp: o.elevation, taps: 4 })
}
