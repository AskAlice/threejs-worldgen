import { test } from 'node:test'
import assert from 'node:assert/strict'
import { World, type HeightModifier } from '../src/world.ts'

test('every one of thousands of modifiers is found by the spatial index', () => {
  const world = new World({ seed: 3 })
  const mods: HeightModifier[] = []
  for (let i = 0; i < 60; i++) for (let j = 0; j < 60; j++)
    mods.push({ type: 'circle', center: [i * 40 - 1200, 0, j * 40 - 1200], radius: 4, falloff: 4, height: (i * 60 + j) % 97 })
  world.addModifier(...mods)
  for (const m of mods) {
    const c = (m as Extract<HeightModifier, { type: 'circle' }>)
    assert.ok(Math.abs(world.height(c.center[0], c.center[2]) - (c.height as number)) < 1e-9)
  }
})

test('modifiers apply in insertion order, including ones too big for the grid', () => {
  const big: HeightModifier = { type: 'circle', center: [0, 0, 0], radius: 50_000, falloff: 10, height: 100 }
  const small: HeightModifier = { type: 'circle', center: [0, 0, 0], radius: 2, falloff: 2, height: 7 }
  const filler: HeightModifier[] = Array.from({ length: 50 }, (_, i) => ({ type: 'circle', center: [i * 30 + 500, 0, 0], radius: 3, falloff: 3, height: 1 }))
  assert.equal(new World({ seed: 3 }).addModifier(...filler, big, small).height(0, 0), 7)
  assert.equal(new World({ seed: 3 }).addModifier(...filler, small, big).height(0, 0), 100)
})
