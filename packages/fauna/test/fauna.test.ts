import { test } from 'node:test'
import assert from 'node:assert/strict'
import { World, createSample } from 'threejs-biomes'
import { DEFAULT_BOIDS, Flock, OpenEnvironment } from '../src/boids.ts'
import { buildFishMesh, PART } from '../src/fish-geometry.ts'
import { DEFAULT_WATER_RULES, FISH_SPECIES, fishClearance, fishHabitat } from '../src/fish-species.ts'
import { spawnTileNow, type SpawnOptions } from '../src/placement.ts'
import { BIRD_SPECIES, buildBirdMesh } from '../src/bird-species.ts'

test('fish meshes: finite, sane bounds, unit normals, closed body', () => {
  for (const [id, sp] of Object.entries(FISH_SPECIES)) {
    const m = buildFishMesh(sp.shape)
    const nv = m.position.length / 3
    for (const v of [...m.position, ...m.normal, ...m.attr]) assert.ok(Number.isFinite(v), `${id}: non-finite value`)
    for (const i of m.index) assert.ok(i < nv, `${id}: index out of range`)
    const [x0, y0, z0, x1, y1, z1] = m.bounds
    assert.ok(z1 <= 0.5 + 1e-6 && z0 >= -0.5 - 1e-6, `${id}: longer than 1 (${z0}…${z1})`)
    assert.ok(z1 - z0 > 0.97, `${id}: shorter than 1`)
    assert.ok(x1 - x0 < 0.8 && x1 > 0 && x0 < 0, `${id}: width ${x0}…${x1}`)
    assert.ok(y1 - y0 < 1 && y1 > 0 && y0 < 0, `${id}: height ${y0}…${y1}`)
    for (let i = 0; i < nv; i++) assert.ok(Math.abs(Math.hypot(m.normal[i * 3], m.normal[i * 3 + 1], m.normal[i * 3 + 2]) - 1) < 1e-4)
    for (let i = 0; i < nv; i++) {
      const s = m.attr[i * 4], h = m.attr[i * 4 + 1], w = m.attr[i * 4 + 3]
      assert.ok(s >= 0 && s <= 1 && h >= -1 && h <= 1 && w >= 0 && w <= 1)
    }
    // The body is a closed, consistently wound surface: every directed edge appears once and its
    // reverse appears once (so the silhouette from any side is closed).
    const edges = new Map<string, number>()
    for (let t = 0; t < m.bodyIndexCount; t += 3) {
      for (let k = 0; k < 3; k++) {
        const key = `${m.index[t + k]},${m.index[t + ((k + 1) % 3)]}`
        edges.set(key, (edges.get(key) ?? 0) + 1)
      }
    }
    for (const [key, n] of edges) {
      assert.equal(n, 1, `${id}: directed edge ${key} used ${n}×`)
      const [a, b] = key.split(',')
      assert.ok(edges.has(`${b},${a}`), `${id}: open edge ${key}`)
    }
    // Body normals point outwards (away from the spine).
    let outward = 0, total = 0
    for (let i = 0; i < nv; i++) {
      if (m.attr[i * 4 + 2] !== PART.body) continue
      total++
      if (m.position[i * 3] * m.normal[i * 3] + m.position[i * 3 + 1] * m.normal[i * 3 + 1] >= -1e-6) outward++
    }
    assert.ok(outward / total > 0.9, `${id}: normals inward`)
  }
})

test('bird meshes: finite and sane', () => {
  for (const [id, sp] of Object.entries(BIRD_SPECIES)) {
    const m = buildBirdMesh(sp.shape)
    for (const v of [...m.position, ...m.normal, ...m.attr]) assert.ok(Number.isFinite(v), `${id}: non-finite`)
    const [x0, , z0, x1, , z1] = m.bounds
    assert.ok(x1 - x0 > 1.5 && x1 - x0 < 3, `${id}: span`)
    assert.ok(z1 - z0 <= 1.01, `${id}: length`)
  }
})

test('boids: separation keeps a minimum distance', () => {
  const params = { ...DEFAULT_BOIDS, minDistance: 0.3, separationDistance: 0.6, neighborRadius: 2, homeRadius: 20 }
  const flock = new Flock(7, 60, [0, 0, 0], params, new OpenEnvironment(), 0.5) // starts crammed together
  const minDist = () => {
    let m = Infinity
    const p = flock.position
    for (let i = 0; i < flock.count; i++) for (let j = i + 1; j < flock.count; j++) m = Math.min(m, Math.hypot(p[i * 3] - p[j * 3], p[i * 3 + 1] - p[j * 3 + 1], p[i * 3 + 2] - p[j * 3 + 2]))
    return m
  }
  for (let s = 0; s < 30; s++) flock.step(1 / 30)
  for (let s = 0; s < 300; s++) {
    flock.step(1 / 30)
    assert.ok(minDist() >= 0.3 * 0.9, `step ${s}: ${minDist()}`)
  }
  // …and the flock stays a flock (cohesion and the home leash).
  for (let i = 0; i < flock.count; i++) assert.ok(Math.hypot(flock.position[i * 3], flock.position[i * 3 + 2]) < 30)
})

test('boids: deterministic', () => {
  const run = (seed: number) => {
    const f = new Flock(seed, 25, [3, 1, -2], DEFAULT_BOIDS, new OpenEnvironment(-5, 5))
    for (let s = 0; s < 200; s++) f.step(1 / 30, [{ x: 3, y: 1, z: 0, radius: 2 }])
    return Array.from(f.position)
  }
  assert.deepEqual(run(11), run(11))
  assert.notDeepEqual(run(11), run(12))
  for (const y of run(11).filter((_, i) => i % 3 === 1)) assert.ok(y >= -5 && y <= 5)
})

// A river mouth in seed 1's flat world (see example/water.ts): sea, river and dry land nearby.
const world = new World({ seed: 1 })
const opts: SpawnOptions = { seed: 5, salt: 1, tileSize: 64, density: 2500, gridResolution: 5, minWavelength: 1 }
const margin = 0.15
const habitat = fishHabitat(DEFAULT_WATER_RULES, margin)
const tiles: [number, number][] = []
for (let i = -164; i <= -160; i++) for (let j = 95; j <= 99; j++) tiles.push([i, j]) // river mouth
for (let i = -187; i <= -185; i++) for (let j = 72; j <= 74; j++) tiles.push([i, j]) // open sea, ~15 m deep

test('placement: deterministic per tile', () => {
  const a = spawnTileNow(-162, 97, FISH_SPECIES, habitat, world.frame, opts)
  const b = spawnTileNow(-162, 97, FISH_SPECIES, habitat, world.frame, opts)
  assert.deepEqual(a.map((g) => [g.species, g.seed, g.count, g.home]), b.map((g) => [g.species, g.seed, g.count, g.home]))
})

test('placement: fish only in water, below the surface, above the bed', () => {
  const sample = createSample(8)
  const kinds = new Set<string>()
  let fish = 0
  for (const [i, j] of tiles) {
    for (const g of spawnTileNow(i, j, FISH_SPECIES, habitat, world.frame, opts)) {
      const sp = FISH_SPECIES[g.species]
      const clearance = fishClearance(sp, margin)
      const flock = new Flock(g.seed, g.count, g.home, { ...DEFAULT_BOIDS, margin: clearance, homeRadius: sp.school.roam }, g.environment)
      kinds.add(`${g.species}:${sp.habitat.water}`)
      for (let step = 0; step <= 240; step++) {
        if (step % 60 === 0) {
          for (let f = 0; f < flock.count; f++) {
            const x = flock.position[f * 3], y = flock.position[f * 3 + 1], z = flock.position[f * 3 + 2]
            world.frame.sample(x, z, sample)
            const where = `${g.species} at ${x.toFixed(1)},${y.toFixed(2)},${z.toFixed(1)} step ${step}`
            assert.ok(sample.waterLevel === sample.waterLevel, `dry: ${where}`)
            // The whole body (centre ± half its height) is under the surface and above the bed.
            assert.ok(y + clearance - margin < sample.waterLevel, `above surface (${sample.waterLevel.toFixed(2)}): ${where}`)
            assert.ok(y - (clearance - margin) > sample.elevation, `in the bed (${sample.elevation.toFixed(2)}): ${where}`)
            fish++
          }
        }
        flock.step(1 / 30)
      }
    }
  }
  assert.ok(fish > 100, `only ${fish} fish checked`)
  assert.ok([...kinds].some((k) => k.endsWith(':fresh')) && [...kinds].some((k) => k.endsWith(':sea')), `kinds: ${[...kinds]}`)
})
