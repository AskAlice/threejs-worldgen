import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compositePopulationMap } from '../src/population-map.ts'

const px = (...rgba: number[]) => new Uint8ClampedArray(rgba) as Uint8ClampedArray<ArrayBuffer>

test('compositePopulationMap: transparent overlay pixels keep the world map colour', () => {
  const base = px(10, 20, 30, 255)
  assert.deepEqual([...compositePopulationMap(base, px(200, 0, 0, 0))], [10, 20, 30, 255])
})

test('compositePopulationMap: opaque overlay pixels blend at alpha and keep the base alpha', () => {
  const base = px(0, 0, 0, 255)
  assert.deepEqual([...compositePopulationMap(base, px(100, 200, 0, 255))], [75, 150, 0, 255])
  assert.deepEqual([...compositePopulationMap(px(0, 0, 0, 255), px(100, 200, 0, 255), 1)], [100, 200, 0, 255])
})

test('compositePopulationMap: composes pixel by pixel and returns the base', () => {
  const base = px(0, 0, 0, 255, 10, 20, 30, 255)
  const top = px(255, 255, 255, 255, 0, 0, 0, 0)
  assert.equal(compositePopulationMap(base, top), base)
  assert.deepEqual([...base], [191, 191, 191, 255, 10, 20, 30, 255])
})
