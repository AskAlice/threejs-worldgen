/** The look of a grass field. Every {@link presets} entry is a complete GrassStyle. */
export interface GrassStyle {
  /** Blades per square metre at full density (LOD 0). */
  density: number
  /** Blade height in metres. Any height works (lawns ~0.1, meadows ~0.5, tall grass 1–3). */
  bladeHeight: number
  /** 0..1 random height spread per blade. */
  heightVariation: number
  /** Blade width at the base in metres. */
  bladeWidth: number
  /** 0..1 random width spread per blade. */
  widthVariation: number
  /** 0..1 natural droop of blades when there is no wind. */
  curvature: number
  /** Higher = less wind/interaction bending. */
  stiffness: number
  /** 0..1 how strongly blades gather into tufts that splay outwards. */
  clumping: number
  /** Tuft diameter in metres. */
  clumpSize: number
  /** Blade colour at the root (any CSS colour). */
  baseColor: string
  /** Blade colour at the tip (any CSS colour). */
  tipColor: string
  /** 0..1 per-blade brightness variation. */
  colorVariation: number
  /** 0..1 field-scale light/dark and dry patches. */
  patchiness: number
  /** 0..1 how much sunlight shines through blades when back-lit. */
  translucency: number
}

const preset = (s: GrassStyle) => s

/**
 * Twelve ready-made looks: eight inspired by real species and four stylized ones. Pass a name as
 * `preset`, then override any {@link GrassStyle} field you like.
 */
export const presets = {
  // Real species (unmown, natural-looking)
  /** Kentucky Bluegrass: dense, fine, blue-green meadow grass. The default. */
  kentuckyBluegrass: preset({
    density: 80,
    bladeHeight: 0.5,
    heightVariation: 0.45,
    bladeWidth: 0.038,
    widthVariation: 0.35,
    curvature: 0.5,
    stiffness: 1,
    clumping: 0.35,
    clumpSize: 0.5,
    baseColor: '#123c1e',
    tipColor: '#4f9d63',
    colorVariation: 0.14,
    patchiness: 0.45,
    translucency: 0.7
  }),
  /** Perennial Ryegrass: glossy, dark green, slightly taller tufts. */
  perennialRyegrass: preset({
    density: 46,
    bladeHeight: 0.55,
    heightVariation: 0.4,
    bladeWidth: 0.055,
    widthVariation: 0.3,
    curvature: 0.3,
    stiffness: 0.9,
    clumping: 0.55,
    clumpSize: 0.5,
    baseColor: '#143b0b',
    tipColor: '#58a32b',
    colorVariation: 0.12,
    patchiness: 0.35,
    translucency: 0.6
  }),
  /** Tall Fescue: coarse, wide blades in strong clumps, up to knee height. */
  tallFescue: preset({
    density: 30,
    bladeHeight: 0.85,
    heightVariation: 0.45,
    bladeWidth: 0.075,
    widthVariation: 0.35,
    curvature: 0.45,
    stiffness: 1.1,
    clumping: 0.7,
    clumpSize: 0.6,
    baseColor: '#1f3d10',
    tipColor: '#8aa748',
    colorVariation: 0.16,
    patchiness: 0.5,
    translucency: 0.6
  }),
  /** Bermuda Grass: very dense, short, fine-bladed turf. */
  bermudaGrass: preset({
    density: 90,
    bladeHeight: 0.24,
    heightVariation: 0.3,
    bladeWidth: 0.03,
    widthVariation: 0.25,
    curvature: 0.25,
    stiffness: 1.4,
    clumping: 0.2,
    clumpSize: 0.3,
    baseColor: '#2f5d1a',
    tipColor: '#93c454',
    colorVariation: 0.1,
    patchiness: 0.4,
    translucency: 0.5
  }),
  /** Zoysia Grass: short, stiff, carpet-like lawn grass. */
  zoysiaGrass: preset({
    density: 95,
    bladeHeight: 0.18,
    heightVariation: 0.25,
    bladeWidth: 0.032,
    widthVariation: 0.2,
    curvature: 0.2,
    stiffness: 1.8,
    clumping: 0.15,
    clumpSize: 0.25,
    baseColor: '#2c5a22',
    tipColor: '#82b957',
    colorVariation: 0.08,
    patchiness: 0.3,
    translucency: 0.4
  }),
  /** St. Augustine Grass: broad, flat, deep green blades. */
  stAugustineGrass: preset({
    density: 34,
    bladeHeight: 0.32,
    heightVariation: 0.3,
    bladeWidth: 0.1,
    widthVariation: 0.25,
    curvature: 0.3,
    stiffness: 1.4,
    clumping: 0.35,
    clumpSize: 0.4,
    baseColor: '#16400e',
    tipColor: '#4f9a2c',
    colorVariation: 0.1,
    patchiness: 0.35,
    translucency: 0.55
  }),
  /** Buffalo Grass: short, curly, grey-green prairie grass. */
  buffaloGrass: preset({
    density: 60,
    bladeHeight: 0.28,
    heightVariation: 0.4,
    bladeWidth: 0.03,
    widthVariation: 0.25,
    curvature: 0.7,
    stiffness: 1.1,
    clumping: 0.5,
    clumpSize: 0.35,
    baseColor: '#56664a',
    tipColor: '#c2cc9a',
    colorVariation: 0.15,
    patchiness: 0.5,
    translucency: 0.4
  }),
  /** Fine Fescue: very thin, floppy, blue-green blades. */
  fineFescue: preset({
    density: 72,
    bladeHeight: 0.6,
    heightVariation: 0.5,
    bladeWidth: 0.022,
    widthVariation: 0.2,
    curvature: 0.75,
    stiffness: 0.7,
    clumping: 0.65,
    clumpSize: 0.4,
    baseColor: '#22432a',
    tipColor: '#7fa98a',
    colorVariation: 0.14,
    patchiness: 0.4,
    translucency: 0.5
  }),
  // Stylized
  /** Toon Meadow (stylized): wide, saturated, bright green blades. */
  toonMeadow: preset({
    density: 32,
    bladeHeight: 0.55,
    heightVariation: 0.3,
    bladeWidth: 0.09,
    widthVariation: 0.2,
    curvature: 0.3,
    stiffness: 0.8,
    clumping: 0.3,
    clumpSize: 0.5,
    baseColor: '#1f8a2a',
    tipColor: '#a6f25c',
    colorVariation: 0.12,
    patchiness: 0.2,
    translucency: 0.9
  }),
  /** Golden Savanna (stylized): tall, dry, golden grass. */
  goldenSavanna: preset({
    density: 26,
    bladeHeight: 1.0,
    heightVariation: 0.45,
    bladeWidth: 0.045,
    widthVariation: 0.3,
    curvature: 0.5,
    stiffness: 0.7,
    clumping: 0.6,
    clumpSize: 0.6,
    baseColor: '#6e5220',
    tipColor: '#f0d27a',
    colorVariation: 0.18,
    patchiness: 0.35,
    translucency: 0.9
  }),
  /** Autumn Haze (stylized): olive-to-ochre autumn field. */
  autumnHaze: preset({
    density: 34,
    bladeHeight: 0.5,
    heightVariation: 0.4,
    bladeWidth: 0.05,
    widthVariation: 0.3,
    curvature: 0.45,
    stiffness: 0.9,
    clumping: 0.5,
    clumpSize: 0.5,
    baseColor: '#4a3214',
    tipColor: '#b39143',
    colorVariation: 0.22,
    patchiness: 0.5,
    translucency: 0.7
  }),
  /** Frostbite (stylized): pale, frosted silver-white grass. */
  frostbite: preset({
    density: 38,
    bladeHeight: 0.45,
    heightVariation: 0.4,
    bladeWidth: 0.04,
    widthVariation: 0.3,
    curvature: 0.35,
    stiffness: 1.5,
    clumping: 0.6,
    clumpSize: 0.45,
    baseColor: '#3e5462',
    tipColor: '#e4eef0',
    colorVariation: 0.1,
    patchiness: 0.25,
    translucency: 0.5
  })
}

/** Name of one of the built-in {@link presets}. */
export type PresetName = keyof typeof presets
