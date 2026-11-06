import type { DirectionalLight, Object3D } from 'three/webgpu'
import { neutralGrassMap, type GrassUniforms } from './material.ts'
import { presets, type GrassStyle, type PresetName } from './presets.ts'
import type { GrassMap } from './grass-map.ts'

/**
 * One of the four levels of detail. Density is interpolated linearly between consecutive LODs, so
 * blades thin out smoothly with distance instead of popping at tile borders.
 */
export interface GrassLOD {
  /** Distance from the camera (metres, XZ) at which this LOD is fully reached. */
  distance: number
  /** Fraction (0..1) of the full blade density kept at this distance. */
  density: number
  /** Vertical segments per blade (or billboard). More = smoother bending, more vertices. */
  segments: number
}

/** Procedural wind. Gusts are scrolling noise along `direction` plus a travelling ripple. */
export interface WindOptions {
  /** World-space XZ direction the wind blows towards. Normalised internally. */
  direction: [x: number, z: number]
  /** How far blades bend. 0 = still, ~0.35 = breeze, 1+ = storm. */
  strength: number
  /** Noise frequency in 1/metres. Smaller = broader gusts. */
  scale: number
  /** How fast gusts travel across the field. */
  speed: number
}

/** An object, or a React-style ref to one (`current` is `null` until mounted). */
export type ObjectRef<T extends Object3D = Object3D> = T | { current: T | null }

/** Something that pushes grass aside: characters, vehicles, balls… */
export interface Interactor {
  /** The object (or a React ref to it). Its world position is read every frame. */
  object: ObjectRef
  /** Influence radius in metres. Blades inside are bent away from the object. */
  radius: number
}

/** Every setting of a {@link Grass} field. All are optional on input; see {@link GrassInput}. */
export interface GrassSettings extends GrassStyle {
  /** Starting look; any {@link GrassStyle} field you pass overrides the preset's value. */
  preset: PresetName
  /** Detailed geometric blades, or lightweight view-facing billboard tufts. */
  type: 'blades' | 'billboards'
  /** Edge length of a streaming tile in metres. Tiles are re-centred around the camera. */
  tileSize: number
  /** Radius (metres) around the camera that has grass. Blades fade out over the last 15%. */
  maxDistance: number
  /** Exactly four levels of detail, ordered near → far. */
  lods: GrassLOD[]
  /** Procedural wind; see {@link WindOptions}. */
  wind: WindOptions
  /** Steepest terrain gradient (rise / run) that still grows grass. `Infinity` disables the check. */
  maxSlope: number
  /** Coverage/height control texture; see {@link GrassMap}. `null` = grass everywhere. */
  grassMap: GrassMap | null
  /** Up to 16 objects that push grass aside. */
  interactors: Interactor[]
  /** Global multiplier on how strongly interactors bend grass. */
  interactionStrength: number
  /** Whether grass within `shadowDistance` casts shadows (needs a shadow-casting light). */
  castShadow: boolean
  /** Radius (metres) around the camera in which grass casts shadows. Shadows are costly: keep it small. */
  shadowDistance: number
  /** Whether grass receives shadows. */
  receiveShadow: boolean
  /** Light used for back-lit translucency. `null` = first DirectionalLight found in the scene. */
  sun: DirectionalLight | null
  /** Tints grass by LOD (red, yellow, green, blue) to help tune `lods`. */
  debugLods: boolean
  /** Milliseconds per frame spent (re)building tiles, nearest first. Spreads work to avoid frame spikes. */
  buildBudget: number
}

/** Partial settings accepted by {@link Grass.create}, {@link Grass.set} and the `<Grass>` component. */
export type GrassInput = Partial<Omit<GrassSettings, 'wind'>> & {
  /** Wind settings to change; unspecified fields keep their current value. */
  wind?: Partial<WindOptions>
}

const DEFAULTS: Omit<GrassSettings, keyof GrassStyle | 'wind'> = {
  preset: 'kentuckyBluegrass',
  type: 'blades',
  tileSize: 25,
  maxDistance: 200,
  lods: [
    { distance: 8, density: 1, segments: 5 },
    { distance: 25, density: 0.25, segments: 3 },
    { distance: 60, density: 0.06, segments: 2 },
    { distance: 120, density: 0.03, segments: 1 },
  ],
  maxSlope: 1.2,
  grassMap: null,
  interactors: [],
  interactionStrength: 1,
  castShadow: true,
  shadowDistance: 20,
  receiveShadow: true,
  sun: null,
  debugLods: false,
  buildBudget: 3,
}
const DEFAULT_WIND: WindOptions = { direction: [1, 0.35], strength: 0.45, scale: 0.045, speed: 0.8 }

/** Billboard clumps hold ~9 strands, so they need far fewer instances for the same look. */
export const BILLBOARD_DENSITY_RATIO = 1 / 5

/** Merges defaults ← preset ← input into complete settings and validates them. */
export function resolveSettings(input: GrassInput): GrassSettings {
  const preset = presets[input.preset ?? DEFAULTS.preset]
  const s: GrassSettings = { ...DEFAULTS, ...preset, ...input, wind: { ...DEFAULT_WIND, ...input.wind } }
  if (s.lods.length !== 4) throw new Error('Grass: `lods` must contain exactly 4 levels.')
  return s
}

/** Pushes every uniform-backed (visual) setting to the shader. */
export function writeSettings(u: GrassUniforms, s: GrassSettings): void {
  u.baseColor.value.set(s.baseColor)
  u.tipColor.value.set(s.tipColor)
  u.colorVariation.value = s.colorVariation
  u.bladeHeight.value = s.bladeHeight
  u.bladeWidth.value = s.bladeWidth
  u.curvature.value = s.curvature
  u.stiffness.value = Math.max(0.05, s.stiffness)
  u.windDirection.value.set(...s.wind.direction).normalize()
  u.windStrength.value = s.wind.strength
  u.windScale.value = s.wind.scale
  u.windSpeed.value = s.wind.speed
  u.lodDistances.value.set(...(s.lods.map((l) => l.distance) as [number, number, number, number]))
  u.lodDensities.value.set(...(s.lods.map((l) => l.density) as [number, number, number, number]))
  u.maxDistance.value = s.maxDistance
  u.interactionStrength.value = s.interactionStrength
  u.patchiness.value = s.patchiness
  u.translucency.value = s.translucency
  u.debugLods.value = s.debugLods ? 1 : 0
  if (s.grassMap) {
    u.map.value = s.grassMap.texture
    u.mapBounds.value.set(s.grassMap.minX, s.grassMap.minZ, s.grassMap.size, s.grassMap.size)
  } else {
    u.map.value = neutralGrassMap // drop the previous map's texture, not just its bounds
    u.mapBounds.value.set(-1e6, -1e6, 2e6, 2e6)
  }
}

/** Settings that change tile contents and therefore require a rebuild. */
export function layoutKey(s: GrassSettings): string {
  return JSON.stringify([s.type, s.tileSize, s.density, s.heightVariation, s.widthVariation, s.clumping, s.clumpSize, s.maxSlope, s.lods])
}

/** Settings that require a new material instance. Only the draw type is baked into the material;
 *  everything else is uniform-driven. */
export function materialKey(s: GrassSettings): string {
  return s.type
}
