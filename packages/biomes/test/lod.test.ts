import { test } from 'node:test'
import assert from 'node:assert/strict'
import { World } from '../src/world.ts'
import { chunkId, chunkSize, type ChunkKey } from '../src/chunk.ts'
import { selectChunks, maxLevel, type ChunkBounds, type LodSettings } from '../src/lod.ts'

const lod: LodSettings = { rootSize: 4096, lodFactor: 2, minChunkSize: 1, viewDistance: 12000 }

// Simulate the renderer: build everything requested, repeat until stable, then check coverage.
function converge(world: World, camera: [number, number, number]) {
  const built = new Map<string, ChunkBounds>()
  const boundsOf = (k: ChunkKey): ChunkBounds => {
    const size = chunkSize(world, k, lod.rootSize)
    return { center: [(k.x + 0.5) * size, 0, (k.y + 0.5) * size], radius: size * 0.71, maxElevation: 0 }
  }
  let sel = selectChunks(world, camera, lod, (k) => built.get(chunkId(k)), 1000)
  for (let i = 0; i < 60 && sel.need.length; i++) {
    for (const k of sel.need) built.set(chunkId(k), boundsOf(k))
    sel = selectChunks(world, camera, lod, (k) => built.get(chunkId(k)), 1000)
  }
  return sel
}

test('flat-world LOD converges, covers the area once and gets fine near the camera', () => {
  const world = new World({ seed: 1 })
  const sel = converge(world, [100, 0.5, 100])
  assert.equal(sel.need.length, 0)
  // No chunk shown together with one of its ancestors (no overlap).
  const ids = new Set(sel.show.map(chunkId))
  for (const k of sel.show) {
    let { level, x, y } = k
    while (level > 0) { level--; x = Math.floor(x / 2); y = Math.floor(y / 2); assert.ok(!ids.has(chunkId({ face: -1, level, x, y })), 'overlap') }
  }
  // Total shown area equals the root tiles' area (no holes).
  const area = sel.show.reduce((a, k) => a + chunkSize(world, k, lod.rootSize) ** 2, 0)
  const roots = new Set(sel.show.map((k) => `${Math.floor(k.x / 2 ** k.level)},${Math.floor(k.y / 2 ** k.level)}`))
  assert.ok(Math.abs(area - roots.size * lod.rootSize ** 2) < 1e-3)
  const finest = Math.max(...sel.show.map((k) => k.level))
  assert.ok(finest >= maxLevel(world, lod) - 2, `finest level ${finest}`)
})

test('planet LOD keeps the deepest level at ant scale bounded', () => {
  const world = new World({ seed: 1, surface: 'sphere', radius: 6_371_000 })
  assert.ok(maxLevel(world, { ...lod, minChunkSize: 0.5 }) <= 25)
})
