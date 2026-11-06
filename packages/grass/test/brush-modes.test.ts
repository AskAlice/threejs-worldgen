import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GrassMap, type BrushMode } from '../src/grass-map.ts'

// One row per brush mode: target channel and direction. Every mode must behave as before.
const CASES: { mode: BrushMode; channel: 0 | 1; sign: 1 | -1 }[] = [
  { mode: 'add', channel: 0, sign: 1 },
  { mode: 'erase', channel: 0, sign: -1 },
  { mode: 'raise', channel: 1, sign: 1 },
  { mode: 'lower', channel: 1, sign: -1 },
]

for (const { mode, channel, sign } of CASES) {
  test(`paint with mode "${mode}" moves only the ${channel ? 'height' : 'coverage'} channel`, () => {
    const map = new GrassMap({ center: [0, 0], size: 32, resolution: 32, coverage: 0.5, height: 1 })
    const i = (16 * map.resolution + 16) * 4
    const before = [map.data[i], map.data[i + 1]]
    assert.equal(map.paint(0, 0, { mode, radius: 4, strength: 0.5 }), true)

    const other = channel === 0 ? 1 : 0
    assert.equal(map.data[i + other], before[other], 'other channel unchanged')
    if (sign > 0) assert.ok(map.data[i + channel] > before[channel], 'target channel increased')
    else assert.ok(map.data[i + channel] < before[channel], 'target channel decreased')
  })
}
