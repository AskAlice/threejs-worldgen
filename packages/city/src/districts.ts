import { cellular, fbm, type CellSample } from 'threejs-biomes'

/** Kinds of district. Each sets street spacing, lot sizes, building heights and styles. */
export type District = 'downtown' | 'residential' | 'industrial' | 'park' | 'farmland'

/** Every district, in a fixed order (used for indexing palettes and stats). */
export const DISTRICTS: readonly District[] = ['downtown', 'residential', 'industrial', 'park', 'farmland']

/** Layout and building rules for one kind of district. */
export interface DistrictStyle {
  /** Spacing of minor streets, metres (0 = no minor streets, e.g. fields and parks). */
  blockSize: number
  /** Target lot area, m². Blocks are split until lots are about this big. */
  lotArea: number
  /** Narrowest acceptable lot, metres (also the smallest split piece). */
  lotWidth: number
  /** Building setback from the lot edge, metres. */
  setback: number
  /** Chance (0..1) that a lot with street frontage gets a building. */
  coverage: number
  /** Floor count range: the low end at the settlement edge, the high end where density peaks. */
  floors: [number, number]
}

/** Where each district goes. Boundaries wobble with noise so they don't form perfect rings. */
export interface DistrictOptions {
  /** Boundary wobble, as a fraction of the settlement radius. */
  noise: number
  /** Size of industrial estates and neighbourhood patches, metres. */
  patchSize: number
  /** Size of parks, metres. */
  parkSize: number
  /** Width (fraction of the radius) of the density peak that makes downtown tall. */
  densityFalloff: number
  /** Per-district rules. */
  styles: Record<District, DistrictStyle>
}

/** Default district rules. */
export const DEFAULT_DISTRICTS: DistrictOptions = {
  noise: 0.12,
  patchSize: 260,
  parkSize: 140,
  densityFalloff: 0.42,
  styles: {
    downtown: { blockSize: 85, lotArea: 900, lotWidth: 16, setback: 0.5, coverage: 0.95, floors: [4, 42] },
    residential: { blockSize: 110, lotArea: 520, lotWidth: 13, setback: 4, coverage: 0.85, floors: [1, 7] },
    industrial: { blockSize: 190, lotArea: 3200, lotWidth: 34, setback: 6, coverage: 0.8, floors: [1, 2] },
    park: { blockSize: 0, lotArea: 6000, lotWidth: 30, setback: 0, coverage: 0, floors: [0, 0] },
    farmland: { blockSize: 0, lotArea: 14000, lotWidth: 60, setback: 18, coverage: 0.12, floors: [1, 2] },
  },
}

/** District shares for one settlement (from its size class). */
export interface DistrictShares {
  /** Downtown reaches this fraction of the radius (0 = no downtown). */
  downtown: number
  /** Farmland starts at this fraction of the radius. */
  farmland: number
  /** Share (0..1) of the built-up ring that is industrial. */
  industrial: number
  /** Share (0..1) of the built-up area that is park. */
  park: number
}

/** Answers "which district is this?" and "how dense is it here?" for one settlement. */
export class DistrictMap {
  /** Rules in use. */
  readonly options: DistrictOptions
  /** District shares in use. */
  readonly shares: DistrictShares
  /** Settlement centre. */
  readonly cx: number
  /** Settlement centre. */
  readonly cz: number
  /** Settlement radius, metres. */
  readonly radius: number
  private readonly seed: number
  private readonly cell: CellSample = { distance: 0, point: [0, 0, 0], random: 0 }

  /** District layout around (`cx`, `cz`) for a settlement of `radius` metres. */
  constructor(options: DistrictOptions, shares: DistrictShares, cx: number, cz: number, radius: number, seed: number) {
    this.options = options
    this.shares = shares
    this.cx = cx; this.cz = cz; this.radius = radius; this.seed = seed
  }

  /** Distance from the centre as a fraction of the radius, with boundary noise. */
  private reach(x: number, z: number): number {
    const d = Math.hypot(x - this.cx, z - this.cz) / this.radius
    return d + fbm(this.seed + 41, x, 3.3, z, { frequency: 1.5 / this.radius, octaves: 3, lacunarity: 2, gain: 0.5 }) * 2 * this.options.noise
  }

  /** The district at (x, z). */
  at(x: number, z: number): District {
    const s = this.shares
    const d = this.reach(x, z)
    if (d < s.downtown) return 'downtown'
    if (d > s.farmland) return 'farmland'
    const o = this.options
    if (s.park > 0 && cellular(this.seed + 43, x / o.parkSize, 1.7, z / o.parkSize, 0.9, this.cell).random < s.park) return 'park'
    if (s.industrial > 0 && d > s.downtown + 0.12 && cellular(this.seed + 47, x / o.patchSize, 2.9, z / o.patchSize, 0.9, this.cell).random < s.industrial) return 'industrial'
    return 'residential'
  }

  /** The rules of the district at (x, z). */
  style(x: number, z: number): DistrictStyle {
    return this.options.styles[this.at(x, z)]
  }

  /** Building density 0..1: peaks downtown and falls off towards the edge (with a little noise). */
  density(x: number, z: number): number {
    const d = Math.hypot(x - this.cx, z - this.cz) / (this.radius * this.options.densityFalloff)
    const n = fbm(this.seed + 53, x, 5.1, z, { frequency: 1 / 120, octaves: 2, lacunarity: 2, gain: 0.5 })
    return Math.min(1, Math.max(0, Math.exp(-d * d) * (0.85 + n * 0.6)))
  }
}
