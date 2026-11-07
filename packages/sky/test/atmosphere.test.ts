import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEG } from '../src/util.ts'
import {
  DEFAULT_ATMOSPHERE,
  densityAt,
  luminance,
  skyRadiance,
  sunDisc,
  transmittance,
  type AtmosphereOptions
} from '../src/scattering.ts'

const R = 6.371e6
const SUN_RADIUS = 0.00465 // the sun's angular radius, radians (≈ 0.27°)
const DEGREE = Math.PI / 180

const sunAt = (elevation: number): [number, number, number] => [
  0,
  Math.sin(elevation * DEGREE),
  Math.cos(elevation * DEGREE)
]

/** Ray-marched sky seen from `altitude` metres, `down` radians below the local horizontal. */
function sky(altitude: number, elevation: number, a: AtmosphereOptions = DEFAULT_ATMOSPHERE) {
  const d: [number, number, number] = [0, Math.sin(elevation * DEGREE), Math.cos(elevation * DEGREE)]
  return skyRadiance(a, R, [0, R + altitude, 0], d, sunAt(40))
}

test('density profile: exponential air and haze, a tent-shaped ozone layer', () => {
  const a = DEFAULT_ATMOSPHERE
  const at = (h: number) => densityAt(a, h)
  assert.equal(at(0)[0], 1) // sea level, density 1
  assert.ok(Math.abs(at(a.rayleighScaleHeight)[0] - Math.exp(-1)) < 1e-12)
  assert.ok(at(3 * a.rayleighScaleHeight)[0] < at(2 * a.rayleighScaleHeight)[0])
  // Haze is thinner than air: it falls away faster with height.
  assert.ok(at(5000)[1] < at(5000)[0])
  assert.ok(at(5000)[1] / at(0)[1] < at(5000)[0] / at(0)[0])
  // Ozone peaks at its centre altitude and is gone at centre ± width.
  assert.ok(Math.abs(at(a.ozoneCenter)[2] - 1) < 1e-12)
  assert.equal(at(a.ozoneCenter + a.ozoneWidth)[2], 0)
  assert.equal(at(0)[2], 0)
  // The density multiplier scales every species; 0 is airless.
  const thin = densityAt({ ...a, density: 0.5 }, 0)
  assert.deepEqual([at(0)[0] * 0.5, at(0)[1] * 0.5], [thin[0], thin[1]])
  assert.deepEqual(densityAt({ ...a, density: 0 }, 0), [0, 0, 0])
})

test('sun disc: full coverage inside the limb, none outside, limb darkening at the edge', () => {
  const centre = sunDisc(0, SUN_RADIUS)
  assert.equal(centre.coverage, 1)
  assert.equal(centre.limb, 1)
  // Real angular size: about 0.53° across, so the disc is present but small.
  assert.ok(Math.abs(2 * SUN_RADIUS - 0.533 * DEG) < 0.02 * DEG)
  assert.equal(sunDisc(SUN_RADIUS * 0.99, SUN_RADIUS).coverage, 1)
  assert.equal(sunDisc(SUN_RADIUS * 1.01, SUN_RADIUS).coverage, 0)
  assert.ok(sunDisc(SUN_RADIUS * 0.99, SUN_RADIUS).limb < 0.6, 'limb darkening towards the edge')
  // Anti-aliasing: at the limb, a soft edge is half covered.
  assert.ok(Math.abs(sunDisc(SUN_RADIUS, SUN_RADIUS, SUN_RADIUS * 0.1).coverage - 0.5) < 1e-9)
  // Past the disc it only dims, never brightens.
  let previous = Infinity
  for (let x = 0; x <= 2 * SUN_RADIUS; x += SUN_RADIUS / 8) {
    const limb = sunDisc(x, SUN_RADIUS).limb
    assert.ok(limb <= previous + 1e-12, `limb rose at ${x}`)
    previous = limb
  }
})

test('atmosphere grades to space from 10 km to the Kármán line, with a lit limb', () => {
  const sea = sky(0, 90)
  const ten = sky(10e3, 90)
  const hundred = sky(100e3, 90)
  assert.ok(sea[2] > sea[0], 'zenith is blue at sea level')
  const seaL = luminance(sea)
  assert.ok(luminance(ten) < seaL * 0.5 && luminance(ten) > seaL * 0.1, `10 km zenith ${luminance(ten)}`)
  assert.ok(luminance(hundred) <= 1e-6, `100 km zenith ${luminance(hundred)} is space`)
  // From 100 km the horizon has dipped ~10°; a ray just above it crosses the dense limb and glows.
  const dip = Math.acos(R / (R + 100e3)) / DEGREE
  const limb = sky(100e3, -(dip - 0.5))
  assert.ok(luminance(limb) > seaL, `limb ${luminance(limb)}`)
  // No hard terminator: the limb fades smoothly away from the horizon, with no step between elevations.
  let previous = luminance(sky(100e3, -(dip - 0.1)))
  assert.ok(previous > luminance(limb))
  for (let e = dip - 0.35; e > dip - 5; e -= 0.25) {
    const l = luminance(sky(100e3, -e))
    assert.ok(l > 0 && l < previous, `fades away from the horizon at ${e.toFixed(2)}°`)
    assert.ok(previous / l < 3, `hard edge at ${e.toFixed(2)}° (${previous} → ${l})`)
    previous = l
  }
})

test('sun disc is visible from the ground but blocked through the planet', () => {
  const a = DEFAULT_ATMOSPHERE
  const o: [number, number, number] = [0, R + 2, 0]
  const toSun = transmittance(a, R, o, sunAt(40))
  const throughPlanet = transmittance(a, R, o, sunAt(-40))
  assert.ok(Math.min(...toSun) > 0.5, `sunlight reaches the ground: ${toSun}`)
  assert.deepEqual(throughPlanet, [0, 0, 0])
})
