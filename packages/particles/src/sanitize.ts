// One schema-driven sanitiser for the package's option structs: a field carries its own type and bounds, so coercing,
// clamping and validating is written once and every solver treats bad input the same way. A schema mirrors its defaults
// object; `applySchema` fixes an already-merged input in place. `MPMOptions.materials` is the one hand-written field:
// its keys are the materials, not known here.

/** `#rrggbb`, the only colour form the renderers accept. */
const HEX = /^#[0-9a-f]{6}$/i
const hex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * One field of a {@link Schema}: how input is coerced and the range it may take. Anything that fails the type (a
 * string for a number, `NaN`, a bad hex colour) is replaced by the same key of the defaults tree.
 */
export type SchemaField =
  /** A number, clamped to `[min, max]`. */
  | { type: 'number'; min?: number; max?: number; minOf?: string }
  /** A number rounded to the nearest integer (halves up, `Math.round`), then clamped. */
  | { type: 'integer'; min?: number; max?: number; minOf?: string }
  /** As many numbers as the default has, each clamped; `round` rounds each one. */
  | { type: 'number[]'; round?: boolean; min?: number; max?: number }
  /** Two numbers, low first (reversed if given the other way round). */
  | { type: 'range'; min?: number; max?: number }
  /** A `#rrggbb` string. */
  | { type: 'color' }
  /** As many `#rrggbb` strings as the default has, each falling back on its own. */
  | { type: 'color[]' }
  /** Up to `max` `#rrggbb` strings (at least one, else the defaults). */
  | { type: 'colors'; max: number }
  /** One of `values`. */
  | { type: 'enum'; values: readonly string[] }
  | { type: 'boolean' }
  /** A number or a string. */
  | { type: 'seed' }
  /** A string (non-empty if `nonEmpty`). */
  | { type: 'string'; nonEmpty?: boolean }

/** A schema: leaves are {@link SchemaField}s, nested options are nested schemas. Key order is the order applied. */
export interface Schema {
  [key: string]: SchemaField | Schema
}

/**
 * Fixes `options` in place against `schema`, taking fallbacks from `defaults` (the resolved defaults tree). Returns
 * `options`. A nested option that is not an object is reset to the defaults, as a missing one already is.
 */
export function applySchema<T extends object>(options: T, schema: Schema, defaults: object): T {
  applyNode(options as Record<string, unknown>, schema, defaults as Record<string, unknown>)
  return options
}

const isField = (node: SchemaField | Schema): node is SchemaField => typeof (node as SchemaField).type === 'string'

function applyNode(o: Record<string, unknown>, schema: Schema, defaults: Record<string, unknown>): void {
  for (const [key, node] of Object.entries(schema)) {
    if (isField(node)) applyField(o, key, node, defaults[key])
    else {
      const child = o[key]
      if (!child || typeof child !== 'object' || Array.isArray(child)) o[key] = structuredClone(defaults[key])
      applyNode(o[key] as Record<string, unknown>, node, (defaults[key] ?? {}) as Record<string, unknown>)
    }
  }
}

function applyField(o: Record<string, unknown>, key: string, f: SchemaField, def: unknown): void {
  const v = o[key]
  switch (f.type) {
    case 'number':
    case 'integer': {
      const min =
        f.minOf && finite(o[f.minOf]) ? Math.max(f.min ?? -Infinity, o[f.minOf] as number) : (f.min ?? -Infinity)
      const n = finite(v) ? Math.min(f.max ?? Infinity, Math.max(min, v)) : (def as number)
      o[key] = f.type === 'integer' ? Math.round(n) : n
      return
    }
    case 'number[]': {
      const src: unknown[] = Array.isArray(v) ? v : []
      o[key] = (Array.isArray(def) ? def : []).map((d, i) => {
        const n = finite(src[i]) ? Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, src[i])) : d
        return f.round ? Math.round(n) : n
      })
      return
    }
    case 'range': {
      const src: unknown[] = Array.isArray(v) ? v : []
      const [a, b] = (Array.isArray(def) ? def : [0, 0]).slice(0, 2).map((d, i) => {
        return finite(src[i]) ? Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, src[i])) : d
      })
      o[key] = a <= b ? [a, b] : [b, a]
      return
    }
    case 'color':
      if (!hex(v)) o[key] = def
      return
    case 'color[]': {
      const src: unknown[] = Array.isArray(v) ? v : []
      o[key] = (Array.isArray(def) ? def : []).map((d, i) => (hex(src[i]) ? src[i] : d))
      return
    }
    case 'colors': {
      const list = Array.isArray(v) ? v.filter(hex).slice(0, f.max) : []
      o[key] = list.length ? list : Array.isArray(def) ? structuredClone(def) : []
      return
    }
    case 'enum':
      if (typeof v !== 'string' || !f.values.includes(v)) o[key] = def
      return
    case 'boolean':
      if (typeof v !== 'boolean') o[key] = def
      return
    case 'seed':
      if (typeof v !== 'number' && typeof v !== 'string') o[key] = def
      return
    case 'string':
      if (typeof v !== 'string' || (f.nonEmpty && !v)) o[key] = def
  }
}
