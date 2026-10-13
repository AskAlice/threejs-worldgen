import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mulberry32 } from 'threejs-biomes'
import { extractBlocks, insetPolygon, isSimplePolygon, orientedBox, polygonArea, polygonsOverlap, RoadGraph, roadsideLots, subdivideBlock, type Vec2 } from '../src/index.ts'

/** n × n grid of streets `size` metres apart. */
function grid(n: number, size: number) {
  const g = new RoadGraph(size)
  const id = (i: number, j: number) => i * n + j
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) g.addNode(i * size, j * size)
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i + 1 < n) g.addEdge(id(i, j), id(i + 1, j), 'minor', 6, 2)
    if (j + 1 < n) g.addEdge(id(i, j), id(i, j + 1), 'minor', 6, 2)
  }
  return g
}

test('blocks are the inner faces of the road graph, inset by half width + sidewalk', () => {
  const g = grid(4, 100)
  // A dead-end spur must not create a face.
  const spur = g.addNode(150, 150)
  g.addEdge(spur, 5, 'minor', 6, 2)
  const blocks = extractBlocks(g)
  assert.equal(blocks.length, 9)
  for (const b of blocks) {
    assert.ok(polygonArea(b.outline) > 0, 'counter-clockwise')
    const inset = 3 + 2 + 0.5
    assert.ok(Math.abs(b.area - (100 - 2 * inset) ** 2) < 1e-6, `area ${b.area}`)
  }
})

test('lots tile a block: areas sum to at most the block, none degenerate, most face a street', () => {
  const block: Vec2[] = [[0, 0], [120, 0], [130, 70], [60, 95], [-5, 60]]
  const area = polygonArea(block)
  for (const seed of [1, 2, 3, 4]) {
    const lots = subdivideBlock(block, { area: 500, width: 12 }, mulberry32(seed))
    assert.ok(lots.length > 6)
    let sum = 0
    for (const l of lots) {
      sum += l.area
      assert.ok(l.area > 12 * 12 * 0.35, `lot area ${l.area}`)
      assert.ok(isSimplePolygon(l.polygon), 'simple')
      assert.ok(polygonArea(l.polygon) > 0, 'counter-clockwise')
      assert.ok(orientedBox(l.polygon).halfWidth * 2 >= 12 * 0.5 - 1e-6, 'not a sliver')
      assert.equal(l.street.length, l.polygon.length)
    }
    assert.ok(sum <= area + 1e-6, `${sum} > ${area}`)
    assert.ok(lots.filter((l) => l.front >= 0).length / lots.length > 0.7, 'street frontage')
    for (let i = 0; i < lots.length; i++) for (let j = i + 1; j < lots.length; j++) {
      const a = insetPolygon(lots[i].polygon, 0.01), b = insetPolygon(lots[j].polygon, 0.01)
      if (a && b) assert.ok(!polygonsOverlap(a, b), `lots ${i} and ${j} overlap`)
    }
  }
})

test('insetPolygon shrinks squares exactly and refuses to invert', () => {
  const sq: Vec2[] = [[0, 0], [10, 0], [10, 10], [0, 10]]
  assert.ok(Math.abs(polygonArea(insetPolygon(sq, 1)!) - 64) < 1e-9)
  assert.equal(insetPolygon(sq, 6), null)
})

test('roadside lots line open roads without overlapping each other or the road', () => {
  const g = new RoadGraph(30)
  const ids = [0, 1, 2, 3, 4].map((i) => g.addNode(i * 40, Math.sin(i) * 8))
  for (let i = 0; i < 4; i++) g.addEdge(ids[i], ids[i + 1], 'secondary', 8, 0)
  const lots = roadsideLots(g, () => ({ area: 450, width: 14 }), () => false)
  assert.ok(lots.length >= 8)
  for (let i = 0; i < lots.length; i++) {
    assert.ok(polygonArea(lots[i].polygon) > 0)
    assert.equal(lots[i].front, 0)
    for (let j = i + 1; j < lots.length; j++) assert.ok(!polygonsOverlap(lots[i].polygon, lots[j].polygon))
  }
})
