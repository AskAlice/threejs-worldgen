import { test } from 'node:test'
import assert from 'node:assert/strict'
import { changed, levaSchema, nest, schemaValues, specSchema } from './leva-options.ts'

// Stand-in for leva's `folder()`, which only wraps its arguments.
const folder = (schema: Record<string, unknown>, settings: object) => ({ folder: schema, settings })

test('numbers become sliders keyed by path and labelled by name', () => {
  const s = levaSchema({ seed: 3, wear: 0.5 }, folder, { ranges: { seed: [1, 100, 1] } })
  assert.deepEqual(s.seed, { value: 3, min: 1, max: 100, step: 1, label: 'seed' })
  assert.deepEqual(s.wear, { value: 0.5, min: 0, max: 2, step: 0.01, label: 'wear' })
})

test('ranges widen to contain the value, and zero gets a symmetric range', () => {
  const s = levaSchema({ a: 7, b: 0 }, folder, { ranges: { a: [0, 1] } })
  assert.equal((s.a as any).max, 7)
  assert.deepEqual([(s.b as any).min, (s.b as any).max], [-1, 1])
})

test('nested objects become collapsed folders with unique /-joined keys', () => {
  const s = levaSchema({ walls: { wetness: 0 }, roofs: { wetness: 0.2 } }, folder)
  assert.deepEqual(Object.keys(s), ['walls', 'roofs'])
  const walls = s.walls as any
  assert.deepEqual(walls.settings, { collapsed: true })
  assert.deepEqual(Object.keys(walls.folder), ['walls/wetness'])
  assert.equal(walls.folder['walls/wetness'].label, 'wetness')
  assert.deepEqual(Object.keys((s.roofs as any).folder), ['roofs/wetness'])
})

test('colours, choices, booleans and strings; arrays, null and skipped keys are left out', () => {
  const s = levaSchema({ glass: '#33465a', style: 'grid', name: 'x', on: true, list: [1], none: null, hidden: 1, deep: { hidden: 2 }, empty: { list: [] } }, folder, {
    choices: { style: ['auto', 'radial'] }, skip: ['hidden'],
  })
  assert.deepEqual(s.glass, { value: '#33465a', label: 'glass' })
  assert.deepEqual(s.style, { value: 'grid', options: ['grid', 'auto', 'radial'], label: 'style' })
  assert.deepEqual(s.name, { value: 'x', label: 'name' })
  assert.deepEqual(s.on, { value: true, label: 'on' })
  assert.deepEqual(Object.keys(s), ['glass', 'style', 'name', 'on'])
})

test('nest turns leva values back into the nested options object', () => {
  assert.deepEqual(nest({ seed: 2, 'facade/night': 1, 'weather/walls/snow': 0.5, 'weather/walls/burn': 0 }), {
    seed: 2, facade: { night: 1 }, weather: { walls: { snow: 0.5, burn: 0 } },
  })
})

test('ranges and choices keyed by path win over the same name elsewhere', () => {
  const s = levaSchema({ fences: { style: 'auto' }, mailboxes: { style: 'us', spacing: 45 } }, folder, {
    choices: { style: ['auto', 'picket'], 'mailboxes/style': ['us', 'eu'] }, ranges: { 'mailboxes/spacing': [10, 100, 1] },
  }) as any
  assert.deepEqual(s.fences.folder['fences/style'].options, ['auto', 'picket'])
  assert.deepEqual(s.mailboxes.folder['mailboxes/style'].options, ['us', 'eu'])
  assert.deepEqual([s.mailboxes.folder['mailboxes/spacing'].min, s.mailboxes.folder['mailboxes/spacing'].max], [10, 100])
})

test('dotted skips leave out that path only, as in the panel', () => {
  const s = levaSchema({ facade: { walls: { a: 1 }, night: 0 }, weather: { walls: { a: 2 } } }, folder, { skip: ['facade.walls'] }) as any
  assert.deepEqual(Object.keys(s.facade.folder), ['facade/night'])
  assert.deepEqual(Object.keys(s.weather.folder.walls.folder), ['weather/walls/a'])
})

test('arrays: element controls under /-indexed keys, ranges and choices by the array name; nest rebuilds the arrays', () => {
  const s = levaSchema({ center: [5, -5], avoid: ['ice'], none: [] }, folder, { arrays: true, ranges: { center: [-10, 10, 1] }, choices: { avoid: ['ice', 'peaks'] } }) as any
  assert.deepEqual(Object.keys(s), ['center', 'avoid'])
  assert.deepEqual(s.center.folder['center/1'], { value: -5, min: -10, max: 10, step: 1, label: '1' })
  assert.deepEqual(s.avoid.folder['avoid/0'].options, ['ice', 'peaks'])
  assert.deepEqual(nest({ 'center/0': 5, 'center/1': -5, 'list/0/x': 1 }), { center: [5, -5], list: [{ x: 1 }] })
})

test('specSchema takes a panel manifest class; schemaValues + nest round-trip the edited options', () => {
  const spec = { defaults: { seed: 1, center: [0, 0], deep: { on: true } }, arrays: true, skip: { center: 'from the site' }, ranges: { seed: [0, 9, 1] as [number, number, number] } }
  assert.deepEqual(specSchema(spec), { skip: ['center'], ranges: spec.ranges, choices: undefined, arrays: true })
  const levaFolder = (schema: unknown, settings: object) => ({ schema, settings }) // leva's own shape
  assert.deepEqual(nest(schemaValues(levaSchema(spec.defaults, levaFolder, specSchema(spec)))), { seed: 1, deep: { on: true } })
})

test('changed keeps only the edited options, so presets under them (e.g. a size class) still apply', () => {
  const defaults = { size: 'town', roads: { arms: 0, primary: { width: 12 } }, styles: { floors: [1, 7] }, center: [0, 0] }
  assert.deepEqual(changed(structuredClone(defaults), defaults), {})
  const edited = { size: 'village', roads: { arms: 0, primary: { width: 9 } }, styles: { floors: [1, 4] }, center: [0, 0] }
  assert.deepEqual(changed(edited, defaults), { size: 'village', roads: { primary: { width: 9 } }, styles: { floors: [1, 4] } })
})
