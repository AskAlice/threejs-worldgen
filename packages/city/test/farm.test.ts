import { test } from 'node:test'
import assert from 'node:assert/strict'
import { World } from '../../biomes/src/world.ts'
import {
  buildingGeometry, cityData, fieldGeometry, generateNetworks, generatePopulation, nearestOnPolyline, planCities, planCity, pointInPolygon, polygonsOverlap,
  resolveCityOptions, runToEnd, Site, type CityInput, type CityPlan, type Climate, type SiteFn,
} from '../src/index.ts'

const rolling: SiteFn = (x, z) => ({ height: Math.sin(x / 300) * 20 + Math.cos(z / 410) * 12, waterLevel: Math.abs(x - 250 + Math.sin(z / 100) * 30) < 20 ? -5 : NaN })
const temperate: Climate = { temperature: 12, moisture: 0.5, biome: 'grassland' }
const farm = (ground: SiteFn = rolling, input: CityInput = {}, climate = temperate) => runToEnd(planCity(ground, resolveCityOptions({ size: 'farmstead', seed: 3, ...input }), climate))

/** Distance from (x, z) to the nearest road edge of a plan. */
const toRoad = (p: CityPlan, x: number, z: number) => Math.min(...p.graph.edges.map((e) => {
  const a = p.graph.nodes[e.a], b = p.graph.nodes[e.b]
  return nearestOnPolyline([[a.x, a.z], [b.x, b.z]], x, z).distance
}))

test('a farmstead: farmhouse, barn, silos and shed in a yard, fields around it, a dirt driveway to the road', () => {
  const p = farm()
  const uses = p.buildings.map((b) => b.use)
  assert.ok(uses.includes('farmhouse') && uses.includes('barn') && uses.includes('machineShed'), `${uses}`)
  assert.ok(p.farm && p.farm.fields.length >= 4, 'fields')
  for (const b of p.buildings) for (const part of b.parts) for (const [x, z] of part.tiers[0].polygon) assert.ok(pointInPolygon(x, z, p.farm.yard), `${b.use} outside the yard`)
  const barn = p.buildings.find((b) => b.use === 'barn')!
  assert.ok(barn.tint && ['gable', 'gambrel'].includes(barn.parts[0].roof) && barn.parts[0].blank)
  assert.ok(p.graph.edges.some((e) => e.type === 'minor' && e.surface === 'dirt'), 'a dirt driveway')
  // Fields: inside the farm, apart from each other, off the yard, the roads and the water.
  const fields = p.farm.fields
  for (const f of fields) {
    assert.ok(!polygonsOverlap(f.polygon, p.farm.yard))
    for (const [x, z] of f.polygon) assert.ok(!p.site.wet(x, z) && toRoad(p, x, z) > 3, `field ${f.id} by a road or water`)
    assert.ok(Math.abs(Math.hypot(...f.rows) - 1) < 1e-9 && f.rowSpacing >= 0)
    for (const g of fields) if (g.id > f.id) assert.ok(!polygonsOverlap(f.polygon, g.polygon), `fields ${f.id} and ${g.id} overlap`)
  }
  // Hooks for other packages: a tractor spot and props in threejs-props' placement shape.
  const [tractor] = p.farm.vehicleSpots
  assert.equal(tractor.kind, 'tractor')
  assert.ok(tractor.working ? pointInPolygon(tractor.position[0], tractor.position[2], fields[tractor.field].polygon) : pointInPolygon(tractor.position[0], tractor.position[2], p.farm.yard))
  assert.ok(p.farm.props.every((q) => (q.kind === 'fence' || q.kind === 'hay-bale') && Number.isFinite(q.x + q.y + q.z + q.yaw)))
  assert.doesNotThrow(() => JSON.stringify(cityData(p, resolveCityOptions().roads).farm))
})

test('farm buildings build valid geometry: gambrel barn, cone-roofed silos', () => {
  const p = farm(rolling, { farm: { barn: { gambrel: 1 }, silos: { count: [2, 2] } } })
  assert.equal(p.buildings.find((b) => b.use === 'barn')!.parts[0].roof, 'gambrel')
  assert.equal(p.buildings.filter((b) => b.use === 'silo').length, 2)
  for (const b of p.buildings) {
    const m = buildingGeometry(b, p.center, { wall: [1, 1, 1], roof: [1, 1, 1], overhang: 0.4, parapet: 0 })
    for (const d of [m.walls, m.roofs]) assert.ok(d.count > 0 && d.index.every((i) => i < d.count), `${b.use}`)
  }
})

/** The road node where the driveway starts must carry a road edge, and no road edge may run over water unbridged. */
function assertJoined(p: CityPlan) {
  const [ax, az] = p.farm!.access
  const access = p.graph.nearestNode(ax, az, 0.5)
  assert.ok(access >= 0 && p.graph.nodes[access].edges.some((e) => p.graph.edges[e].type !== 'minor'), 'access node on a road edge')
  assert.ok(!p.site.wet(ax, az), 'access on dry ground')
  for (const e of p.graph.edges) {
    if (e.bridge) continue
    const a = p.graph.nodes[e.a], b = p.graph.nodes[e.b]
    for (let t = 0; t <= 1; t += 0.05) assert.ok(!p.site.wet(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t), `edge ${e.id} (${e.type}) runs over water`)
  }
}

test('a pond on the road: the driveway still joins the road on dry ground, the road bridges the pond', () => {
  const pond: SiteFn = (x, z) => ({ height: 0, waterLevel: Math.abs(x) < 12 && Math.abs(z - 200) < 15 ? 1 : NaN })
  for (let seed = 1; seed <= 5; seed++) {
    const p = farm(pond, { seed, farm: { road: [[-600, 200], [600, 200]] } })
    assert.ok(p.farm, `seed ${seed}: a farm`)
    assertJoined(p)
  }
})

test('degenerate sizes finish: zero fence length, zero field size', () => {
  // All pasture, so every field is fenced.
  const fenced = farm(rolling, { farm: { fences: { length: 0 }, crops: { corn: { weight: 0 }, wheat: { weight: 0 }, fallow: { weight: 0 } } } })
  const fences = fenced.farm!.props.filter((q) => q.kind === 'fence')
  assert.ok(fences.length > 0 && fences.every((q) => (q.length ?? 0) > 0 && Number.isFinite(q.x)))
  assert.ok(farm(rolling, { farm: { fieldSize: [0, 0] } }).farm)
})

test('farms are deterministic', () => {
  assert.deepEqual(cityData(farm(), resolveCityOptions().roads), cityData(farm(), resolveCityOptions().roads))
  assert.notDeepEqual(farm().farm!.fields, farm(rolling, { seed: 4 }).farm!.fields)
})

test('no farm on water or on a steep slope', () => {
  const lake = farm(() => ({ height: -2, waterLevel: 0 }))
  assert.equal(lake.farm, null)
  assert.equal(lake.buildings.length, 0)
  const cliff = farm((x) => ({ height: x * 0.4, waterLevel: NaN }))
  assert.equal(cliff.farm, null)
  // On a gentle slope it moves to the flattest dry spot, and its yard stays within the slope limit.
  const p = farm(rolling)
  const o = resolveCityOptions({ size: 'farmstead' }).farm
  for (const [x, z] of p.farm!.yard) assert.ok(!p.site.wet(x, z) && p.site.slope(x, z) <= o.maxSlope + 1e-9)
})

test('crops follow the climate; corn fields carry rows for a crop renderer', () => {
  const cold = farm(rolling, {}, { temperature: 1, moisture: 0.3, biome: 'steppe' })
  assert.ok(cold.farm!.fields.every((f) => f.crop !== 'corn'), 'no corn in the cold')
  const warm = farm(rolling, { seed: 5, farm: { crops: { wheat: { weight: 0 }, fallow: { weight: 0 }, pasture: { weight: 0 } } } }, { temperature: 24, moisture: 0.6, biome: 'grassland' })
  assert.ok(warm.farm!.fields.length > 0 && warm.farm!.fields.every((f) => f.crop === 'corn' && f.rowSpacing === 0.76))
  const mesh = fieldGeometry(warm.farm!, warm.center, (x, z) => warm.site.height(x, z), { rowContrast: { corn: 0.1, wheat: 0, fallow: 0, pasture: 0 }, tramlines: { corn: 0, wheat: 24, fallow: 0, pasture: 0 }, yardColor: '#888070', offset: 0.2, step: 6 })
  assert.ok(mesh.count > 0 && mesh.index.every((i) => i < mesh.count) && mesh.attributes.field.length === mesh.count * 4)
})

test('every farm of a seeded world has a driveway joined to the road network', () => {
  const world = new World({ seed: 11 })
  const data = generatePopulation(world, { radius: 12_000, totalPopulation: 400_000 })
  const network = generateNetworks(data)
  const farms = planCities(data, undefined, network).filter((s) => s.size === 'farmstead').slice(0, 6)
  assert.ok(farms.length >= 3, `${farms.length} farmsteads`)
  let built = 0
  for (const s of farms) {
    const p = runToEnd(planCity(Site.frameFn(world.frame), resolveCityOptions({ size: 'farmstead', center: [s.x, s.z], radius: s.radius, seed: s.seed, farm: { road: s.road!.points, roadType: s.road!.type } }), temperate))
    if (!p.farm) continue
    built++
    // The driveway's far end lies on a network road, and the yard is reachable from it.
    assertJoined(p)
    const [ax, az] = p.farm.access
    assert.ok(network.edges.some((e) => e.type !== 'rail' && e.type !== 'powerline' && nearestOnPolyline(e.points, ax, az).distance < 0.5), 'access on the network')
    const access = p.graph.nearestNode(ax, az, 0.5)
    const [a, b] = [p.farm.yard[1], p.farm.yard[2]]
    const gate = p.graph.nearestNode((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0.5)
    assert.ok(access >= 0 && gate >= 0 && p.graph.shortestPath(access, gate, () => 1).length >= 2, 'yard connected to the road')
  }
  assert.ok(built >= 3, `${built} of ${farms.length} built`)
})
