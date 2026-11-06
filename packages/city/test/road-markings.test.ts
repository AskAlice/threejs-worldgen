import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCityUniforms, resolveCityOptions, ROAD_MARKINGS, roadSurfaceLook } from '../src/index.ts'
import { createRoadMaterial } from '../src/road-material.ts'
import type { RoadType } from '../src/graph.ts'

const CLASSES: readonly RoadType[] = ['primary', 'secondary', 'minor']

test('every road class gets its own markings', () => {
  assert.equal(new Set(CLASSES.map((t) => JSON.stringify(ROAD_MARKINGS[t]))).size, CLASSES.length)
  // Arterials: a double centre line and two lanes each way. Collectors: one dashed line, one lane. Local streets: bare edges.
  assert.equal(ROAD_MARKINGS.primary.centreLine, 'double')
  assert.equal(ROAD_MARKINGS.primary.lanes, 2)
  assert.ok(ROAD_MARKINGS.primary.laneLines && ROAD_MARKINGS.primary.edgeLines)
  assert.equal(ROAD_MARKINGS.secondary.centreLine, 'dashed')
  assert.equal(ROAD_MARKINGS.secondary.lanes, 1)
  assert.equal(ROAD_MARKINGS.secondary.laneLines, false)
  assert.equal(ROAD_MARKINGS.minor.centreLine, 'none')
  assert.equal(ROAD_MARKINGS.minor.lanes, 1)
  assert.equal(ROAD_MARKINGS.minor.edgeLines, false)
  for (const t of CLASSES) {
    assert.ok(ROAD_MARKINGS[t].lanes >= 1, `${t}: no lanes`)
    assert.ok(['none', 'dashed', 'solid', 'double'].includes(ROAD_MARKINGS[t].centreLine), `${t}: bad centre line`)
  }
})

test('markings are a material-wide paint switch, the styles come from the road class attribute', () => {
  const look = resolveCityOptions({}).roadLook
  assert.equal(roadSurfaceLook(look).markings, true)
  assert.equal(roadSurfaceLook({ ...look, markings: false }).markings, false)
  // One material draws every class, so it carries no material-wide centre line, lane or edge style.
  const s = roadSurfaceLook(look)
  assert.equal(s.centreLine, undefined)
  assert.equal(s.laneLines, undefined)
  assert.equal(s.edgeLines, undefined)
})

test('the road material builds with the per-class inputs', () => {
  const r = createRoadMaterial(createCityUniforms(), resolveCityOptions({}).roadLook)
  assert.equal(r.material.name, 'props/road-surface')
  r.dispose()
})
