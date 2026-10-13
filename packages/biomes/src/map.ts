import { createSample, hexToRgb, type LocalFrame, type World } from './world.ts'
import { clamp, lerp, smoothstep } from './noise.ts'

/** What a world map shows. */
export type MapMode = 'biomes' | 'height' | 'temperature' | 'moisture' | 'continentalness' | 'erosion' | 'rivers' | 'ground'

/** Settings for {@link renderWorldMap}. */
export interface MapOptions {
  /** What to draw. */
  mode: MapMode
  /** Centre in local frame coordinates `[x, z]` (flat world, or the world's `origin` frame on a planet). */
  center: [number, number]
  /** Edge length of the mapped square, metres. */
  size: number
  /** Pixels per side. */
  resolution: number
  /** Add hill shading. */
  shade: boolean
}

/** Default map: a 40 km biome map, 256 px, shaded. */
export const DEFAULT_MAP: MapOptions = { mode: 'biomes', center: [0, 0], size: 40_000, resolution: 256, shade: true }

const ramp = (stops: [number, [number, number, number]][], t: number): [number, number, number] => {
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, a] = stops[i - 1], [t1, b] = stops[i]
      const k = (t - t0) / (t1 - t0 || 1)
      return [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)]
    }
  }
  return stops[stops.length - 1][1]
}
const HEIGHT_RAMP: [number, [number, number, number]][] = [
  [0, [0.05, 0.12, 0.3]], [0.48, [0.2, 0.45, 0.7]], [0.5, [0.85, 0.82, 0.6]], [0.55, [0.35, 0.6, 0.3]],
  [0.75, [0.55, 0.5, 0.35]], [0.9, [0.6, 0.58, 0.56]], [1, [1, 1, 1]],
]
const HEAT_RAMP: [number, [number, number, number]][] = [[0, [0.2, 0.3, 0.9]], [0.5, [0.95, 0.95, 0.8]], [1, [0.9, 0.2, 0.1]]]

/**
 * Renders a top-down map of the world into RGBA bytes (row 0 = −Z edge). Pure (no DOM), so it also
 * runs in workers and tests; draw it with `new ImageData(pixels, resolution)` or into a `DataTexture`.
 * @param frame Local frame the map is centred in (default: the world's own frame; on planets use
 *   `world.frameAt(lat, lon)` to map anywhere).
 */
export function renderWorldMap(world: World, input: Partial<MapOptions> = {}, frame: LocalFrame = world.frame): Uint8ClampedArray<ArrayBuffer> {
  const o = { ...DEFAULT_MAP, ...input }
  const n = o.resolution
  const out = new Uint8ClampedArray(n * n * 4)
  const s = createSample()
  const heights = new Float32Array(n * n)
  const biomeRgb = world.options.biomes.map((b) => hexToRgb(b.color))
  const sea = world.options.seaLevel
  const span = Math.max(1, world.options.mountains.height + 200)
  const weights = new Float32Array(7)
  const color = new Float32Array(3)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = o.center[0] + ((i + 0.5) / n - 0.5) * o.size
    const z = o.center[1] + ((j + 0.5) / n - 0.5) * o.size
    frame.sample(x, z, s, o.size / n)
    heights[j * n + i] = s.elevation
    let rgb: [number, number, number]
    switch (o.mode) {
      case 'biomes': {
        rgb = [0, 0, 0]
        for (let k = 0; k < s.count; k++) {
          const c = biomeRgb[s.biomes[k]], w = s.weights[k]
          rgb[0] += c[0] * w; rgb[1] += c[1] * w; rgb[2] += c[2] * w
        }
        if (!Number.isNaN(s.waterLevel) && s.waterLevel > s.elevation) rgb = [rgb[0] * 0.4, rgb[1] * 0.55, rgb[2] * 0.9 + 0.1]
        break
      }
      case 'height': rgb = ramp(HEIGHT_RAMP, clamp(0.5 + (s.elevation - sea) / (2 * span), 0, 1)); break
      case 'temperature': rgb = ramp(HEAT_RAMP, clamp((s.temperature + 25) / 60, 0, 1)); break
      case 'moisture': rgb = ramp([[0, [0.75, 0.6, 0.35]], [1, [0.1, 0.35, 0.8]]], s.moisture); break
      case 'continentalness': rgb = ramp(HEAT_RAMP, 0.5 + 0.5 * s.continentalness); break
      case 'erosion': rgb = [s.erosion, s.erosion, s.erosion]; break
      case 'rivers': rgb = [0.15 + 0.6 * s.valley, 0.15 + 0.6 * s.valley, 0.2 + 0.8 * Math.max(s.valley, s.river)]; break
      case 'ground': world.ground(s, 0, weights, color); rgb = [color[0], color[1], color[2]]; break
    }
    const p = (j * n + i) * 4
    out[p] = rgb[0] * 255; out[p + 1] = rgb[1] * 255; out[p + 2] = rgb[2] * 255; out[p + 3] = 255
  }
  if (o.shade) {
    const cell = o.size / n
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const h = (a: number, b: number) => heights[clamp(b, 0, n - 1) * n + clamp(a, 0, n - 1)]
      const dx = (h(i + 1, j) - h(i - 1, j)) / (2 * cell), dz = (h(i, j + 1) - h(i, j - 1)) / (2 * cell)
      const light = clamp(0.75 + (-dx - dz) * 0.6, 0.4, 1.3) * (heights[j * n + i] < sea ? 1 : 1)
      const p = (j * n + i) * 4
      const k = lerp(1, light, smoothstep(sea - 1, sea + 1, heights[j * n + i]))
      out[p] *= k; out[p + 1] *= k; out[p + 2] *= k
    }
  }
  return out
}
