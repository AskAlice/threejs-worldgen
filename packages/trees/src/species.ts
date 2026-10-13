/** Envelope that attraction points are sampled in; it gives the crown its silhouette. */
export type CrownShape = 'sphere' | 'ellipsoid' | 'hemisphere' | 'cone' | 'column' | 'umbrella' | 'vase'

/** Pattern drawn on leaf cards (generated procedurally, no image files). `'none'` = no foliage. */
export type LeafShape = 'broad' | 'needle' | 'palm' | 'fern' | 'blade' | 'none'

/**
 * Which generator builds the plant: space colonisation for trees and shrubs, or a dedicated simple generator for
 * plants that don't branch like trees.
 */
export type TreeKind = 'colonization' | 'palm' | 'cactus' | 'fern' | 'reed' | 'flowers' | 'tuft' | 'succulent' | 'bamboo' | 'lilyPad'

/** Every parameter of a generated tree or plant. All lengths are metres. Plain JSON. */
export interface TreeParams {
  /** Generator; see {@link TreeKind}. */
  kind: TreeKind
  /** Total height (top of the crown). */
  height: number
  /** Height of the clear trunk below the crown (where the crown envelope starts). */
  trunkHeight: number
  /** Crown silhouette. */
  crownShape: CrownShape
  /** Horizontal radius of the crown envelope. */
  crownRadius: number
  /** Vertical extent of the crown envelope, ending at `height`. */
  crownHeight: number
  /** Attraction points sampled in the crown. More = denser, finer branching (and slower generation). */
  attractionPoints: number
  /** Length of one growth step (branch segment). */
  segmentLength: number
  /** Attraction points this close to a branch are reached and removed. */
  killDistance: number
  /** Attraction points only pull branch nodes within this distance. */
  influenceDistance: number
  /** Maximum growth steps. */
  iterations: number
  /** Added to every growth direction: `[0, -0.3, 0]` makes branches droop (gravity), `[0, 0.3, 0]` reach up (light). */
  tropism: [x: number, y: number, z: number]
  /** Random wobble added to growth directions, 0..1. High values give gnarled, twisting wood. */
  jitter: number
  /** Grow a straight central leader through the whole crown (conifers). */
  leader: boolean
  /** Stems rising from the ground. 1 = a tree; several = a multi-stemmed shrub (cactus: number of arms; reed: stalks). */
  stems: number
  /** Maximum random lean of the trunk, in radians. */
  trunkLean: number
  /** Pipe-model exponent: a parent's radius^e = the sum of its children's. 2 = da Vinci's rule; lower = thicker limbs. */
  radiusExponent: number
  /** Trunk radius at the base (above any flare). */
  baseRadius: number
  /** Radius of the thinnest twigs. */
  tipRadius: number
  /** Extra radius right at the ground, as a fraction of `baseRadius` (0.5 = 50 % wider). */
  rootFlare: number
  /** Lobed buttress roots at the base, 0..1 (bald cypress, rainforest emergents). */
  buttress: number
  /** Arching prop roots from the lower trunk into the ground (mangroves). */
  propRoots: number
  /** Sides of the trunk tube. Branches use fewer, twigs at least 3. */
  radialSegments: number
  /** Pattern on the leaf cards. */
  leafShape: LeafShape
  /** Edge length of one leaf card (a cluster of leaves). For palms and ferns: frond length; for reeds: blade length. */
  leafSize: number
  /** Leaf cards per twig node (fractional values are random). Palms/ferns: fronds; reeds: blades per stalk. */
  leafDensity: number
  /** How many nodes back from each branch tip carry leaves. Conifers: many (needles along branches); broadleaves: few. */
  leafDepth: number
  /** Bark (or stem) base colour, CSS. */
  barkColor: string
  /** Strength of bark furrows and colour noise, 0..1 (birch and beech are smooth, oak and pine deeply furrowed). */
  barkContrast: number
  /** Dark horizontal marks on the bark, 0..1 (birch). */
  barkMarks: number
  /** Leaf base colour, CSS. */
  leafColor: string
  /** Per-card variation of leaf brightness and hue, 0..1. */
  leafColorVariation: number
  /** Fruit (apples, berries) per leafy twig node, fractional = probability; flower heads per stalk; 0 = none. */
  fruit: number
  /** Fruit or flower-head diameter. */
  fruitSize: number
  /** Colours fruit and petals are picked from (seeded per fruit). CSS. */
  fruitColors: string[]
  /** Suggested minimum distance between two of these when scattered (used by `createVegetationLayers`). */
  spacing: number
  /** Per-instance uniform scale range when scattered. */
  scaleRange: [min: number, max: number]
  /** Per-instance hue shift of foliage (± radians), so scattered copies of one variant don't look cloned. */
  hueVariation: number
  /** Per-instance saturation change of foliage (± fraction). */
  saturationVariation: number
  /** Per-instance random lean when scattered, radians. */
  leanVariation: number
  /** Per-instance crown thinning, 0..1: each instance drops a random share (up to this) of its leaf cards. */
  densityVariation: number
}

/** The species preset names. Other packages (biomes, worldgen) refer to these keys. */
export type SpeciesName =
  | 'oak' | 'beech' | 'maple' | 'birch' | 'spruce' | 'pine' | 'fir' | 'redwood' | 'acacia' | 'baobab' | 'palm'
  | 'jungleEmergent' | 'olive' | 'cypress' | 'mangrove' | 'deadSnag' | 'cactus' | 'shrub' | 'dwarfShrub' | 'thornShrub'
  | 'fern' | 'reed' | 'apple' | 'berryBush' | 'flowers' | 'tallGrassTuft' | 'succulent' | 'bamboo' | 'lilyPad'

/** Parameters every species starts from (a generic broadleaf tree). */
export const DEFAULT_TREE_PARAMS: TreeParams = {
  kind: 'colonization',
  height: 14,
  trunkHeight: 3.5,
  crownShape: 'ellipsoid',
  crownRadius: 6,
  crownHeight: 10.5,
  attractionPoints: 2200,
  segmentLength: 0.35,
  killDistance: 0.7,
  influenceDistance: 2.8,
  iterations: 140,
  tropism: [0, 0.04, 0],
  jitter: 0.25,
  leader: false,
  stems: 1,
  trunkLean: 0.06,
  radiusExponent: 2.3,
  baseRadius: 0.4,
  tipRadius: 0.012,
  rootFlare: 0.35,
  buttress: 0,
  propRoots: 0,
  radialSegments: 9,
  leafShape: 'broad',
  leafSize: 0.75,
  leafDensity: 2,
  leafDepth: 3,
  barkColor: '#5a4a3c',
  barkContrast: 0.6,
  barkMarks: 0,
  leafColor: '#4a6b2a',
  leafColorVariation: 0.15,
  fruit: 0,
  fruitSize: 0.08,
  fruitColors: ['#b3261e'],
  spacing: 9,
  scaleRange: [0.8, 1.2],
  hueVariation: 0.08,
  saturationVariation: 0.12,
  leanVariation: 0.03,
  densityVariation: 0.25,
}

const p = (overrides: Partial<TreeParams>): TreeParams => ({ ...DEFAULT_TREE_PARAMS, ...overrides })

/** Tuned parameters per species. Spread one and override fields to make your own: `{ ...species.oak, height: 20 }`. */
export const species: Record<SpeciesName, TreeParams> = {
  oak: p({ height: 14, trunkHeight: 3.2, crownRadius: 7, crownHeight: 11, jitter: 0.35, baseRadius: 0.45, barkColor: '#54463a', barkContrast: 0.75 }),
  beech: p({
    height: 19, trunkHeight: 5, crownRadius: 7, crownHeight: 14, baseRadius: 0.4, barkColor: '#8b8a82', barkContrast: 0.2,
    leafColor: '#557a2e', jitter: 0.18, tropism: [0, 0.08, 0], attractionPoints: 2600,}),
  maple: p({
    height: 15, trunkHeight: 3, crownShape: 'sphere', crownRadius: 6, crownHeight: 12, barkColor: '#5d544c', barkContrast: 0.5,
    leafColor: '#5d8a2c', leafSize: 0.8,
  }),
  birch: p({
    height: 16, trunkHeight: 4, crownRadius: 3.2, crownHeight: 11.5, baseRadius: 0.2, tipRadius: 0.008, tropism: [0, -0.12, 0],
    attractionPoints: 900, influenceDistance: 2.2, barkColor: '#dcd7cc', barkContrast: 0.25, barkMarks: 0.8, leafColor: '#6c9136',
    leafSize: 0.55, leafDensity: 1.8, spacing: 6, segmentLength: 0.3, killDistance: 0.6,}),
  spruce: p({
    height: 22, trunkHeight: 1.5, crownShape: 'cone', crownRadius: 4, crownHeight: 20.5, leader: true, attractionPoints: 1400,
    segmentLength: 0.35, killDistance: 0.7, influenceDistance: 2.0, tropism: [0, -0.28, 0], jitter: 0.12, radiusExponent: 2.1,
    baseRadius: 0.36, tipRadius: 0.01, radialSegments: 8, leafShape: 'needle', leafSize: 1.2, leafDensity: 2.2, leafDepth: 8,
    barkColor: '#4b3a2f', leafColor: '#2b4a2b', leafColorVariation: 0.1, spacing: 5,
  }),
  pine: p({
    height: 19, trunkHeight: 9.5, crownShape: 'ellipsoid', crownRadius: 4.2, crownHeight: 9, attractionPoints: 1000, tropism: [0, 0.14, 0],
    jitter: 0.3, baseRadius: 0.38, leafShape: 'needle', leafSize: 1.1, leafDensity: 2.4, leafDepth: 5, barkColor: '#7a4f35',
    barkContrast: 0.8, leafColor: '#3c5a2c', spacing: 7, segmentLength: 0.35, killDistance: 0.7, influenceDistance: 2.4,}),
  fir: p({
    height: 20, trunkHeight: 1.2, crownShape: 'cone', crownRadius: 3.4, crownHeight: 18.8, leader: true, attractionPoints: 1300,
    segmentLength: 0.33, killDistance: 0.66, influenceDistance: 1.9, tropism: [0, -0.1, 0], jitter: 0.08, radiusExponent: 2.1,
    baseRadius: 0.32, tipRadius: 0.01, radialSegments: 8, leafShape: 'needle', leafSize: 1.1, leafDensity: 2.4, leafDepth: 9,
    barkColor: '#5b5149', barkContrast: 0.35, leafColor: '#264238', leafColorVariation: 0.08, spacing: 4.5,
  }),
  redwood: p({
    height: 48, trunkHeight: 14, crownShape: 'column', crownRadius: 4.8, crownHeight: 34, leader: true, attractionPoints: 2500,
    segmentLength: 0.6, killDistance: 1.2, influenceDistance: 3, tropism: [0, -0.18, 0], jitter: 0.15, radiusExponent: 2,
    baseRadius: 1.5, tipRadius: 0.015, rootFlare: 0.55, radialSegments: 12, leafShape: 'needle', leafSize: 1.7, leafDensity: 2.2,
    leafDepth: 6, barkColor: '#7b3f2a', barkContrast: 0.9, leafColor: '#33502d', spacing: 14,
  }),
  acacia: p({
    height: 8, trunkHeight: 3, crownShape: 'umbrella', crownRadius: 6.5, crownHeight: 2.4, attractionPoints: 1200, segmentLength: 0.35,
    killDistance: 0.7, influenceDistance: 3.5, tropism: [0, 0.1, 0], jitter: 0.35, trunkLean: 0.15, baseRadius: 0.27, radiusExponent: 2.1,
    leafSize: 0.6, leafDensity: 2, leafDepth: 2, barkColor: '#4a3e33', leafColor: '#69803a', spacing: 22,
  }),
  baobab: p({
    height: 16, trunkHeight: 10.5, crownShape: 'umbrella', crownRadius: 7, crownHeight: 4.5, attractionPoints: 220, segmentLength: 0.6,
    killDistance: 1.2, influenceDistance: 5, tropism: [0, 0.2, 0], jitter: 0.3, radiusExponent: 1.55, baseRadius: 1.7, tipRadius: 0.06,
    rootFlare: 0.25, radialSegments: 12, leafSize: 0.7, leafDensity: 0.7, leafDepth: 1, barkColor: '#9a8b7a', barkContrast: 0.3,
    leafColor: '#5d7a2f', spacing: 30,
  }),
  palm: p({
    kind: 'palm', height: 10, baseRadius: 0.2, trunkLean: 0.3, radialSegments: 8, leafShape: 'palm', leafSize: 4.6, leafDensity: 14,
    barkColor: '#8a7560', barkContrast: 0.5, leafColor: '#4f7a2a', spacing: 7,
  }),
  jungleEmergent: p({
    height: 42, trunkHeight: 30, crownShape: 'umbrella', crownRadius: 11, crownHeight: 8, attractionPoints: 2500, segmentLength: 0.6,
    killDistance: 1.2, influenceDistance: 5, tropism: [0, 0.12, 0], jitter: 0.25, baseRadius: 1.0, rootFlare: 0.5, buttress: 0.9,
    radialSegments: 12, leafSize: 1.1, leafDensity: 1.6, leafDepth: 2, barkColor: '#8d8270', barkContrast: 0.35, leafColor: '#3e6a25',
    spacing: 18,
  }),
  olive: p({
    height: 6, trunkHeight: 1.3, crownRadius: 3.6, crownHeight: 4.5, attractionPoints: 900, segmentLength: 0.25, killDistance: 0.5,
    influenceDistance: 1.8, jitter: 0.65, trunkLean: 0.35, stems: 2, radiusExponent: 2.1, baseRadius: 0.32, leafSize: 0.42,
    leafDensity: 2, barkColor: '#6b6359', barkContrast: 0.85, leafColor: '#7b8a5b', leafColorVariation: 0.1, spacing: 8,
  }),
  cypress: p({
    height: 24, trunkHeight: 5, crownShape: 'cone', crownRadius: 4.6, crownHeight: 19, leader: true, attractionPoints: 1500,
    segmentLength: 0.45, killDistance: 0.9, influenceDistance: 2.6, tropism: [0, -0.06, 0], jitter: 0.2, baseRadius: 0.6, rootFlare: 0.9,
    buttress: 0.7, radialSegments: 11, leafShape: 'needle', leafSize: 1.2, leafDensity: 2.2, leafDepth: 6, barkColor: '#7a6a5c',
    barkContrast: 0.5, leafColor: '#5d7a3a', spacing: 9,
  }),
  mangrove: p({
    height: 7, trunkHeight: 2.6, crownShape: 'hemisphere', crownRadius: 4, crownHeight: 4.4, attractionPoints: 900, segmentLength: 0.3,
    killDistance: 0.6, influenceDistance: 2.2, jitter: 0.35, baseRadius: 0.2, propRoots: 11, leafSize: 0.5, leafDensity: 1.8,
    barkColor: '#5e5248', leafColor: '#3d5f2a', spacing: 6,
  }),
  deadSnag: p({
    height: 12, trunkHeight: 5, crownRadius: 3, crownHeight: 7, attractionPoints: 90, segmentLength: 0.55, killDistance: 1.1,
    influenceDistance: 3, jitter: 0.55, baseRadius: 0.35, tipRadius: 0.035, leafShape: 'none', leafDensity: 0, barkColor: '#8f877c',
    barkContrast: 0.7, spacing: 25,
  }),
  cactus: p({
    kind: 'cactus', height: 6, baseRadius: 0.28, stems: 3, radialSegments: 20, leafShape: 'none', leafDensity: 0,
    barkColor: '#4f6b3a', barkContrast: 0.3, spacing: 10,
  }),
  shrub: p({
    height: 1.8, trunkHeight: 0.15, crownShape: 'hemisphere', crownRadius: 1.4, crownHeight: 1.65, attractionPoints: 500,
    segmentLength: 0.12, killDistance: 0.24, influenceDistance: 0.7, stems: 4, trunkLean: 0.5, baseRadius: 0.05, tipRadius: 0.005,
    rootFlare: 0, radialSegments: 5, leafSize: 0.38, leafDensity: 2.2, leafDepth: 3, leafColor: '#4d6b2a', spacing: 3,
  }),
  dwarfShrub: p({
    height: 0.5, trunkHeight: 0.04, crownShape: 'hemisphere', crownRadius: 0.6, crownHeight: 0.46, attractionPoints: 300,
    segmentLength: 0.05, killDistance: 0.1, influenceDistance: 0.3, stems: 5, trunkLean: 0.8, jitter: 0.4, baseRadius: 0.02,
    tipRadius: 0.003, rootFlare: 0, radialSegments: 4, leafSize: 0.16, leafDensity: 2.2, leafDepth: 3, leafColor: '#5e6e35',
    barkColor: '#4a3a30', spacing: 1.2,
  }),
  thornShrub: p({
    height: 2.2, trunkHeight: 0.3, crownShape: 'vase', crownRadius: 1.6, crownHeight: 1.9, attractionPoints: 400, segmentLength: 0.14,
    killDistance: 0.28, influenceDistance: 0.9, stems: 3, trunkLean: 0.4, jitter: 0.6, baseRadius: 0.06, tipRadius: 0.006,
    rootFlare: 0, radialSegments: 5, leafSize: 0.26, leafDensity: 0.9, leafDepth: 2, barkColor: '#5b4a3d', leafColor: '#6b7a3a',
    spacing: 4,
  }),
  fern: p({
    kind: 'fern', height: 0.9, baseRadius: 0.012, radialSegments: 4, leafShape: 'fern', leafSize: 1.0, leafDensity: 9,
    barkColor: '#4a5a2a', leafColor: '#4a7a2c', spacing: 1.6,
  }),
  reed: p({
    kind: 'reed', height: 2.2, baseRadius: 0.01, stems: 12, radialSegments: 4, leafShape: 'blade', leafSize: 1.4, leafDensity: 2,
    barkColor: '#8a7a50', leafColor: '#7a8a45', spacing: 0.9, leanVariation: 0.15,
  }),
  apple: p({
    height: 5, trunkHeight: 1.3, crownShape: 'sphere', crownRadius: 2.7, attractionPoints: 900, segmentLength: 0.22, killDistance: 0.45,
    influenceDistance: 1.7, jitter: 0.45, trunkLean: 0.15, tropism: [0, 0.02, 0], radiusExponent: 2.2, baseRadius: 0.18, tipRadius: 0.007,
    rootFlare: 0.2, radialSegments: 7, leafSize: 0.45, leafDensity: 1.7, leafDepth: 3, barkColor: '#5e4b3c', barkContrast: 0.7,
    leafColor: '#5c8a34', fruit: 0.3, fruitSize: 0.08, fruitColors: ['#b3261e', '#c8412a', '#a51d2d', '#d9a23a', '#9fb33a'], spacing: 6,
    scaleRange: [0.85, 1.15],
  }),
  berryBush: p({
    height: 1.4, trunkHeight: 0.1, crownShape: 'hemisphere', crownRadius: 1.1, crownHeight: 1.3, attractionPoints: 420, segmentLength: 0.1,
    killDistance: 0.2, influenceDistance: 0.6, stems: 5, trunkLean: 0.5, jitter: 0.35, baseRadius: 0.035, tipRadius: 0.004, rootFlare: 0,
    radialSegments: 4, leafSize: 0.3, leafDensity: 2.4, leafDepth: 3, barkColor: '#4e3d33', leafColor: '#3f6a2a', fruit: 0.7,
    fruitSize: 0.03, fruitColors: ['#c0182a', '#a3142a', '#2a1f5c'], spacing: 2.2, scaleRange: [0.7, 1.3],
  }),
  flowers: p({
    kind: 'flowers', height: 0.45, stems: 7, baseRadius: 0.004, radialSegments: 3, leafShape: 'blade', leafSize: 0.25, leafDensity: 2,
    barkColor: '#4d7a2e', leafColor: '#4d7a2e', fruit: 0.9, fruitSize: 0.06,
    fruitColors: ['#f2d43a', '#ecebf2', '#d9467a', '#8a5cd6', '#f08a2c', '#e23b3b'], spacing: 0.6, scaleRange: [0.7, 1.3],
    hueVariation: 0.15, leanVariation: 0.1,
  }),
  tallGrassTuft: p({
    kind: 'tuft', height: 0.9, baseRadius: 0.01, leafShape: 'blade', leafSize: 0.9, leafDensity: 22, barkColor: '#6d7a3a',
    leafColor: '#7d8f45', leafColorVariation: 0.2, spacing: 0.7, scaleRange: [0.6, 1.3], hueVariation: 0.12, leanVariation: 0.1,
  }),
  succulent: p({
    kind: 'succulent', height: 0.3, baseRadius: 0.03, radialSegments: 6, leafShape: 'none', leafSize: 0.24, leafDensity: 18,
    barkColor: '#6f9a7a', barkContrast: 0.15, spacing: 0.8, scaleRange: [0.6, 1.4], hueVariation: 0.15,
  }),
  bamboo: p({
    kind: 'bamboo', height: 9, stems: 14, baseRadius: 0.05, radialSegments: 7, leafShape: 'blade', leafSize: 0.32, leafDensity: 5,
    barkColor: '#7f9a3e', barkContrast: 0.2, leafColor: '#5f8a35', spacing: 4, scaleRange: [0.75, 1.15], leanVariation: 0.05,
  }),
  lilyPad: p({
    kind: 'lilyPad', height: 0.05, leafShape: 'none', leafSize: 0.35, leafDensity: 5, barkColor: '#3f6b2a', barkContrast: 0.15,
    fruit: 0.3, fruitSize: 0.12, fruitColors: ['#f4f1ee', '#f2b6c8', '#f7e27a'], spacing: 1.2, scaleRange: [0.7, 1.4], leanVariation: 0,
  }),
}
