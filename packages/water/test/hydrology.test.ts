import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeHydrology, fillDepressions, flowAccumulation, flowReceivers, hydrologyWaterAt, riverModifiers, sampleGrid, type HydrologyGrid } from '../src/hydrology.ts'

const grid = (cols: number, rows: number, f: (c: number, r: number) => number, cellSize = 1): HydrologyGrid => {
  const heights = new Float64Array(cols * rows)
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = f(c, r)
  return { cols, rows, cellSize, x0: 0, z0: 0, heights }
}

// A bowl with a rim at 10 and one notch in the rim at 6: water fills it to exactly 6.
const basin = grid(21, 21, (c, r) => {
  const edge = c === 0 || r === 0 || c === 20 || r === 20
  if (edge) return c === 10 && r === 0 ? 6 : 10
  return 2 + Math.hypot(c - 10, r - 10) * 0.1
})

test('a closed basin fills exactly to its spill level', () => {
  const filled = fillDepressions(basin.heights, basin.cols, basin.rows, 0)
  for (let r = 1; r < 20; r++) for (let c = 1; c < 20; c++) assert.equal(filled[r * 21 + c], 6)
  // Nothing is ever lowered.
  for (let i = 0; i < filled.length; i++) assert.ok(filled[i] >= basin.heights[i])
})

test('after an ε-fill every non-outlet cell drains strictly downhill to an outlet', () => {
  const g = grid(40, 30, (c, r) => Math.sin(c * 0.7) * 3 + Math.cos(r * 0.5) * 2 + ((c * 7 + r * 13) % 5) * 0.4)
  const filled = fillDepressions(g.heights, g.cols, g.rows, 1e-3)
  const receivers = flowReceivers(filled, g.cols, g.rows)
  for (let i = 0; i < receivers.length; i++) {
    const c = i % g.cols, r = (i / g.cols) | 0
    const edge = c === 0 || r === 0 || c === g.cols - 1 || r === g.rows - 1
    if (receivers[i] < 0) { assert.ok(edge, `interior sink at ${c},${r}`); continue }
    assert.ok(filled[receivers[i]] < filled[i], 'flow goes downhill')
    // Following receivers always ends at an outlet (no cycles).
    let j = i, steps = 0
    while (receivers[j] >= 0) { j = receivers[j]; assert.ok(++steps <= receivers.length) }
  }
})

test('flow accumulation conserves area: outlets receive every cell exactly once', () => {
  const g = grid(25, 25, (c, r) => (c - 12) ** 2 * 0.01 + r * 0.3 + Math.sin(c + r) * 0.2, 2)
  const filled = fillDepressions(g.heights, g.cols, g.rows, 1e-3)
  const receivers = flowReceivers(filled, g.cols, g.rows)
  const { accumulation, order } = flowAccumulation(receivers, 4)
  let atOutlets = 0
  for (let i = 0; i < receivers.length; i++) if (receivers[i] < 0) atOutlets += accumulation[i]
  assert.equal(atOutlets, g.cols * g.rows * 4)
  assert.equal(new Set(order).size, receivers.length, 'order visits every cell once')
  for (let i = 0; i < receivers.length; i++) if (receivers[i] >= 0) assert.ok(accumulation[receivers[i]] > accumulation[i])
})

test('sea cells are outlets and are never filled', () => {
  const g = grid(20, 20, (c) => c - 5) // sea (≤ 0) on the west
  const result = analyzeHydrology(g, { seaLevel: 0, riverArea: 1e9 })
  for (let i = 0; i < g.heights.length; i++) {
    if (g.heights[i] <= 0) {
      assert.equal(result.filled[i], g.heights[i])
      assert.equal(result.receivers[i], -1)
    }
  }
})

test('lakes: the basin is one lake at its spill level with the right area and depth', () => {
  const result = analyzeHydrology(basin, { minLakeArea: 1, minLakeDepth: 0.1 })
  assert.equal(result.lakes.length, 1)
  const lake = result.lakes[0]
  assert.equal(lake.level, 6)
  assert.equal(lake.area, 19 * 19)
  assert.ok(Math.abs(lake.maxDepth - 4) < 1e-9)
  assert.equal(lake.mask.reduce((a, b) => a + b, 0), 19 * 19)
  assert.equal(hydrologyWaterAt(result, 10, 10).kind, 'lake')
  assert.equal(hydrologyWaterAt(result, 10, 10).depth, 4)
  // Too-small lakes are dropped.
  assert.equal(analyzeHydrology(basin, { minLakeArea: 1000 }).lakes.length, 0)
})

test('rivers: a valley gives a river that widens and never rises downstream', () => {
  // A V-shaped valley draining south (+z) with a little noise.
  const g = grid(61, 121, (c, r) => Math.abs(c - 30) * 0.5 + (120 - r) * 0.2 + Math.sin(c * 1.3 + r * 0.7) * 0.05, 10)
  const result = analyzeHydrology(g, { riverArea: 50_000, smoothing: 1 })
  assert.ok(result.rivers.length >= 1)
  const main = result.rivers.reduce((a, b) => (a.points.length > b.points.length ? a : b))
  assert.ok(main.points.length > 50, 'main stem runs down the valley')
  for (let i = 1; i < main.points.length; i++) {
    assert.ok(main.bed[i] <= main.bed[i - 1] + 1e-12, 'bed descends')
    assert.ok(main.surface[i] <= main.surface[i - 1] + 1e-12, 'surface descends')
    assert.ok(main.area[i] >= main.area[i - 1], 'area grows')
    assert.ok(main.surface[i] > main.bed[i])
  }
  assert.ok(main.width.at(-1)! > main.width[0])
  const mods = riverModifiers(result)
  assert.ok(mods.length > 0)
  for (const m of mods) {
    assert.equal(m.type, 'path')
    for (const [, y] of m.points) assert.equal(y, 0) // flat world: points are [x, 0, z, height]
    for (let i = 1; i < m.points.length; i++) assert.ok(m.points[i][3] <= m.points[i - 1][3] + 1e-12)
  }
  const mid = main.points[Math.floor(main.points.length / 2)]
  const w = hydrologyWaterAt(result, mid[0], mid[1])
  assert.equal(w.kind, 'river')
  assert.ok(w.flowZ > 0, 'flows south, downhill')
})

test('sampleGrid covers the region edges', () => {
  const g = sampleGrid((x, z) => x + z * 100, { x: -10, z: 5, width: 20, depth: 10, cellSize: 2 })
  assert.equal(g.cols, 11)
  assert.equal(g.rows, 6)
  assert.equal(g.heights[0], -10 + 500)
  assert.equal(g.heights[g.heights.length - 1], 10 + 1500)
})
