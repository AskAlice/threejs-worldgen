import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Object3D } from 'three/webgpu'
import { World, type LocalFrame } from 'threejs-biomes'
import { AssetRegistry, editDistance, fuzzyScore, isPlausible, placeAsset, planSpawns, type AssetDef, type PlacementRule } from '../src/assets.ts'

const make = (id: string, name: string, category: string, tags: string[], placement: AssetDef['placement'], aliases: string[] = []): AssetDef =>
  ({ id, name, package: 'test', category, tags, aliases, params: {}, placement, create: () => new Object3D() })

const registry = new AssetRegistry().register(
  make('trees/redwood', 'Redwood', 'tree', ['conifer', 'giant'], { surface: 'ground', slope: [0, 0.6] }, ['sequoia', 'big tree']),
  make('trees/palm', 'Palm tree', 'tree', ['tropical', 'coast'], { surface: 'ground' }),
  make('city/skyscraper', 'Skyscraper', 'building', ['tower', 'office'], { surface: 'ground' }),
  make('fauna/trout', 'Trout', 'fish', ['freshwater'], { surface: 'underwater', depth: [0.5, 100] }),
  make('plants/cactus', 'Cactus', 'plant', ['desert'], { surface: 'ground', biomes: ['desert'] }, ['succulent']),
  make('vehicles/fishing-boat', 'Fishing boat', 'vehicle', ['boat', 'sea'], { surface: 'water', depth: [2, 1000] }),
)

test('fuzzy search tolerates typos and partial words', () => {
  assert.equal(registry.search('redwod')[0].asset.id, 'trees/redwood')
  assert.equal(registry.search('plm tree')[0].asset.id, 'trees/palm')
  assert.equal(registry.search('skyscrapr')[0].asset.id, 'city/skyscraper')
  assert.equal(registry.search('boat')[0].asset.id, 'vehicles/fishing-boat')
  assert.equal(registry.search('xyzzy').length, 0)
  assert.ok(fuzzyScore('oak', 'Oak') > fuzzyScore('oak', 'Cloak tree'))
})

test('fuzzy score ranks exact over prefix over substring over subsequence over typos', () => {
  assert.equal(fuzzyScore('oak', 'oak'), 1)
  assert.equal(fuzzyScore('OAK', 'oak'), 1)
  assert.equal(fuzzyScore('', 'oak'), 0)
  assert.ok(fuzzyScore('red', 'redwood') > 0, 'prefix')
  assert.ok(fuzzyScore('redwood', 'redwood') > fuzzyScore('red', 'redwood'), 'exact beats prefix')
  assert.ok(fuzzyScore('red', 'redwood') > fuzzyScore('wood', 'redwood'), 'prefix beats substring')
  assert.ok(fuzzyScore('rdw', 'redwood') > 0, 'subsequence')
  assert.ok(fuzzyScore('redwod', 'redwood') > 0, 'typo tolerated')
  assert.ok(fuzzyScore('redwod', 'redwood') < fuzzyScore('redwo', 'redwood'), 'typo ranks below a prefix')
  assert.equal(editDistance('redwod', 'redwood'), 1, 'adjacent transposition is one edit')
  assert.equal(fuzzyScore('zzzz', 'redwood'), 0)
})

test('search matches aliases like tags', () => {
  assert.equal(registry.search('sequoia')[0].asset.id, 'trees/redwood')
  assert.equal(registry.search('big tree')[0].asset.id, 'trees/redwood')
  assert.equal(registry.search('succulent')[0].asset.id, 'plants/cactus')
  assert.equal(registry.search('sequoia').length, 1)
})

test('filters narrow by category, placement kind, package and biome', () => {
  assert.deepEqual(registry.list({ category: 'tree' }).map((a) => a.id), ['trees/redwood', 'trees/palm'])
  assert.deepEqual(registry.list({ surface: 'water' }).map((a) => a.id), ['vehicles/fishing-boat'])
  assert.deepEqual(registry.list({ surface: 'underwater' }).map((a) => a.id), ['fauna/trout'])
  assert.equal(registry.list({ package: 'test' }).length, registry.list().length)
  assert.ok(!registry.list({ biome: 'tundra' }).some((a) => a.id === 'plants/cactus'))
  assert.ok(registry.list({ biome: 'desert' }).some((a) => a.id === 'plants/cactus'))
  assert.equal(registry.list({ category: 'tree', surface: 'water' }).length, 0)
})

test('search honours the same filters', () => {
  assert.deepEqual(registry.search('boat', 50, { surface: 'water' }).map((m) => m.asset.id), ['vehicles/fishing-boat'])
  assert.equal(registry.search('boat', 50, { surface: 'ground' }).length, 0)
  assert.deepEqual(registry.search('', 50, { category: 'fish' }).map((m) => m.asset.id), ['fauna/trout'])
  assert.equal(registry.search('', 2).length, 2, 'limit applies to an empty query')
})

test('placement keeps fish in water and trees on land, deterministically', () => {
  const world = new World({ seed: 4 })
  const plan = planSpawns(registry, world, world.frame, 0, 0, 20_000, 60, 'demo')
  assert.ok(plan.length > 20, `planned ${plan.length}`)
  for (const p of plan) {
    const s = world.frame.sample(p.x, p.z)
    const wet = !Number.isNaN(s.waterLevel) && s.waterLevel > s.elevation
    const a = registry.get(p.id)!
    if (a.placement.surface === 'ground') assert.ok(!wet, `${p.id} in water`)
    else assert.ok(wet, `${p.id} on land`)
  }
  assert.deepEqual(planSpawns(registry, world, world.frame, 0, 0, 20_000, 60, 'demo'), plan)
  assert.ok(isPlausible(world, world.frame, plan[0].x, plan[0].z, registry.get(plan[0].id)!.placement))
})

test('placeAsset snaps to the ground and is deterministic, and refuses implausible spots', async () => {
  const world = new World({ seed: 4 })
  const frame = world.frame
  const dry = spot(world, frame, registry.get('trees/redwood')!.placement, false)
  assert.ok(dry, 'found a dry spot')
  const a = await placeAsset(registry, 'trees/redwood', world, frame, dry![0], dry![1], 7)
  const b = await placeAsset(registry, 'trees/redwood', world, frame, dry![0], dry![1], 7)
  assert.ok(a && b)
  assert.deepEqual(a.plan, b.plan)
  assert.equal(a.object.position.y, a.plan.y)
  assert.equal(a.object.rotation.y, a.plan.yaw)
  assert.equal(await placeAsset(registry, 'fauna/trout', world, frame, dry![0], dry![1], 7), undefined)
  assert.equal(await placeAsset(registry, 'nope/none', world, frame, dry![0], dry![1], 7), undefined)
})

/** The first frame-local spot on a coarse grid where `rule` fits, on land when `wet` is false. */
function spot(world: World, frame: LocalFrame, rule: PlacementRule, wet: boolean): [number, number] | undefined {
  for (let x = -5000; x <= 5000; x += 250) for (let z = -5000; z <= 5000; z += 250) {
    const s = frame.sample(x, z)
    if ((!Number.isNaN(s.waterLevel) && s.waterLevel > s.elevation) !== wet) continue
    if (isPlausible(world, frame, x, z, rule)) return [x, z]
  }
  return undefined
}
