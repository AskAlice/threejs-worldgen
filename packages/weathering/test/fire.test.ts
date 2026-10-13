import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FireSim, FIRE_STATE, moistureDamping, type FireCellInfo, type FireInput, type FireLandscape } from '../src/fire-sim.ts'
import { Weather } from '../src/weather.ts'

const DAY = 86400
const grass = (f: (x: number, z: number, out: FireCellInfo) => void = () => {}): FireLandscape => ({
  cell(x, z, out) {
    Object.assign(out, { elevation: 0, firebreak: false, grass: 0.5, shrub: 0, tree: 0 })
    f(x, z, out)
    return out
  },
})
// Uniform landscapes: no patchy fuel or moisture unless a test asks for it.
const calm: FireInput = { size: 400, cellSize: 4, jitter: 0.3, fallback: { wind: [0, 0], moisture: 0.06 }, lightning: { enabled: false }, variation: { fuel: 0, moisture: 0 } }

// Burnt or burning extent from the ignition point along +x and −x.
function extent(sim: FireSim, dir: 1 | -1, z = 0): number {
  let far = 0
  for (let d = 0; d < 200; d += sim.options.cellSize) {
    const i = sim.index(d * dir, z)
    if (i >= 0 && sim.state[i] !== FIRE_STATE.unburnt) far = d
  }
  return far
}

test('wind drives the head fire downwind', () => {
  const sim = new FireSim({ ...calm, fallback: { wind: [8, 0], moisture: 0.06 } }, { landscape: grass() })
  sim.ignite(0, 0, 4)
  sim.runTo(120)
  const down = extent(sim, 1), up = extent(sim, -1)
  assert.ok(down > up * 2, `downwind ${down} m vs upwind ${up} m`)
})

test('fire runs uphill faster than downhill', () => {
  const sim = new FireSim(calm, { landscape: grass((x, _z, out) => { out.elevation = x * 0.4 }) })
  sim.ignite(0, 0, 4)
  sim.runTo(150)
  const uphill = extent(sim, 1), downhill = extent(sim, -1)
  assert.ok(uphill > downhill * 1.5, `uphill ${uphill} m vs downhill ${downhill} m`)
})

test('fire never crosses water, rock or firebreak lines', () => {
  const sim = new FireSim(
    { ...calm, fallback: { wind: [10, 0], moisture: 0.04 }, firebreaks: { lines: [{ points: [[-200, 60], [200, 60]], width: 8 }] } },
    { landscape: grass((x, _z, out) => { out.firebreak = x > 40 && x < 52 }) }, // a river at x = 40…52
  )
  sim.ignite(0, 0, 4)
  sim.runTo(3600)
  for (let i = 0; i < sim.state.length; i++) {
    const [x, z] = sim.center(i)
    if (x > 52 || z > 64) assert.equal(sim.state[i], FIRE_STATE.unburnt, `burnt at ${x}, ${z}`)
  }
  assert.ok(extent(sim, 1) >= 36, 'it reached the river')
})

test('wet fuel does not burn', () => {
  assert.equal(moistureDamping(1), 0)
  assert.equal(moistureDamping(0), 1)
  const sim = new FireSim({ ...calm, fallback: { wind: [0, 0], moisture: 0.35 } }, { landscape: grass() })
  sim.ignite(0, 0, 4)
  sim.runTo(600)
  assert.equal(sim.stats.burning + sim.stats.burnt, 0)
})

test('fuel is conserved: what is left = what was there − consumed + regrown', () => {
  const sim = new FireSim({ ...calm, fallback: { wind: [4, 1], moisture: 0.06 } }, { landscape: grass((x, z, out) => { out.tree = x > 0 ? 3 : 0; out.shrub = z > 0 ? 0.8 : 0 }) })
  const before = sim.stats.fuel
  sim.ignite(0, 0, 8)
  for (const t of [60, 600, 1800, DAY, 40 * DAY]) {
    sim.runTo(t)
    const s = sim.stats
    assert.ok(s.consumed > 0)
    const now = sim.totalFuel()
    assert.ok(Math.abs(now - (before - s.consumed + s.regrown)) < before * 1e-4, `at ${t}: ${now} vs ${before - s.consumed + s.regrown}`)
    assert.ok(s.fuel < before)
  }
})

test('deterministic: same seed same fire, however time is chunked or scrubbed', () => {
  const make = () => new FireSim({ ...calm, seed: 'det', fallback: { wind: [5, 2], moisture: 0.07 } }, { landscape: grass() })
  const a = make(), b = make(), c = make(), d = make()
  for (const s of [a, b, c, d]) s.ignite(10, -6, 6, 20)
  a.runTo(200)
  for (let t = 0; t <= 200; t += 37) b.runTo(t)
  b.runTo(200)
  c.runTo(1500)
  c.runTo(200) // scrubbed back: replays
  let calls = 0
  while (d.time < 200) { d.runTo(200, 0); calls++ } // zero budget: one tick per call, catching up
  assert.ok(calls > 1)
  assert.deepEqual(b.state, a.state)
  assert.deepEqual(c.state, a.state)
  assert.deepEqual(d.state, a.state)
  assert.deepEqual(b.fuel, a.fuel)
  assert.deepEqual(d.fuel, a.fuel)
  const other = new FireSim({ ...calm, seed: 'other', fallback: { wind: [5, 2], moisture: 0.07 } }, { landscape: grass() })
  other.ignite(10, -6, 6, 20)
  other.runTo(200)
  assert.notDeepEqual(other.state, a.state)
})

test('regrowth: grass returns in weeks, trees take decades, then the land can burn again', () => {
  const sim = new FireSim({ ...calm, size: 80 }, { landscape: grass((_x, _z, out) => { out.tree = 2 }) })
  sim.ignite(0, 0, 60)
  sim.runTo(DAY)
  const i = sim.index(0, 0)
  assert.equal(sim.state[i], FIRE_STATE.burnt)
  assert.ok(sim.scar(i) > 0.9)
  sim.runTo(60 * DAY)
  assert.equal(sim.state[i], FIRE_STATE.regrowing)
  const g = sim.regrowthAt(0, 0)
  assert.ok(g.grass > 0.99 && g.tree < 0.5, JSON.stringify(g)) // only the unburnt trunks (residual fuel) are left
  assert.ok(sim.scar(i) < 0.9)
  sim.runTo(21 * 365 * DAY)
  assert.equal(sim.state[i], FIRE_STATE.unburnt)
  assert.ok(Math.abs(sim.totalFuel() - (80 / 4) ** 2 * 16 * 2.5) < 1)
})

test('lightning from the weather starts fires deterministically', () => {
  const weather = new Weather({ seed: 'dry storm', climate: { temperature: 30, moisture: 0.6 }, storms: { chance: 1, lightning: 30, rain: 0 }, precipitation: { maxRate: 0 } })
  const run = () => {
    const sim = new FireSim({ size: 4000, cellSize: 50, tick: 10, lightning: { chance: 1 }, moistureOfExtinction: 0.9 }, { landscape: grass(), weather })
    sim.runTo(2 * 3600)
    return sim
  }
  const a = run()
  assert.ok(a.stats.consumed > 0, 'a strike started a fire')
  assert.deepEqual(run().state, a.state)
})
