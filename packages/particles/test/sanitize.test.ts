import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applySchema, type Schema } from '../src/sanitize.ts'
import { DEFAULT_MPM, resolveMPMOptions } from '../src/mpm-reference.ts'
import { DEFAULT_LAVA, resolveLavaOptions } from '../src/mpm-lava.ts'
import { DEFAULT_FLUID_SURFACE, resolveFluidSurfaceOptions } from '../src/fluid-surface.ts'
import { DEFAULT_PUDDLES, resolvePuddleOptions, resolveSplashOptions } from '../src/mpm-water.ts'

const DEFAULTS = {
  n: 2,
  i: 2,
  v: [1, 2, 3],
  round: [3, 4],
  r: [1, 5],
  c: '#112233',
  cs: ['#112233', '#445566'],
  colors: ['#112233', '#445566'],
  e: 'a',
  b: true,
  s: 1,
  t: 'x'
}

const SCHEMA: Schema = {
  n: { type: 'number', min: 0, max: 10 },
  i: { type: 'integer', min: 0, max: 10 },
  v: { type: 'number[]', min: 0, max: 10 },
  round: { type: 'number[]', min: 1, max: 32, round: true },
  r: { type: 'range', min: 0, max: 10 },
  c: { type: 'color' },
  cs: { type: 'color[]' },
  colors: { type: 'colors', max: 2 },
  e: { type: 'enum', values: ['a', 'b'] },
  b: { type: 'boolean' },
  s: { type: 'seed' },
  t: { type: 'string', nonEmpty: true }
}

const fix = (input: object): typeof DEFAULTS => {
  const o = { ...structuredClone(DEFAULTS), ...input }
  return applySchema(o, SCHEMA, DEFAULTS)
}

test('numbers clamp to their bounds and fall back on anything NaN or non-numeric', () => {
  assert.equal(fix({ n: 100 }).n, 10)
  assert.equal(fix({ n: -5 }).n, 0)
  assert.equal(fix({ n: Number.NaN }).n, 2)
  assert.equal(fix({ n: Number.POSITIVE_INFINITY }).n, 2)
  assert.equal(fix({ n: '7' }).n, 2)
  assert.equal(fix({ n: undefined }).n, 2)
})

test('integers round half up after clamping, as the resolvers always have', () => {
  assert.equal(fix({ i: 2.5 }).i, 3)
  assert.equal(fix({ i: 2.4 }).i, 2)
  assert.equal(fix({ i: 9.6 }).i, 10) // clamped to 10, not rounded to 10 from 9.6 beyond the bound
  assert.equal(fix({ i: -0.4 }).i, 0)
  assert.equal(fix({ i: 20.6 }).i, 10)
  assert.equal(fix({ i: '4' }).i, 2)
})

test('number vectors clamp each element, keep the default length, and round only when asked', () => {
  assert.deepEqual(fix({ v: [20, -1] }).v, [10, 0, 3])
  assert.deepEqual(fix({ v: ['20', 5, 1] }).v, [1, 5, 1])
  assert.deepEqual(fix({ v: 'nope' } as object).v, [1, 2, 3])
  assert.deepEqual(fix({ round: [3.5, 0, 99] }).round, [4, 1])
})

test('ranges keep a low-high order', () => {
  assert.deepEqual(fix({ r: [9, 2] }).r, [2, 9])
  assert.deepEqual(fix({ r: [99, -1] }).r, [0, 10])
  assert.deepEqual(fix({ r: [3] } as object).r, [3, 5])
})

test('colors fall back on a bad hex string, per element for a fixed vector', () => {
  assert.equal(fix({ c: 'red' }).c, '#112233')
  assert.equal(fix({ c: '#ABCDEF' }).c, '#ABCDEF')
  assert.equal(fix({ c: 7 } as object).c, '#112233')
  assert.deepEqual(fix({ cs: ['#000000', 'blue'] }).cs, ['#000000', '#445566'])
  assert.deepEqual(fix({ cs: [] } as object).cs, ['#112233', '#445566'])
})

test('colour lists keep the valid entries up to their maximum, else the defaults', () => {
  assert.deepEqual(fix({ colors: ['#000000', 'blue', '#ffffff', '#010101'] }).colors, ['#000000', '#ffffff'])
  assert.deepEqual(fix({ colors: ['bad'] }).colors, ['#112233', '#445566'])
  assert.deepEqual(fix({ colors: 'nope' } as object).colors, ['#112233', '#445566'])
})

test('enums, booleans, seeds and strings reject the wrong type', () => {
  assert.equal(fix({ e: 'c' }).e, 'a')
  assert.equal(fix({ e: 'b' }).e, 'b')
  assert.equal(fix({ b: 1 } as object).b, true)
  assert.equal(fix({ b: false }).b, false)
  assert.equal(fix({ s: 'seed' }).s, 'seed')
  assert.equal(fix({ s: 42 }).s, 42)
  assert.equal(fix({ s: true } as object).s, 1)
  assert.equal(fix({ t: '' }).t, 'x')
  assert.equal(fix({ t: 5 } as object).t, 'x')
})

test('a schema fixes a merged options object in place', () => {
  const o = { ...structuredClone(DEFAULTS), n: 99 }
  assert.equal(applySchema(o, SCHEMA, DEFAULTS), o)
  assert.equal(o.n, 10)
})

test('the dependent bound lowers a value to the already resolved sibling, as the hand-written ladder did', () => {
  assert.equal(resolveMPMOptions({ substeps: 6, maxSubsteps: 1 }).maxSubsteps, 6)
  assert.equal(resolveMPMOptions({ substeps: 3, maxSubsteps: 99 }).maxSubsteps, 64)
  assert.equal(resolveMPMOptions({ substeps: 200 }).maxSubsteps, 64) // substeps clamps first, then bounds maxSubsteps
  assert.equal(resolveMPMOptions({ substeps: 4 }).maxSubsteps, 8)
})

test('a nested option that is not an object comes back from the defaults', () => {
  assert.deepEqual(resolveMPMOptions({ render: null }).render, DEFAULT_MPM.render)
})

test('the solvers keep their own bounds and fallbacks', () => {
  assert.deepEqual(resolvePuddleOptions({ resolution: [3.6, 9999], cellSize: Number.NaN }).resolution, [4, 2048])
  assert.equal(resolvePuddleOptions({ cellSize: Number.NaN }).cellSize, DEFAULT_PUDDLES.cellSize)

  const splash = resolveSplashOptions({ particles: [9.6, 0], maxPerFrame: 3.5 })
  assert.deepEqual(splash.particles, [10, 1])
  assert.equal(splash.maxPerFrame, 4)

  const lava = resolveLavaOptions({ material: '', render: { roughness: 0, crust: 'red', iterations: 9 } })
  assert.equal(lava.material, DEFAULT_LAVA.material)
  assert.equal(lava.render.roughness, 0.02)
  assert.equal(lava.render.crust, DEFAULT_LAVA.render.crust)
  assert.equal(lava.render.iterations, 4)

  const surface = resolveFluidSurfaceOptions({ sky: ['#000000', 'nope'], absorption: [-1, 2, 3.5] })
  assert.deepEqual(surface.sky, ['#000000', DEFAULT_FLUID_SURFACE.sky[1], DEFAULT_FLUID_SURFACE.sky[2]])
  assert.deepEqual(surface.absorption, [0, 2, 3.5])
})
