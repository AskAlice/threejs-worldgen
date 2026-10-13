import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FireSim, FIRE_STATE, lengthToBreadth, type FireCellInfo, type FireLandscape } from '../src/fire-sim.ts'
import { collectFireSources, createFireSources, frontIntensity, plumeOcclusion, smokeTransmittance } from '../src/fire-front.ts'

const S = 8 // SOURCE_STRIDE
const LOOK = { flaming: 25, crownHeight: 10, linger: 240, frontGlow: 0.9, smoulderGlow: 0.35 }
const land = (tree = 0): FireLandscape => ({
  cell(_x, _z, out: FireCellInfo) {
    return Object.assign(out, { elevation: 0, firebreak: false, grass: 0.5, shrub: 0, tree })
  },
})
const burning = (load = 0) => {
  const sim = new FireSim({ size: 400, cellSize: 8, fallback: { wind: [0, 0], moisture: 0.05 }, residence: 600, variation: { fuel: 0, moisture: 0 } }, { landscape: land(load) })
  sim.ignite(0, 0, 8, 0)
  sim.runTo(240)
  return sim
}

test('front intensity: a short flaming phase right after ignition, longer for heavy fuel', () => {
  assert.equal(frontIntensity(Infinity, 1, 40), 0)
  assert.ok(frontIntensity(5, 1, 40) > frontIntensity(120, 1, 40) * 5)
  assert.ok(frontIntensity(120, 4, 40) > frontIntensity(120, 0.4, 40))
})

test('flames and embers come only from the active front, not the burning interior', () => {
  const sim = burning()
  const s = collectFireSources(sim, LOOK, createFireSources(sim.cols * sim.rows))
  assert.ok(s.flameCount > 10)
  // Every burning cell vs the cells feeding flames: the flames sit on the outer ring.
  let maxR = 0, burningCells = 0
  for (let i = 0; i < sim.cols * sim.rows; i++) {
    if (sim.state[i] !== FIRE_STATE.burning) continue
    burningCells++
    const [x, z] = sim.center(i)
    maxR = Math.max(maxR, Math.hypot(x, z))
  }
  assert.ok(s.flameCount < burningCells * 0.75, `${s.flameCount} flame cells of ${burningCells} burning`)
  let weighted = 0, total = 0
  for (let k = 0; k < s.flameCount; k++) {
    const x = s.flames[k * S] + sim.minX, z = s.flames[k * S + 2] + sim.minZ, w = s.flames[k * S + 3]
    weighted += Math.hypot(x, z) * w
    total += w
  }
  assert.ok(weighted / total > maxR * 0.7, `flames at mean radius ${(weighted / total).toFixed(0)} of ${maxR.toFixed(0)}`)
  // The ground glow is a band at the front: the ignition point has gone dark.
  const centre = sim.index(0, 0)
  assert.ok(s.texture[centre * 4] < 0.4 * 255, `centre glow ${s.texture[centre * 4]}`)
  assert.equal(s.emberCount, s.flameCount)
})

test('smoke: darker and taller over forest than grass, wisps from the burnt interior', () => {
  const grass = burning(0), forest = burning(2)
  const g = collectFireSources(grass, LOOK, createFireSources(grass.cols * grass.rows))
  const f = collectFireSources(forest, LOOK, createFireSources(forest.cols * forest.rows))
  const meanTint = (s: typeof g) => {
    let t = 0, w = 0
    for (let k = 0; k < s.smokeCount; k++) { t += s.smoke[k * S + 6] * s.smoke[k * S + 3]; w += s.smoke[k * S + 3] }
    return t / w
  }
  assert.ok(meanTint(f) > meanTint(g) + 0.3, `forest tint ${meanTint(f)} vs grass ${meanTint(g)}`)
  assert.ok(f.smokeTotal > g.smokeTotal)
  // Crown fire: tree flames are lifted and bigger.
  assert.ok(f.flames[5] > 5 && f.flames[4] > g.flames[4])
})

test('deterministic: the same sim state gives the same sources', () => {
  const a = collectFireSources(burning(), LOOK, createFireSources(0))
  const b = collectFireSources(burning(), LOOK, createFireSources(0))
  assert.equal(a.flameCount, b.flameCount)
  assert.deepEqual(a.flames.subarray(0, a.flameCount * S), b.flames.subarray(0, b.flameCount * S))
  assert.deepEqual(a.texture, b.texture)
})

test('plume occlusion: downwind, widening, and reddening the sun', () => {
  const at = (x: number, z: number) => plumeOcclusion(x, z, 0, 0, 5, 0, 1000)
  assert.ok(at(1000, 0) > at(-1000, 0) * 10)
  assert.ok(at(1000, 0) > at(1000, 400))
  assert.ok(at(3000, 300) > 0.01 && at(3000, 300) < at(500, 0))
  assert.equal(plumeOcclusion(0, 0, 0, 0, 5, 0, 0), 0)
  const [r, g, b] = smokeTransmittance(0.5)
  assert.ok(r > g && g > b)
  assert.ok(Math.abs(g - 0.5) < 1e-9)
})

test('wind makes an elongated ellipse (Anderson L/B), patchy fuel keeps it deterministic', () => {
  assert.equal(lengthToBreadth(0), 1)
  assert.ok(lengthToBreadth(2) > 2 && lengthToBreadth(2) < 3.5, `${lengthToBreadth(2)}`)
  assert.equal(lengthToBreadth(20), 8)
  const run = () => {
    const sim = new FireSim({ size: 600, cellSize: 8, fallback: { wind: [8, 0], moisture: 0.05 }, residence: 600 }, { landscape: land(0) })
    sim.ignite(0, 0, 8, 0)
    sim.runTo(240)
    return sim
  }
  const sim = run()
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity
  for (let i = 0; i < sim.cols * sim.rows; i++) {
    if (sim.state[i] === FIRE_STATE.unburnt) continue
    const [x, z] = sim.center(i)
    minx = Math.min(minx, x); maxx = Math.max(maxx, x); minz = Math.min(minz, z); maxz = Math.max(maxz, z)
  }
  assert.ok((maxx - minx) > 1.7 * (maxz - minz), // the 8-neighbour grid rounds the flanks (~2 for a theoretical 2.9)
    `length ${maxx - minx} m vs breadth ${maxz - minz} m`)
  assert.ok(maxx > -minx * 5, 'the head runs, the backing fire crawls')
  assert.deepEqual(run().state, sim.state)
})
