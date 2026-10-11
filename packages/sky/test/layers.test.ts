import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LAYERS, layerAt, resolveAtmosphere, inSpace } from '../src/layers.ts'
import { DEFAULT_ATMOSPHERE, skyRadiance } from '../src/scattering.ts'
import { apsides, orbitState, type OrbitalElements } from '../src/kepler.ts'
import { StarSystem } from '../src/bodies.ts'
import { DEFAULT_CLOUDS, cloudCover } from '../src/clouds.ts'

test('layers: altitudes map to the right layer and the Kármán line is space', () => {
  assert.equal(layerAt(-1), 'ground')
  assert.equal(layerAt(2000), 'troposphere')
  assert.equal(layerAt(30_000), 'stratosphere')
  assert.equal(layerAt(70_000), 'mesosphere')
  assert.equal(layerAt(400_000), 'thermosphere')
  assert.equal(layerAt(36_000_000), 'space')
  assert.ok(!inSpace(99_000) && inSpace(100_000))
})

test('layers scale with the planet radius and keep the sky colour', () => {
  const R = 120_000
  const a = resolveAtmosphere(DEFAULT_ATMOSPHERE, R)
  assert.ok(Math.abs(a.layers.karman - DEFAULT_LAYERS.karman * (R / 6.371e6)) < 1e-6)
  const big = skyRadiance(DEFAULT_ATMOSPHERE, 6.371e6, [0, 6.371e6 + 1, 0], [0, 1, 0], [0.5, Math.sqrt(0.75), 0])
  const small = skyRadiance(a, R, [0, R + 1, 0], [0, 1, 0], [0.5, Math.sqrt(0.75), 0])
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(small[c] / big[c] - 1) < 0.05, `channel ${c}: ${small[c]} vs ${big[c]}`)
  assert.equal(resolveAtmosphere({ ...DEFAULT_ATMOSPHERE, scaleWithRadius: false }, R).height, DEFAULT_ATMOSPHERE.height)
})

test('apsides: distances, positions and passage times', () => {
  const GM = 3.986e14
  const el: OrbitalElements = { semiMajorAxis: 3.844e8, eccentricity: 0.0549, inclination: 5.1, longitudeOfAscendingNode: 125, argumentOfPeriapsis: 318, meanAnomalyAtEpoch: 135, period: 0 }
  const a = apsides(el, GM, 1e6)
  assert.ok(Math.abs(a.periapsis - 3.844e8 * (1 - 0.0549)) < 1e-3)
  assert.ok(Math.abs(Math.hypot(...a.apoapsisPosition) - a.apoapsis) < 1e-3)
  const atPeri = orbitState(el, GM, a.nextPeriapsis).position, atApo = orbitState(el, GM, a.nextApoapsis).position
  assert.ok(Math.hypot(atPeri[0] - a.periapsisPosition[0], atPeri[1] - a.periapsisPosition[1], atPeri[2] - a.periapsisPosition[2]) < 1)
  assert.ok(Math.abs(Math.hypot(...atApo) - a.apoapsis) < 1)
  assert.ok(a.nextPeriapsis >= 1e6 && a.nextApoapsis >= 1e6)
  const moon = new StarSystem().apsides('moon')!
  assert.deepEqual(moon.names, ['perigee', 'apogee'])
  assert.deepEqual(new StarSystem().apsides('home')!.names, ['perihelion', 'aphelion'])
})

test('cloud cover: deterministic, seeded, and tracks the coverage setting', () => {
  const frac = (coverage: number) => {
    let n = 0, k = 0
    for (let x = 0; x < 400; x++) for (let z = 0; z < 40; z++) { n++; k += cloudCover({ ...DEFAULT_CLOUDS, coverage }, 7, [x * 3000, 6.371e6, z * 3000]) > 0.5 ? 1 : 0 }
    return k / n
  }
  assert.equal(cloudCover(DEFAULT_CLOUDS, 7, [1, 2, 3]), cloudCover(DEFAULT_CLOUDS, 7, [1, 2, 3]))
  const field = (seed: number) => Array.from({ length: 50 }, (_, i) => cloudCover(DEFAULT_CLOUDS, seed, [i * 7000, 6.371e6, 0]))
  assert.notDeepEqual(field(7), field(8))
  const lo = frac(0.15), mid = frac(0.4), hi = frac(0.8)
  assert.ok(lo < mid && mid < hi, `${lo} ${mid} ${hi}`)
  assert.ok(Math.abs(mid - 0.4) < 0.2, `coverage 0.4 gives ${mid}`)
})
