import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SHELLS, formatAltitude, resolveShells } from '../src/shells.ts'
import { DEFAULT_LAYERS, EARTH_RADIUS, clipPlanes } from '../src/layers.ts'
import { StarSystem } from '../src/bodies.ts'

test('shells: troposphere, ionosphere, Kármán line and the moon apogee resolve to altitudes', () => {
  const sys = new StarSystem()
  const [tropo, karman, iono, apogee] = resolveShells(DEFAULT_SHELLS.shells, DEFAULT_LAYERS, sys)
  assert.deepEqual([tropo.label, tropo.altitude], ['Troposphere', 12_000])
  assert.equal(iono.altitude, 300_000)
  assert.equal(karman.altitude, 100_000)
  // The Moon's apogee is ~405 500 km from Earth's centre.
  assert.ok(Math.abs(apogee.altitude + sys.home.radius - 405_500e3) < 3_000e3, `apogee ${apogee.altitude}`)
  // Numeric altitudes scale with the atmosphere; layer names come pre-scaled.
  assert.equal(resolveShells([{ label: 'x', altitude: 300_000, color: '#ffffff' }], DEFAULT_LAYERS, sys, 0.5)[0].altitude, 150_000)
  // No moon: no apogee shell.
  assert.equal(resolveShells(DEFAULT_SHELLS.shells, DEFAULT_LAYERS, new StarSystem({ moon: null })).length, 3)
  assert.equal(formatAltitude(100_000), '100 km')
  assert.equal(formatAltitude(399_000_000), '399 000 km')
})

test('clip planes span an ant on the ground to the moon', () => {
  const [antNear, antFar] = clipPlanes(0.005, EARTH_RADIUS)
  assert.ok(antNear <= 0.001 && antFar > 1e6, `${antNear} ${antFar}`) // tiny near, still sees the horizon sky
  const [orbitNear, orbitFar] = clipPlanes(400_000, EARTH_RADIUS)
  assert.ok(orbitNear > 1000 && orbitNear < 400_000 && orbitFar > 2 * 400_000)
  const [, moonFar] = clipPlanes(400_000, EARTH_RADIUS, 100_000, 405_000e3)
  assert.ok(moonFar > 405_000e3)
})
