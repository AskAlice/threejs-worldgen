import { test } from 'node:test'
import assert from 'node:assert/strict'
// The world module directly (not the threejs-biomes index), so these tests load no three.js.
import { World } from '../../biomes/src/world.ts'
import { HexGrid } from '../src/hex.ts'
import { aggregatePopulation, generatePopulation, nightLights, type PopulationData } from '../src/model.ts'
import { generateNetworks, reachable } from '../src/network.ts'
import { renderPopulationMap } from '../src/map.ts'

const small = { radius: 7000, totalPopulation: 250_000 }
const flat = new World({ seed: 1 })
const flatData = generatePopulation(flat, small)

function roundTrips(grid: HexGrid, points: [number, number][], res: number) {
  const edge = grid.edgeLength(res)
  for (const [x, z] of points) {
    const back = grid.toLocal(grid.fromLocal(x, z))
    assert.ok(Math.hypot(back[0] - x, back[1] - z) < 1e-6 * Math.max(1, Math.hypot(x, z)), `local round trip at ${x}, ${z}`)
    const cell = grid.cellAtLocal(x, z, res)
    const c = grid.centerLocal(cell)
    assert.ok(Math.hypot(c[0] - x, c[1] - z) < edge * 1.3, 'point lies within its cell')
    assert.equal(grid.cellAtLocal(c[0], c[1], res), cell, 'cell centre maps back to the cell')
    const ring = grid.boundaryLocal(cell)
    assert.ok(ring.length >= 6)
    for (const [bx, bz] of ring) assert.ok(Math.abs(Math.hypot(bx - c[0], bz - c[1]) / edge - 1) < 0.35, 'corners about one edge from the centre')
    const parent = grid.parent(cell, res - 2)
    assert.ok(grid.children(parent, res).includes(cell), 'cell is among its parent\'s children')
    assert.equal(grid.disk(cell, 1).length, 7)
  }
}

const points: [number, number][] = [[0, 0], [1234.5, -987.6], [-20_000, 15_000], [8000, 31_000], [-3.3, 0.7]]

test('plane: cell ↔ position round trips at Earth-equivalent sizes', () => {
  const grid = new HexGrid(flat)
  assert.ok(Math.abs(grid.edgeLength(8) - 531.4) < 1)
  assert.equal(grid.resolutionFor(500), 8)
  assert.equal(grid.resolutionFor(1400), 7)
  for (const res of [6, 8, 10]) roundTrips(grid, points, res)
})

test('sphere: cell ↔ position round trips, sizes scale with the radius', () => {
  const planet = new World({ seed: 2, surface: 'sphere', radius: 120_000 })
  const grid = new HexGrid(planet, planet.frameAt(20, 30))
  assert.ok(Math.abs(grid.edgeLength(4) - 26_071.8 * (120_000 / 6_371_007.18)) < 1)
  for (const res of [4, 6, 8]) roundTrips(grid, points.map(([x, z]) => [x / 4, z / 4]), res)
  // Planet-centred positions go through latitude/longitude and back.
  const p = grid.fromLatLng(-33.5, 151.2)
  const [lat, lng] = grid.toLatLng(...p)
  assert.ok(Math.abs(lat + 33.5) < 1e-9 && Math.abs(lng - 151.2) < 1e-9)
  assert.ok(Math.abs(Math.hypot(...p) - 120_000) < 1e-6)
})

test('aggregation up the hierarchy is consistent (parent = sum of children)', () => {
  const d = flatData
  assert.equal(d.total, small.totalPopulation)
  for (let r = d.resolution - 3; r <= d.resolution; r++) {
    const fine = aggregatePopulation(d, r)
    let sum = 0
    for (const a of fine.values()) { sum += a.population; assert.ok(Number.isInteger(a.population)) }
    assert.equal(sum, d.total, `res ${r} sums to the total`)
    if (r === d.resolution - 3) continue
    const coarse = aggregatePopulation(d, r - 1)
    const children = new Map<string, number>()
    for (const a of fine.values()) {
      const p = d.grid.parent(a.cell, r - 1)
      children.set(p, (children.get(p) ?? 0) + a.population)
    }
    for (const a of coarse.values()) assert.equal(children.get(a.cell), a.population, `parent ${a.cell} at res ${r - 1}`)
  }
  let finer = 0
  for (const a of aggregatePopulation(d, d.resolution + 1).values()) finer += a.population
  assert.ok(Math.abs(finer - d.total) < 1e-6)
})

test('determinism: same seed, same people; another seed, other people', () => {
  const again = generatePopulation(new World({ seed: 1 }), small)
  assert.deepEqual(again.settlements, flatData.settlements)
  assert.deepEqual(again.cells.map((c) => c.population), flatData.cells.map((c) => c.population))
  assert.deepEqual(generateNetworks(again).edges, generateNetworks(flatData).edges)
  const other = generatePopulation(flat, { ...small, seed: 99 })
  assert.notDeepEqual(other.settlements.map((s) => s.position), flatData.settlements.map((s) => s.position))
})

test('ranked settlements follow the rank-size rule', () => {
  for (const zipf of [0.8, 1, 1.3]) {
    const d = zipf === 1 ? flatData : generatePopulation(flat, { ...small, zipf })
    const ranked = d.settlements.filter((s) => s.rank > 0)
    assert.ok(ranked.length >= 5, 'enough settlements to rank')
    const p1 = ranked[0].population
    ranked.forEach((s, i) => {
      assert.equal(s.rank, i + 1)
      assert.ok(Math.abs(s.population - p1 / (i + 1) ** zipf) <= 1.5, `rank ${i + 1}`)
    })
    const sum = ranked.reduce((t, s) => t + s.population, 0)
    assert.ok(Math.abs(sum - small.totalPopulation * (1 - d.options.ruralShare)) < ranked.length)
    assert.ok(d.settlements.some((s) => s.class === 'farmstead'))
  }
})

function checkDry(world: World, d: PopulationData) {
  const avoid = new Set(d.options.habitability.avoid)
  for (const s of d.settlements) {
    const cell = d.cells[d.index.get(s.cell)!]
    assert.notEqual(cell.landUse, 'water')
    assert.ok(cell.habitability > 0)
    const sample = d.grid.frame.sample(s.position[0], s.position[1])
    assert.ok(!(sample.waterLevel > sample.elevation), `settlement ${s.id} is on dry land`)
    let avoided = 0
    for (let b = 0; b < sample.count; b++) if (avoid.has(world.options.biomes[sample.biomes[b]].id)) avoided += sample.weights[b]
    assert.ok(avoided <= 0.5, `settlement ${s.id} is not on glacier, peaks, volcanic or deep ocean`)
  }
}

test('no settlements in water or on glaciers', () => {
  checkDry(flat, flatData)
  // A cold, wet archipelago: lots of sea and ice.
  const cold = new World({ seed: 5, continents: { landBias: -0.15 }, climate: { baseTemperature: -9, temperatureRange: 10 } })
  const d = generatePopulation(cold, { ...small, minHabitability: 0.02 })
  const glacier = cold.options.biomes.findIndex((b) => b.id === 'glacier')
  assert.ok(d.cells.some((c) => { const s = d.grid.frame.sample(c.position[0], c.position[1]); return s.biomes[0] === glacier }), 'the cold world has glaciers')
  assert.ok(d.cells.some((c) => c.landUse === 'water'), 'and water')
  checkDry(cold, d)
})

test('road network connects every settlement; routes start and end at settlements', () => {
  const net = generateNetworks(flatData)
  const towns = flatData.settlements.filter((s) => s.class !== 'farmstead')
  const seen = reachable(net, towns[0].id)
  for (const s of towns) assert.ok(seen.has(s.id), `settlement ${s.id} reachable by road`)
  for (const e of net.edges) {
    const a = flatData.settlements[e.from], b = flatData.settlements[e.to]
    assert.deepEqual(e.points[0], a.position)
    assert.deepEqual(e.points[e.points.length - 1], b.position)
    assert.ok(e.length >= Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1]) - 1e-6)
    assert.ok(e.cells.length > 0)
  }
  assert.ok(net.edges.some((e) => e.type === 'powerline'))
})

test('population map is a pure RGBA image', () => {
  const px = renderPopulationMap(flatData, { resolution: 32 }, generateNetworks(flatData))
  assert.equal(px.length, 32 * 32 * 4)
  assert.ok(px.some((v, i) => i % 4 === 3 && v === 255))
  assert.deepEqual(renderPopulationMap(flatData, { resolution: 32, mode: 'lights' }), renderPopulationMap(flatData, { resolution: 32, mode: 'lights' }))
})

test('night lights come as typed arrays with samplers', () => {
  const lights = nightLights(flatData, flatData.resolution - 1)
  const n = lights.cells.length
  assert.ok(n > 0 && lights.intensity.length === n && lights.centers.length === n * 3 && lights.local.length === n * 2)
  assert.ok(lights.intensity.every((v) => v >= 0 && v <= 1) && lights.intensity.some((v) => v > 0.5))
  const i = lights.intensity.indexOf(Math.max(...lights.intensity))
  assert.equal(lights.sampleLocal(lights.local[i * 2], lights.local[i * 2 + 1]), lights.intensity[i])
  assert.equal(lights.sample(lights.centers[i * 3], lights.centers[i * 3 + 1], lights.centers[i * 3 + 2]), lights.intensity[i])
  assert.equal(lights.sampleLocal(1e6, 1e6), 0)
})
