/**
 * Bird species: plain JSON for a low-poly body with flapping wings, colours, flight style, the biomes
 * each lives over and how it flocks. Same placement and boids as fish, with an air band above the
 * ground instead of a water band.
 */
import type { WorldSample } from 'threejs-biomes'
import type { Band } from './boids.ts'
import { loftBody, MeshBuilder, PART, type MeshData } from './fish-geometry.ts'
import type { Habitat } from './placement.ts'

/** Bird body shape; lengths are fractions of the body length (beak to tail tip = 1). */
export interface BirdShape {
  /** Wingspan. */
  span: number
  /** Wing chord at the root. */
  chord: number
  /** Tip chord as a fraction of the root chord. */
  taper: number
  /** How far back the wing tips sit. */
  sweep: number
  /** Where the wing root's leading edge is, from the beak. */
  wingAt: number
  /** Body depth. */
  depth: number
  /** Body width. */
  width: number
  /** Tail length. */
  tail: number
  /** Tail spread (width at the tip). */
  tailWidth: number
}

/** A bird species. All plain JSON. */
export interface BirdSpecies {
  /** Display name. */
  name: string
  /** Body length (beak to tail tip), metres. */
  length: number
  /** ± fraction of length varied per bird. */
  lengthVariation: number
  /** Shape. */
  shape: BirdShape
  /** Colours (`#rrggbb`). */
  colors: {
    /** Back and upper wing. */
    back: string
    /** Belly and under wing. */
    belly: string
    /** Wing tips. */
    tip: string
    /** Share of the span (from the tip) coloured `tip`. */
    tipLength: number
  }
  /** Flight style. */
  flight: {
    /** Cruising speed, m/s. */
    speed: number
    /** Wing beats per second. */
    flapRate: number
    /** Wing beat amplitude, radians. */
    flapAmplitude: number
    /** 0…1 share of time spent gliding. */
    glide: number
    /** Height band above the ground (or water), metres. */
    altitude: [number, number]
    /** Whether it flies over water. */
    overWater: boolean
  }
  /** Biome ids it lives over, with weights (e.g. `{ coast: 1, deepOcean: 0.3 }`). */
  biomes: Record<string, number>
  /** Flocking. */
  flock: {
    /** Birds per flock, [min, max]. */
    size: [number, number]
    /** Distance kept between neighbours, metres. */
    spacing: number
    /** How far (metres) a flock roams from home. */
    roam: number
  }
}

/** Built-in birds: gulls over coasts, crows over forests and fields, swallows over meadows and wetlands, vultures soaring over savanna and desert. */
export const BIRD_SPECIES: Readonly<Record<string, BirdSpecies>> = {
  gull: {
    name: 'Gull', length: 0.6, lengthVariation: 0.12,
    shape: { span: 2.3, chord: 0.3, taper: 0.45, sweep: 0.18, wingAt: 0.28, depth: 0.16, width: 0.15, tail: 0.25, tailWidth: 0.2 },
    colors: { back: '#9aa4ae', belly: '#f4f4f2', tip: '#1a1a1a', tipLength: 0.18 },
    flight: { speed: 9, flapRate: 2.6, flapAmplitude: 0.55, glide: 0.5, altitude: [6, 35], overWater: true },
    biomes: { coast: 1, deepOcean: 0.35, wetland: 0.4, mangrove: 0.3 },
    flock: { size: [3, 10], spacing: 4, roam: 120 },
  },
  crow: {
    name: 'Crow', length: 0.45, lengthVariation: 0.1,
    shape: { span: 2.1, chord: 0.34, taper: 0.7, sweep: 0.06, wingAt: 0.28, depth: 0.18, width: 0.16, tail: 0.3, tailWidth: 0.22 },
    colors: { back: '#16161c', belly: '#22222a', tip: '#101014', tipLength: 0.1 },
    flight: { speed: 11, flapRate: 3.5, flapAmplitude: 0.6, glide: 0.15, altitude: [8, 40], overWater: false },
    biomes: { deciduousForest: 0.8, grassland: 0.7, taiga: 0.5, temperateRainforest: 0.4, steppe: 0.3, mediterranean: 0.3 },
    flock: { size: [4, 12], spacing: 3, roam: 120 },
  },
  swallow: {
    name: 'Swallow', length: 0.18, lengthVariation: 0.1,
    shape: { span: 1.9, chord: 0.22, taper: 0.3, sweep: 0.3, wingAt: 0.3, depth: 0.14, width: 0.14, tail: 0.35, tailWidth: 0.3 },
    colors: { back: '#1a2a5a', belly: '#e8d8c8', tip: '#101830', tipLength: 0.15 },
    flight: { speed: 12, flapRate: 7, flapAmplitude: 0.7, glide: 0.35, altitude: [2, 20], overWater: true },
    biomes: { grassland: 1, wetland: 1, savanna: 0.4, mediterranean: 0.5, alpineMeadow: 0.4, dryForest: 0.3 },
    flock: { size: [8, 24], spacing: 1.5, roam: 80 },
  },
  vulture: {
    name: 'Vulture', length: 0.95, lengthVariation: 0.1,
    shape: { span: 2.6, chord: 0.5, taper: 0.8, sweep: 0.02, wingAt: 0.25, depth: 0.2, width: 0.2, tail: 0.22, tailWidth: 0.25 },
    colors: { back: '#4a3a2a', belly: '#6a5a40', tip: '#1a1410', tipLength: 0.2 },
    flight: { speed: 10, flapRate: 1.4, flapAmplitude: 0.35, glide: 0.9, altitude: [40, 120], overWater: false },
    biomes: { savanna: 1, badlands: 0.6, desert: 0.35, mediterranean: 0.3, dryForest: 0.3 },
    flock: { size: [2, 6], spacing: 10, roam: 200 },
  },
}

/** Builds a bird mesh (beak at z = 0.5, tail tip at z = −0.5, wings along x). */
export function buildBirdMesh(shape: BirdShape, rings = 10, sides = 8): MeshData {
  const b = new MeshBuilder()
  const bodyLen = Math.max(0.3, 1 - shape.tail)
  const bodyIndexCount = loftBody(b, (u) => {
    const e = Math.pow(Math.sin(Math.PI * Math.min(1, u * 0.85 + 0.03)), 0.7) * (u < 0.15 ? 0.6 + (0.4 * u) / 0.15 : 1)
    return { z: 0.5 - u * bodyLen, y: 0, top: shape.depth * 0.5 * e, bottom: shape.depth * 0.5 * e, halfWidth: shape.width * 0.5 * e, s: u * bodyLen }
  }, rings, sides, 2)

  const half = shape.span / 2
  const rootX = shape.width * 0.3
  const z0 = 0.5 - shape.wingAt
  for (const side of [1, -1]) {
    b.sheet(5, 3, (r, c) => {
      const t = r / 4
      const chord = shape.chord * (1 - (1 - shape.taper) * t)
      const lead = z0 - shape.sweep * Math.pow(t, 1.5)
      return [side * (rootX + t * (half - rootX)), 0.02 * t, lead - (chord * c) / 2]
    }, [0, 1, 0], PART.wing, shape.depth)
  }
  const zt = 0.5 - bodyLen + 0.02
  b.sheet(2, 3, (r, c) => {
    const v = c - 1
    const w = r === 0 ? shape.width * 0.25 : shape.tailWidth * 0.5
    return [v * w, 0, r === 0 ? zt : -0.5 + Math.abs(v) * 0.03]
  }, [0, 1, 0], PART.birdTail, shape.depth)
  return b.build(bodyIndexCount)
}

/**
 * Bird placement rules: biome weights from the world's biome mix (pass `world.options.biomes` ids),
 * and an air band between the species' altitudes above the ground (or water, if it flies over water).
 */
export function birdHabitat(biomeIds: readonly string[]): Habitat<BirdSpecies> {
  return {
    suitability(sp, sample: WorldSample) {
      if (sample.waterLevel === sample.waterLevel && !sp.flight.overWater) return 0
      let w = 0
      for (let i = 0; i < sample.count; i++) w += sample.weights[i] * (sp.biomes[biomeIds[sample.biomes[i]]] ?? 0)
      return w
    },
    band(sp, sample: WorldSample, out: Band) {
      const wet = sample.waterLevel === sample.waterLevel
      if (wet && !sp.flight.overWater) return false
      const ground = wet ? Math.max(sample.elevation, sample.waterLevel) : sample.elevation
      out.floor = ground + sp.flight.altitude[0]
      out.top = ground + sp.flight.altitude[1]
      return true
    },
    minThickness: (sp) => Math.min(4, (sp.flight.altitude[1] - sp.flight.altitude[0]) * 0.5),
    groupSize: (sp) => sp.flock.size,
    roam: (sp) => sp.flock.roam,
  }
}
