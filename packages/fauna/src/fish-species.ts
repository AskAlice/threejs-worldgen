/**
 * Fish species: plain JSON describing a body (lofted cross-sections along a spine), fins, a colour
 * pattern, how it swims, where it lives and how it schools. Tweak, save, replace or add species
 * without code.
 */
import type { WorldSample } from 'threejs-biomes'
import type { Band } from './boids.ts'
import type { Habitat } from './placement.ts'

/** Caudal (tail) fin outline. */
export type TailShape = 'forked' | 'lunate' | 'rounded' | 'truncate'

/** A median fin (dorsal or anal) along the back or belly. Positions are fractions of the total length (0 = nose, 1 = tail tip). */
export interface FinSpec {
  /** Where the fin base starts. */
  start: number
  /** Length of the fin base. */
  length: number
  /** Fin height as a fraction of the total length. */
  height: number
  /** How far the fin leans back (0 = upright, 1 = swept back by its own height). */
  sweep: number
}

/** A paired fin (pectoral or pelvic), one on each side. */
export interface PairedFinSpec {
  /** Where along the body it attaches (0 = nose, 1 = tail tip). */
  position: number
  /** Where on the flank it attaches: −1 belly … 1 back. */
  height: number
  /** Fin length as a fraction of the total length. 0 = no fin. */
  size: number
  /** Droop below horizontal, radians (0 = straight out, ~1.4 = hanging down). */
  angle: number
}

/** Body shape. Lengths are fractions of the total length (the fish is built 1 unit long and scaled). */
export interface FishShape {
  /** Deepest body height (back to belly). 0.15 = slender (pike), 0.6 = disc (tang). */
  depth: number
  /** Widest body width. */
  width: number
  /** Where the body is deepest, as a fraction of the body (not counting the tail fin). */
  depthAt: number
  /** Share of the total length that is body; the rest is the tail fin. */
  bodyLength: number
  /** Nose shape exponent: 0.4 blunt and round … 1.2 long and pointed. */
  nose: number
  /** Share of the depth above the spine: 0.5 symmetric, 0.65 humped back, 0.35 deep belly. */
  back: number
  /** Tail-stalk (peduncle) height as a fraction of the deepest height. */
  peduncle: number
  /** Cross-section exponent: 2 = ellipse, 3 = boxy. */
  squareness: number
  /** Tail fin. */
  tail: {
    /** Outline. */
    shape: TailShape
    /** Span (tip to tip) as a fraction of the total length. */
    height: number
    /** 0…1 depth of the notch for forked and lunate tails. */
    fork: number
    /** 0 = symmetric, 0.5 = upper lobe much longer (sharks). */
    asymmetry: number
  }
  /** Dorsal fins along the back, front to back. */
  dorsal: FinSpec[]
  /** Anal fins along the belly. */
  anal: FinSpec[]
  /** Pectoral fins (behind the gills). */
  pectoral: PairedFinSpec
  /** Pelvic fins (under the belly). */
  pelvic: PairedFinSpec
  /** Mouth. */
  mouth: {
    /** Length of the mouth line as a fraction of the total length. */
    size: number
    /** −1 underslung (carp, shark) … 0 terminal … 1 upturned. */
    tilt: number
  }
  /** Eye. */
  eye: {
    /** Radius as a fraction of the total length. */
    size: number
    /** Distance from the nose as a fraction of the total length. */
    position: number
    /** Height on the head: −1 belly … 1 back. */
    height: number
  }
}

/** Colour pattern, drawn in the shader (no textures). Colours are `#rrggbb`. */
export interface FishPattern {
  /** Back colour. */
  back: string
  /** Belly colour. */
  belly: string
  /** Fin colour. */
  fin: string
  /** 0…1 countershading (dark back, light belly). 0 = all `back`. */
  countershade: number
  /** Where back meets belly, −1 … 1. */
  shadeLine: number
  /** Stripes or bars. */
  stripes: {
    /** Stripes per body length (0 = none). */
    count: number
    /** 0…1 share of each period that is stripe. */
    width: number
    /** Stripe colour. */
    color: string
    /** 0 = vertical bars, 1 = lengthwise lines. */
    direction: number
    /** Waviness (mackerel). */
    wobble: number
    /** Height range [−1…1, −1…1] (belly…back) where stripes appear. */
    region: [number, number]
    /** 0…1 dark outline around stripes (clownfish). */
    edge: number
  }
  /** Spots. */
  spots: {
    /** Spots per body length (0 = none). */
    density: number
    /** Spot radius as a fraction of the spot spacing (≤ 0.25). */
    size: number
    /** Spot colour. */
    color: string
    /** Height range where spots appear. */
    region: [number, number]
  }
  /** 0…1 thin-film iridescence on the flanks. */
  iridescence: number
  /** 0…1 silvery sheen. */
  metalness: number
  /** Surface roughness. */
  roughness: number
  /** Iris colour. */
  eye: string
}

/** Where a species lives. */
export interface FishHabitat {
  /** Fresh water (rivers, inland), sea, or either. */
  water: 'fresh' | 'sea' | 'any'
  /** Water temperature range, °C (soft edges of 2 °C). */
  temperature: [number, number]
  /** Water depth range, metres (soft edges of 20 %). */
  depth: [number, number]
  /** Relative abundance where it fits (0 = never spawns). */
  weight: number
}

/** How a species schools. */
export interface SchoolSpec {
  /** Fish per school, [min, max]. 1 = solitary. */
  size: [number, number]
  /** Distance kept between neighbours, in body lengths. */
  spacing: number
  /** Cruising speed, body lengths per second. */
  speed: number
  /** How far (metres) a school roams from its home. */
  roam: number
}

/** How a species swims (drives the vertex animation). */
export interface SwimSpec {
  /** Tail amplitude as a fraction of the length. */
  amplitude: number
  /** Body wavelength in body lengths (≈1 for most fish, shorter for eels). */
  wavelength: number
  /** Tail beats per body length swum. */
  beat: number
  /** Pectoral fin flutter, 0…1. */
  flutter: number
}

/** A fish species. All plain JSON. */
export interface FishSpecies {
  /** Display name. */
  name: string
  /** Typical adult length, metres. */
  length: number
  /** ± fraction of length varied per fish. */
  lengthVariation: number
  /** ± hue shift per fish, radians. */
  hueVariation: number
  /** Body. */
  shape: FishShape
  /** Colours. */
  pattern: FishPattern
  /** Swimming. */
  swim: SwimSpec
  /** Where it lives. */
  habitat: FishHabitat
  /** Schooling. */
  school: SchoolSpec
}

const base: FishSpecies = {
  name: 'Fish',
  length: 0.3,
  lengthVariation: 0.15,
  hueVariation: 0.08,
  shape: {
    depth: 0.24, width: 0.12, depthAt: 0.35, bodyLength: 0.82, nose: 0.7, back: 0.55, peduncle: 0.3, squareness: 2.2,
    tail: { shape: 'forked', height: 0.28, fork: 0.45, asymmetry: 0 },
    dorsal: [{ start: 0.3, length: 0.2, height: 0.1, sweep: 0.4 }],
    anal: [{ start: 0.58, length: 0.12, height: 0.06, sweep: 0.4 }],
    pectoral: { position: 0.26, height: -0.3, size: 0.12, angle: 0.5 },
    pelvic: { position: 0.45, height: -0.85, size: 0.08, angle: 1.1 },
    mouth: { size: 0.06, tilt: 0 },
    eye: { size: 0.025, position: 0.08, height: 0.3 },
  },
  pattern: {
    back: '#4a5a4a', belly: '#e8e4d8', fin: '#7a7a6a', countershade: 0.8, shadeLine: -0.1,
    stripes: { count: 0, width: 0.3, color: '#222222', direction: 0, wobble: 0, region: [-1, 1], edge: 0 },
    spots: { density: 0, size: 0.15, color: '#222222', region: [-1, 1] },
    iridescence: 0.2, metalness: 0.15, roughness: 0.35, eye: '#c8b060',
  },
  swim: { amplitude: 0.1, wavelength: 1, beat: 1.2, flutter: 0.5 },
  habitat: { water: 'sea', temperature: [0, 30], depth: [1, 100], weight: 1 },
  school: { size: [8, 20], spacing: 1.2, speed: 1, roam: 15 },
}

function species(over: DeepPartialSpecies): FishSpecies {
  return mergeSpecies(structuredClone(base), over)
}

type DeepPartialSpecies = { [K in keyof FishSpecies]?: FishSpecies[K] extends unknown[] ? FishSpecies[K] : FishSpecies[K] extends object ? { [L in keyof FishSpecies[K]]?: FishSpecies[K][L] extends unknown[] ? FishSpecies[K][L] : FishSpecies[K][L] extends object ? Partial<FishSpecies[K][L]> : FishSpecies[K][L] } : FishSpecies[K] }

function mergeSpecies<T>(target: T, over: unknown): T {
  for (const [k, v] of Object.entries(over as object)) {
    const t = target as Record<string, unknown>
    t[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergeSpecies(t[k], v) : v
  }
  return target
}

/**
 * Built-in fish, keyed by id, matched to habitats: freshwater (trout, carp, perch, pike), warm reef
 * (clownfish, tang, parrotfish), cold sea (cod, herring, mackerel) and large open-water fish (tuna,
 * shark).
 */
export const FISH_SPECIES: Readonly<Record<string, FishSpecies>> = {
  trout: species({
    name: 'Trout', length: 0.4,
    shape: { depth: 0.22, width: 0.12, depthAt: 0.38, nose: 0.65, tail: { shape: 'truncate', height: 0.24, fork: 0.15, asymmetry: 0 }, dorsal: [{ start: 0.33, length: 0.14, height: 0.09, sweep: 0.3 }, { start: 0.66, length: 0.04, height: 0.03, sweep: 0.2 }], mouth: { size: 0.08, tilt: 0 } },
    pattern: {
      back: '#5a6a3a', belly: '#f0e8d8', fin: '#8a7a5a', countershade: 0.7,
      stripes: { count: 1, width: 0.25, color: '#d07a8a', direction: 1, wobble: 0, region: [-0.25, 0.15], edge: 0 },
      spots: { density: 14, size: 0.16, color: '#2a2a1a', region: [-0.2, 1] },
      iridescence: 0.35,
    },
    habitat: { water: 'fresh', temperature: [2, 18], depth: [0.6, 8], weight: 1 },
    school: { size: [1, 4], spacing: 3, speed: 1.2, roam: 10 },
  }),
  carp: species({
    name: 'Carp', length: 0.55, hueVariation: 0.15,
    shape: { depth: 0.32, width: 0.16, depthAt: 0.38, nose: 0.5, back: 0.62, peduncle: 0.35, tail: { shape: 'forked', height: 0.3, fork: 0.35, asymmetry: 0 }, dorsal: [{ start: 0.32, length: 0.36, height: 0.08, sweep: 0.2 }], mouth: { size: 0.05, tilt: -0.6 } },
    pattern: { back: '#6a5a2a', belly: '#e0c890', fin: '#8a6a3a', countershade: 0.6, iridescence: 0.15, metalness: 0.3, eye: '#d0a040' },
    swim: { amplitude: 0.08, wavelength: 1.1, beat: 1, flutter: 0.6 },
    habitat: { water: 'fresh', temperature: [10, 30], depth: [0.8, 10], weight: 1 },
    school: { size: [3, 8], spacing: 2, speed: 0.6, roam: 12 },
  }),
  perch: species({
    name: 'Perch', length: 0.25,
    shape: { depth: 0.28, width: 0.13, depthAt: 0.36, back: 0.6, nose: 0.75, dorsal: [{ start: 0.26, length: 0.2, height: 0.12, sweep: 0.2 }, { start: 0.5, length: 0.14, height: 0.08, sweep: 0.3 }], tail: { shape: 'forked', height: 0.26, fork: 0.3, asymmetry: 0 } },
    pattern: {
      back: '#5a6a2a', belly: '#e8e0b0', fin: '#d06030', countershade: 0.7,
      stripes: { count: 6, width: 0.35, color: '#2a3a1a', direction: 0, wobble: 0.02, region: [-0.4, 1], edge: 0 },
    },
    habitat: { water: 'fresh', temperature: [4, 26], depth: [0.6, 12], weight: 1.2 },
    school: { size: [6, 18], spacing: 1.5, speed: 0.9, roam: 12 },
  }),
  pike: species({
    name: 'Pike', length: 0.8, lengthVariation: 0.25,
    shape: { depth: 0.15, width: 0.1, depthAt: 0.45, bodyLength: 0.86, nose: 1.15, back: 0.5, peduncle: 0.45, squareness: 2.4, tail: { shape: 'forked', height: 0.18, fork: 0.25, asymmetry: 0 }, dorsal: [{ start: 0.66, length: 0.12, height: 0.07, sweep: 0.3 }], anal: [{ start: 0.68, length: 0.1, height: 0.06, sweep: 0.3 }], mouth: { size: 0.1, tilt: 0.1 }, eye: { size: 0.018, position: 0.1, height: 0.5 } },
    pattern: {
      back: '#3a5a2a', belly: '#e8e8c0', fin: '#7a6a3a', countershade: 0.7,
      spots: { density: 10, size: 0.22, color: '#c8d090', region: [-0.6, 0.8] },
    },
    swim: { amplitude: 0.07, wavelength: 1, beat: 1, flutter: 0.3 },
    habitat: { water: 'fresh', temperature: [0, 24], depth: [0.8, 12], weight: 0.5 },
    school: { size: [1, 1], spacing: 4, speed: 0.4, roam: 14 },
  }),
  clownfish: species({
    name: 'Clownfish', length: 0.1, lengthVariation: 0.2, hueVariation: 0.05,
    shape: { depth: 0.36, width: 0.16, depthAt: 0.35, nose: 0.45, back: 0.55, peduncle: 0.45, squareness: 2.2, tail: { shape: 'rounded', height: 0.3, fork: 0, asymmetry: 0 }, dorsal: [{ start: 0.25, length: 0.42, height: 0.1, sweep: 0.15 }], anal: [{ start: 0.55, length: 0.15, height: 0.09, sweep: 0.2 }], pectoral: { position: 0.3, height: -0.2, size: 0.16, angle: 0.6 }, eye: { size: 0.04, position: 0.1, height: 0.3 } },
    pattern: {
      back: '#ff6a10', belly: '#ff8a30', fin: '#ff7a20', countershade: 0.2,
      stripes: { count: 3, width: 0.14, color: '#ffffff', direction: 0, wobble: 0.012, region: [-1, 1], edge: 0.9 },
      iridescence: 0, metalness: 0, roughness: 0.45, eye: '#ffa040',
    },
    swim: { amplitude: 0.1, wavelength: 1, beat: 2, flutter: 1 },
    habitat: { water: 'sea', temperature: [23, 35], depth: [1, 15], weight: 1 },
    school: { size: [2, 5], spacing: 2.5, speed: 1, roam: 4 },
  }),
  tang: species({
    name: 'Tang', length: 0.25,
    shape: { depth: 0.58, width: 0.1, depthAt: 0.42, nose: 0.55, back: 0.5, peduncle: 0.2, bodyLength: 0.8, squareness: 2, tail: { shape: 'lunate', height: 0.32, fork: 0.35, asymmetry: 0 }, dorsal: [{ start: 0.2, length: 0.55, height: 0.08, sweep: 0.1 }], anal: [{ start: 0.42, length: 0.35, height: 0.07, sweep: 0.1 }], mouth: { size: 0.03, tilt: 0.1 }, eye: { size: 0.035, position: 0.14, height: 0.35 } },
    pattern: {
      back: '#1a4ad0', belly: '#2a60e0', fin: '#102060', countershade: 0.3,
      stripes: { count: 1, width: 0.2, color: '#0a1030', direction: 1, wobble: 0.08, region: [-0.1, 0.8], edge: 0 },
      iridescence: 0.3, metalness: 0, eye: '#202020',
    },
    habitat: { water: 'sea', temperature: [22, 35], depth: [2, 30], weight: 1 },
    school: { size: [5, 14], spacing: 1.6, speed: 0.9, roam: 10 },
  }),
  parrotfish: species({
    name: 'Parrotfish', length: 0.45, hueVariation: 0.25,
    shape: { depth: 0.32, width: 0.15, depthAt: 0.38, nose: 0.45, back: 0.55, tail: { shape: 'lunate', height: 0.28, fork: 0.25, asymmetry: 0 }, dorsal: [{ start: 0.22, length: 0.45, height: 0.07, sweep: 0.1 }], anal: [{ start: 0.52, length: 0.18, height: 0.06, sweep: 0.2 }], mouth: { size: 0.04, tilt: 0 } },
    pattern: {
      back: '#20a080', belly: '#60d0b0', fin: '#e060a0', countershade: 0.4,
      stripes: { count: 2, width: 0.12, color: '#f070b0', direction: 1, wobble: 0.15, region: [-0.8, 0.9], edge: 0 },
      spots: { density: 9, size: 0.18, color: '#f0a0c0', region: [-1, 1] },
      iridescence: 0.4, metalness: 0,
    },
    swim: { amplitude: 0.08, wavelength: 1, beat: 1, flutter: 1 },
    habitat: { water: 'sea', temperature: [21, 35], depth: [1, 25], weight: 0.8 },
    school: { size: [3, 8], spacing: 2, speed: 0.7, roam: 14 },
  }),
  cod: species({
    name: 'Cod', length: 0.8, lengthVariation: 0.25,
    shape: { depth: 0.22, width: 0.14, depthAt: 0.3, nose: 0.6, back: 0.55, peduncle: 0.28, tail: { shape: 'truncate', height: 0.2, fork: 0, asymmetry: 0 }, dorsal: [{ start: 0.26, length: 0.12, height: 0.08, sweep: 0.2 }, { start: 0.42, length: 0.15, height: 0.07, sweep: 0.2 }, { start: 0.62, length: 0.14, height: 0.06, sweep: 0.2 }], anal: [{ start: 0.45, length: 0.14, height: 0.06, sweep: 0.2 }, { start: 0.63, length: 0.13, height: 0.05, sweep: 0.2 }], mouth: { size: 0.07, tilt: -0.2 } },
    pattern: {
      back: '#6a6a3a', belly: '#e8e4d0', fin: '#7a7050', countershade: 0.75,
      stripes: { count: 1, width: 0.06, color: '#e8e8d0', direction: 1, wobble: 0.03, region: [-0.2, 0.3], edge: 0 },
      spots: { density: 22, size: 0.2, color: '#4a4220', region: [-0.3, 1] },
      iridescence: 0.05,
    },
    swim: { amplitude: 0.08, wavelength: 1, beat: 1, flutter: 0.4 },
    habitat: { water: 'sea', temperature: [-2, 14], depth: [6, 200], weight: 1 },
    school: { size: [5, 16], spacing: 1.8, speed: 0.6, roam: 25 },
  }),
  herring: species({
    name: 'Herring', length: 0.28,
    shape: { depth: 0.2, width: 0.09, depthAt: 0.42, nose: 0.85, back: 0.45, peduncle: 0.25, tail: { shape: 'forked', height: 0.28, fork: 0.7, asymmetry: 0 }, dorsal: [{ start: 0.4, length: 0.12, height: 0.08, sweep: 0.3 }], anal: [{ start: 0.66, length: 0.08, height: 0.04, sweep: 0.3 }], mouth: { size: 0.05, tilt: 0.4 } },
    pattern: { back: '#2a4a6a', belly: '#e8eef0', fin: '#a0b0b8', countershade: 0.9, shadeLine: 0.25, iridescence: 0.8, metalness: 0.45, roughness: 0.25, eye: '#d0d8e0' },
    swim: { amplitude: 0.1, wavelength: 1, beat: 1.4, flutter: 0.3 },
    habitat: { water: 'sea', temperature: [-1, 16], depth: [3, 200], weight: 1.4 },
    school: { size: [40, 110], spacing: 1, speed: 1.4, roam: 30 },
  }),
  mackerel: species({
    name: 'Mackerel', length: 0.35,
    shape: { depth: 0.19, width: 0.12, depthAt: 0.42, nose: 0.95, back: 0.5, peduncle: 0.16, tail: { shape: 'forked', height: 0.3, fork: 0.75, asymmetry: 0 }, dorsal: [{ start: 0.3, length: 0.12, height: 0.07, sweep: 0.4 }, { start: 0.56, length: 0.08, height: 0.05, sweep: 0.3 }], anal: [{ start: 0.58, length: 0.07, height: 0.04, sweep: 0.3 }] },
    pattern: {
      back: '#1a6a6a', belly: '#f0f0f0', fin: '#5a7a80', countershade: 0.95, shadeLine: 0,
      stripes: { count: 14, width: 0.32, color: '#0a1a2a', direction: 0, wobble: 0.12, region: [0.1, 1], edge: 0 },
      iridescence: 0.7, metalness: 0.4, roughness: 0.25,
    },
    swim: { amplitude: 0.09, wavelength: 1, beat: 1.5, flutter: 0.2 },
    habitat: { water: 'sea', temperature: [4, 20], depth: [3, 150], weight: 1 },
    school: { size: [25, 70], spacing: 1, speed: 1.8, roam: 30 },
  }),
  tuna: species({
    name: 'Tuna', length: 1.8, lengthVariation: 0.2,
    shape: { depth: 0.26, width: 0.2, depthAt: 0.4, bodyLength: 0.8, nose: 0.75, back: 0.5, peduncle: 0.1, tail: { shape: 'lunate', height: 0.38, fork: 0.7, asymmetry: 0 }, dorsal: [{ start: 0.3, length: 0.12, height: 0.07, sweep: 0.5 }, { start: 0.5, length: 0.07, height: 0.11, sweep: 0.6 }], anal: [{ start: 0.55, length: 0.06, height: 0.1, sweep: 0.6 }], pectoral: { position: 0.28, height: 0, size: 0.18, angle: 0.3 } },
    pattern: { back: '#101a40', belly: '#d8dce4', fin: '#c0a030', countershade: 0.95, shadeLine: 0.1, iridescence: 0.5, metalness: 0.5, roughness: 0.25 },
    swim: { amplitude: 0.06, wavelength: 1.2, beat: 1.2, flutter: 0 },
    habitat: { water: 'sea', temperature: [10, 30], depth: [12, 500], weight: 0.6 },
    school: { size: [6, 20], spacing: 1.2, speed: 1.5, roam: 50 },
  }),
  shark: species({
    name: 'Shark', length: 2.6, lengthVariation: 0.3, hueVariation: 0.04,
    shape: { depth: 0.18, width: 0.15, depthAt: 0.38, bodyLength: 0.78, nose: 0.9, back: 0.55, peduncle: 0.2, squareness: 2.2, tail: { shape: 'forked', height: 0.34, fork: 0.55, asymmetry: 0.45 }, dorsal: [{ start: 0.32, length: 0.12, height: 0.13, sweep: 0.7 }, { start: 0.68, length: 0.04, height: 0.04, sweep: 0.4 }], anal: [{ start: 0.68, length: 0.04, height: 0.03, sweep: 0.4 }], pectoral: { position: 0.3, height: -0.6, size: 0.2, angle: 0.4 }, pelvic: { position: 0.55, height: -0.85, size: 0.05, angle: 0.8 }, mouth: { size: 0.08, tilt: -1 }, eye: { size: 0.012, position: 0.1, height: 0.25 } },
    pattern: { back: '#5a6670', belly: '#eef0f0', fin: '#5a6670', countershade: 1, shadeLine: -0.2, iridescence: 0, metalness: 0, roughness: 0.55, eye: '#101010' },
    swim: { amplitude: 0.08, wavelength: 1.1, beat: 0.6, flutter: 0 },
    habitat: { water: 'sea', temperature: [12, 32], depth: [10, 500], weight: 0.25 },
    school: { size: [1, 1], spacing: 4, speed: 0.6, roam: 60 },
  }),
}

/** Smooth 0…1 window: 1 inside [lo, hi], fading to 0 over `soft` outside. */
export function window01(x: number, lo: number, hi: number, soft: number): number {
  const a = soft > 0 ? Math.min(1, Math.max(0, (x - lo) / soft + 1)) : x >= lo ? 1 : 0
  const b = soft > 0 ? Math.min(1, Math.max(0, (hi - x) / soft + 1)) : x <= hi ? 1 : 0
  return a * b
}

/** Water at a world sample: whether there is any, how deep, and whether it is fresh. */
export interface WaterInfo {
  /** Water depth (surface − bed), metres; 0 where dry. */
  depth: number
  /** Water surface height (local y); NaN where dry. */
  surface: number
  /** Bed height (local y). */
  floor: number
  /** True for rivers and inland water; false for the sea. */
  fresh: boolean
  /** Water temperature, °C. */
  temperature: number
}

/** Rules for telling river water from sea water. */
export interface WaterRules {
  /** River strength (the world's `river`, 0…1) above which water counts as a river. */
  riverStrength: number
  /** Continentalness above which water counts as inland (fresh). */
  inland: number
}

/** Default {@link WaterRules}. */
export const DEFAULT_WATER_RULES: WaterRules = { riverStrength: 0.25, inland: 0.12 }

/** Reads water from a world sample (the world's `waterLevel` is the sea or river surface, NaN where dry). */
export function waterInfo(sample: WorldSample, rules: WaterRules = DEFAULT_WATER_RULES, out: WaterInfo = { depth: 0, surface: NaN, floor: 0, fresh: false, temperature: 0 }): WaterInfo {
  const surface = sample.waterLevel
  out.surface = surface
  out.floor = sample.elevation
  out.depth = surface === surface ? Math.max(0, surface - sample.elevation) : 0
  out.fresh = sample.river > rules.riverStrength || sample.continentalness > rules.inland
  out.temperature = sample.temperature
  return out
}

/** How well a species fits some water: 0 = can't live here, otherwise its weighted suitability. */
export function fishSuitability(species: FishSpecies, water: WaterInfo): number {
  const h = species.habitat
  if (water.depth <= 0 || h.weight <= 0) return 0
  if (h.water === 'fresh' && !water.fresh) return 0
  if (h.water === 'sea' && water.fresh) return 0
  const t = window01(water.temperature, h.temperature[0], h.temperature[1], 2)
  const d = water.depth >= h.depth[0] ? window01(water.depth, h.depth[0], h.depth[1], h.depth[1] * 0.2) : 0
  return h.weight * t * d
}

/** Steepest pitch (radians) a swimming fish takes; used for its vertical clearance. */
export const MAX_FISH_PITCH = 0.35

/**
 * Vertical room (metres) a fish needs from the bed and from the surface: `margin` plus half its
 * largest body/tail height and what pitching adds, for the largest fish of the species. Keeping
 * fish centres this far inside the water keeps every fin under the surface.
 */
export function fishClearance(species: FishSpecies, margin: number): number {
  const L = species.length * (1 + species.lengthVariation)
  return margin + L * (Math.max(species.shape.depth, species.shape.tail.height) * 0.5 * 1.1 + 0.5 * Math.sin(MAX_FISH_PITCH))
}

/** Fish placement rules: water of the right kind, temperature and depth; the band is bed … surface. */
export function fishHabitat(rules: WaterRules, margin: number): Habitat<FishSpecies> {
  const w: WaterInfo = { depth: 0, surface: NaN, floor: 0, fresh: false, temperature: 0 }
  return {
    suitability: (sp, sample) => fishSuitability(sp, waterInfo(sample, rules, w)),
    band(sp: FishSpecies, sample: WorldSample, out: Band) {
      waterInfo(sample, rules, w)
      if (w.depth <= 0) return false
      if ((sp.habitat.water === 'fresh' && !w.fresh) || (sp.habitat.water === 'sea' && w.fresh)) return false
      out.floor = w.floor
      out.top = w.surface
      return true
    },
    minThickness: (sp) => 2 * fishClearance(sp, margin) + 0.05,
    groupSize: (sp) => sp.school.size,
    roam: (sp) => sp.school.roam,
  }
}
