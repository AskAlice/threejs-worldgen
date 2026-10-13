import { test } from 'node:test'
import assert from 'node:assert/strict'
import { World } from 'threejs-biomes'
import {
  architectureFor, buildingGeometry, cityData, citySize, DEFAULT_SIZE_CLASSES, generatePopulation, modifierPoint, planCities, planCity,
  pointInPolygon, resolveCityOptions, roadAnchors, roadGeometry, routeCost, runToEnd, SETTLEMENT_SIZES, Site, type CityInput, type CityPlan,
  type SettlementSize,
} from '../src/index.ts'

const ground = (x: number, z: number) => ({ height: Math.sin(x / 300) * 20 + Math.cos(z / 410) * 12, waterLevel: Math.abs(x - 250 + Math.sin(z / 100) * 30) < 20 ? -5 : NaN })
const plans = new Map<string, CityPlan>() // plans are pure: plan each settlement once per file
const plan = (size: SettlementSize, seed = 3, extra: CityInput = {}) => {
  const key = JSON.stringify([size, seed, extra])
  if (!plans.has(key)) plans.set(key, runToEnd(planCity(ground, resolveCityOptions({ size, seed, ...extra }), { temperature: 12, moisture: 0.5, biome: 'grassland' })))
  return plans.get(key)!
}

test('bigger classes have more buildings, taller ones and more road', () => {
  // Each class at the bottom of its radius range: the smallest metropolis still outgrows the largest-class below it.
  // (Farmsteads are farms, not smaller hamlets: see farm.test.ts.)
  const stats = SETTLEMENT_SIZES.filter((s) => s !== 'farmstead').map((size) => {
    const p = plan(size, 3, { radius: DEFAULT_SIZE_CLASSES[size].radius[0] })
    const h = p.buildings.filter((b) => !b.use).map((b) => b.height) // landmarks have their own heights
    return { size, buildings: p.buildings.length, mean: h.reduce((s, x) => s + x, 0) / h.length, max: Math.max(...h), road: p.graph.totalLength() }
  })
  assert.ok(stats[0].buildings > 0, 'hamlets have houses')
  for (let i = 1; i < stats.length; i++) {
    const [a, b] = [stats[i - 1], stats[i]]
    assert.ok(b.buildings > a.buildings && b.road > a.road && b.max >= a.max && b.mean >= a.mean, JSON.stringify([a, b]))
  }
  assert.ok(stats[4].max > stats[3].max && stats[3].max > 2 * stats[2].max, 'towers in cities, taller ones in metropolises')
})

test('a town: a main street of 2–3 storey shops, a church, town hall and water tower, no towers', () => {
  const p = plan('town')
  assert.deepEqual(p.buildings.filter((b) => b.use).map((b) => b.use).sort(), ['church', 'townHall', 'waterTower'])
  const homes = p.buildings.filter((b) => !b.use)
  assert.ok(homes.every((b) => b.style !== 'tower' && b.floors <= DEFAULT_SIZE_CLASSES.town.maxFloors))
  const main = homes.filter((b) => b.district === 'downtown')
  assert.ok(main.length > 10 && main.every((b) => b.style === 'block' && b.floors >= 2), `${main.length} on the main street`)
  assert.ok(main.filter((b) => b.shops).length > main.length / 2, 'shops on the ground floor')
  // Downtown is a strip along the street through the centre, not a disc.
  const { axis } = p.districts
  const along = main.map((b) => Math.abs((b.center[0] - p.center[0]) * Math.cos(axis) + (b.center[1] - p.center[1]) * Math.sin(axis)))
  const across = main.map((b) => Math.abs((b.center[1] - p.center[1]) * Math.cos(axis) - (b.center[0] - p.center[0]) * Math.sin(axis)))
  assert.ok(Math.max(...along) > 2 * Math.max(...across), 'longer than it is wide')
  // The height limit is an option: lower it and nothing (but the landmarks) rises above it.
  const low = plan('town', 3, { sizes: { town: { maxFloors: 2 } } })
  assert.ok(low.buildings.every((b) => b.use || b.floors <= 2))
})

test('villages and hamlets: houses on big lots along the road, a church in the village, a junction in the hamlet', () => {
  const village = plan('village')
  const civic = village.buildings.filter((b) => b.use)
  assert.ok(civic.length >= 1 && civic.length <= 2 && civic.some((b) => b.use === 'church'))
  assert.ok(village.buildings.every((b) => b.use || (b.style === 'house' && b.floors <= 2)))
  assert.ok(village.lots.every((l) => l.district !== 'downtown'))
  const hamlet = plan('hamlet')
  assert.ok(hamlet.buildings.length >= 4 && hamlet.buildings.every((b) => !b.use && b.style === 'house'))
  assert.ok(hamlet.graph.nodes.some((n) => n.edges.length >= 3), 'a junction')
  const homes = (p: CityPlan) => p.lots.filter((l) => l.district === 'residential')
  const area = (p: CityPlan) => homes(p).reduce((s, l) => s + l.area, 0) / homes(p).length
  assert.ok(area(village) > 2 * area(plan('city')), 'bigger lots than a city')
})

test('a town plans fast and deterministically', () => {
  const fresh = () => runToEnd(planCity(ground, resolveCityOptions({ size: 'town', seed: 3 }), { temperature: 12, moisture: 0.5, biome: 'grassland' }))
  plan('town', 9) // warm up the JIT
  // CPU time, not wall time, so a busy machine doesn't fail the test.
  const t = process.cpuUsage()
  const a = fresh()
  const used = process.cpuUsage(t)
  assert.ok((used.user + used.system) / 1000 < 1000, `well under a second (${((used.user + used.system) / 1000).toFixed(0)} ms CPU)`)
  assert.deepEqual(cityData(a, resolveCityOptions().roads), cityData(fresh(), resolveCityOptions().roads))
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
  assert.ok(wet.buildings.filter((b) => b.style === 'house' && !b.use).every((b) => b.stilts > 0))
  const arid = plan('village', 3, { architecture: 'arid' })
  const houses = arid.buildings.filter((b) => b.style === 'house')
  assert.ok(houses.filter((b) => b.parts[0].roof === 'flat').length > houses.length * 0.6)
})

test('geometry and data exports are consistent', () => {
  const p = plan('village')
  // An ordinary building, and the church, town hall and water tower (cone roof, tank underside).
  for (const b of [p.buildings[0], ...plan('town').buildings.filter((b) => b.use)]) {
    const m = buildingGeometry(b, p.center, { wall: [1, 1, 1], roof: [1, 1, 1], overhang: 0.4, parapet: 0.9 })
    for (const d of [m.walls, m.roofs, m.simpleWalls, m.simpleRoofs]) {
      assert.ok(d.count > 0 && d.attributes.position.length === d.count * 3, `${b.use ?? b.style}`)
      assert.ok(d.index.every((i) => i < d.count))
      assert.ok(d.index instanceof Uint16Array)
    }
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

test('cities come from the population model, largest first, sized by their people', () => {
  const world = new World({ seed: 11 })
  const input = { radius: 8000, totalPopulation: 300_000 }
  const data = generatePopulation(world, input)
  const sites = planCities(data)
  assert.deepEqual(sites, planCities(generatePopulation(world, input)))
  assert.equal(sites.length, data.settlements.length)
  assert.ok(sites.every((s) => s.road === null), 'no network given, no farm roads')
  assert.ok(new Set(sites.map((s) => s.size)).size >= 2)
  sites.forEach((s, i) => {
    assert.equal(s.size, citySize(s.settlement.class))
    assert.deepEqual([s.x, s.z], s.settlement.position)
    const { radius } = DEFAULT_SIZE_CLASSES[s.size]
    assert.ok(s.radius >= radius[0] && s.radius <= radius[1], `${s.size} radius ${s.radius}`)
    // Ranked settlements largest first, then the farmsteads.
    if (i && s.size !== 'farmstead') assert.ok(s.settlement.population <= sites[i - 1].settlement.population)
    if (i) assert.ok(s.size === 'farmstead' || sites[i - 1].size !== 'farmstead')
  })
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
