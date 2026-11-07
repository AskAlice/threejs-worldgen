import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SEA_BANDS, seabedWeights, seabedWeightsAtHeight } from '../src/seabed.ts'

const steps = 20_000
const span = 220
const depthAt = (i: number) => -10 + (i * span) / steps

test('seabed weights stay a valid blend and dry out above the waterline', () => {
  for (let i = 0; i <= steps; i++) {
    const d = depthAt(i)
    const w = seabedWeights(d)
    assert.ok(
      w.every((x) => x >= 0 && x <= 1),
      `weights in range at ${d} m`
    )
    assert.ok(w[0] + w[1] + w[2] <= 1 + 1e-9, `weights do not overfill at ${d} m`)
  }
  assert.deepEqual(seabedWeights(-1), [0, 0, 0])
  assert.deepEqual(seabedWeights(0), [0, 0, 0])
  assert.deepEqual(seabedWeights(200), [0, 0, 1])
})

test('seabed darkens with depth: shelf weight only falls, abyss weight only rises', () => {
  // Below the shoreline ramp (1.5 m) the tint is fully on, so the bands only shift with depth.
  let prev = seabedWeights(1.5)
  for (let i = 1; i <= steps; i++) {
    const d = depthAt(i)
    if (d < 1.5) continue
    const w = seabedWeights(d)
    assert.ok(w[0] <= prev[0] + 1e-9, `shelf weight rose at ${d} m`)
    assert.ok(w[2] >= prev[2] - 1e-9, `abyss weight fell at ${d} m`)
    prev = w
  }
})

test('seabed bands are distinguishable', () => {
  const shelf = seabedWeights(4)
  assert.ok(shelf[0] > 0.5 && shelf[0] > shelf[1] && shelf[0] > shelf[2], 'shallow shelf is mainly turquoise')
  const slope = seabedWeights((SEA_BANDS.shelf + SEA_BANDS.slope) / 2)
  assert.ok(slope[1] > 0.9, 'mid depth is mainly blue-green')
  assert.ok(Math.abs(slope[1] - shelf[1]) > 0.3 && Math.abs(slope[1] - seabedWeights(200)[1]) > 0.3)
  const abyss = seabedWeights(SEA_BANDS.abyss + 20)
  assert.ok(abyss[2] > 0.99, 'deep ocean is fully dark')
})

test('no step at the band thresholds', () => {
  for (const edge of [0, 1.5, SEA_BANDS.shelf, SEA_BANDS.slope, SEA_BANDS.abyss]) {
    for (let k = 0; k < 3; k++) {
      const jump = Math.abs(seabedWeights(edge + 1e-3)[k] - seabedWeights(edge - 1e-3)[k])
      assert.ok(jump < 5e-3, `weight ${k} jumps ${jump} at ${edge} m`)
    }
  }
  // Sweep the whole ramp: neighbouring samples never jump (the bands are continuous, not quantised).
  let prev = seabedWeights(depthAt(0))
  for (let i = 1; i <= steps; i++) {
    const w = seabedWeights(depthAt(i))
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(w[k] - prev[k]) < 0.02, `discontinuity at ${depthAt(i)} m`)
    prev = w
  }
})

test('jitter shifts the bands without breaking them', () => {
  const flat = seabedWeights(SEA_BANDS.shelf / 2)
  assert.ok(seabedWeights(SEA_BANDS.shelf / 2, 1)[0] < flat[0], 'positive jitter reads deeper')
  assert.ok(seabedWeights(SEA_BANDS.shelf / 2, -1)[0] > flat[0], 'negative jitter reads shallower')
  for (const jitter of [-1, 0, 1]) {
    const w = seabedWeights(6, jitter)
    assert.ok(w.every((x) => x >= 0 && x <= 1))
  }
})

// Peak slope of a smoothstep edge of width `w` (at the midpoint). Every band edge is one.
const edgeSlope = (width: number) => 1.5 / width
// Sum of the band slopes, the steepest the weights can change per metre of height.
const STEEPEST =
  edgeSlope(1.5) +
  edgeSlope(SEA_BANDS.shelf) +
  edgeSlope(SEA_BANDS.slope - SEA_BANDS.shelf) +
  edgeSlope(SEA_BANDS.abyss - SEA_BANDS.slope)

test('weights come from the fragment height, not from interpolating the triangle vertices', () => {
  // What per-vertex banding does (the old shader): weights at the two vertices of an aerial-LOD
  // triangle, linearly interpolated across it. A 30 m drop across one triangle facets the edge by a
  // large fraction of a band, which is what drew the stepped contours along the mesh.
  const top = seabedWeightsAtHeight(20)
  const bottom = seabedWeightsAtHeight(-10)
  let faceted = 0
  for (let i = 0; i <= 200; i++) {
    const t = i / 200
    const fragment = seabedWeightsAtHeight(20 - 30 * t)
    for (let k = 0; k < 3; k++) {
      faceted = Math.max(faceted, Math.abs(top[k] + (bottom[k] - top[k]) * t - fragment[k]))
    }
  }
  assert.ok(faceted > 0.1, `a coarse triangle would facet the bands by ${faceted.toFixed(3)}`)

  // The fragment function is the only input: the same height gives the same weights at every mesh
  // resolution, and a height-derived depth is exactly the mirrored depth API.
  for (let h = -200; h <= 60; h += 0.5) {
    assert.deepEqual(seabedWeightsAtHeight(h), seabedWeights(-h))
  }
})

test('band edges are continuous at any pixel scale: no step between neighbouring fragments', () => {
  // 2.5 km aerial view: one pixel spans about 4 m of surface height. Across it each weight may move
  // by its own slope times the height delta, and never by a jump.
  const pixel = 4
  let prev = seabedWeightsAtHeight(60)
  for (let h = 60 - pixel; h >= -200; h -= pixel) {
    const w = seabedWeightsAtHeight(h)
    for (let k = 0; k < 3; k++) {
      assert.ok(
        Math.abs(w[k] - prev[k]) <= STEEPEST * pixel + 1e-9,
        `weight ${k} steps by ${Math.abs(w[k] - prev[k]).toFixed(3)} at ${h.toFixed(1)} m`
      )
    }
    prev = w
  }
})

test('the far-range jitter moves the shallow band edges, so their contours cannot survive', () => {
  // The shader adds `farDetail * 2.5` metres of world-anchored noise to the depth, so the shore and
  // shelf edges (1.5 m and 10 m wide — the ones that read as hard rings at aerial range) each move
  // by ±2.5 m of depth, well over a fifth of their own width. Deeper bands are broad gradients with
  // no hairline edge to break.
  const jitter = 2.5
  for (const [name, depth] of [
    ['shore', 0.75],
    ['shelf', 9]
  ] as const) {
    const a = seabedWeights(depth, jitter)
    const b = seabedWeights(depth, -jitter)
    const moved = Math.max(...a.map((x, k) => Math.abs(x - b[k])))
    assert.ok(moved > 0.15, `${name} band edge moves too little (${moved.toFixed(3)})`)
  }
  // The jitter itself cannot introduce a contour: sweeping it is continuous at every depth.
  for (const depth of [-2, 0.75, 5, 9, 22, 50, 100, 150]) {
    let prev = seabedWeights(depth, -jitter)
    for (let j = -jitter + 0.05; j <= jitter; j += 0.05) {
      const w = seabedWeights(depth, j)
      for (let k = 0; k < 3; k++) {
        assert.ok(Math.abs(w[k] - prev[k]) <= STEEPEST * 0.05 + 1e-9, `jitter steps the bands at ${depth} m`)
      }
      prev = w
    }
  }
})
