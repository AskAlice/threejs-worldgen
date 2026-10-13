import { test } from 'node:test'
import assert from 'node:assert/strict'
import { World } from '../src/world.ts'
import { buildChunk, cubeToSphere, sphereToFace } from '../src/chunk.ts'

const settings = { resolution: 9, rootSize: 2048, skirt: 0.02 }

// Every main-grid triangle faces up/out; every skirt triangle faces away from the chunk centre.
function checkWinding(world: World, face: number) {
  const c = buildChunk(world, { face, level: face < 0 ? 3 : 4, x: face < 0 ? -2 : 5, y: face < 0 ? 1 : 7 }, settings)
  const p = c.positions, idx = c.index, n = settings.resolution
  const up = face < 0 ? [0, 1, 0] : (() => { const l = Math.hypot(...c.center); return c.center.map((v) => v / l) })()
  let mainBad = 0, skirtBad = 0
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, d] = [idx[t], idx[t + 1], idx[t + 2]]
    const e1 = [0, 1, 2].map((k) => p[b * 3 + k] - p[a * 3 + k]), e2 = [0, 1, 2].map((k) => p[d * 3 + k] - p[a * 3 + k])
    const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
    const skirt = a >= n * n || b >= n * n || d >= n * n
    if (!skirt) { if (nrm[0] * up[0] + nrm[1] * up[1] + nrm[2] * up[2] <= 0) mainBad++ }
    else {
      const mid = [0, 1, 2].map((k) => (p[a * 3 + k] + p[b * 3 + k] + p[d * 3 + k]) / 3)
      if (nrm[0] * mid[0] + nrm[1] * mid[1] + nrm[2] * mid[2] <= 0) skirtBad++
    }
  }
  return { mainBad, skirtBad }
}

test('plane chunk triangles face up and skirts face out', () => {
  assert.deepEqual(checkWinding(new World({ seed: 3 }), -1), { mainBad: 0, skirtBad: 0 })
})

test('planet chunk triangles face out on all six cube faces', () => {
  const world = new World({ seed: 3, surface: 'sphere', radius: 50_000 })
  for (let f = 0; f < 6; f++) assert.deepEqual(checkWinding(world, f), { mainBad: 0, skirtBad: 0 }, `face ${f}`)
})

test('cube projection round-trips through sphereToFace', () => {
  for (let f = 0; f < 6; f++) for (const [u, v] of [[0, 0], [0.5, -0.3], [-0.9, 0.9]]) {
    const d = cubeToSphere(f, u, v)
    assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-9)
    assert.equal(sphereToFace(...d).face, f)
  }
})

test('neighbouring plane chunks share border heights exactly', () => {
  const world = new World({ seed: 9 })
  const a = buildChunk(world, { face: -1, level: 2, x: 0, y: 0 }, settings)
  const b = buildChunk(world, { face: -1, level: 2, x: 1, y: 0 }, settings)
  const n = settings.resolution
  for (let j = 0; j < n; j++) {
    const ya = a.positions[(j * n + n - 1) * 3 + 1] + a.center[1], yb = b.positions[(j * n) * 3 + 1] + b.center[1]
    assert.ok(Math.abs(ya - yb) < 1e-3, `row ${j}: ${ya} vs ${yb}`)
  }
})

test('invalid options from GUIs or URLs are sanitised instead of producing NaN', () => {
  const world = new World({ seed: 7, continents: { scale: 0, octaves: 0 }, mountains: { scale: Number.NaN }, rules: { maxBiomes: 0 } })
  const s = world.sampleAt(100, 0, 100)
  assert.ok(Number.isFinite(s.elevation) && s.count > 0)
  world.set({ hills: { scale: -5 } })
  assert.ok(Number.isFinite(world.sampleAt(5, 0, 5).elevation))
})
