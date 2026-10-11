import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orbitState, orbitalPeriod, solveKepler, type OrbitalElements } from '../src/kepler.ts'
import { StarSystem } from '../src/bodies.ts'
import { SkyClock, toSimTime } from '../src/time.ts'

const GM = 1.32712440018e20
const el = (e: number, extra: Partial<OrbitalElements> = {}): OrbitalElements => ({
  semiMajorAxis: 1.5e11, eccentricity: e, inclination: 12, longitudeOfAscendingNode: 40, argumentOfPeriapsis: 75, meanAnomalyAtEpoch: 10, period: 0, ...extra,
})

test('Kepler solver satisfies M = E - e sin E for e up to 0.99', () => {
  for (const e of [0, 0.01, 0.3, 0.7, 0.9, 0.97, 0.99]) {
    for (let M = -20; M <= 20; M += 0.0137) {
      const E = solveKepler(M, e)
      assert.ok(Math.abs(E - e * Math.sin(E) - M) < 1e-11, `e=${e} M=${M} residual ${E - e * Math.sin(E) - M}`)
    }
  }
})

test('orbit is periodic', () => {
  for (const e of [0, 0.2, 0.9]) {
    const P = orbitalPeriod(1.5e11, GM)
    const a = orbitState(el(e), GM, 1.234e6), b = orbitState(el(e), GM, 1.234e6 + 3 * P)
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(a.position[k] - b.position[k]) < 1e-6 * 1.5e11)
      assert.ok(Math.abs(a.velocity[k] - b.velocity[k]) < 1e-6 * 3e4)
    }
  }
})

test('analytic orbit conserves energy and angular momentum', () => {
  for (const e of [0, 0.3, 0.97]) {
    const o = el(e)
    const expectedEnergy = -GM / (2 * o.semiMajorAxis)
    let h0: number[] | null = null
    for (let t = 0; t < 4e7; t += 1.37e6) {
      const { position: r, velocity: v } = orbitState(o, GM, t)
      const energy = (v[0] ** 2 + v[1] ** 2 + v[2] ** 2) / 2 - GM / Math.hypot(...r)
      assert.ok(Math.abs(energy / expectedEnergy - 1) < 1e-9, `energy drift at e=${e}`)
      const h = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]]
      h0 ??= h
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(h[k] - h0[k]) < 1e-9 * Math.hypot(...h0), `angular momentum drift at e=${e}`)
    }
  }
})

test('inclined orbit: angular momentum tilts by the inclination', () => {
  const { position: r, velocity: v } = orbitState(el(0.1, { inclination: 30 }), GM, 5e6)
  const h = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]]
  const tilt = Math.acos(h[1] / Math.hypot(...h)) * 180 / Math.PI // +Y is ecliptic north
  assert.ok(Math.abs(tilt - 30) < 1e-9)
})

test('default home planet: a year of ~365.25 days and a 24 h solar day', () => {
  const s = new StarSystem()
  assert.ok(Math.abs(s.period('home') / 86400 - 365.256) < 0.01)
  assert.ok(Math.abs(s.solarDay() - 86400) < 5)
  // Synodic month (new moon to new moon) ≈ 29.53 days.
  assert.ok(Math.abs(s.solarDay('moon') / 86400 - 29.53) < 0.05)
})

test('procedural planets are seeded and deterministic', () => {
  const a = new StarSystem({ seed: 'abc', planets: 6 }), b = new StarSystem({ seed: 'abc', planets: 6 }), c = new StarSystem({ seed: 'xyz', planets: 6 })
  assert.equal(a.bodies.length, 9)
  assert.deepEqual(a.bodies, b.bodies)
  assert.notDeepEqual(a.bodies.map((x) => x.orbit?.semiMajorAxis), c.bodies.map((x) => x.orbit?.semiMajorAxis))
  for (const p of a.bodies.slice(3)) assert.ok(Math.abs(p.orbit!.semiMajorAxis / 1.496e11 - 1) > 0.2, 'clear of the home orbit')
})

test('clock: time scale, pause, day length and date jumps', () => {
  const c = new SkyClock({ date: '2026-01-01T00:00:00Z', timeScale: 60 })
  const t0 = c.time
  c.update(0.1)
  assert.equal(c.time - t0, 6)
  c.set({ paused: true }); c.update(0.1)
  assert.equal(c.time - t0, 6)
  c.set({ paused: false, dayLength: 864 }); c.update(0.1) // 86400 s in 864 s → ×100
  assert.ok(Math.abs(c.time - t0 - 16) < 1e-9)
  c.reset({ date: '2026-01-01T00:00:00Z', dayLength: 864 }) // same date: no jump
  assert.ok(Math.abs(c.time - t0 - 16) < 1e-9)
  c.set({ date: '2026-01-02T00:00:00Z' })
  assert.equal(c.time, toSimTime('2026-01-02T00:00:00Z'))
})
