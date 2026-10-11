import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BoxGeometry, InstancedMesh, MeshBasicNodeMaterial, PerspectiveCamera } from 'three/webgpu'
import {
  INSTANCE_STRIDE, Scatter, directionToFrame, frameDirection, octDecode, octEncode, placeTile, poissonDisk, resolveLayer, selectLod,
} from '../src/index.ts'

function minDistance(points: Float32Array | number[], stride = 3) {
  let best = Infinity
  for (let a = 0; a < points.length; a += stride) {
    for (let b = a + stride; b < points.length; b += stride) {
      best = Math.min(best, Math.hypot(points[a] - points[b], points[a + 1] - points[b + 1]))
    }
  }
  return best
}

const sortKey = (p: number[]) => p.map((v) => v.toFixed(4)).join(',')
function triples(points: Float32Array) {
  const out: number[][] = []
  for (let i = 0; i < points.length; i += 3) out.push([points[i], points[i + 1], points[i + 2]])
  return out.map(sortKey).sort()
}

test('poisson disk: spacing holds within and across tiles, and tiles stitch exactly', () => {
  const spacing = 3
  const size = 20
  const tiles = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([i, j]) => poissonDisk(i * size, j * size, size, spacing, 42))
  const union = tiles.flatMap((t) => [...t])
  assert.ok(union.length / 3 > 50, 'enough points')
  assert.ok(minDistance(union) >= spacing - 1e-3, `min distance ${minDistance(union)}`)

  // One big tile over the same area gives exactly the same points as the four small ones: no seams, no gaps.
  const big = poissonDisk(0, 0, size * 2, spacing, 42)
  assert.deepEqual(triples(new Float32Array(union)), triples(big))

  // Deterministic, and seed-dependent.
  assert.deepEqual([...poissonDisk(20, 0, size, spacing, 42)], [...tiles[1]])
  assert.notDeepEqual([...poissonDisk(0, 0, size, spacing, 43)], [...tiles[0]])
})

test('poisson disk: packs densely (blue noise, not sparse dart throwing)', () => {
  const spacing = 2
  const pts = poissonDisk(-50, -50, 100, spacing, 7)
  const density = (pts.length / 3 / (100 * 100)) * spacing * spacing
  // Random sequential packing saturates near 0.70 / r²; a single Matérn-II pass would give at most 0.32.
  assert.ok(density > 0.5 && density < 0.7, `density ${density}`)
})

const flat = () => 0
const layer = (name: string, extra: object = {}) => resolveLayer({ name, spacing: 2, ...extra })

test('placement: deterministic, respects density and filters', () => {
  const a = placeTile([layer('a')], 0, 0, 30, 9, flat)[0]
  const b = placeTile([layer('a')], 0, 0, 30, 9, flat)[0]
  assert.deepEqual([...a], [...b])
  assert.ok(a.length / INSTANCE_STRIDE > 100)

  assert.equal(placeTile([layer('a', { density: 0 })], 0, 0, 30, 9, flat)[0].length, 0)
  const half = placeTile([layer('a', { density: 0.5 })], 0, 0, 30, 9, flat)[0].length / a.length
  assert.ok(half > 0.35 && half < 0.65, `half density kept ${half}`)

  const slope = (x: number) => x * 0.8 // slope 0.8 everywhere
  assert.equal(placeTile([layer('a', { maxSlope: 0.5 })], 0, 0, 30, 9, slope)[0].length, 0)
  assert.ok(placeTile([layer('a', { minSlope: 0.5 })], 0, 0, 30, 9, slope)[0].length > 0)
  assert.equal(placeTile([layer('a', { minHeight: 1 })], 0, 0, 30, 9, flat)[0].length, 0)
  assert.equal(placeTile([layer('a')], 0, 0, 30, 9, () => NaN)[0].length, 0, 'no terrain, no instances')

  // Function densities see world coordinates.
  const east = placeTile([layer('a', { density: (x: number) => (x > 15 ? 1 : 0) })], 0, 0, 30, 9, flat)[0]
  for (let o = 0; o < east.length; o += INSTANCE_STRIDE) assert.ok(east[o + 12] > 15)
})

test('placement: a group shares one point set, so its layers never overlap', () => {
  const [oak, birch] = placeTile([layer('oak', { density: 0.5 }), layer('birch', { density: 0.5 })], 0, 0, 40, 3, flat)
  assert.ok(oak.length > 0 && birch.length > 0)
  const both: number[] = []
  for (const d of [oak, birch]) for (let o = 0; o < d.length; o += INSTANCE_STRIDE) both.push(d[o + 12], d[o + 14])
  assert.ok(minDistance(both, 2) >= 2 - 1e-3)
})

test('placement: scale range, sink, clustering and alignment', () => {
  const [d] = placeTile([layer('r', { scale: [2, 3], sink: 0.5 })], 0, 0, 30, 1, () => 10)
  for (let o = 0; o < d.length; o += INSTANCE_STRIDE) {
    assert.ok(d[o + 17] >= 2 && d[o + 17] <= 3)
    assert.ok(Math.abs(d[o + 13] - 9.5) < 1e-5)
  }
  const even = placeTile([layer('c')], 0, 0, 200, 1, flat)[0].length
  const clumped = placeTile([layer('c', { cluster: { scale: 40, threshold: 0.5, strength: 1 } })], 0, 0, 200, 1, flat)[0].length
  assert.ok(clumped < even * 0.75 && clumped > even * 0.2, `clumped ${clumped / even}`)

  // align = 1 on a 45° slope tilts the instance's up axis onto the terrain normal.
  const [t] = placeTile([layer('t', { align: 1, randomYaw: false })], 0, 0, 10, 1, (x) => x)
  const upX = t[4]
  const upY = t[5]
  assert.ok(Math.abs(Math.atan2(-upX, upY) - Math.PI / 4) < 1e-3)
})

test('placement: tilt leans instances by at most `tilt`', () => {
  const [d] = placeTile([layer('t', { tilt: 0.2 })], 0, 0, 30, 1, flat)
  let max = 0
  for (let o = 0; o < d.length; o += INSTANCE_STRIDE) max = Math.max(max, Math.acos(Math.min(1, d[o + 5] / d[o + 17])))
  assert.ok(max > 0.1 && max <= 0.2 + 1e-4, `max lean ${max}`)
})

test('selectLod: thresholds and hysteresis', () => {
  const d = [10, 50, 200]
  assert.equal(selectLod(5, d), 0)
  assert.equal(selectLod(10, d), 1)
  assert.equal(selectLod(199, d), 2)
  assert.equal(selectLod(250, d), -1)
  assert.equal(selectLod(10.5, d, 0, 0.1), 0, 'stays near while inside the band')
  assert.equal(selectLod(11.5, d, 0, 0.1), 1, 'switches once past the band')
  assert.equal(selectLod(9.5, d, 1, 0.1), 1)
  assert.equal(selectLod(8.5, d, 1, 0.1), 0)
  assert.equal(selectLod(190, d, -1, 0.1), -1, 'hidden stays hidden just inside the range')
  assert.equal(selectLod(170, d, -1, 0.1), 2)
})

test('octahedral mapping: round trips and frame lookup', () => {
  for (const hemisphere of [true, false]) {
    for (let k = 0; k < 200; k++) {
      const theta = (k * 2.399) % (Math.PI * 2)
      const y = hemisphere ? (k % 50) / 50 : ((k % 50) / 25) - 1
      const r = Math.sqrt(1 - y * y)
      const dir = [Math.cos(theta) * r, y, Math.sin(theta) * r]
      const [u, v] = octEncode(dir[0], dir[1], dir[2], hemisphere)
      assert.ok(u >= 0 && u <= 1 && v >= 0 && v <= 1)
      const back = octDecode(u, v, hemisphere)
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(back[c] - dir[c]) < 1e-9, `${hemisphere} ${dir} -> ${back}`)
    }
    const frames = 8
    for (let i = 0; i < frames; i++) {
      for (let j = 0; j < frames; j++) {
        const d = frameDirection(i, j, frames, hemisphere)
        assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-9)
        // Every frame direction maps back to its own frame (corners of the full map share one pole direction).
        const [fi, fj] = directionToFrame(d[0], d[1], d[2], frames, hemisphere)
        const same = frameDirection(fi, fj, frames, hemisphere)
        assert.ok(Math.hypot(same[0] - d[0], same[1] - d[1], same[2] - d[2]) < 1e-9)
      }
    }
  }
  assert.deepEqual(octDecode(0.5, 0.5, true).map((v) => Math.round(v * 1e9) / 1e9), [0, 1, 0], 'centre of the hemi map looks straight down')
  assert.ok(Math.abs(frameDirection(0, 0, 8, true)[1]) < 1e-9, 'corner frames sit on the horizon')
})

test('Scatter streams tiles around the camera, pools by LOD and answers queries', () => {
  const camera = new PerspectiveCamera()
  camera.position.set(0, 2, 0)
  camera.updateMatrixWorld()
  const geometry = new BoxGeometry()
  const material = new MeshBasicNodeMaterial()
  const scatter = Scatter.create({
    camera,
    tileSize: 20,
    layers: [{ name: 'box', spacing: 4, lods: [{ distance: 20, geometry, material }, { distance: 60, geometry, material }], colorVariation: 0.2 }],
  })
  assert.ok(scatter.stats.tiles > 0)
  assert.ok(scatter.stats.visible > 0 && scatter.stats.visible <= scatter.stats.instances)
  const meshes = scatter.object.children as InstancedMesh[]
  assert.equal(meshes.length, 2, 'one pooled mesh per LOD')
  const params = meshes[0].geometry.getAttribute('scatterParams').array
  assert.ok(params[2] > 0 && params[2] < 1, 'per-instance random reaches the GPU')
  assert.equal(meshes[0].geometry.getAttribute('position'), geometry.getAttribute('position'), 'pools share the level geometry buffers')
  assert.ok(meshes[0].count > 0 && meshes[1].count > meshes[0].count)

  const near = scatter.query(0, 0, 30)
  assert.ok(near.length > 0 && near.every((i) => Math.hypot(i.x, i.z) <= 30 && i.layer === 'box'))
  // Far away (not streamed in) gives the same answer as a fresh scatter would.
  const far = scatter.query(5000, 5000, 15)
  assert.deepEqual(far, Scatter.create({ camera, tileSize: 20, layers: [{ name: 'box', spacing: 4, lods: [{ distance: 60, geometry, material }] }] }).query(5000, 5000, 15))

  camera.position.set(1000, 2, 0)
  camera.updateMatrixWorld()
  scatter.update(Infinity)
  assert.ok(scatter.query(0, 0, 30).length === near.length, 'queries stay deterministic after tiles are released')

  // Changing only the draw distance keeps placement; changing spacing regenerates.
  scatter.set({ layers: [{ name: 'box', spacing: 4, lods: [{ distance: 80, geometry, material }] }] })
  scatter.update(Infinity)
  assert.ok(scatter.stats.visible > 0)
  scatter.dispose()
  assert.equal(scatter.object.parent, null)
})

test('multi-material levels pool as single-material meshes sharing instance buffers (no shared shadow render object)', () => {
  const camera = new PerspectiveCamera()
  camera.position.set(0, 2, 0)
  camera.updateMatrixWorld()
  const geometry = new BoxGeometry() // 6 groups, material indices 0..5
  const materials = Array.from({ length: 6 }, () => new MeshBasicNodeMaterial())
  const scatter = Scatter.create({ camera, tileSize: 20, layers: [{ name: 'box', spacing: 4, lods: [{ distance: 40, geometry, material: materials }], colorVariation: 0.2 }] })
  const meshes = scatter.object.children as InstancedMesh[]
  assert.equal(meshes.length, 6, 'one mesh per material group')
  assert.equal(scatter.stats.meshes, 6)
  for (const [k, mesh] of meshes.entries()) {
    assert.ok(!Array.isArray(mesh.material), 'never a material array')
    assert.equal(mesh.material, materials[geometry.groups[k].materialIndex!])
    assert.equal(mesh.geometry.groups.length, 0)
    assert.deepEqual([mesh.geometry.drawRange.start, mesh.geometry.drawRange.count], [geometry.groups[k].start, geometry.groups[k].count])
    assert.equal(mesh.instanceMatrix, meshes[0].instanceMatrix, 'matrices shared')
    assert.equal(mesh.instanceColor, meshes[0].instanceColor, 'colours shared')
    assert.equal(mesh.geometry.getAttribute('scatterParams'), meshes[0].geometry.getAttribute('scatterParams'), 'params shared')
    assert.ok(mesh.count > 0 && mesh.count === meshes[0].count)
  }
  scatter.dispose()
})
