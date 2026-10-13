// leva's counterpart of options-gui.ts for the R3F sandboxes: a package's plain-JSON options become a
// leva schema, and leva's values become the nested props the package's React components take. The R3F
// sandboxes build it from the same panel manifests (`example/<demo>.panel.ts`) as the three.js sandboxes,
// with {@link specSchema}; scripts/options-coverage.mjs checks both.
import type { PanelClassSpec } from './panel'

/** Slider ranges by option name or `/`-joined path (anything else gets a range from its default value). */
export type Ranges = Record<string, [min: number, max: number, step?: number]>
/** Dropdown choices by option name or `/`-joined path. */
export type Choices = Record<string, readonly string[]>
/** What to show. */
export interface SchemaOptions {
  ranges?: Ranges
  choices?: Choices
  /** Option names (left out at any depth) or dotted paths (`facade.walls`: that path and below), as in the panel. */
  skip?: string[]
  /** Also edit non-empty arrays: a folder of their elements, which take the array's name for ranges and choices. */
  arrays?: boolean
}
/** leva's `folder()`, passed in so this module stays pure (and testable without a DOM). */
export type Folder = (schema: any, settings: { collapsed: boolean }) => unknown

/** The schema options of a panel-manifest class: the same skips, ranges, choices and arrays as its lil-gui panel. */
export function specSchema({ skip = {}, ranges, choices, arrays }: PanelClassSpec): SchemaOptions {
  return { skip: Object.keys(skip), ranges, choices, arrays }
}

/**
 * leva schema for a plain-JSON options object: numbers → sliders, booleans → checkboxes, `#rrggbb` →
 * colour pickers, strings → text or dropdowns, nested objects (and, with `arrays`, arrays) → collapsed
 * folders; null and (without `arrays`) arrays are left out. Keys are `/`-joined paths (leva wants keys unique
 * even across folders), labels the names.
 */
export function levaSchema(target: object, folder: Folder, opts: SchemaOptions = {}, path: string[] = [], arrayName?: string): Record<string, unknown> {
  const { ranges = {}, choices = {}, skip = [], arrays = false } = opts
  const schema: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(target)) {
    const p = [...path, name]
    if (skip.includes(name) || skip.includes(p.join('.'))) continue
    const key = p.join('/')
    const label = name
    const lookup = arrayName ?? name // array elements use the array's name, as in the lil-gui panel
    if (value && typeof value === 'object' && (!Array.isArray(value) || (arrays && value.length > 0))) {
      const inner = levaSchema(value, folder, opts, p, Array.isArray(value) ? name : undefined)
      if (Object.keys(inner).length) schema[name] = folder(inner, { collapsed: true })
    } else if (typeof value === 'number') {
      const [min, max, step] = ranges[key] ?? ranges[lookup] ?? guessRange(value)
      const lo = Math.min(min, value), hi = Math.max(max, value)
      schema[key] = { value, min: lo, max: hi, step: step ?? niceStep(lo, hi), label }
    } else if (typeof value === 'boolean' || (typeof value === 'string' && !(choices[key] ?? choices[lookup]))) {
      schema[key] = { value, label }
    } else if (typeof value === 'string') {
      const list = choices[key] ?? choices[lookup]
      schema[key] = { value, options: list.includes(value) ? [...list] : [value, ...list], label }
    }
  }
  return schema
}

/**
 * Turns leva's values (`{ 'facade/night': 1, 'center/0': 5 }`) back into nested options (`{ facade: { night: 1 },
 * center: [5] }`): numeric path segments are array indices.
 */
export function nest(values: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [key, value] of Object.entries(values)) {
    const path = key.split('/')
    let o = out
    for (let i = 0; i < path.length - 1; i++) o = o[path[i]] ??= /^\d+$/.test(path[i + 1]) ? [] : {}
    o[path[path.length - 1]] = value
  }
  return out
}

/**
 * Only the options in `values` that differ from `defaults` (arrays compare whole), nested. leva always reports every
 * control; passing just the edits lets presets the panel doesn't show (a size class's road and district rules) apply.
 */
export function changed(values: Record<string, any>, defaults: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(values)) {
    const d = defaults?.[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && d && typeof d === 'object' && !Array.isArray(d)) {
      const inner = changed(v, d)
      if (Object.keys(inner).length) out[k] = inner
    } else if (JSON.stringify(v) !== JSON.stringify(d)) out[k] = v
  }
  return out
}

/** The values a schema starts with, flat by key (what leva's `useControls` returns before any edit). */
export function schemaValues(schema: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(schema)) {
    if (entry && 'value' in entry) out[key] = entry.value
    else Object.assign(out, schemaValues(entry?.schema ?? {}))
  }
  return out
}

function guessRange(v: number): [number, number] {
  if (v === 0) return [-1, 1]
  return v > 0 ? [0, v * 4] : [v * 4, -v * 4]
}

function niceStep(min: number, max: number): number {
  const span = max - min
  return span > 1000 ? 1 : span > 10 ? 0.1 : span > 1 ? 0.01 : 0.001
}
