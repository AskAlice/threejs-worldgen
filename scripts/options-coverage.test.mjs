import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coverage, levaTarget, paramDefaults, UnparsedDefault } from './options-coverage.mjs'
import * as leva from '../example/leva-options.ts'

test('every primitive option editable: nothing to report', () => {
  const defaults = { a: 1, b: 'x', c: true, d: { e: 2, f: '#ffffff' } }
  assert.deepEqual(coverage(defaults, { target: structuredClone(defaults) }), { uncovered: [], unreasoned: [], unused: [], unparsed: [] })
})

test('target defaults to the defaults object', () => {
  assert.deepEqual(coverage({ a: 1 }).uncovered, [])
})

test('reports nested paths missing from the target', () => {
  const defaults = { a: 1, d: { e: 2, f: { g: 3 } } }
  assert.deepEqual(coverage(defaults, { target: { a: 1, d: { e: 2 } } }).uncovered, ['d.f.g'])
})

test('null, functions and arrays are not editable unless skipped (arrays: only with `arrays`)', () => {
  const defaults = { n: null, fn: () => 0, list: [1, 2], none: [] }
  assert.deepEqual(coverage(defaults).uncovered, ['n', 'fn', 'list', 'none'])
  assert.deepEqual(coverage(defaults, { arrays: true }).uncovered, ['n', 'fn', 'none'])
})

test('a bare skip name matches that key at any depth', () => {
  const defaults = { seed: 1, layer: { seed: 2, origin: [0, 0] } }
  const r = coverage(defaults, { skip: { seed: 'derived from the world seed', origin: 'set by the sandbox' } })
  assert.deepEqual(r, { uncovered: [], unreasoned: [], unused: [], unparsed: [] })
})

test('a dotted skip matches only that path and what is under it', () => {
  const defaults = { facade: { walls: { brick: null } }, weather: { walls: { wet: null } } }
  const r = coverage(defaults, { skip: { 'facade.walls': 'palettes' } })
  assert.deepEqual(r.uncovered, ['weather.walls.wet'])
})

test('skips need a reason, and stale skips are reported', () => {
  const r = coverage({ a: 1, b: null }, { skip: { b: '  ', gone: 'renamed', 'a.x': 'not a path' } })
  assert.deepEqual(r.unreasoned, ['b'])
  assert.deepEqual(r.unused, ['gone', 'a.x'])
  assert.deepEqual(r.uncovered, [])
})

test('paramDefaults reads literal parameter defaults', () => {
  function f(sample, x, z, e = 0.25, name = 'a', on = true, opts = {}) { return [sample, x, z, e, name, on, opts] }
  assert.deepEqual(paramDefaults(f), { e: 0.25, name: 'a', on: true, opts: {} })
})

test('paramDefaults: destructured parameters, by property key', () => {
  function f(world, { a = 1, b = 0.5, renamed: r = 'x', nested: { deep = 2 } = {}, ...rest } = {}) { return [world, a, b, r, deep, rest] }
  assert.deepEqual(paramDefaults(f), { a: 1, b: 0.5, renamed: 'x', nested: { deep: 2 } })
})

test('paramDefaults: nested parentheses, brackets, strings and comments do not end the list', () => {
  function f(a = Math.max(1, 2), b = [3, (4)], c = '),(', /* d = 9, */ e = (1 + 2) * 2) { return [a, b, c, e] }
  assert.deepEqual(paramDefaults(f), { a: 2, b: [3, 4], c: '),(', e: 6 })
})

test('paramDefaults: .25, 1_000, negative and expression defaults are evaluated', () => {
  function f(a = .25, b = 1_000, c = -1, d = 2 * Math.PI, e = 'x'.repeat(2), g = a * 4) { return [a, b, c, d, e, g] }
  assert.deepEqual(paramDefaults(f), { a: 0.25, b: 1000, c: -1, d: 2 * Math.PI, e: 'xx', g: 1 })
})

test('paramDefaults: a default it cannot evaluate is kept as UnparsedDefault, never dropped', () => {
  const LIMIT = 3
  function f(a = LIMIT * 2, b = 1) { return [a, b] }
  const d = paramDefaults(f)
  assert.ok(d.a instanceof UnparsedDefault)
  assert.equal(d.a.source, 'LIMIT * 2')
  assert.equal(d.b, 1)
  // …and the check reports it: uncovered unless the panel edits it, and always listed as unparsed.
  assert.deepEqual(coverage(d), { uncovered: ['a'], unreasoned: [], unused: [], unparsed: ['a = LIMIT * 2'] })
  assert.deepEqual(coverage(d, { target: { a: 6, b: 1 } }).uncovered, [])
  assert.deepEqual(coverage(d, { target: { a: 6, b: 1 } }).unparsed, ['a = LIMIT * 2'])
})

test('paramDefaults: arrow functions, methods and class constructors', () => {
  assert.deepEqual(paramDefaults((x, y = 2) => x + y), { y: 2 })
  assert.deepEqual(paramDefaults((x) => (x ? 1 : 0)), {})
  assert.deepEqual(paramDefaults({ m(a, b = 'q') { return [a, b] } }.m), { b: 'q' })
  assert.deepEqual(paramDefaults(class { constructor(a = 7) { this.a = a } go(b = 8) { return b } }), { a: 7 })
})

test('levaTarget: what the R3F page edits, from the same manifest (dotted skips, arrays)', () => {
  const defaults = { seed: 1, center: [0, 0], facade: { night: 0, walls: { brick: ['#aa0000'] } }, weather: { walls: { wet: 0 } } }
  const spec = { defaults, arrays: true, skip: { center: 'from the site', 'facade.walls': 'palettes' } }
  const r = coverage(defaults, { target: levaTarget(spec, defaults, leva), skip: spec.skip, arrays: spec.arrays })
  assert.deepEqual(r, { uncovered: [], unreasoned: [], unused: [], unparsed: [] })
  // Without `arrays` leva leaves arrays out, so an unskipped array is caught.
  const noArrays = { ...spec, arrays: false, skip: { 'facade.walls': 'palettes' } }
  assert.deepEqual(coverage(defaults, { target: levaTarget(noArrays, defaults, leva), skip: noArrays.skip }).uncovered, ['center'])
})
