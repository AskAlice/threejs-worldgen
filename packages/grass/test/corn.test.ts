import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Object3D, PerspectiveCamera } from 'three/webgpu'
import { Corn, FlattenMap, PLANT_STRIDE, createCanopyGeometry, createCornGeometry, plantRows, pointInPolygon, type CornField } from '../src/index.ts'

// An L-shaped (concave) field with rows at 30°.
const L: CornField = { polygon: [[0, 0], [40, 0], [40, 15], [15, 15], [15, 40], [0, 40]], rowDirection: Math.PI / 6, rowSpacing: 0.76 }
const opts = { plantSpacing: 0.18, seed: 7 }

const plants = (a: Float32Array) => Array.from({ length: a.length / PLANT_STRIDE }, (_, i) => Array.from(a.subarray(i * PLANT_STRIDE, (i + 1) * PLANT_STRIDE)))

test('rows: every plant is inside the field polygon, on the row lattice', () => {
  const out = plantRows([L], -10, -10, 50, 50, opts)
  const n = out.length / PLANT_STRIDE
  // ~ area / (row spacing × plant spacing), less the gaps.
  const area = 40 * 15 + 15 * 25
  assert.ok(n > (area / (0.76 * 0.18)) * 0.9 && n < (area / (0.76 * 0.18)) * 1.02, `plant count ${n}`)
  const bx = -Math.sin(L.rowDirection), bz = Math.cos(L.rowDirection)
  const v0 = L.polygon[0][0] * bx + L.polygon[0][1] * bz
  for (const [x, z] of plants(out)) {
    assert.ok(pointInPolygon(L.polygon, x, z), `(${x}, ${z}) inside`)
    assert.ok(!(x > 15.01 && z > 15.01), `(${x}, ${z}) not in the notch`)
    // Across-row position is (k + 0.5) row spacings from the first vertex, give or take 2 cm.
    const rows = (x * bx + z * bz - v0) / L.rowSpacing
    assert.ok(Math.abs(rows - Math.floor(rows) - 0.5) < 0.03, `row offset ${rows}`)
  }
})

test('rows: chunks stitch exactly (each plant in exactly one chunk)', () => {
  const whole = plants(plantRows([L], 0, 0, 40, 40, opts)).map((p) => p.join()).sort()
  const parts = [[0, 0], [16, 0], [32, 0], [0, 16], [16, 16], [32, 16], [0, 32], [16, 32], [32, 32]]
    .flatMap(([x, z]) => plants(plantRows([L], x, z, x + 16, z + 16, opts)).map((p) => p.join())).sort()
  assert.deepEqual(parts, whole)
})

test('rows: deterministic from the seed, sorted by rank', () => {
  const a = plantRows([L], 0, 0, 20, 20, opts)
  assert.deepEqual(a, plantRows([L], 0, 0, 20, 20, opts))
  assert.notDeepEqual(a, plantRows([L], 0, 0, 20, 20, { ...opts, seed: 8 }))
  const ranks = plants(a).map((p) => p[4])
  for (let i = 1; i < ranks.length; i++) assert.ok(ranks[i] >= ranks[i - 1])
  // A rank prefix is an even thinning: the first quarter of the plants spreads over the whole chunk.
  const quarter = plants(a).slice(0, ranks.length / 4)
  const west = quarter.filter(([x]) => x < 10).length
  assert.ok(Math.abs(west / quarter.length - 0.5) < 0.1)
})

test('flatten map: a stamp flattens exactly its radius, falling along the travel direction', () => {
  const map = new FlattenMap(-10, -10, 10, 10, 0.1)
  map.stamp(0, 0, 1.5, 1, 0)
  // Flat out to a texel inside the radius, standing from a texel outside it (the rim is antialiased).
  assert.equal(map.sample(0, 0), 1)
  assert.equal(map.sample(1.38, 0), 1)
  assert.equal(map.sample(0, -1.38), 1)
  assert.equal(map.sample(-0.97, 0.97), 1)
  assert.equal(map.sample(1.62, 0), 0)
  assert.equal(map.sample(0, 1.62), 0)
  assert.equal(map.sample(1.2, 1.2), 0)
  // Fall direction (G/B bytes) points forwards (+X) on the centreline.
  const o = ((100 * map.width) + 100) * 4
  assert.ok(map.data[o + 1] > 240 && Math.abs(map.data[o + 2] - 128) < 3)
  map.clear()
  assert.equal(map.sample(0, 0), 0)
})

test('corn: an interactor flattens its radius along the path it drives', () => {
  const tractor = new Object3D()
  tractor.position.set(10, 0.5, 10)
  const camera = new PerspectiveCamera()
  camera.position.set(10, 2, 0)
  const corn = new Corn({ camera, fields: [L], interactors: [{ object: tractor, radius: 1.2 }] })
  corn.update(Infinity)
  assert.ok(corn.stats.chunks > 0 && corn.stats.plants > 0)
  // Flat within the radius (less one 0.5 m texel), standing beyond it (plus one texel).
  const texel = corn.flattenMap.texel
  assert.equal(texel, 0.5)
  assert.equal(corn.flattened(10, 10), 1)
  assert.equal(corn.flattened(10 + 1.2 - texel, 10), 1)
  assert.equal(corn.flattened(10, 10 - 1.2 + texel), 1)
  assert.equal(corn.flattened(10 + 1.2 + texel, 10), 0)
  assert.equal(corn.flattened(10 - 1.2 - texel, 10), 0)
  // Driving 5 m in one frame flattens the whole strip, not just both ends.
  tractor.position.set(10, 0.5, 5)
  corn.update(0)
  for (const z of [5, 6, 7.5, 9]) assert.equal(corn.flattened(10.6, z), 1, `z = ${z}`)
  assert.equal(corn.flattened(12, 7.5), 0)
  // High above the corn (a drone, a bird) it flattens nothing.
  tractor.position.set(5, 30, 5)
  corn.update(0)
  tractor.position.set(5, 30, 2)
  corn.update(0)
  assert.equal(corn.flattened(5, 3), 0)
  // Interaction off: nothing new is flattened.
  corn.set({ interactionStrength: 0 })
  tractor.position.set(3, 0, 3)
  corn.update(0)
  assert.equal(corn.flattened(3, 3), 0)
  // Back on: the track restarts where the tractor is now, with no stripe from where it was before the pause.
  corn.set({ interactionStrength: 1 })
  corn.update(0)
  assert.equal(corn.flattened(3, 3), 1)
  assert.equal(corn.flattened(4.5, 2.25), 0, 'no stripe back to the position before interaction was off')
  corn.dispose()
})

test('corn: set/reset, plain-JSON settings, and plants only near the camera', () => {
  const camera = new PerspectiveCamera()
  camera.position.set(5, 1.7, 5)
  const corn = new Corn({ camera, fields: [L], growth: 0.3 })
  corn.update(Infinity)
  const near = corn.stats.plants
  assert.equal(corn.settings.growth, 0.3)
  corn.set({ harvested: true, wind: { strength: 0 } })
  assert.equal(corn.settings.harvested, true)
  assert.equal(corn.settings.wind.speed, 0.7)
  corn.reset({ fields: [L] })
  assert.equal(corn.settings.growth, 0.8)
  const { interactors: _i, sun: _s, ...json } = corn.settings
  assert.deepEqual(JSON.parse(JSON.stringify(json)), json)
  // From 200 m up there are no plants, only the canopy.
  camera.position.set(5, 200, 5)
  corn.update(Infinity)
  assert.equal(corn.stats.plants, 0)
  assert.ok(near > 0)
  corn.dispose()
})

test('geometry: plant model levels of detail and the canopy surface', () => {
  const counts = [0, 1, 2].map((d) => createCornGeometry(d).getAttribute('position').count)
  assert.ok(counts[0] > counts[1] && counts[1] > counts[2], `vertex counts ${counts}`)
  const g = createCanopyGeometry([L], 1, () => 0)
  const pos = g.getAttribute('position')
  const wall = g.getAttribute('aCanopy')
  let topArea = 0
  const idx = g.index!.array
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]]
    if (wall.getZ(a) || wall.getZ(b) || wall.getZ(c)) continue
    const ux = pos.getX(b) - pos.getX(a), uz = pos.getZ(b) - pos.getZ(a)
    const vx = pos.getX(c) - pos.getX(a), vz = pos.getZ(c) - pos.getZ(a)
    topArea += Math.abs(ux * vz - uz * vx) / 2
  }
  assert.ok(Math.abs(topArea - (40 * 15 + 15 * 25)) < 1, `canopy area ${topArea}`)
})
