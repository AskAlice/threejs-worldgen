import { fbm, hash01 } from 'threejs-biomes'
import type { Site } from './site.ts'

/**
 * How street directions are chosen (Chen et al. 2008, "Interactive Procedural Street Modeling").
 * The field is a weighted sum of basis tensors; roads follow its major or minor eigenvector.
 */
export interface TensorFieldOptions {
  /** Main grid orientation, degrees from +x. */
  gridAngle: number
  /** Weight of the grid tensors (straight, perpendicular streets). */
  grid: number
  /** Extra grid patches with their own orientation (neighbourhoods laid out at different angles). */
  gridPatches: number
  /** Largest angle (degrees) a grid patch turns away from `gridAngle`. */
  gridVariation: number
  /** Size of each grid patch's area of influence, as a fraction of the settlement radius. */
  gridDecay: number
  /** Weight of the radial tensor around the centre (ring roads and spokes). */
  radial: number
  /** Reach of the radial tensor, as a fraction of the settlement radius. */
  radialDecay: number
  /** Weight of terrain-following tensors (streets along contours and coastlines). */
  terrain: number
  /** Slope (rise/run) at which terrain alignment reaches full weight. */
  terrainSlope: number
  /** Angular noise, degrees: 0 = crisp geometry, 30+ = organic, winding streets. */
  noise: number
  /** Size of the noise features, metres. */
  noiseScale: number
}

/** Default field: a mostly gridded layout with a radial centre that follows the terrain. */
export const DEFAULT_TENSOR_FIELD: TensorFieldOptions = {
  gridAngle: 0, grid: 1, gridPatches: 3, gridVariation: 35, gridDecay: 0.55,
  radial: 0.6, radialDecay: 0.35, terrain: 1.2, terrainSlope: 0.12, noise: 6, noiseScale: 450,
}

interface Basis { x: number; z: number; angle: number; weight: number; decay2: number }

/**
 * A 2D street tensor field. {@link TensorField.align} turns a heading into the nearest field
 * direction (major or minor eigenvector, either sign), which is how roads are steered.
 */
export class TensorField {
  private grids: Basis[] = []
  private readonly o: TensorFieldOptions
  private readonly cx: number
  private readonly cz: number
  private readonly radius: number
  private readonly site: Site | null
  private readonly seed: number
  private readonly g: [number, number] = [0, 0]

  /** Field around (`cx`, `cz`) for a settlement of `radius` metres; `site` adds terrain alignment. */
  constructor(options: TensorFieldOptions, cx: number, cz: number, radius: number, seed: number, site: Site | null = null) {
    this.o = options
    this.cx = cx; this.cz = cz; this.radius = radius; this.site = site; this.seed = seed
    const deg = Math.PI / 180
    const decay = options.gridDecay * radius
    this.grids.push({ x: cx, z: cz, angle: options.gridAngle * deg, weight: options.grid, decay2: (decay * 1.6) ** 2 })
    for (let i = 0; i < options.gridPatches; i++) {
      const a = hash01(seed, i, 1, 77) * Math.PI * 2
      const r = (0.35 + 0.55 * hash01(seed, i, 2, 77)) * radius
      const turn = (hash01(seed, i, 3, 77) * 2 - 1) * options.gridVariation * deg
      this.grids.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, angle: options.gridAngle * deg + turn, weight: options.grid, decay2: decay * decay })
    }
  }

  /** Major-eigenvector angle (radians) at (x, z). The minor eigenvector is perpendicular to it. */
  angle(x: number, z: number): number {
    const o = this.o
    let c = 0, s = 0
    const add = (theta: number, w: number) => { c += w * Math.cos(2 * theta); s += w * Math.sin(2 * theta) }
    for (const b of this.grids) {
      const d2 = (x - b.x) ** 2 + (z - b.z) ** 2
      add(b.angle, b.weight * Math.exp(-d2 / b.decay2))
    }
    if (o.radial > 0) {
      const dx = x - this.cx, dz = z - this.cz
      const d2 = dx * dx + dz * dz
      const rd = o.radialDecay * this.radius
      if (d2 > 1e-6) add(Math.atan2(dz, dx), o.radial * Math.exp(-d2 / (rd * rd)))
    }
    if (this.site && o.terrain > 0) {
      const g = this.site.gradient(x, z, this.g)
      const m = Math.hypot(g[0], g[1])
      // Major axis up the slope, so the minor axis follows the contours.
      if (m > 1e-6) add(Math.atan2(g[1], g[0]), o.terrain * Math.min(1, m / Math.max(1e-6, o.terrainSlope)))
    }
    let theta = Math.abs(c) + Math.abs(s) < 1e-9 ? o.gridAngle * (Math.PI / 180) : Math.atan2(s, c) / 2
    if (o.noise > 0) theta += fbm(this.seed + 31, x, 11.7, z, { frequency: 1 / o.noiseScale, octaves: 2, lacunarity: 2, gain: 0.5 }) * 2 * o.noise * (Math.PI / 180)
    return theta
  }

  /**
   * The field direction at (x, z) closest to heading (`hx`, `hz`): one of ±major, ±minor.
   * Writes a unit vector into `out`.
   */
  align(x: number, z: number, hx: number, hz: number, out: [number, number] = [0, 0]): [number, number] {
    const t = this.angle(x, z)
    const ux = Math.cos(t), uz = Math.sin(t)
    const major = ux * hx + uz * hz
    const minor = -uz * hx + ux * hz
    if (Math.abs(major) >= Math.abs(minor)) { out[0] = Math.sign(major || 1) * ux; out[1] = Math.sign(major || 1) * uz }
    else { out[0] = -Math.sign(minor) * uz; out[1] = Math.sign(minor) * ux }
    return out
  }
}
