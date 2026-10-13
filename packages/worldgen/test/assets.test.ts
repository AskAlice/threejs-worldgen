import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Object3D } from 'three/webgpu'
import { World } from 'threejs-biomes'
import { AssetRegistry, fuzzyScore, isPlausible, planSpawns, type AssetDef } from '../src/assets.ts'

const make = (id: string, name: string, category: string, tags: string[], placement: AssetDef['placement']): AssetDef =>
  ({ id, name, package: 'test', category, tags, params: {}, placement, create: () => new Object3D() })

const registry = new AssetRegistry().register(
  make('trees/redwood', 'Redwood', 'tree', ['conifer', 'giant'], { surface: 'ground', slope: [0, 0.6] }),
  make('trees/palm', 'Palm tree', 'tree', ['tropical', 'coast'], { surface: 'ground' }),
  make('city/skyscraper', 'Skyscraper', 'building', ['tower', 'office'], { surface: 'ground' }),
  make('fauna/trout', 'Trout', 'fish', ['freshwater'], { surface: 'underwater', depth: [0.5, 100] }),
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
