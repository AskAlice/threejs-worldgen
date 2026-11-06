import { test } from 'node:test'
import assert from 'node:assert/strict'
import { World } from '../src/world.ts'
import { buildChunk, chunkSize, cubeToSphere, sphereToFace, type ChunkData, type ChunkKey } from '../src/chunk.ts'

const settings = { resolution: 9, rootSize: 2048, skirt: 0.02 }

// Same walk as chunk.ts's border ring: the k-th skirt vertex copies the k-th border vertex.
function borderLoop(n: number): number[] {
  const loop: number[] = []
  for (let i = 0; i < n - 1; i++) loop.push(i)
  for (let j = 0; j < n - 1; j++) loop.push(j * n + n - 1)
  for (let i = n - 1; i > 0; i--) loop.push((n - 1) * n + i)
  for (let j = n - 1; j > 0; j--) loop.push(j * n)
  return loop
}

const worldPos = (d: ChunkData, v: number): [number, number, number] =>
  [d.center[0] + d.positions[v * 3], d.center[1] + d.positions[v * 3 + 1], d.center[2] + d.positions[v * 3 + 2]]

// The morph offset must land every vertex on the parent level's *rendered* surface (not just near it):
// that is what makes a split or merge morph instead of snapping. Both levels sample the same world
// function, so even vertices already sit on the parent grid; odd ones sit on a parent edge, or on the
// diagonal shared by the parent quad's two triangles.
test('geomorph offset lands every vertex on the parent level surface', () => {
  const n = settings.resolution
  for (const planet of [false, true]) {
    const world = planet ? new World({ seed: 11, surface: 'sphere', radius: 50_000 }) : new World({ seed: 11 })
    const parentKey: ChunkKey = { face: planet ? 0 : -1, level: 4, x: 3, y: 2 }
    const parent = buildChunk(world, parentKey, settings)
    const at = (x: number, y: number) => worldPos(parent, y * n + x)
    const mid = (a: [number, number, number], b: [number, number, number]): [number, number, number] =>
      [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
    let max = 0, maxOffset = 0
    for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
      const child = buildChunk(world, { face: parentKey.face, level: parentKey.level + 1, x: parentKey.x * 2 + ox, y: parentKey.y * 2 + oy }, settings)
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const p = (ox * (n - 1) + i) / 2, q = (oy * (n - 1) + j) / 2
        const surface = p % 1 === 0 && q % 1 === 0 ? at(p, q)
          : p % 1 === 0 ? mid(at(p, q - 0.5), at(p, q + 0.5))
          : q % 1 === 0 ? mid(at(p - 0.5, q), at(p + 0.5, q))
          : mid(at(p - 0.5, q + 0.5), at(p + 0.5, q - 0.5))
        const v = j * n + i
        const coarse = worldPos(child, v)
        for (let k = 0; k < 3; k++) coarse[k] += child.morph[v * 3 + k]
        for (let k = 0; k < 3; k++) max = Math.max(max, Math.abs(coarse[k] - surface[k]))
        maxOffset = Math.max(maxOffset, Math.hypot(child.morph[v * 3], child.morph[v * 3 + 1], child.morph[v * 3 + 2]))
      }
    }
    assert.ok(maxOffset > 0.01, `${planet ? 'planet' : 'plane'} morph is not a no-op (${maxOffset} m)`)
    assert.ok(max < 0.01, `${planet ? 'planet' : 'plane'} parent-surface error ${max} m`)
  }
})

// A finer neighbour cracks against this chunk by its own deviation from this surface. The skirt must hang
// deeper than that, at every neighbouring level, so a level seam never opens a hole.
test('skirt hangs deeper than the crack a finer neighbouring level opens', () => {
  const n = settings.resolution
  for (const planet of [false, true]) {
    const world = planet ? new World({ seed: 5, surface: 'sphere', radius: 50_000 }) : new World({ seed: 5 })
    const parentKey: ChunkKey = { face: planet ? 0 : -1, level: 3, x: 2, y: 3 }
    const parent = buildChunk(world, parentKey, settings)
    const border = borderLoop(n)
    const depth = Math.hypot(...[0, 1, 2].map((k) => parent.positions[(n * n) * 3 + k] - parent.positions[border[0] * 3 + k]))
    assert.ok(depth >= chunkSize(world, parentKey, settings.rootSize) * settings.skirt, `${planet ? 'planet' : 'plane'} skirt fraction`)
    let crack = 0
    for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
      const child = buildChunk(world, { face: parentKey.face, level: parentKey.level + 1, x: parentKey.x * 2 + ox, y: parentKey.y * 2 + oy }, settings)
      for (let v = 0; v < n * n; v++) crack = Math.max(crack, Math.hypot(child.morph[v * 3], child.morph[v * 3 + 1], child.morph[v * 3 + 2]))
    }
    assert.ok(depth > crack, `${planet ? 'planet' : 'plane'} skirt ${depth} m vs crack ${crack} m`)
    // The skirt keeps the border's morph offset, so the wall stays attached while the chunk morphs.
    for (let k = 0; k < border.length; k++) for (let c = 0; c < 3; c++) assert.equal(parent.morph[(n * n + k) * 3 + c], parent.morph[border[k] * 3 + c])
  }
})

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

// The same area at two levels must agree at every world position both levels sample: the level only
// changes tessellation. Before the fix each chunk filtered noise by its own spacing, so shared vertices
// sampled different terrain (coarse peaks flattened, biome weights and colours changed).
test('chunk elevation, biome weights and colour do not depend on the LOD level', () => {
  const settings = { resolution: 9, rootSize: 2048, skirt: 0.02 }
  const n = settings.resolution
  for (const planet of [false, true]) {
    const world = planet ? new World({ seed: 11, surface: 'sphere', radius: 50_000 }) : new World({ seed: 11 })
    const R = world.options.radius
    const coarse = { face: planet ? 0 : -1, level: 4, x: 3, y: 2 }
    const coarseSize = chunkSize(world, coarse, settings.rootSize)
    const step = planet ? 2 / 2 ** coarse.level : 0
    const c = buildChunk(world, coarse, settings)
    const elevation = (d: typeof c, v: number) => planet
      ? Math.hypot(d.center[0] + d.positions[v * 3], d.center[1] + d.positions[v * 3 + 1], d.center[2] + d.positions[v * 3 + 2]) - R
      : d.center[1] + d.positions[v * 3 + 1]
    let shared = 0, maxElevation = 0, maxColor = 0, maxDirect = 0
    const p: [number, number, number] = [0, 0, 0]
    const s = world.sampleAt(0, 0, 0)
    for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
      const f = buildChunk(world, { face: coarse.face, level: coarse.level + 1, x: coarse.x * 2 + ox, y: coarse.y * 2 + oy }, settings)
      for (let j = 0; j < n; j += 2) for (let i = 0; i < n; i += 2) {
        // Fine vertices that coincide with the coarse grid (children sit 2×2 inside the parent).
        const ci = ox * (n - 1) / 2 + i / 2, cj = oy * (n - 1) / 2 + j / 2
        const cv = cj * n + ci, fv = j * n + i
        shared++
        maxElevation = Math.max(maxElevation, Math.abs(elevation(c, cv) - elevation(f, fv)))
        for (let k = 0; k < 3; k++) {
          maxColor = Math.max(maxColor, Math.abs(c.colors[cv * 3 + k] - f.colors[fv * 3 + k]),
            Math.abs(c.biomeColors[cv * 3 + k] - f.biomeColors[fv * 3 + k]))
        }
        // ...and both match the world's authoritative (unfiltered) sample at that point.
        if (planet) {
          const u = -1 + (coarse.x + ci / (n - 1)) * step, v = -1 + (coarse.y + cj / (n - 1)) * step
          cubeToSphere(coarse.face, u, v, p)
          p[0] *= R; p[1] *= R; p[2] *= R
        } else {
          p[0] = (coarse.x + ci / (n - 1)) * coarseSize; p[1] = 0; p[2] = (coarse.y + cj / (n - 1)) * coarseSize
        }
        maxDirect = Math.max(maxDirect, Math.abs(elevation(c, cv) - world.sampleAt(p[0], p[1], p[2], s).elevation))
      }
    }
    assert.equal(shared, 4 * 5 * 5)
    assert.ok(maxElevation < (planet ? 0.02 : 0.002), `${planet ? 'planet' : 'plane'} elevation delta ${maxElevation} m`)
    assert.ok(maxDirect < (planet ? 0.02 : 0.002), `${planet ? 'planet' : 'plane'} filtered-vs-authoritative delta ${maxDirect} m`)
    assert.ok(maxColor < 1e-4, `${planet ? 'planet' : 'plane'} colour delta ${maxColor}`)
  }
})
