import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DISTRICTS, DEFAULT_ROADS, DEFAULT_TENSOR_FIELD, DistrictMap, generateRoads, RoadGraph, segmentIntersection, Site, TensorField } from '../src/index.ts'

const R = 600
function town(seed = 1) {
  const site = Site.around(0, 0, R * 1.45, 10).fill((x, z) => ({ height: Math.sin(x / 300) * 20, waterLevel: Math.abs(x - 250 + Math.sin(z / 100) * 30) < 20 ? -2 : NaN }))
  const districts = new DistrictMap(DEFAULT_DISTRICTS, { downtown: 0.2, farmland: 0.85, industrial: 0.15, park: 0.06 }, 0, 0, R, seed)
  const field = new TensorField(DEFAULT_TENSOR_FIELD, 0, 0, R, seed, site)
  return generateRoads({ site, field, districts, cx: 0, cz: 0, radius: R, arms: 4, seed }, DEFAULT_ROADS)
}

test('addEdge refuses crossings, duplicates and nodes on the edge', () => {
  const g = new RoadGraph(10)
  const a = g.addNode(0, 0), b = g.addNode(10, 0), c = g.addNode(5, -5), d = g.addNode(5, 5), e = g.addNode(20, 0)
  assert.ok(g.addEdge(a, b, 'minor', 6, 2) >= 0)
  assert.equal(g.addEdge(c, d, 'minor', 6, 2), -1, 'crossing without a node')
  assert.equal(g.addEdge(b, a, 'minor', 6, 2), -1, 'duplicate')
  const m = g.splitEdge(0, 5, 0.3)
  assert.ok(g.addEdge(c, m, 'minor', 6, 2) >= 0 && g.addEdge(m, d, 'minor', 6, 2) >= 0, 'crossing through the split node')
  assert.equal(g.addEdge(a, e, 'minor', 6, 2), -1, 'overlaps existing edges')
  assert.deepEqual(g.shortestPath(c, b), [c, m, b])
})

test('grown network is planar: no two edges cross away from a shared node', () => {
  const g = town()
  assert.ok(g.edges.length > 100)
  for (let i = 0; i < g.edges.length; i++) {
    const e = g.edges[i], a = g.nodes[e.a], b = g.nodes[e.b]
    for (let j = i + 1; j < g.edges.length; j++) {
      const f = g.edges[j]
      if (f.a === e.a || f.a === e.b || f.b === e.a || f.b === e.b) continue
      const c = g.nodes[f.a], d = g.nodes[f.b]
      assert.equal(segmentIntersection(a.x, a.z, b.x, b.z, c.x, c.z, d.x, d.z), null, `edges ${i} and ${j} cross`)
    }
  }
})

test('grown network is connected and bridges the river', () => {
  const g = town()
  const visited = new Uint8Array(g.nodes.length)
  const queue = [0]
  visited[0] = 1
  while (queue.length) {
    const n = queue.pop()!
    for (const e of g.nodes[n].edges) { const m = g.other(e, n); if (!visited[m]) { visited[m] = 1; queue.push(m) } }
  }
  assert.equal(visited.reduce((s, v) => s + v, 0), g.nodes.length)
  assert.ok(g.edges.some((e) => e.bridge), 'at least one bridge')
})

test('snapping merges road ends: no two distinct nodes closer than a metre', () => {
  const g = town(7)
  for (let i = 0; i < g.nodes.length; i++) {
    const near = g.nearestNode(g.nodes[i].x, g.nodes[i].z, 1, (n) => n === i)
    assert.equal(near, -1, `node ${i} has a twin`)
  }
})

test('growth is deterministic', () => {
  assert.deepEqual(town(3).toJSON(), town(3).toJSON())
})
