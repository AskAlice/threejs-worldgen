import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GROUND_MATERIALS } from '../src/biomes.ts'
import { renderWorldMap } from '../src/map.ts'
import { World } from '../src/world.ts'

const flat = (landBias: number) =>
  new World({
    seed: 3,
    continents: { landBias },
    mountains: { height: 0 },
    hills: { height: 0 },
    detail: { height: 0 },
    micro: { height: 0 },
    rivers: { enabled: false }
  })

// The map must derive land colour from the same palette the 3D ground does, not from the saturated
// debug biome colours; water must use the ocean's deep sea colour.
test('biome map land matches the 3D ground palette', () => {
  const world = flat(1)
  const n = 8,
    size = 2000,
    cell = size / n
  const px = renderWorldMap(world, { mode: 'biomes', center: [0, 0], size, resolution: n, shade: false })
  const i = 3,
    j = 5
  const s = world.sampleAt((i + 0.5 - n / 2) * cell, 0, (j + 0.5 - n / 2) * cell)
  assert.ok(s.elevation > world.options.seaLevel, 'test point is land')
  const { color } = world.ground(s, 0, new Float32Array(GROUND_MATERIALS.length), new Float32Array(3))
  assert.equal(px[(j * n + i) * 4 + 3], 255)
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(px[(j * n + i) * 4 + k] - color[k] * 255) <= 1, `channel ${k}`)
  // ...and it is not the biome debug colour the map used to paint.
  const debug = world.options.biomes[s.biomes[0]].color
  const rgb = [parseInt(debug.slice(1, 3), 16), parseInt(debug.slice(3, 5), 16), parseInt(debug.slice(5, 7), 16)]
  assert.notDeepEqual([...px.slice((j * n + i) * 4, (j * n + i) * 4 + 3)], rgb)
})

test('biome map water uses the ocean sea colour', () => {
  const px = renderWorldMap(flat(-1), { mode: 'biomes', center: [0, 0], size: 2000, resolution: 8, shade: false })
  for (let k = 0; k < 8 * 8; k++) assert.deepEqual([...px.slice(k * 4, k * 4 + 3)], [11, 50, 71])
})
