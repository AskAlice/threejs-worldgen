import { test } from 'node:test'
import assert from 'node:assert/strict'
import { World } from 'threejs-biomes'
import {
  architectureFor, buildingGeometry, cityData, findSettlements, modifierPoint, planCity, pointInPolygon, resolveCityOptions,
  roadAnchors, roadGeometry, routeCost, runToEnd, Site, type SettlementSize,
} from '../src/index.ts'

const ground = (x: number, z: number) => ({ height: Math.sin(x / 300) * 20 + Math.cos(z / 410) * 12, waterLevel: Math.abs(x - 250 + Math.sin(z / 100) * 30) < 20 ? -5 : NaN })
const plan = (size: SettlementSize, seed = 3, extra = {}) => runToEnd(planCity(ground, resolveCityOptions({ size, seed, ...extra }), { temperature: 12, moisture: 0.5, biome: 'grassland' }))

test('every size class gets buildings, bigger classes more of them', () => {
  const counts = (['hamlet', 'village', 'town', 'city'] as const).map((s) => plan(s).buildings.length)
  assert.ok(counts[0] > 0, 'hamlets have houses')
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] > counts[i - 1], `${counts}`)
})

test('a town plans fast and deterministically', () => {
  plan('town', 9) // warm up the JIT
  // CPU time, not wall time, so a busy machine doesn't fail the test.
  const t = process.cpuUsage()
  const a = plan('town')
  const used = process.cpuUsage(t)
  assert.ok((used.user + used.system) / 1000 < 1000, `well under a second (${((used.user + used.system) / 1000).toFixed(0)} ms CPU)`)
  assert.deepEqual(cityData(a, resolveCityOptions().roads), cityData(plan('town'), resolveCityOptions().roads))
})

test('buildings stand inside their lots, on dry ground, with sane heights', () => {
  const p = plan('town')
  for (const b of p.buildings) {
    const lot = p.lots[b.lot]
    for (const part of b.parts) for (const [x, z] of part.tiers[0].polygon) assert.ok(pointInPolygon(x, z, lot.polygon) || nearEdge(x, z, lot.polygon), `building ${b.id} leaves lot`)
    assert.ok(Number.isFinite(b.base) && b.bottom < b.base && b.height > 2)
    assert.ok(!p.site.wet(b.center[0], b.center[1]))
  }
})

function nearEdge(x: number, z: number, p: [number, number][]) {
  return p.some((a, i) => { const b = p[(i + 1) % p.length]; const l = Math.hypot(b[0] - a[0], b[1] - a[1]); return Math.abs((b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0])) / l < 1e-6 })
}

test('road surfaces follow the size class; rural roads have no kerbs', () => {
  const hamlet = plan('hamlet')
  assert.ok(hamlet.graph.edges.every((e) => e.surface === 'gravel' || e.surface === 'dirt'))
  assert.ok(hamlet.graph.edges.every((e) => e.sidewalk === 0))
  const town = plan('town')
  assert.ok(town.graph.edges.some((e) => e.surface === 'asphalt' && e.sidewalk > 0))
  for (const e of town.graph.edges) if (e.surface === 'gravel' || e.surface === 'dirt') assert.equal(e.sidewalk, 0)
})

test('climate picks the architecture: stilts in wetlands, flat roofs in deserts', () => {
  assert.equal(architectureFor({ temperature: 15, moisture: 0.9, biome: 'wetland' }), 'wetland')
  assert.equal(architectureFor({ temperature: 26, moisture: 0.1, biome: 'desert' }), 'arid')
  assert.equal(architectureFor({ temperature: -4, moisture: 0.5, biome: 'taiga' }), 'cold')
  const wet = plan('village', 3, { architecture: 'wetland' })
  assert.ok(wet.buildings.filter((b) => b.style === 'house').every((b) => b.stilts > 0))
  const arid = plan('village', 3, { architecture: 'arid' })
  const houses = arid.buildings.filter((b) => b.style === 'house')
  assert.ok(houses.filter((b) => b.parts[0].roof === 'flat').length > houses.length * 0.6)
})

test('geometry and data exports are consistent', () => {
  const p = plan('village')
  const b = p.buildings[0]
  const m = buildingGeometry(b, p.center, { wall: [1, 1, 1], roof: [1, 1, 1], overhang: 0.4, parapet: 0.9 })
  for (const d of [m.walls, m.roofs, m.simpleWalls, m.simpleRoofs]) {
    assert.equal(d.attributes.position.length, d.count * 3)
    assert.ok(d.index.every((i) => i < d.count))
    assert.ok(d.index instanceof Uint16Array)
  }
  const r = roadGeometry(p.graph, p.profiles, p.center, (x, z) => ground(x, z).height, { kerbHeight: 0.15, offset: 0.1, deckThickness: 1.2, pierSpacing: 24 })
  assert.ok(r.count > 0 && r.index.every((i) => i < r.count))
  const data = cityData(p, resolveCityOptions().roads)
  assert.doesNotThrow(() => JSON.stringify(data))
  assert.ok(roadAnchors(data, { spacing: 25 }).length > 0)
  assert.ok(data.lots.filter((l) => l.building >= 0).length === data.buildings.length)
  const cost = routeCost('car', resolveCityOptions().roads)
  const path = p.graph.shortestPath(0, p.graph.nodes.length - 1, cost)
  assert.ok(path.length >= 2)
})

test('settlement placement is deterministic and sized by score', () => {
  const world = new World({ seed: 11 })
  const region = { minX: -6000, minZ: -6000, maxX: 6000, maxZ: 6000 }
  const a = findSettlements(world, world.frame, region, { sampleSpacing: 400 })
  assert.deepEqual(a, findSettlements(world, world.frame, region, { sampleSpacing: 400 }))
  for (const s of a) {
    assert.ok(s.score >= 0.35 && s.score <= 1)
    assert.ok(Number.isNaN(world.sample(s.x, s.z).waterLevel), 'on dry land')
  }
  // Asking for a sub-region gives the same settlements inside it.
  const sub = findSettlements(world, world.frame, { minX: 0, minZ: 0, maxX: 6000, maxZ: 6000 }, { sampleSpacing: 400 })
  assert.deepEqual(sub, a.filter((s) => s.x >= 0 && s.z >= 0))
})

test('flatten modifiers land on the planned height, on flat worlds and planets', () => {
  for (const surface of ['plane', 'sphere'] as const) {
    const world = new World({ seed: 5, surface, radius: 60_000 })
    const frame = surface === 'sphere' ? world.frameAt(20, 30) : world.frame
    for (const [x, z] of [[0, 0], [900, -1300]]) {
      const target = frame.height(x, z) + 3
      const [px, py, pz, h] = modifierPoint(world, frame, x, z, target)
      world.addModifier({ type: 'circle', center: [px, py, pz], radius: 20, falloff: 5, height: h })
      assert.ok(Math.abs(frame.height(x, z) - target) < 0.05, `${surface}: ${frame.height(x, z)} vs ${target}`)
    }
  }
})

test('site sampling reads the frame', () => {
  const world = new World({ seed: 2 })
  const site = Site.fromFrame(world.frame, 0, 0, 100, 25)
  assert.ok(Math.abs(site.height(25, 50) - world.height(25, 50)) < 1e-3)
})
