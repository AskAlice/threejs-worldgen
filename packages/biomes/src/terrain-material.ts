import { Color, MeshStandardNodeMaterial, Vector3, type Node } from 'three/webgpu'
import {
  Fn, If, attribute, cameraPosition, clamp, dFdx, dFdy, distance, float, mix, mx_noise_float, normalView, positionLocal,
  positionView, positionWorld, smoothstep, uniform, vec2, vec3, vec4,
} from 'three/tsl'

/** How the terrain is coloured. */
export type TerrainDebug = 'none' | 'biomes' | 'lod' | 'splat'

/** Look of the terrain surface. All values are live through the returned uniforms. */
export interface TerrainMaterialOptions {
  /** Debug view: `biomes` (biome map colours), `lod` (tint by quadtree level), `splat` (rock/snow/sand/wet). */
  debug: TerrainDebug
  /** Strength of the procedural colour variation and micro bumps (0 = flat vertex colours). */
  detail: number
  /** Scale multiplier of the detail noise (higher = finer). */
  detailScale: number
  /** Distance over which detail fades out, metres. */
  detailDistance: number
  /** Bump strength of the micro relief. */
  bump: number
  /** Overall brightness multiplier of the ground colour. */
  brightness: number
  /** Saturation multiplier of the ground colour (1 = as generated). */
  saturation: number
  /** Draw as wireframe. */
  wireframe: boolean
}

/** Default terrain look. */
export const DEFAULT_TERRAIN_MATERIAL: TerrainMaterialOptions = {
  debug: 'none', detail: 1, detailScale: 1, detailDistance: 220, bump: 1, brightness: 1, saturation: 1, wireframe: false,
}

/**
 * Creates the uniforms behind a terrain material. Exported so the {@link TerrainUniforms} type is
 * documented in full; `WorldTerrain` creates and updates them for you.
 */
export function createTerrainUniforms(o: TerrainMaterialOptions = DEFAULT_TERRAIN_MATERIAL) {
  return {
    /** Detail strength. */
    detail: uniform(o.detail),
    /** Detail noise scale. */
    detailScale: uniform(o.detailScale),
    /** Detail fade distance, metres. */
    detailDistance: uniform(o.detailDistance),
    /** Bump strength. */
    bump: uniform(o.bump),
    /** Brightness multiplier. */
    brightness: uniform(o.brightness),
    /** Saturation multiplier. */
    saturation: uniform(o.saturation),
    /** Slope (rise/run) where bare rock takes over (synced from the world's `ground.rockSlope`). */
    rockSlope: uniform(0.85),
    /** Temperature (°C) below which snow settles (synced from `ground.snowTemperature`). */
    snowTemperature: uniform(-3),
    /** Height band around sea level that is sand, metres (synced from `ground.sandBand`). */
    sandBand: uniform(1.2),
    /** Rock colour (linear). */
    rockColor: uniform(new Color('#7a756e')),
    /** Snow colour (linear). */
    snowColor: uniform(new Color('#f2f5f8')),
    /** Sand colour (linear). */
    sandColor: uniform(new Color('#d8c393')),
    /** Mud colour (linear). */
    mudColor: uniform(new Color('#3f3a2c')),
  }
}

/** Uniforms behind a terrain material, for live tweaks. */
export type TerrainUniforms = ReturnType<typeof createTerrainUniforms>

// Screen-space bump from a procedural height (Mikkelsen, "Bump Mapping Unparametrized Surfaces on the GPU").
function perturbNormal(height: Node<'float'>, scale: Node<'float'>) {
  const sx = dFdx(positionView)
  const sy = dFdy(positionView)
  const n = normalView
  const r1 = sy.cross(n)
  const r2 = n.cross(sx)
  const det = sx.dot(r1)
  const dh = vec2(dFdx(height), dFdy(height)).mul(scale)
  const grad = det.sign().mul(dh.x.mul(r1).add(dh.y.mul(r2)))
  return det.abs().mul(n).sub(grad).normalize()
}

/**
 * The terrain's node material: per-vertex biome soil colours, per-pixel rock / snow / sand / mud from
 * slope, temperature, height and rivers, then procedural detail that depends on the ground (rock
 * grain, snow sparkle, sand ripples, wet darkening) and micro bumps, all
 * fading out with distance so far LODs don't shimmer. Each chunk mesh must set
 * `userData.detailOffset` (its centre modulo the detail period, a `Vector3`) and `userData.level`.
 */
export function createTerrainMaterial(input: Partial<TerrainMaterialOptions> = {}): { material: MeshStandardNodeMaterial; uniforms: TerrainUniforms; setDebug: (debug: TerrainDebug) => void } {
  const o = { ...DEFAULT_TERRAIN_MATERIAL, ...input }
  const u = createTerrainUniforms(o)
  const material = new MeshStandardNodeMaterial({ wireframe: o.wireframe })
  material.name = 'WorldTerrain'

  // Continuous detail coordinates: chunk-local position + the chunk's centre modulo a period (float32-safe at planet scale).
  const offset = uniform(new Vector3()).onObjectUpdate(({ object }) => object?.userData.detailOffset)
  const level = uniform(0).onObjectUpdate(({ object }) => object?.userData.level ?? 0)
  const p = positionLocal.add(offset).mul(u.detailScale)

  const base = attribute<'vec3'>('color', 'vec3')
  const climate = attribute<'vec4'>('climate', 'vec4')
  const biome = attribute<'vec3'>('biomeColor', 'vec3')

  const fade = smoothstep(u.detailDistance, u.detailDistance.mul(0.25), distance(positionWorld, cameraPosition)).mul(u.detail)

  // Five noise lookups, only for fragments close enough to show them: broad patches, rock grain, sand
  // ripples (warped by the patches) and snow sparkle. Far fragments skip all of it.
  const noise = Fn(() => {
    const n = vec4(0).toVar()
    If(fade.greaterThan(0.002), () => {
      const patches = mx_noise_float(p.mul(0.08)).mul(0.5).add(mx_noise_float(p.mul(0.6)).mul(0.25))
      const grain = mx_noise_float(p.mul(3.1))
      const ripple = mx_noise_float(vec3(p.x.mul(0.9), patches.mul(3), p.z.mul(4.5)))
      const sparkle = smoothstep(0.82, 0.95, mx_noise_float(p.mul(37)))
      n.assign(vec4(patches, grain, ripple, sparkle))
    })
    return n
  })()
  const patches = noise.x, grain = noise.y, ripple = noise.z, sparkle = noise.w

  // Ground overrides per pixel (smooth, noise-broken edges at any LOD): steep → rock, cold → snow,
  // near the waterline → sand, along rivers → mud.
  const aboveSea = climate.x, temperature = climate.y, river = climate.z, slope = climate.w
  const rock = smoothstep(u.rockSlope.mul(0.7), u.rockSlope, slope.add(patches.mul(0.25)))
  const snow = smoothstep(u.snowTemperature.add(1.5), u.snowTemperature.sub(1.5), temperature.add(patches.mul(3))).mul(smoothstep(1.8, 1.2, slope))
  const sand = smoothstep(u.sandBand, u.sandBand.mul(0.3), aboveSea.abs().add(patches.mul(u.sandBand).mul(0.6))).mul(rock.oneMinus())
  const wet = river.mul(0.85)

  let ground = mix(base, u.mudColor, wet)
  ground = mix(ground, u.sandColor, sand)
  ground = mix(ground, u.rockColor, rock)
  ground = mix(ground, u.snowColor, snow)
  const variation = float(1).add(patches.mul(0.22)).add(grain.mul(rock).mul(0.18)).add(ripple.mul(sand).mul(0.08))
  let color = ground.mul(mix(float(1), variation, fade))
  color = color.mul(mix(float(1), float(0.6), wet.mul(0.6)))
  color = color.add(vec3(sparkle.mul(snow).mul(fade).mul(0.6)))
  const lum = color.dot(vec3(0.2126, 0.7152, 0.0722))
  color = mix(vec3(lum), color, u.saturation).mul(u.brightness)

  const lodTint = vec3(level.mul(12.9898), level.mul(78.233), level.mul(37.719)).sin().mul(43758.5453).fract().mul(0.7).add(0.3)
  const views: Record<TerrainDebug, Node<'vec3'>> = {
    none: color,
    biomes: biome,
    lod: lodTint.mul(ground.add(0.25)),
    splat: vec3(rock.add(snow), snow.add(sand), snow.add(wet)),
  }
  // Debug views swap the colour node (one recompile) instead of branching per fragment.
  const setDebug = (debug: TerrainDebug) => {
    material.colorNode = views[debug] ?? views.none
    material.needsUpdate = true
  }
  setDebug(o.debug)

  material.roughnessNode = clamp(float(0.95).sub(wet.mul(0.45)).sub(snow.mul(0.2)).sub(sparkle.mul(snow).mul(0.4)), 0.15, 1)
  material.metalnessNode = float(0)

  // Micro relief bump from the same noise, stronger on rock and sand.
  const height = patches.mul(0.6).add(grain.mul(rock.mul(0.5).add(0.15))).add(ripple.mul(sand).mul(0.4))
  material.normalNode = perturbNormal(height.mul(fade), u.bump.mul(0.05))

  return { material, uniforms: u, setDebug }
}

/** Sets an sRGB `#rrggbb` colour on a three `Color` (helper for GUIs). */
export function setColor(target: Color, hex: string): Color {
  return target.set(hex)
}
