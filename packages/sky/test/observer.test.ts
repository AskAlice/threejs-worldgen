import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StarSystem } from '../src/bodies.ts'
import { moonPhase, observe, sunTimes, type ObserverOptions } from '../src/observer.ts'
import { DEFAULT_ATMOSPHERE, skyRadiance, transmittance } from '../src/scattering.ts'
import { toSimTime } from '../src/time.ts'

const at = (latitude: number, longitude: number): ObserverOptions => ({ frame: 'local', latitude, longitude, planetCenter: [0, 0, 0] })

test('moon phase: new, full and quarter geometry', () => {
  const sun: [number, number, number] = [1.5e11, 0, 0], obs: [number, number, number] = [0, 0, 0]
  const fresh = moonPhase(sun, [3.8e8, 0, 0], obs)
  assert.ok(fresh.illumination < 1e-9 && Math.abs(fresh.phaseAngle - 180) < 1e-6)
  assert.ok(fresh.cycle < 1e-9 || fresh.cycle > 1 - 1e-9)
  const full = moonPhase(sun, [-3.8e8, 0, 0], obs)
  assert.ok(full.illumination > 1 - 1e-9 && full.phaseAngle < 1e-6 && Math.abs(full.cycle - 0.5) < 1e-9)
  const quarter = moonPhase(sun, [0, 0, -3.8e8], obs) // 90° east of the sun in ecliptic longitude
  assert.ok(Math.abs(quarter.illumination - 0.5) < 0.01 && Math.abs(quarter.cycle - 0.25) < 0.01)
})

test('real moon phases emerge from the default orbits', () => {
  const s = new StarSystem()
  const full = observe(s, toSimTime('2024-01-25T17:54:00Z'), at(51.5, 0))
  const fresh = observe(s, toSimTime('2024-01-11T11:57:00Z'), at(51.5, 0))
  assert.ok(full.moonIllumination > 0.95, `full moon lit ${full.moonIllumination}`)
  assert.ok(fresh.moonIllumination < 0.05, `new moon lit ${fresh.moonIllumination}`)
  assert.ok(full.moonAngularRadius > 0.0042 && full.moonAngularRadius < 0.0049)
})

test('sun on the meridian near noon UTC at longitude 0, and the solstice sun is high in the north', () => {
  const s = new StarSystem()
  const st = observe(s, toSimTime('2026-06-21T12:00:00Z'), at(45, 0))
  assert.ok(Math.abs(st.solarTime - 12) < 0.1, `solar time ${st.solarTime}`)
  assert.ok(Math.abs(st.sunElevation - (90 - 45 + 23.44)) < 0.3, `elevation ${st.sunElevation}`)
  assert.ok(Math.abs(st.sunAzimuth - 180) < 2, `azimuth ${st.sunAzimuth}`)
  const winter = observe(s, toSimTime('2026-12-21T12:00:00Z'), at(45, 0))
  assert.ok(Math.abs(winter.sunElevation - (90 - 45 - 23.44)) < 0.3)
})

test('sunrise and sunset: 12 h + refraction at the equator of an untilted planet', () => {
  const s = new StarSystem({ home: { axialTilt: 0, orbit: { eccentricity: 0 } }, moon: null, planets: 0 })
  const day = s.solarDay()
  const { sunrise, sunset } = sunTimes(s, 0, 0, 0)
  assert.ok(sunrise !== null && sunset !== null)
  let len = (sunset! - sunrise!) % day
  if (len < 0) len += day
  const expected = day / 2 + (2 * 0.833 / 360) * day
  assert.ok(Math.abs(len - expected) < 2, `day length ${len} vs ${expected}`)
})

test('sunrise and sunset: about 15 h 37 min of daylight at 45° N on the June solstice', () => {
  const s = new StarSystem()
  const { sunrise, sunset } = sunTimes(s, toSimTime('2026-06-21T00:00:00Z'), 45, 0)
  const hours = (sunset! - sunrise!) / 3600
  assert.ok(Math.abs(hours - 15.62) < 0.05, `daylight ${hours} h`)
})

test('scattering: blue zenith, red low sun, nothing through the planet', () => {
  const a = DEFAULT_ATMOSPHERE, R = 6.371e6
  const o: [number, number, number] = [0, R + 2, 0]
  const zenith = skyRadiance(a, R, o, [0, 1, 0], [0.5, Math.sqrt(0.75), 0])
  assert.ok(zenith[2] > zenith[1] && zenith[1] > zenith[0], `zenith ${zenith}`)
  const low = transmittance(a, R, o, [Math.cos(0.03), Math.sin(0.03), 0])
  assert.ok(low[0] > low[2] * 3, `low sun ${low}`)
  assert.deepEqual(transmittance(a, R, o, [0, -1, 0]), [0, 0, 0])
})
