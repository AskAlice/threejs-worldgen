// Options coverage check: every option of a package's defaults must be editable in its sandbox panel, or skipped
// with a stated reason.
//
// How it finds the panels: each sandbox declares its panel in a manifest next to it, `example/<demo>.panel.ts`,
// exporting `panels: PanelSpec` (see example/panel.ts): package name → class name → { defaults, skip, ranges,
// choices, arrays, target }. The sandbox builds its panel from the same manifest (`specOptions`), so the skip
// list is written once. This script imports every `example/*.panel.ts` (Node strips the types) and compares the
// class's `defaults` (the package's exported default options, the source of truth) with what the panel can edit.
//
// Usage: node --conditions=worldgen-source scripts/options-coverage.mjs   (exits 1 on any gap)
// The R3F sandboxes build their leva controls from the same manifests (`useSpec`, example/r3f-shared.tsx); a manifest
// lists them in `export const r3f = { '<page>-r3f.tsx': ['<class>', …] }`, and they are checked the same way.
//
// Test:  node --test scripts/options-coverage.test.mjs

/**
 * Compares a package's default options with a sandbox panel. Option keys are nested paths (`facade.night`).
 * A path is covered when the panel skips it with a reason, or the value at that path in `target` is something the
 * panel edits: a number, string or boolean, or (with `arrays`) a non-empty array. Skip semantics match the panel:
 * a bare name (`seed`) skips that key at any depth, a dotted path (`facade.walls`) skips that path and below.
 * @param {object} defaults The package's default options.
 * @param {{ target?: object, skip?: Record<string, string>, arrays?: boolean }} [panel] What the panel edits.
 * An {@link UnparsedDefault} (from {@link paramDefaults}) is an option like any other (covered only when skipped or in
 * `target`), and is always listed in `unparsed` (`name = <source>`) so it never drops out of the report.
 * @returns {{ uncovered: string[], unreasoned: string[], unused: string[], unparsed: string[] }} Options neither
 *   editable nor skipped, skips without a reason, skips that match no option, and defaults that couldn't be evaluated.
 */
export function coverage(defaults, { target = defaults, skip = {}, arrays = false } = {}) {
  const used = new Set()
  const uncovered = []
  const unparsed = []
  const skipped = (path) => {
    for (let i = 0; i < path.length; i++) {
      const hit = [path[i], path.slice(0, i + 1).join('.')].find((k) => Object.hasOwn(skip, k))
      if (hit) return used.add(hit)
    }
    return false
  }
  const walk = (o, path) => {
    for (const [k, v] of Object.entries(o)) {
      const p = [...path, k]
      if (v instanceof UnparsedDefault) unparsed.push(`${p.join('.')} = ${v.source}`)
      if (skipped(p)) continue
      if (isPlain(v)) walk(v, p)
      else if (!editable(p.reduce((t, key) => (t != null && Object.hasOwn(Object(t), key) ? t[key] : undefined), target), arrays)) uncovered.push(p.join('.'))
    }
  }
  walk(defaults, [])
  return {
    uncovered,
    unreasoned: Object.keys(skip).filter((k) => typeof skip[k] !== 'string' || !skip[k].trim()),
    unused: Object.keys(skip).filter((k) => !used.has(k)),
    unparsed,
  }
}

/** A parameter default {@link paramDefaults} could not evaluate (it refers to something out of scope): reported, never dropped. */
export class UnparsedDefault {
  constructor(source) { this.source = source }
}

/**
 * Parameter defaults of a function, by parameter name: `f(a, e = 0.25, { b = 1 } = {})` → `{ e: 0.25, b: 1 }`.
 * Reads the parameter list from the source (nested brackets, strings and comments are skipped), including
 * destructured parameters (by property key; nested patterns nest), and evaluates each default expression, with the
 * earlier parameters in scope. A default it can't evaluate becomes an {@link UnparsedDefault} holding its source, so
 * the coverage check still lists the option.
 */
export function paramDefaults(fn) {
  const src = fn.toString()
  if (/^(async\s+)?[\w$]+\s*=>/.test(src)) return {} // `x => …`: one parameter, no default
  const open = src.startsWith('class') ? src.search(/\bconstructor\s*\(/) : 0
  if (open < 0) return {}
  const start = src.indexOf('(', open)
  const out = {}
  const scope = {}
  pattern(src.slice(start + 1, scan(src, start + 1, ')')), out, scope)
  return out
}

// Index of the first `stop` character at bracket depth 0 from `i` (strings, templates and comments skipped).
function scan(s, i, stop) {
  let depth = 0
  for (; i < s.length; i++) {
    const c = s[i]
    if (c === '"' || c === "'" || c === '`') { for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++; continue }
    if (c === '/' && s[i + 1] === '*') { i = s.indexOf('*/', i + 2) + 1 || s.length; continue }
    if (c === '/' && s[i + 1] === '/') { i = s.indexOf('\n', i) >>> 0; continue }
    if (depth === 0 && stop.includes(c)) return i
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
  }
  return s.length
}

// Splits at top-level commas.
function split(s) {
  const parts = []
  for (let i = 0; i <= s.length;) {
    const j = scan(s, i, ',')
    parts.push(s.slice(i, j).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').trim())
    i = j + 1
  }
  return parts.filter(Boolean)
}

// Reads one parameter list or destructuring pattern (`a = 1, { b: c = 2 } = {}, ...rest`) into `out`.
function pattern(list, out, scope, keyed = false) {
  for (const part of split(list)) {
    if (part.startsWith('...')) continue
    const eq = scan(part, 0, '=')
    let lhs = part.slice(0, eq).trim()
    const rhs = eq < part.length ? part.slice(eq + 1).trim() : null
    let key = null
    if (keyed && /^[\w$]+\s*:/.test(lhs)) { key = lhs.slice(0, lhs.indexOf(':')).trim(); lhs = lhs.slice(lhs.indexOf(':') + 1).trim() }
    if (lhs.startsWith('{') || lhs.startsWith('[')) {
      const inner = {}
      pattern(lhs.slice(1, scan(lhs, 1, lhs[0] === '{' ? '}' : ']')), inner, scope, lhs[0] === '{')
      if (key) out[key] = inner
      else Object.assign(out, inner)
      continue
    }
    const name = key ?? lhs.match(/^[\w$]+/)?.[0]
    if (!name || rhs === null) continue
    out[name] = evaluate(rhs, scope)
    scope[lhs.match(/^[\w$]+/)?.[0] ?? name] = out[name]
  }
}

function evaluate(expr, scope) {
  try {
    const names = Object.keys(scope).filter((k) => !(scope[k] instanceof UnparsedDefault))
    return new Function(...names, `return (${expr})`)(...names.map((k) => scope[k]))
  } catch {
    return new UnparsedDefault(expr)
  }
}

const isPlain = (v) => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype
const editable = (v, arrays) => ['number', 'string', 'boolean'].includes(typeof v) || (arrays && Array.isArray(v) && v.length > 0)

/**
 * What an R3F sandbox edits for a manifest class: the leaf values of the leva schema `useSpec` builds from it
 * (example/leva-options.ts), nested back into an options object, for {@link coverage}'s `target`.
 */
export function levaTarget(spec, defaults, { levaSchema, specSchema, schemaValues, nest }) {
  const schema = levaSchema(spec.target ?? defaults, (inner, settings) => ({ schema: inner, settings }), specSchema(spec))
  return nest(schemaValues(schema))
}

if (import.meta.main) {
  const { readdirSync, readFileSync } = await import('node:fs')
  const { pathToFileURL } = await import('node:url')
  const dir = new URL('../example/', import.meta.url)
  const leva = await import(new URL('leva-options.ts', dir).href)
  const files = readdirSync(dir)
  let failed = false
  const report = (label, spec, r) => {
    const bad = r.uncovered.length + r.unreasoned.length + r.unused.length
    failed ||= bad > 0
    console.log(`${bad ? '✗' : '✓'} ${label}`)
    for (const k of r.uncovered) console.log(`    not in the panel: ${k}`)
    for (const k of r.unreasoned) console.log(`    skipped without a reason: ${k}`)
    for (const k of r.unused) console.log(`    skip matches no option: ${k}`)
    for (const k of r.unparsed) console.log(`    unparsed default (checked by name only): ${k}`)
    for (const [k, why] of Object.entries(spec.skip ?? {})) if (!r.unused.includes(k)) console.log(`    skip ${k}: ${why}`)
  }
  const checkedPages = new Set()
  for (const file of files.filter((f) => f.endsWith('.panel.ts')).sort()) {
    const { panels, r3f = {} } = await import(pathToFileURL(new URL(file, dir).pathname).href)
    const all = Object.values(panels).reduce((o, classes) => Object.assign(o, classes), {})
    const defaultsOf = (spec) => (typeof spec.defaults === 'function' ? spec.defaults(paramDefaults) : spec.defaults)
    for (const [pkg, classes] of Object.entries(panels)) {
      for (const [name, spec] of Object.entries(classes)) {
        const defaults = defaultsOf(spec)
        report(`${file} ${pkg} ${name}`, spec, coverage(defaults, { target: spec.target ?? defaults, skip: spec.skip, arrays: spec.arrays }))
      }
    }
    // The R3F pages built from this manifest: they must use it (`useSpec('<class>', …)` from './<demo>.panel'), and
    // the leva controls it makes must cover the same options.
    for (const [page, names] of Object.entries(r3f)) {
      checkedPages.add(page)
      let src = ''
      try { src = readFileSync(new URL(page, dir), 'utf8') } catch { /* reported below */ }
      for (const name of names) {
        const spec = all[name]
        const label = `${page} (via ${file}) ${name}`
        const problems = []
        if (!src) problems.push(`page ${page} not found`)
        else if (!src.includes(`'./${file.replace(/\.ts$/, '')}'`)) problems.push(`page does not import ./${file.replace(/\.ts$/, '')}`)
        else if (!src.includes(`useSpec('${name}'`)) problems.push(`page does not call useSpec('${name}', …)`)
        if (!spec) problems.push(`no class ${name} in the manifest`)
        if (problems.length) { failed = true; console.log(`✗ ${label}`); for (const p of problems) console.log(`    ${p}`); continue }
        const defaults = defaultsOf(spec)
        report(label, spec, coverage(defaults, { target: levaTarget(spec, defaults, leva), skip: spec.skip, arrays: spec.arrays }))
      }
    }
  }
  for (const page of files.filter((f) => f.endsWith('-r3f.tsx') && !checkedPages.has(f)).sort()) console.log(`· ${page}: no panel manifest lists it (not checked)`)
  process.exit(failed ? 1 : 0)
}
