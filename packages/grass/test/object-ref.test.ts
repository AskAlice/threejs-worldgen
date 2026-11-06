import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Object3D } from 'three/webgpu'
import { resolveObject } from '../src/grass.ts'

// The one resolver both entry points use for terrain and interactors.

test('resolveObject returns a plain object unchanged', () => {
  const object = new Object3D()
  assert.equal(resolveObject(object), object)
})

test('resolveObject unwraps a ref object', () => {
  const object = new Object3D()
  assert.equal(resolveObject({ current: object }), object)
})

test('resolveObject returns null for an unmounted ref and for undefined', () => {
  assert.equal(resolveObject({ current: null }), null)
  assert.equal(resolveObject(undefined), null)
})
