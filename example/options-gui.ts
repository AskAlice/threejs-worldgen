import GUI from 'three/addons/libs/lil-gui.module.min.js'

/** Slider ranges by option name (anything else gets a range from its default value). */
export type Ranges = Record<string, [min: number, max: number, step?: number]>
/** Dropdown choices by option name. */
export type Choices = Record<string, readonly string[]>

/**
 * Builds a lil-gui panel for a plain-JSON options object: numbers → sliders, booleans → checkboxes,
 * strings → text or dropdowns, `#rrggbb` → colour pickers, nested objects → folders. Every change calls
 * `onChange(path, value)`; the shared sandboxes use it to call `set({...})` on the package. `skip` takes option
 * names (skipped at any depth) or dotted paths. With `arrays`, non-empty arrays become folders too (their elements
 * use the array's name for ranges and choices), and a change inside one reports the array's path and a copy of it.
 */
export function addOptions(gui: GUI, target: Record<string, any>, onChange: (path: string[], value: unknown) => void, opts: { ranges?: Ranges; choices?: Choices; skip?: string[]; path?: string[]; closed?: boolean; arrays?: boolean; name?: string } = {}) {
  const { ranges = {}, choices = {}, skip = [], path = [] } = opts
  for (const [key, value] of Object.entries(target)) {
    const p = [...path, key]
    if (skip.includes(key) || skip.includes(p.join('.'))) continue
    const notify = (v: unknown) => onChange(p, v)
    const name = Array.isArray(target) ? opts.name ?? key : key
    if (value && typeof value === 'object' && (!Array.isArray(value) || (opts.arrays && value.length > 0))) {
      const folder = gui.addFolder(key)
      const sub = Array.isArray(value) ? () => onChange(p, structuredClone(value)) : onChange
      addOptions(folder, value, sub, { ...opts, path: p, name: Array.isArray(value) ? key : name })
      if (opts.closed !== false) folder.close()
    } else if (typeof value === 'number') {
      const r = ranges[name] ?? guessRange(value)
      gui.add(target, key, r[0], r[1], r[2] ?? niceStep(r[0], r[1])).onChange(notify)
    } else if (typeof value === 'boolean') {
      gui.add(target, key).onChange(notify)
    } else if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) {
      gui.addColor(target, key).onChange(notify)
    } else if (typeof value === 'string') {
      ;(choices[name] ? gui.add(target, key, choices[name] as string[]) : gui.add(target, key)).onChange(notify)
    }
  }
}

function guessRange(v: number): [number, number] {
  if (v === 0) return [-1, 1]
  return v > 0 ? [0, v * 4] : [v * 4, -v * 4]
}

function niceStep(min: number, max: number): number {
  const span = max - min
  return span > 1000 ? 1 : span > 10 ? 0.1 : span > 1 ? 0.01 : 0.001
}

/** Builds `{ a: { b: value } }` from a path, for `set()` calls. */
export function patch(path: string[], value: unknown): Record<string, unknown> {
  return path.reduceRight<any>((acc, k) => ({ [k]: acc }), value)
}
