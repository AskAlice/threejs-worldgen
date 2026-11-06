import { test } from 'node:test'
import assert from 'node:assert/strict'
import { merge, resolve } from '../src/index.ts'

test('merge: nested objects merge, arrays and scalars replace, undefined is skipped, null replaces', () => {
  const base = { a: 1, nested: { x: 1, y: 2 }, list: [1, 2, 3], keep: 'yes', gone: 'value' }
  const out = merge(structuredClone(base), { a: 2, nested: { y: 20, z: 30 }, list: [9], keep: undefined, gone: null })
  assert.deepEqual(out, { a: 2, nested: { x: 1, y: 20, z: 30 }, list: [9], keep: 'yes', gone: null })
})

test('resolve: clones the defaults, so neither side aliases the other', () => {
  const defaults = { nested: { x: 1 }, list: [1, 2] }
  const out = resolve(defaults, { nested: { y: 2 }, list: [3] })
  assert.deepEqual(out, { nested: { x: 1, y: 2 }, list: [3] })
  assert.deepEqual(defaults, { nested: { x: 1 }, list: [1, 2] })
  out.list.push(4)
  assert.deepEqual(defaults.list, [1, 2])
})

test('resolve: applies inputs in order, later wins', () => {
  assert.deepEqual(resolve({ a: 1, b: 1 }, { a: 2 }, { a: 3, b: undefined }), { a: 3, b: 1 })
})

test('merge: ignores prototype keys and non-object input', () => {
  const target = { a: 1 }
  const out = merge(target, JSON.parse('{"__proto__": {"polluted": 1}, "constructor": {"x": 1}, "a": 2}'))
  assert.deepEqual(out, { a: 2 })
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  assert.equal(merge(target, null), target)
  assert.equal(merge(target, 'nope'), target)
})
