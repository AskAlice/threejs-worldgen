import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Object3D } from 'three/webgpu'
import { mount, terrainKey } from '../src/lifecycle.ts'

// The shared wrapper lifecycle: create (maybe async), attach, dispose exactly once, and terrain keying.
// `mount` is the React-free core of `useInstance`; these tests pin the unmount-mid-create rule the
// components rely on.

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('a synchronous instance attaches at once and is disposed once on cancel', () => {
  const attached: string[] = []
  const disposed: string[] = []
  const cancel = mount(
    () => 'field',
    (field) => disposed.push(field),
    (field) => attached.push(field)
  )

  assert.deepEqual(attached, ['field'])
  assert.deepEqual(disposed, [])

  cancel()
  assert.deepEqual(disposed, ['field'])
  cancel()
  assert.deepEqual(disposed, ['field'], 'cancel is idempotent')
})

test('a resolved async instance attaches once and is disposed once when unmounted', async () => {
  const create = deferred<string>()
  const attached: string[] = []
  const disposed: string[] = []
  const cancel = mount(
    () => create.promise,
    (field) => disposed.push(field),
    (field) => attached.push(field)
  )

  assert.deepEqual(attached, [], 'nothing attaches before the create resolves')
  create.resolve('field')
  await create.promise
  assert.deepEqual(attached, ['field'])
  assert.deepEqual(disposed, [])

  cancel()
  assert.deepEqual(disposed, ['field'])
})

test('unmounting mid-create disposes the created field exactly once and never attaches it', async () => {
  const create = deferred<string>()
  const attached: string[] = []
  const disposed: string[] = []
  let creations = 0
  const cancel = mount(
    () => {
      creations++
      return create.promise
    },
    (field) => disposed.push(field),
    (field) => attached.push(field)
  )

  assert.equal(creations, 1)
  cancel() // unmount before the create resolves
  create.resolve('field')
  await create.promise

  assert.deepEqual(attached, [], 'a cancelled create is never attached')
  assert.deepEqual(disposed, ['field'], 'the created field is disposed exactly once')

  cancel()
  assert.deepEqual(disposed, ['field'], 'the cleanup does not dispose it again')
})

test('a cancelled create does not disturb the instance mounted after it', async () => {
  const first = deferred<string>()
  const disposed: string[] = []
  const attached: string[] = []
  const cancelFirst = mount(
    () => first.promise,
    (field) => disposed.push(field),
    (field) => attached.push(field)
  )

  cancelFirst()
  const cancelSecond = mount(
    () => 'second',
    (field) => disposed.push(field),
    (field) => attached.push(field)
  )
  first.resolve('first')
  await first.promise

  assert.deepEqual(attached, ['second'], 'only the live instance is attached')
  assert.deepEqual(disposed, ['first'], 'the abandoned create is disposed, not the live one')

  cancelSecond()
  assert.deepEqual(disposed, ['first', 'second'])
})

test('a terrain ref keeps its identity, so a late mount adopts instead of recreating', () => {
  const terrain = { current: null as Object3D | null }
  assert.equal(terrainKey(terrain), terrain, 'the ref itself is the key, even while empty')
  assert.equal(terrainKey(terrain), terrain, 'the key does not change when the ref fills')

  const object = {} as Object3D
  assert.equal(terrainKey(object), object, 'a plain object keys on its identity')

  assert.equal(
    terrainKey(() => 1),
    null,
    'a height function is read live, not keyed'
  )
  assert.equal(
    terrainKey(() => 2),
    null,
    'a new inline function is not a new terrain'
  )
})
