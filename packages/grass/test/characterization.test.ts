import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PerspectiveCamera } from 'three/webgpu'
import { Grass, GrassMap, createBladeGeometry } from '../src/index.ts'
import { TileStream } from '../src/grass-tiles.ts'
import { TileGeometryStore } from '../src/grass-geometry.ts'
import { Retirement } from '../src/retirement.ts'

test('blade geometry: three vertices per row plus a tip, for any segment count', () => {
  for (const segments of [1, 2, 3, 5, 8]) {
    const g = createBladeGeometry(segments)
    const pos = g.getAttribute('position')
    const uv = g.getAttribute('uv')
    const index = g.index!.array
    const tip = segments * 3

    assert.equal(pos.count, segments * 3 + 1, `segments ${segments}: vertices`)
    assert.equal(uv.count, pos.count, `segments ${segments}: uvs`)
    assert.equal(index.length, (segments - 1) * 12 + 6, `segments ${segments}: indices`)
    for (const i of index) assert.ok(i >= 0 && i < pos.count, `segments ${segments}: index ${i} in range`)

    // Every row is left edge, midrib, right edge: same height, mirrored, midrib centred.
    for (let r = 0; r < segments; r++) {
      const y = r / segments
      const [l, m, rt] = [r * 3, r * 3 + 1, r * 3 + 2]
      for (const v of [l, m, rt]) assert.ok(Math.abs(pos.getY(v) - y) < 1e-6, `row ${r} height`)
      assert.equal(pos.getX(m), 0, `row ${r} midrib`)
      assert.ok(pos.getX(l) < 0 && pos.getX(rt) > 0, `row ${r} edges`)
      assert.ok(Math.abs(pos.getX(l) + pos.getX(rt)) < 1e-12, `row ${r} mirrored`)
    }

    // The single tip vertex closes the strip: two triangles join the last row to it.
    assert.ok(Math.abs(pos.getY(tip) - 1) < 1e-6 && pos.getX(tip) === 0 && pos.getZ(tip) === 0)
    assert.deepEqual(Array.from(index.slice(-6)), [tip - 3, tip - 2, tip, tip - 2, tip - 1, tip])

    // No degenerate triangle anywhere.
    for (let t = 0; t < index.length; t += 3) {
      const [a, b, c] = [index[t], index[t + 1], index[t + 2]]
      const ux = pos.getX(b) - pos.getX(a), uy = pos.getY(b) - pos.getY(a), uz = pos.getZ(b) - pos.getZ(a)
      const vx = pos.getX(c) - pos.getX(a), vy = pos.getY(c) - pos.getY(a), vz = pos.getZ(c) - pos.getZ(a)
      const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
      assert.ok(area > 1e-9, `segments ${segments}: triangle ${t / 3} is degenerate`)
    }
  }

  // Geometry is a pure function of the segment count.
  const [a, b] = [createBladeGeometry(4), createBladeGeometry(4)]
  assert.deepEqual(Array.from(a.getAttribute('position').array), Array.from(b.getAttribute('position').array))
  assert.deepEqual(Array.from(a.index!.array), Array.from(b.index!.array))
})

type TileRef = { ix: number; iz: number }

/** The extracted generator, wired to a real field's settings/terrain but no material or tiles. */
function streamFor(grass: Grass) {
  const retirement = new Retirement()
  const material = () => null
  return new TileStream({
    object: grass.object,
    settings: () => grass.settings,
    billboard: () => grass.settings.type === 'billboards',
    height: () => grass.sampleHeight,
    densityAt: (dist) => grass.densityAt(dist),
    material,
    geometry: new TileGeometryStore({ settings: () => grass.settings, material }, retirement),
    retirement,
  })
}

function grow(stream: TileStream, grass: Grass, tile: TileRef, c: number, upTo: number) {
  const n = stream.cellsPerSide
  const cs = grass.settings.tileSize / n
  const cell = stream.createCell(tile, c, cs)
  stream.generate(tile, cell, c, cs, stream.cellFull, upTo)
  return { cell, cs, n }
}

test('cells: generation is deterministic per cell coordinate and stays inside its cell', () => {
  // Clumping 0 keeps the raw draw inside the cell; tufts deliberately spill by up to clumpSize / 2.
  const grass = new Grass({ camera: new PerspectiveCamera(), clumping: 0 })
  const stream = streamFor(grass)
  const c = 7
  const { cell, cs, n } = grow(stream, grass, { ix: 2, iz: -3 }, c, 40)
  assert.equal(cell.count, 40)
  assert.equal(cell.candidates, 40)
  const cx = (c % n) * cs, cz = Math.floor(c / n) * cs
  for (let i = 0; i < cell.count; i++) {
    const [x, y, z, yaw] = cell.offsets.subarray(i * 4, (i + 1) * 4)
    assert.ok(x >= cx && x <= cx + cs && z >= cz && z <= cz + cs, `blade ${i} at (${x}, ${z}) in cell`)
    assert.equal(y, 0) // flat terrain
    assert.ok(yaw >= 0 && yaw < Math.PI * 2)
    // LOD ranks are the candidate order, so fewer blades are always an exact prefix of more.
    assert.ok(Math.abs(cell.params[i * 4 + 2] - (i + 0.5) / stream.cellFull) < 1e-9, `blade ${i} rank`)
  }

  // Same cell coordinates, same blades.
  const again = grow(stream, grass, { ix: 2, iz: -3 }, c, 40)
  assert.deepEqual(Array.from(cell.offsets), Array.from(again.cell.offsets))
  assert.deepEqual(Array.from(cell.params), Array.from(again.cell.params))
  assert.deepEqual(Array.from(cell.patches), Array.from(again.cell.patches))
  // A different cell draws a different stream.
  const other = grow(stream, grass, { ix: 2, iz: -3 }, c + 1, 40)
  assert.notDeepEqual(Array.from(cell.offsets), Array.from(other.cell.offsets))

  // Growing a cell further only appends: the first 12 blades are untouched.
  const tile = { ix: 2, iz: -3 }
  const prefix = stream.createCell(tile, c, cs)
  stream.generate(tile, prefix, c, cs, stream.cellFull, 12)
  const first = Array.from(prefix.offsets.subarray(0, 12 * 4))
  stream.generate(tile, prefix, c, cs, stream.cellFull, 40)
  assert.equal(prefix.count, 40)
  assert.deepEqual(Array.from(prefix.offsets.subarray(0, 12 * 4)), first)
  grass.dispose()
})

test('cells: default clumping spreads tufts no further than half a clump past the cell', () => {
  const grass = new Grass({ camera: new PerspectiveCamera() })
  const { cell, cs, n } = grow(streamFor(grass), grass, { ix: 0, iz: 0 }, 0, 30)
  const pad = grass.settings.clumpSize / 2
  for (let i = 0; i < cell.count; i++) {
    const [x, , z] = cell.offsets.subarray(i * 4, (i + 1) * 4)
    assert.ok(x >= -pad && x <= cs + pad && z >= -pad && z <= cs + pad, `blade ${i} spilled past its tuft`)
  }
  assert.equal(n, Math.round(grass.settings.tileSize / 5))
  grass.dispose()
})

test('grass map: fill sets every texel to the clamped coverage and height', () => {
  const map = new GrassMap({ center: [0, 0], size: 8, resolution: 4 })
  const texels = () => Array.from({ length: 16 }, (_, i) => Array.from(map.data.subarray(i * 4, i * 4 + 4)))
  map.fill(0.5, 1)
  for (const [r, g, b, a] of texels()) assert.deepEqual([r, g, b, a], [128, 128, 0, 255])
  map.fill(0, 0)
  for (const [r, g] of texels()) assert.deepEqual([r, g], [0, 0])
  map.fill(2, 3) // both clamped to 1 and 2x
  for (const [r, g, b, a] of texels()) assert.deepEqual([r, g, b, a], [255, 255, 0, 255])
  map.dispose()
})

test('grass map: paint changes only the brush disc, one channel at a time', () => {
  const map = new GrassMap({ center: [0, 0], size: 32, resolution: 16 }) // 2 m texels
  const res = map.resolution
  const texel = map.size / res
  const rr = 4 / texel
  const before = map.data.slice()
  assert.equal(map.paint(0, 0, { mode: 'erase', radius: 4, strength: 0.5 }), true)

  const cx = (0 - map.minX) / texel - 0.5
  const cz = (0 - map.minZ) / texel - 0.5
  let inside = 0
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const o = (j * res + i) * 4
      const d = Math.hypot(i - cx, j - cz) / rr
      if (d >= 1) {
        assert.deepEqual(Array.from(map.data.subarray(o, o + 4)), Array.from(before.subarray(o, o + 4)), `texel ${i},${j} outside the brush`)
      } else if (d < 0.5) {
        inside++
        assert.ok(map.data[o] >= 140 && map.data[o] <= 180, `centre of the brush darkened`)
        assert.equal(map.data[o + 1], 128, 'height untouched')
      }
    }
  }
  assert.ok(inside > 0)
  // Alpha stays opaque and blue stays reserved.
  for (let i = 3; i < map.data.length; i += 4) assert.equal(map.data[i], 255)

  // Raise only touches green, and never red.
  const mid = map.data.slice()
  map.paint(8, 8, { mode: 'raise', radius: 2, strength: 0.5 })
  for (let i = 0; i < map.data.length; i += 4) {
    assert.equal(map.data[i], mid[i], 'raise leaves coverage alone')
    assert.equal(map.data[i + 3], 255)
  }
  assert.ok(map.data.some((v, i) => i % 4 === 1 && v !== mid[i]), 'raise increased height')

  // A brush entirely off the map is a no-op.
  const away = map.data.slice()
  assert.equal(map.paint(1000, 0, { mode: 'erase', radius: 2, strength: 1 }), false)
  assert.deepEqual(Array.from(map.data), Array.from(away))
  map.dispose()
})
