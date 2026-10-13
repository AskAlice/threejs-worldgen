import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SHOOTING_STARS, meteorsAt } from '../src/shooting-stars.ts'
import { DEFAULT_LIGHTING, computeLighting } from '../src/day-night.ts'
import { StarSystem } from '../src/bodies.ts'
import { observe } from '../src/observer.ts'
import { DEFAULT_ATMOSPHERE } from '../src/scattering.ts'
import { galacticMatrix, DEFAULT_MILKY_WAY } from '../src/milky-way.ts'
import { mulVec } from '../src/util.ts'
import { toSimTime } from '../src/time.ts'

test('meteor schedule is seeded, deterministic and matches the rate', () => {
  const o = { ...DEFAULT_SHOOTING_STARS, rate: 120 }
  let seen = 0
  const starts = new Set<number>()
  for (let t = 0; t < 3600; t += 0.1) for (const m of meteorsAt(o, t)) starts.add(m.start)
  seen = starts.size
  assert.ok(seen > 80 && seen < 160, `${seen} meteors in an hour at 120/h`)
  assert.deepEqual(meteorsAt(o, 1234.5), meteorsAt(o, 1234.5))
  const other = new Set<number>()
  for (let t = 0; t < 600; t += 0.1) for (const m of meteorsAt({ ...o, seed: 99 }, t)) other.add(m.start)
  assert.notDeepEqual([...starts].filter((s) => s < 600), [...other])
  for (let t = 0; t < 600; t += 0.5) for (const m of meteorsAt(o, t)) {
    const mid = [(m.from[0] + m.to[0]) / 2, (m.from[1] + m.to[1]) / 2, (m.from[2] + m.to[2]) / 2]
    assert.ok(mid[1] / Math.hypot(...mid) > Math.sin((o.minElevation - 1) * Math.PI / 180), 'above minElevation')
  }
})

test('shower meteors move away from the radiant', () => {
  const o = { ...DEFAULT_SHOOTING_STARS, rate: 0, shower: 600, radiant: [90, 45] as [number, number] }
  const r = [Math.cos(Math.PI / 4), Math.sin(Math.PI / 4), 0]
  let n = 0
  for (let t = 0; t < 600; t += 0.5) for (const m of meteorsAt(o, t)) {
    const a = Math.acos(m.from[0] * r[0] + m.from[1] * r[1] + m.from[2] * r[2]), b = Math.acos(m.to[0] * r[0] + m.to[1] * r[1] + m.to[2] * r[2])
    assert.ok(b > a, 'ends farther from the radiant than it starts')
    n++
  }
  assert.ok(n > 0)
})

test('lighting: bright warm-white noon, red low sun, dark night with stars out', () => {
  const s = new StarSystem()
  const at = (date: string) => observe(s, toSimTime(date), { frame: 'local', latitude: 45, longitude: 0, planetCenter: [0, 0, 0] }, [0, 2, 0])
  const ctx = { starTemperature: 5772, moonSkyIntensity: 0.02 }
  const noon = computeLighting(at('2026-06-21T12:00:00Z'), DEFAULT_ATMOSPHERE, DEFAULT_LIGHTING, ctx)
  assert.ok(noon.sunIntensity > 2.5 && noon.night === 0)
  assert.ok(noon.sunColor[0] >= noon.sunColor[2])
  const dusk = computeLighting(at('2026-06-21T19:30:00Z'), DEFAULT_ATMOSPHERE, DEFAULT_LIGHTING, ctx)
  assert.ok(dusk.sunColor[2] < 0.5 * dusk.sunColor[0], `dusk colour ${dusk.sunColor}`)
  const midnight = computeLighting(at('2026-06-22T00:00:00Z'), DEFAULT_ATMOSPHERE, DEFAULT_LIGHTING, ctx)
  assert.equal(midnight.sunIntensity, 0)
  assert.ok(midnight.night > 0.99 && midnight.skyLuminance < 1e-3 && midnight.exposure > noon.exposure)
  // Never pitch black: starlight/airglow fill stays on at night, whatever the moon does.
  assert.ok(midnight.ambientIntensity >= DEFAULT_LIGHTING.nightAmbient * 0.99, `night fill ${midnight.ambientIntensity}`)
})

test('galactic frame: pole and centre map to galactic axes', () => {
  const m = galacticMatrix(DEFAULT_MILKY_WAY)
  const l = DEFAULT_MILKY_WAY.pole[0] * Math.PI / 180, b = DEFAULT_MILKY_WAY.pole[1] * Math.PI / 180
  const pole = mulVec(m, [Math.cos(b) * Math.cos(l), Math.sin(b), -Math.cos(b) * Math.sin(l)])
  assert.ok(Math.abs(pole[1] - 1) < 1e-9)
})
