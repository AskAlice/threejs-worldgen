import { aggregatePopulation, type AggregateCell, type LandUse, type PopulationData } from './model.ts'
import type { Network, NetworkType } from './network.ts'

/** What a population view colours cells by. */
export type PopulationMode = 'density' | 'landUse' | 'lights' | 'habitability'

/** Colours shared by {@link renderPopulationMap} and the 3D overlay. All `#rrggbb`, plain JSON. */
export interface PopulationStyle {
  /** Density ramp: `[t, colour]` stops, t = log(1 + density) / log(1 + maxDensity). */
  densityRamp: [number, string][]
  /** People per km² at the top of the density ramp. */
  maxDensity: number
  /** Night-light ramp over brightness 0…1. */
  lightRamp: [number, string][]
  /** Habitability ramp over 0…1. */
  habitabilityRamp: [number, string][]
  /** Colour per land use. */
  landUse: Record<LandUse, string>
  /** Colour per network type. */
  networks: Record<NetworkType, string>
  /** Settlement marker colour. */
  settlement: string
}

/** Default colours: a yellow → red → white density ramp, warm night lights, muted land use. */
export const DEFAULT_STYLE: PopulationStyle = {
  densityRamp: [[0, '#f3efd2'], [0.3, '#f6d27a'], [0.55, '#ee8b3a'], [0.8, '#c4302b'], [1, '#fff4e8']],
  maxDensity: 20_000,
  lightRamp: [[0, '#05060c'], [0.25, '#4a2a08'], [0.6, '#f0a030'], [1, '#fff6d8']],
  habitabilityRamp: [[0, '#5b3b2a'], [0.5, '#c9b458'], [1, '#3f9a3a']],
  landUse: { urban: '#c8413a', suburban: '#e8a35c', farmland: '#d8cf7a', wilderness: '#4f7a4a', water: '#2c5d8a' },
  networks: { highway: '#ffffff', road: '#f2e6c8', track: '#a68d68', rail: '#3a3a46', powerline: '#7fd0ff' },
  settlement: '#1a1a1a',
}

/** Settings for {@link renderPopulationMap}. */
export interface PopulationMapOptions {
  /** What to colour cells by. */
  mode: PopulationMode
  /** Centre in local `[x, z]`; `null` = the population's centre. */
  center: [number, number] | null
  /** Edge length of the mapped square, metres; `null` = the region's diameter. */
  size: number | null
  /** Pixels per side. */
  resolution: number
  /** H3 resolution to colour (coarser = smoother); `null` = the data's own. */
  hexResolution: number | null
  /** Draw settlements as discs (farmsteads as single pixels). */
  settlements: boolean
  /** Draw networks (needs the `network` argument). */
  networks: boolean
}

/** Default map: the whole region, 256 px, density, with settlements and networks. */
export const DEFAULT_POPULATION_MAP: PopulationMapOptions = { mode: 'density', center: null, size: null, resolution: 256, hexResolution: null, settlements: true, networks: true }

/**
 * Renders a top-down population map into RGBA bytes (row 0 = −Z edge, like `renderWorldMap` in
 * threejs-biomes). Pixels outside the region are transparent, so it composites over a world map. Pure.
 */
export function renderPopulationMap(data: PopulationData, input: Partial<PopulationMapOptions> = {}, network?: Network, style: PopulationStyle = DEFAULT_STYLE): Uint8ClampedArray<ArrayBuffer> {
  const o = { ...DEFAULT_POPULATION_MAP, ...input }
  const n = o.resolution
  const center = o.center ?? data.options.center
  const size = o.size ?? data.options.radius * 2
  const res = o.hexResolution ?? data.resolution
  const cells = aggregatePopulation(data, res)
  const out = new Uint8ClampedArray(n * n * 4)
  const colors = new Map<string, [number, number, number]>()
  const px = size / n
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = center[0] + ((i + 0.5) / n - 0.5) * size, z = center[1] + ((j + 0.5) / n - 0.5) * size
    const c = data.grid.cellAtLocal(x, z, res)
    const a = cells.get(c)
    if (!a || Math.hypot(x - data.options.center[0], z - data.options.center[1]) > data.options.radius) continue
    let rgb = colors.get(c)
    if (!rgb) colors.set(c, (rgb = cellColor(a, o.mode, style)))
    put(out, n, i, j, rgb)
  }
  const toPx = (x: number, z: number): [number, number] => [((x - center[0]) / size + 0.5) * n, ((z - center[1]) / size + 0.5) * n]
  if (o.networks && network) {
    const order: NetworkType[] = ['powerline', 'track', 'road', 'rail', 'highway']
    for (const type of order) {
      const rgb = hexRgb(style.networks[type])
      for (const e of network.edges) {
        if (e.type !== type) continue
        for (let k = 1; k < e.points.length; k++) line(out, n, toPx(...e.points[k - 1]), toPx(...e.points[k]), rgb)
      }
    }
  }
  if (o.settlements) {
    const rgb = hexRgb(style.settlement)
    for (const s of data.settlements) {
      const [cx, cy] = toPx(s.position[0], s.position[1])
      const r = s.class === 'farmstead' ? 0 : Math.max(1, s.radius / px)
      for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= Math.max(0.5, r * r)) put(out, n, x, y, rgb)
      }
    }
  }
  return out
}

/** Colour (0…1 sRGB) of a cell in a view mode. */
export function cellColor(cell: Pick<AggregateCell, 'density' | 'light' | 'habitability' | 'landUse'>, mode: PopulationMode, style: PopulationStyle = DEFAULT_STYLE): [number, number, number] {
  switch (mode) {
    case 'landUse': return hexRgb(style.landUse[cell.landUse])
    case 'lights': return ramp(style.lightRamp, cell.light)
    case 'habitability': return cell.landUse === 'water' ? hexRgb(style.landUse.water) : ramp(style.habitabilityRamp, cell.habitability)
    default: return cell.landUse === 'water' && cell.density === 0 ? hexRgb(style.landUse.water) : ramp(style.densityRamp, densityT(cell.density, style))
  }
}

/** 0…1 position of a density on the (logarithmic) density ramp. */
export function densityT(density: number, style: PopulationStyle = DEFAULT_STYLE): number {
  return Math.min(1, Math.log1p(Math.max(0, density)) / Math.log1p(style.maxDensity))
}

/** Samples a `[t, #rrggbb]` ramp at t (0…1 sRGB out). */
export function ramp(stops: [number, string][], t: number): [number, number, number] {
  if (!stops.length) return [0, 0, 0]
  if (t <= stops[0][0]) return hexRgb(stops[0][1])
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, a] = stops[i - 1], [t1, b] = stops[i]
      const k = (t - t0) / (t1 - t0 || 1), ca = hexRgb(a), cb = hexRgb(b)
      return [ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k, ca[2] + (cb[2] - ca[2]) * k]
    }
  }
  return hexRgb(stops[stops.length - 1][1])
}

function hexRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace('#', ''), 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

function put(out: Uint8ClampedArray, n: number, i: number, j: number, rgb: [number, number, number]) {
  if (i < 0 || j < 0 || i >= n || j >= n) return
  const p = (j * n + i) * 4
  out[p] = rgb[0] * 255; out[p + 1] = rgb[1] * 255; out[p + 2] = rgb[2] * 255; out[p + 3] = 255
}

function line(out: Uint8ClampedArray, n: number, a: [number, number], b: [number, number], rgb: [number, number, number]) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))))
  for (let k = 0; k <= steps; k++) put(out, n, Math.floor(a[0] + ((b[0] - a[0]) * k) / steps), Math.floor(a[1] + ((b[1] - a[1]) * k) / steps), rgb)
}
