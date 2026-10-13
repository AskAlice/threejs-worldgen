import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MeshStandardNodeMaterial, type BufferGeometry, type Node } from 'three/webgpu'
import { float, vec3 } from 'three/tsl'
import { mulberry32 } from 'threejs-scatter'
import { BIOMES } from 'threejs-biomes'
import {
  applyImpostorWeather, createVegetationLayers, drawLeafImage, generateRock, generateTree, generateTreeLevels, growSkeleton, rocks, species, treeUniforms, type SpeciesName,
} from '../src/index.ts'

const NAMES: SpeciesName[] = [
  'oak', 'beech', 'maple', 'birch', 'spruce', 'pine', 'fir', 'redwood', 'acacia', 'baobab', 'palm', 'jungleEmergent', 'olive', 'cypress',
  'mangrove', 'deadSnag', 'cactus', 'shrub', 'dwarfShrub', 'thornShrub', 'fern', 'reed', 'apple', 'berryBush', 'flowers', 'tallGrassTuft',
  'succulent', 'bamboo', 'lilyPad',
]
const LEAFLESS = ['deadSnag', 'cactus', 'succulent', 'lilyPad']
const FRUITING = ['apple', 'berryBush', 'flowers']
const MAYBE_FRUIT = ['lilyPad'] // flowers on some pads, by chance

const positions = (g: BufferGeometry) => g.getAttribute('position').array as Float32Array

/** Max horizontal distance from the trunk axis among vertices with y in [y0, y1]. */
function reach(g: BufferGeometry, y0: number, y1: number) {
  const p = positions(g)
  let r = 0
  for (let i = 0; i < p.length; i += 3) if (p[i + 1] >= y0 && p[i + 1] <= y1) r = Math.max(r, Math.hypot(p[i], p[i + 2]))
  return r
}

test('species: exactly the contracted keys, all generate', () => {
  assert.deepEqual(Object.keys(species).sort(), [...NAMES].sort())
  for (const name of NAMES) {
    const p = species[name]
    const tree = generateTree(p, 3)
    assert.ok(positions(tree.trunk).length > 0, `${name} has a trunk`)
    assert.equal(tree.leaves === null, LEAFLESS.includes(name), `${name} leaves`)
    if (!MAYBE_FRUIT.includes(name)) assert.equal(tree.fruit !== null, FRUITING.includes(name), `${name} fruit`)
    const h = tree.bounds.max.y
    assert.ok(h > p.height * 0.35 && (name === 'lilyPad' || h < p.height * 1.3), `${name} height ${h.toFixed(2)} vs ${p.height}`)
    for (const g of [tree.trunk, tree.leaves, tree.fruit]) if (g) assert.equal(g.getAttribute('cardRandom').count, g.getAttribute('position').count)
    for (const v of positions(tree.trunk)) assert.ok(Number.isFinite(v), `${name} finite`)
  }
})

test('generateTree is deterministic per seed', () => {
  const a = generateTree(species.birch, 11)
  const b = generateTree(species.birch, 11)
  const c = generateTree(species.birch, 12)
  assert.deepEqual(positions(a.trunk), positions(b.trunk))
  assert.deepEqual(positions(a.leaves!), positions(b.leaves!))
  assert.notDeepEqual(positions(a.trunk), positions(c.trunk))
})

test('detail levels share a skeleton and get lighter', () => {
  const [full, simple] = generateTreeLevels(species.oak, 5, [1, 0.35])
  assert.ok(positions(simple.trunk).length < positions(full.trunk).length * 0.6)
  assert.ok(positions(simple.leaves!).length < positions(full.leaves!).length)
  assert.ok(Math.abs(simple.bounds.max.y - full.bounds.max.y) < 1.5, 'same silhouette height')
  assert.deepEqual(positions(generateTree(species.oak, 5).trunk), positions(full.trunk))
})

test('space colonisation: pipe-model radii and a connected tree', () => {
  const p = species.maple
  const sk = growSkeleton(p, mulberry32(9))
  assert.ok(sk.count > 300)
  for (let i = 1; i < sk.count; i++) assert.ok(sk.parent[i] >= 0 && sk.parent[i] < i, 'parents come first')
  const e = p.radiusExponent
  const sums = new Float64Array(sk.count)
  for (let i = 1; i < sk.count; i++) sums[sk.parent[i]] += Math.pow(sk.radius[i], e)
  let checked = 0
  for (let i = 0; i < sk.count; i++) {
    if (!sums[i] || sk.radius[i] <= p.tipRadius * 3) continue
    assert.ok(Math.abs(Math.pow(sk.radius[i], e) - sums[i]) / sums[i] < 0.05, `pipe model at ${i}`)
    checked++
  }
  assert.ok(checked > 10)
  assert.ok(Math.abs(sk.radius[0] - p.baseRadius) < 1e-6)
})

test('species features: umbrella acacia, conical spruce, buttressed cypress, mangrove prop roots', () => {
  const acacia = generateTree(species.acacia, 1).bounds
  assert.ok(acacia.max.x - acacia.min.x > (acacia.max.y - acacia.min.y) * 1.1, 'acacia is wider than tall')

  const spruce = generateTree(species.spruce, 1)
  const all = spruce.leaves!
  assert.ok(reach(all, 3, 8) > reach(all, 15, 20) * 1.5, 'spruce narrows towards the top')

  const cypress = generateTree(species.cypress, 1).trunk
  assert.ok(reach(cypress, -0.05, 0.1) > reach(cypress, 2.5, 3) * 1.4, 'cypress base flares')

  const mangrove = generateTree(species.mangrove, 1).trunk
  assert.ok(reach(mangrove, -0.4, 0.2) > species.mangrove.baseRadius * 5, 'mangrove roots reach out')
  const plain = generateTree({ ...species.mangrove, propRoots: 0 }, 1).trunk
  assert.ok(reach(plain, -0.4, 0.2) < species.mangrove.baseRadius * 3)
})

test('rocks: deterministic, sit on y = 0 with a flat base, roughly the requested size', () => {
  for (const [name, p] of Object.entries(rocks)) {
    const a = generateRock(p, 4)
    assert.deepEqual(positions(a), positions(generateRock(p, 4)), name)
    a.computeBoundingBox()
    const box = a.boundingBox!
    assert.ok(box.min.y > -0.15 * p.size && box.min.y <= 0.001, `${name} base ${box.min.y}`)
    const width = Math.max(box.max.x - box.min.x, box.max.z - box.min.z)
    assert.ok(width > p.size * 0.6 && width < p.size * 1.6, `${name} width ${width} vs ${p.size}`)
    assert.ok(box.max.y < width, `${name} is not taller than wide`)
  }
  assert.notDeepEqual(positions(generateRock(rocks.boulder, 1)), positions(generateRock(rocks.boulder, 2)))
})

test('leaf images: soft-edged coverage, transparent corners', () => {
  for (const shape of ['broad', 'needle', 'palm', 'fern', 'blade'] as const) {
    const { data, size } = drawLeafImage(shape, 64)
    let covered = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] >= 128) covered++
    const share = covered / (size * size)
    assert.ok(share > 0.08 && share < 0.8, `${shape} coverage ${share}`)
    assert.equal(data[3], 0, `${shape} bottom-left corner is clear`)
    assert.equal(data[(size * size - 1) * 4 + 3], 0, `${shape} top-right corner is clear`)
  }
})

test('createVegetationLayers: variants share a group, LODs scale with size, densities split', async () => {
  const layers = await createVegetationLayers({
    species: [{ name: 'oak', density: 0.6, group: 'canopy' }, { name: 'fern', density: 0.9 }, { name: 'boulder', density: 0.3 }],
    variants: 2,
    density: (name, x) => (name === 'oak' && x < 0 ? 0 : 1),
  })
  assert.deepEqual(layers.map((l) => l.name), ['oak#0', 'oak#1', 'fern#0', 'fern#1', 'boulder#0', 'boulder#1'])
  assert.deepEqual(layers.map((l) => l.group), ['canopy', 'canopy', 'fern', 'fern', 'boulder', 'boulder'])
  const oak = layers[0]
  const fern = layers[2]
  assert.equal(oak.lods.length, 2)
  assert.ok(Array.isArray(oak.lods[0].material) && oak.lods[0].geometry.groups.length === 2, 'bark + leaves in one geometry')
  assert.deepEqual(oak.scale, species.oak.scaleRange)
  assert.equal(oak.tilt, species.oak.leanVariation)
  assert.ok(fern.lods[1].distance < oak.lods[1].distance, 'small plants switch LOD sooner')
  assert.equal(layers[4].align, 1, 'rocks follow the slope')
  const d = oak.density as (x: number, z: number) => number
  assert.equal(d(-5, 0), 0)
  assert.ok(Math.abs(d(5, 0) - 0.3) < 1e-9)
  await assert.rejects(createVegetationLayers({ species: [{ name: 'notATree', density: 1 }] }))
})

test('apple fruit hangs below the crown and merges as material group 2', async () => {
  const tree = generateTree(species.apple, 2)
  assert.ok(tree.fruit && positions(tree.fruit).length > 0)
  const [layer] = await createVegetationLayers({ species: [{ name: 'apple', density: 1 }], variants: 1 })
  assert.deepEqual(layer.lods[0].geometry.groups.map((g) => g.materialIndex), [0, 1, 2])
  assert.equal((layer.lods[0].material as unknown[]).length, 3)
})

test('every biome scatter table entry (threejs-biomes BIOMES) is a species or rock preset', () => {
  const names = BIOMES.flatMap((b) => b.scatter.map((e) => e.species))
  assert.ok(names.length > 20)
  for (const name of names) assert.ok(name in species || name in rocks, `${name} has a preset`)
})

/** Whether `target` is anywhere in the TSL graph under `node`. */
function dependsOn(node: unknown, target: unknown): boolean {
  const seen = new Set<unknown>()
  const stack = [node as Node]
  while (stack.length) {
    const n = stack.pop()!
    if (n === target) return true
    if (!n || seen.has(n)) continue
    seen.add(n)
    for (const c of n.getChildren()) stack.push(c as Node)
  }
  return false
}

test('impostors get the same weather as the mesh LODs: snow by the baked normal, wet, burn, damage leaf loss', () => {
  const surface = { color: vec3(0.2, 0.4, 0.1), alpha: float(1), normal: vec3(0, 1, 0), mask: float(0.5) }
  const m = new MeshStandardNodeMaterial()
  applyImpostorWeather(m, surface)
  const u = treeUniforms
  for (const k of ['snow', 'wetness', 'burn', 'damage'] as const) assert.ok(dependsOn(m.colorNode, u[k]), `colour reacts to ${k}`)
  assert.ok(dependsOn(m.colorNode, surface.normal), 'snow settles by the baked normal')
  assert.ok(dependsOn(m.colorNode, surface.color), 'keeps the tinted baked colour')
  assert.ok(dependsOn(m.colorNode, surface.mask), 'foliage mask splits leaves from bark')
  assert.ok(dependsOn(m.roughnessNode, u.wetness) && dependsOn(m.roughnessNode, u.snow), 'wet gloss, snow roughness')

  const snow = float(0.7)
  const own = new MeshStandardNodeMaterial()
  applyImpostorWeather(own, surface, { weather: { snow }, rock: true })
  assert.ok(dependsOn(own.colorNode, snow) && !dependsOn(own.colorNode, u.snow), 'per-material weather inputs win, like on the meshes')
  assert.ok(!dependsOn(own.colorNode, surface.mask), 'rocks have no foliage')
})
