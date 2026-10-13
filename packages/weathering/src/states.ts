import { Color, type MeshStandardNodeMaterial, type Node, type UniformNode } from 'three/webgpu'
import {
  cameraPosition, clamp, dFdx, dFdy, dot, float, fwidth, length, materialColor, max, materialEmissive, materialMetalness, materialNormal, materialOpacity,
  materialRoughness, mix, mx_noise_float, mx_worley_noise_vec2, normalView, normalWorld, positionView, positionWorld, smoothstep,
  step, time, uniform, vec2, vec3, vertexColor,
} from 'three/tsl'
import { merge, resolve } from './util.ts'

/**
 * The four material states every weathered asset understands, each 0…1:
 * - `wetness`: darker, more saturated albedo, glossy surface, drip streaks on walls, puddles on flat ground
 * - `snow`: snow settling on upward-facing surfaces, with noise-broken edges and sparkle
 * - `burn`: scorch → char → ash; foliage loses leaves (with `heat`, glowing ember cracks)
 * - `damage`: cracks, dents, darkening; missing pieces where cut-outs are allowed
 */
export type StateChannel = 'wetness' | 'snow' | 'burn' | 'damage'

/** The four channels in storage order (RGBA of a {@link StateField}, xyzw of {@link InstanceStates}). */
export const STATE_CHANNELS: readonly StateChannel[] = ['wetness', 'snow', 'burn', 'damage']

/** Plain-number material states, each 0…1. */
export type MaterialStates = Record<StateChannel, number>

/**
 * The material-state contract as TSL nodes: the four float states, plus optional `heat` (0…1, "on fire
 * right now"), which drives the ember glow, and `ash` (0…1, white ash vs black char where burnt). Any field may be left out: missing states cost nothing (no
 * shader code is generated for them). Numbers are accepted as constants.
 */
export type MaterialStateNodes = Partial<Record<StateChannel | 'heat' | 'ash', Node<'float'> | number>>

/** Look of the four states. Plain JSON; every value is live through {@link StateLook.uniforms}. */
export interface StateLookOptions {
  /** Multiplier on every pattern frequency (raise for small props, lower for huge cliffs). */
  noiseScale: number
  /** How much albedo darkens when soaked (0…1). */
  wetDarkening: number
  /** Saturation of soaked albedo (1 = unchanged). */
  wetSaturation: number
  /** Roughness of a soaked surface. */
  wetRoughness: number
  /** Puddle coverage on flat ground at full wetness (0 = none). */
  puddles: number
  /** Puddle pattern frequency, 1/m. */
  puddleScale: number
  /** Strength of drip streaks on vertical faces (0 = none). */
  streaks: number
  /** Streak frequency, 1/m. */
  streakScale: number
  /** Snow colour (`#rrggbb`). */
  snowColor: string
  /** Snow roughness. */
  snowRoughness: number
  /** How far down the sides snow reaches at full snow (0 = only flat tops, 1 = down to vertical). */
  snowReach: number
  /** Noise amplitude breaking up the snow edge. */
  snowBreakup: number
  /** Snow edge noise frequency, 1/m. */
  snowScale: number
  /** Snow sparkle strength. */
  sparkle: number
  /** Sparkle frequency, 1/m. */
  sparkleScale: number
  /** Light scorch tint at low burn (`#rrggbb`, multiplied in). */
  scorchColor: string
  /** Char colour (`#rrggbb`). */
  charColor: string
  /** Ash colour on fully burnt surfaces (`#rrggbb`). */
  ashColor: string
  /** Ember glow colour (`#rrggbb`). */
  emberColor: string
  /** Ember glow intensity (emissive multiplier). */
  emberIntensity: number
  /** Ember crack frequency, 1/m. */
  emberScale: number
  /** Share of foliage lost at full burn (needs `foliage`). */
  leafLoss: number
  /** Leaf-loss pattern frequency, 1/m. */
  leafScale: number
  /** Crack colour (`#rrggbb`). */
  crackColor: string
  /** Crack cell frequency, 1/m. */
  crackScale: number
  /** Crack line width (in cell units, ~0.02…0.2). */
  crackWidth: number
  /** Dent bump strength. */
  dentStrength: number
  /** Damage above which pieces go missing (needs `cutout`). */
  holeThreshold: number
}

/** Default state look. */
export const DEFAULT_STATE_LOOK: StateLookOptions = {
  noiseScale: 1,
  wetDarkening: 0.45, wetSaturation: 1.25, wetRoughness: 0.12, puddles: 0.6, puddleScale: 0.35, streaks: 0.6, streakScale: 2.5,
  snowColor: '#f4f7fb', snowRoughness: 0.7, snowReach: 0.55, snowBreakup: 0.3, snowScale: 1.3, sparkle: 0.6, sparkleScale: 40,
  scorchColor: '#7a5a40', charColor: '#0d0b09', ashColor: '#8d8882', emberColor: '#ff5a14', emberIntensity: 6, emberScale: 2.2,
  leafLoss: 0.95, leafScale: 3,
  crackColor: '#1c1814', crackScale: 2.5, crackWidth: 0.07, dentStrength: 0.6, holeThreshold: 0.7,
}

/** Creates the uniforms behind a {@link StateLook} (exported so {@link StateLookUniforms} is documented in full). */
export function createStateLookUniforms(o: StateLookOptions = DEFAULT_STATE_LOOK) {
  return {
    /** {@link StateLookOptions.noiseScale}. */ noiseScale: uniform(o.noiseScale),
    /** {@link StateLookOptions.wetDarkening}. */ wetDarkening: uniform(o.wetDarkening),
    /** {@link StateLookOptions.wetSaturation}. */ wetSaturation: uniform(o.wetSaturation),
    /** {@link StateLookOptions.wetRoughness}. */ wetRoughness: uniform(o.wetRoughness),
    /** {@link StateLookOptions.puddles}. */ puddles: uniform(o.puddles),
    /** {@link StateLookOptions.puddleScale}. */ puddleScale: uniform(o.puddleScale),
    /** {@link StateLookOptions.streaks}. */ streaks: uniform(o.streaks),
    /** {@link StateLookOptions.streakScale}. */ streakScale: uniform(o.streakScale),
    /** {@link StateLookOptions.snowColor} (linear). */ snowColor: uniform(new Color(o.snowColor)),
    /** {@link StateLookOptions.snowRoughness}. */ snowRoughness: uniform(o.snowRoughness),
    /** {@link StateLookOptions.snowReach}. */ snowReach: uniform(o.snowReach),
    /** {@link StateLookOptions.snowBreakup}. */ snowBreakup: uniform(o.snowBreakup),
    /** {@link StateLookOptions.snowScale}. */ snowScale: uniform(o.snowScale),
    /** {@link StateLookOptions.sparkle}. */ sparkle: uniform(o.sparkle),
    /** {@link StateLookOptions.sparkleScale}. */ sparkleScale: uniform(o.sparkleScale),
    /** {@link StateLookOptions.scorchColor} (linear). */ scorchColor: uniform(new Color(o.scorchColor)),
    /** {@link StateLookOptions.charColor} (linear). */ charColor: uniform(new Color(o.charColor)),
    /** {@link StateLookOptions.ashColor} (linear). */ ashColor: uniform(new Color(o.ashColor)),
    /** {@link StateLookOptions.emberColor} (linear). */ emberColor: uniform(new Color(o.emberColor)),
    /** {@link StateLookOptions.emberIntensity}. */ emberIntensity: uniform(o.emberIntensity),
    /** {@link StateLookOptions.emberScale}. */ emberScale: uniform(o.emberScale),
    /** {@link StateLookOptions.leafLoss}. */ leafLoss: uniform(o.leafLoss),
    /** {@link StateLookOptions.leafScale}. */ leafScale: uniform(o.leafScale),
    /** {@link StateLookOptions.crackColor} (linear). */ crackColor: uniform(new Color(o.crackColor)),
    /** {@link StateLookOptions.crackScale}. */ crackScale: uniform(o.crackScale),
    /** {@link StateLookOptions.crackWidth}. */ crackWidth: uniform(o.crackWidth),
    /** {@link StateLookOptions.dentStrength}. */ dentStrength: uniform(o.dentStrength),
    /** {@link StateLookOptions.holeThreshold}. */ holeThreshold: uniform(o.holeThreshold),
  }
}

/** Uniforms behind a {@link StateLook}, for live tweaks. */
export type StateLookUniforms = ReturnType<typeof createStateLookUniforms>

/**
 * A live, shareable look for the material states. Share one between materials so a single `set()`
 * restyles every wet, snowy, burnt and damaged surface at once.
 */
export class StateLook {
  /** Resolved settings. */
  options: StateLookOptions
  /** TSL uniforms (updated by {@link StateLook.set} / {@link StateLook.reset}). */
  readonly uniforms: StateLookUniforms

  /** Creates a look; anything not given uses {@link DEFAULT_STATE_LOOK}. */
  constructor(input: Partial<StateLookOptions> = {}) {
    this.options = resolve(DEFAULT_STATE_LOOK, input)
    this.uniforms = createStateLookUniforms(this.options)
  }

  /** Merges `input` into the current settings. */
  set(input: Partial<StateLookOptions>): this {
    this.options = merge(this.options, input)
    const u = this.uniforms as Record<string, UniformNode<unknown, unknown>>
    for (const [k, v] of Object.entries(this.options)) {
      const target = u[k]
      if (!target) continue
      if (typeof v === 'string') (target.value as Color).set(v)
      else target.value = v
    }
    return this
  }

  /** Replaces all settings: anything not in `input` goes back to the defaults. */
  reset(input: Partial<StateLookOptions> = {}): this {
    return this.set(resolve(DEFAULT_STATE_LOOK, input))
  }
}

let sharedLook: StateLook | null = null
/** The look used when none is passed: one shared instance, created on first use. */
export function defaultStateLook(): StateLook {
  return (sharedLook ??= new StateLook())
}

/** The surface going in: what the material would look like without weathering. */
export interface StateSurface {
  /** Base albedo. */
  color: Node<'vec3'>
  /** Base roughness. */
  roughness: Node<'float'> | number
  /** Shading normal in view space (normal-mapped if you have one). Default: `normalView`. */
  normal?: Node<'vec3'>
  /** Base emissive. Default: black. */
  emissive?: Node<'vec3'>
  /** Base opacity. Default: 1. */
  opacity?: Node<'float'> | number
  /** Base metalness. Default: 0. */
  metalness?: Node<'float'> | number
}

/** The surface coming out: plug these into the material's nodes. */
export interface StateResult {
  /** Albedo. */
  color: Node<'vec3'>
  /** Roughness. */
  roughness: Node<'float'>
  /** View-space shading normal. */
  normal: Node<'vec3'>
  /** Emissive (ember glow). */
  emissive: Node<'vec3'>
  /** Opacity (leaf loss, missing pieces). Use with `alphaTest`. */
  opacity: Node<'float'>
  /** Metalness (char and snow kill it). */
  metalness: Node<'float'>
}

/** Where and how the states are applied. Every field is optional. */
export interface StateContext {
  /**
   * Position the patterns (puddles, cracks, snow edges, …) are anchored to, metres. Default
   * `positionWorld`. With a floating origin pass something that does not jump on rebase, e.g.
   * `positionLocal` for objects or `positionWorld + uniform(origin mod period)` for terrain.
   */
  position?: Node<'vec3'>
  /** World-space normal deciding up-facing (snow, puddles) and vertical (streaks). Default `normalWorld`. */
  worldNormal?: Node<'vec3'>
  /** View-space geometric normal (no normal map): snow and puddles smooth the surface towards it. Default `normalView`. */
  geometryNormal?: Node<'vec3'>
  /** Seconds, animating drips and embers. Default: the TSL `time` node; pass a uniform for scrubbable time. */
  time?: Node<'float'>
  /** Look to use. Default {@link defaultStateLook}. */
  look?: StateLook
  /** Foliage (or a 0…1 foliage mask node): burn removes leaves through opacity. */
  foliage?: boolean | Node<'float'>
  /** Allow damage to cut holes through opacity (needs `alphaTest`). Off for terrain. */
  cutout?: boolean
  /** Puddles on flat ground. Default true. */
  puddles?: boolean
  /** Drip streaks on vertical faces. Default true. */
  streaks?: boolean
}

const asFloat = (v: Node<'float'> | number): Node<'float'> => (typeof v === 'number' ? float(v) : v)
const asState = (v: Node<'float'> | number | undefined): Node<'float'> | null => (v === undefined || v === 0 ? null : asFloat(v).clamp(0, 1))

// Screen-space bump of `normal` by a procedural height (Mikkelsen 2010).
function bump(normal: Node<'vec3'>, height: Node<'float'>): Node<'vec3'> {
  const sx = dFdx(positionView)
  const sy = dFdy(positionView)
  const r1 = sy.cross(normal)
  const r2 = normal.cross(sx)
  const det = sx.dot(r1)
  const dh = vec2(dFdx(height), dFdy(height))
  const grad = det.sign().mul(dh.x.mul(r1).add(dh.y.mul(r2)))
  return det.abs().mul(normal).sub(grad).normalize()
}

/**
 * Applies the four material states to a surface. This is the contract every package plugs into:
 * give it what your material would output without weather plus the state nodes, and use what it
 * returns. Order: damage → burn → wetness → snow (snow covers everything, wet char looks wet).
 *
 * @example
 * ```ts
 * const out = applyMaterialStates(
 *   { color: barkColor, roughness: 0.9, normal: normalView },
 *   { wetness: field.wetness, snow: field.snow, burn: instance.burn, heat: fire.heat },
 *   { foliage: true },
 * )
 * material.colorNode = out.color; material.roughnessNode = out.roughness
 * material.normalNode = out.normal; material.emissiveNode = out.emissive; material.opacityNode = out.opacity
 * ```
 */
export function applyMaterialStates(surface: StateSurface, states: MaterialStateNodes, ctx: StateContext = {}): StateResult {
  const u = (ctx.look ?? defaultStateLook()).uniforms
  const p = (ctx.position ?? positionWorld).mul(u.noiseScale)
  const nWorld = ctx.worldNormal ?? normalWorld
  const nGeo = ctx.geometryNormal ?? normalView
  const t = ctx.time ?? time
  const up = nWorld.y

  let color: Node<'vec3'> = surface.color
  let roughness = asFloat(surface.roughness)
  let normal: Node<'vec3'> = surface.normal ?? normalView
  let emissive: Node<'vec3'> = surface.emissive ?? vec3(0)
  let opacity = asFloat(surface.opacity ?? 1)
  let metalness = asFloat(surface.metalness ?? 0)

  const damage = asState(states.damage)
  const burn = asState(states.burn)
  const heat = asState(states.heat)
  const ash = asState(states.ash)
  const wet = asState(states.wetness)
  const snow = asState(states.snow)

  // Anti-aliasing: every pattern fades to its mean as its wavelength nears the pixel footprint, and
  // every threshold is as soft as one pixel of its input. No sparkle, no stair steps.
  const footprint = max(length(fwidth(p)), 1e-5)
  const resolved = (wavelength: Node<'float'> | number) => smoothstep(2, 8, asFloat(wavelength).div(footprint))
  const aaStep = (edge: Node<'float'> | number, v: Node<'float'>) => {
    const w = max(fwidth(v), 1e-4)
    return smoothstep(asFloat(edge).sub(w), asFloat(edge).add(w), v)
  }
  // Domain-warped, mildly anisotropic, multi-scale noise with mean 0 (about ±0.5), octaves faded by footprint.
  const warped = (wavelengths: number[], amps: number[], salt: number) => {
    const w0 = wavelengths[0]
    const warp = vec3(mx_noise_float(p.div(w0 * 2.3).add(salt)), 0, mx_noise_float(p.div(w0 * 2.3).add(salt + 31.7))).mul(w0 * 0.45)
    const q = p.add(warp)
    let sum: Node<'float'> = float(0)
    wavelengths.forEach((l, i) => { sum = sum.add(mx_noise_float(q.mul(vec3(1 / l, 1 / l, 0.7 / l)).add(salt * (i + 1))).mul(amps[i]).mul(resolved(l))) })
    return sum
  }

  if (damage) {
    // Cracks along Worley cell borders that spread as damage grows, dents, grime.
    const cells = mx_worley_noise_vec2(p.mul(u.crackScale))
    const grow = smoothstep(0.05, 0.5, damage.add(warped([1.4], [0.25], 3.1)))
    const crack = smoothstep(u.crackWidth, 0, cells.y.sub(cells.x)).mul(grow).mul(resolved(float(1).div(u.crackScale)))
    const dent = mx_noise_float(p.mul(0.9)).mul(u.dentStrength).mul(damage).mul(resolved(1.1))
    color = mix(color, u.crackColor, crack.mul(0.85)).mul(damage.mul(0.18).oneMinus())
    roughness = roughness.add(damage.mul(0.12)).add(crack.mul(0.25)).clamp(0, 1)
    normal = bump(normal, dent.mul(0.04).sub(crack.mul(0.012)))
    if (ctx.cutout) {
      const chunk = mx_noise_float(p.mul(u.crackScale.mul(0.35))).mul(0.5).add(0.5)
      opacity = opacity.mul(step(smoothstep(u.holeThreshold, 1, damage).mul(0.6), chunk))
    }
  }

  if (burn || heat) {
    const b = burn ?? float(0)
    // The scar edge: crisp at the scale of the fire front, broken up at small scales only near the edge.
    const n = warped([14, 3.5, 0.9], [0.55, 0.3, 0.15], 7.3)
    const edgeBand = b.mul(b.oneMinus()).mul(4).add(0.12)
    const v = b.add(n.mul(0.24).mul(edgeBand))
    const charred = aaStep(0.45, v)
    const scorched = smoothstep(0.03, 0.4, b).mul(charred.oneMinus())
    // Real burn scars keep the ground's structure: char and ash are dark and pale versions of it.
    const lum = dot(color, vec3(0.2126, 0.7152, 0.0722))
    const charCol = mix(u.charColor, color.mul(0.18), 0.4)
    const ashCol = mix(u.ashColor, u.charColor, 0.35).mul(lum.mul(0.6).add(0.7))
    // Ash is a partial, softly varying share over the char (never a flat sheet): heavier where more fuel burnt.
    const ashAmt = clamp((ash ?? float(0)).mul(n.mul(0.5).add(0.45)), 0, 0.6).mul(smoothstep(0.6, 1, b))
    color = mix(color, color.mul(u.scorchColor).mul(2.2), scorched.mul(0.55))
    color = mix(color, mix(charCol, ashCol, ashAmt), charred)
    roughness = mix(roughness, float(0.95), charred)
    metalness = metalness.mul(charred.oneMinus())
    if (heat) {
      // Glowing cracks in the char, faded to their mean where too small to resolve, flickering slowly.
      const cells = mx_worley_noise_vec2(p.mul(u.emberScale))
      const cracks = mix(float(0.12), smoothstep(0.12, 0, cells.y.sub(cells.x)), resolved(float(1).div(u.emberScale)))
      const flicker = mx_noise_float(p.mul(u.emberScale.mul(0.15)).add(vec3(0, t.mul(0.9), 0))).mul(0.5).add(0.5)
      const glow = heat.mul(heat).mul(heat).mul(cracks).mul(flicker.mul(0.6).add(0.4))
      emissive = emissive.add(u.emberColor.mul(u.emberIntensity).mul(glow))
      color = mix(color, u.charColor, heat.mul(0.5))
    }
    if (ctx.foliage && burn) {
      const mask = ctx.foliage === true ? float(1) : ctx.foliage
      const leaf = mx_noise_float(p.mul(u.leafScale)).mul(0.5).add(0.5)
      opacity = opacity.mul(step(burn.mul(u.leafLoss).mul(mask).mul(1.1), leaf))
    }
  }

  if (wet) {
    const lum = dot(color, vec3(0.2126, 0.7152, 0.0722))
    const soaked = mix(vec3(lum), color, u.wetSaturation).mul(u.wetDarkening.oneMinus())
    color = mix(color, soaked, wet)
    roughness = mix(roughness, u.wetRoughness, wet.mul(0.9))
    if (ctx.streaks !== false) {
      const vertical = smoothstep(0.75, 0.3, up.abs())
      const s = mx_noise_float(vec3(p.x.mul(u.streakScale), p.y.mul(u.streakScale.mul(0.12)).add(t.mul(0.15)), p.z.mul(u.streakScale)))
      const streak = smoothstep(0.1, 0.6, s).mul(vertical).mul(wet).mul(u.streaks).mul(resolved(float(1).div(u.streakScale)))
      color = color.mul(streak.mul(0.3).oneMinus())
      roughness = roughness.mul(streak.mul(0.6).oneMinus())
    }
    if (ctx.puddles !== false) {
      // Puddles collect on flat ground in broad, warped low spots (not a blotch pattern).
      const flat = smoothstep(0.9, 0.98, up)
      const scale = float(1).div(max(u.puddleScale, 1e-3))
      const low = warped([12, 4], [0.7, 0.3], 19.1).mul(scale.div(3).min(1)).add(0.5)
      // Only properly wet ground pools water; puddles darken a little and mostly turn glossy.
      const puddle = flat.mul(aaStep(low, wet.mul(u.puddles).sub(0.35)))
      color = mix(color, color.mul(0.72), puddle)
      roughness = mix(roughness, float(0.03), puddle)
      normal = mix(normal, nGeo, puddle).normalize()
    }
  }

  if (snow) {
    const edge = warped([3, 0.8], [0.7, 0.3], 23.9).mul(2)
    const threshold = snow.mul(u.snowReach.add(1)).oneMinus()
    const cover = smoothstep(threshold, threshold.add(0.12), up.add(edge.mul(u.snowBreakup))).mul(smoothstep(0, 0.08, snow))
    const sparkle = smoothstep(0.8, 0.92, mx_noise_float(p.mul(u.sparkleScale).add(cameraPosition.mul(0.05)))).mul(cover).mul(u.sparkle).mul(resolved(float(1).div(u.sparkleScale)))
    color = mix(color, u.snowColor.mul(up.mul(0.12).add(0.88)), cover).add(sparkle)
    roughness = mix(roughness, u.snowRoughness, cover).sub(sparkle.mul(0.4)).clamp(0.02, 1)
    normal = mix(normal, nGeo, cover.mul(0.85)).normalize()
    metalness = metalness.mul(cover.oneMinus())
    emissive = emissive.mul(cover.oneMinus())
  }

  return { color, roughness, normal, emissive, opacity, metalness }
}

/**
 * Applies the material states to a node material in place, starting from whatever it already outputs
 * (its `colorNode`/`roughnessNode`/… if set, else its colour, maps and scalars). Sets `alphaTest = 0.5`
 * when foliage or cut-outs need it. Call once per material. Vertex colours are folded into the base colour
 * (and `vertexColors` turned off); `InstancedMesh.instanceColor` still multiplies the result, so tint
 * instances through `colorNode` instead if their snow and ash should stay white and grey.
 *
 * @example
 * ```ts
 * const material = new MeshStandardNodeMaterial({ color: '#8a7f70', roughness: 0.8 })
 * applyMaterialStatesTo(material, field.node())            // wet / snowy / burnt / damaged from a StateField
 * applyMaterialStatesTo(leaves, instances.node(), { foliage: true })
 * ```
 */
export function applyMaterialStatesTo<T extends MeshStandardNodeMaterial>(material: T, states: MaterialStateNodes, ctx: StateContext = {}): T {
  const m = material
  // Fold vertex colours in here: three would multiply them in after colorNode, tinting snow and ash.
  const base = (m.colorNode as Node<'vec3'> | null) ?? materialColor
  const out = applyMaterialStates(
    {
      color: m.vertexColors ? base.mul(vertexColor().xyz) : base,
      roughness: (m.roughnessNode as Node<'float'> | null) ?? materialRoughness,
      normal: (m.normalNode as Node<'vec3'> | null) ?? materialNormal,
      emissive: (m.emissiveNode as Node<'vec3'> | null) ?? materialEmissive,
      opacity: (m.opacityNode as Node<'float'> | null) ?? materialOpacity,
      metalness: (m.metalnessNode as Node<'float'> | null) ?? materialMetalness,
    },
    states,
    ctx,
  )
  m.colorNode = out.color
  m.roughnessNode = out.roughness
  m.normalNode = out.normal
  m.emissiveNode = out.emissive
  m.opacityNode = out.opacity
  m.metalnessNode = out.metalness
  m.vertexColors = false
  if ((ctx.foliage || ctx.cutout) && !m.alphaTest) m.alphaTest = 0.5
  m.needsUpdate = true
  return m
}

/** One float uniform per state: whole-material states (e.g. "all roofs are snowy"). */
export type MaterialStateUniforms = Record<StateChannel | 'heat', UniformNode<'float', number>>

/**
 * Creates one uniform per state (plus `heat`), usable directly as {@link MaterialStateNodes}. Change
 * them with `uniforms.snow.value = 0.8`, or {@link setMaterialStateUniforms}.
 */
export function createMaterialStateUniforms(values: Partial<MaterialStates & { heat: number }> = {}): MaterialStateUniforms {
  return {
    wetness: uniform(values.wetness ?? 0),
    snow: uniform(values.snow ?? 0),
    burn: uniform(values.burn ?? 0),
    damage: uniform(values.damage ?? 0),
    heat: uniform(values.heat ?? 0),
  }
}

/** Copies plain values into uniforms from {@link createMaterialStateUniforms}. */
export function setMaterialStateUniforms(uniforms: MaterialStateUniforms, values: Partial<MaterialStates & { heat: number }>): void {
  for (const [k, v] of Object.entries(values)) if (v !== undefined && k in uniforms) uniforms[k as StateChannel].value = v
}
