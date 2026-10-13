/**
 * Procedural star field and Milky Way on the celestial sphere, drawn per pixel in TSL (no textures):
 * seeded stars in three cube-mapped cell layers, a realistic magnitude distribution, colours from
 * black-body temperatures, twinkling that grows with airmass, extinction near the horizon, and a
 * limiting magnitude that drops as the sky brightens (so stars come out one by one at dusk).
 */
import { AdditiveBlending, BackSide, Mesh, NodeMaterial, SphereGeometry, Vector3 } from 'three/webgpu'
import { abs, dot, exp, float, floor, fract, fwidth, length, log, max, mix, normalize, select, sin, smoothstep, sqrt, step, time, uniform, vec3, vec4 } from 'three/tsl'
import { applySkyState, createSkyUniforms, domeDirection, farDomePosition, type SkyUniforms } from './atmosphere.ts'
import { DEFAULT_MILKY_WAY, applyMilkyWay, createMilkyWayUniforms, milkyWayNode, type MilkyWayOptions, type MilkyWayUniforms } from './milky-way.ts'
import { moonCoverage } from './moon.ts'
import type { SkyState } from './observer.ts'
import { kelvinToRgb, merge, seedOf, type DeepPartial } from './util.ts'

/** Star field settings. Plain JSON. */
export interface StarsOptions {
  /** Draw stars (and the Milky Way). */
  enabled: boolean
  /** Seed for star positions, brightness and colours. */
  seed: number | string
  /** Overall star brightness. */
  brightness: number
  /** Faintest magnitude shown under a perfectly dark sky (6 ≈ naked eye, 8 = binoculars-rich). */
  magnitudeLimit: number
  /** Multiplier on how many stars each cell layer holds, 0..1.5. */
  density: number
  /** Twinkle strength, 0..1. Grows towards the horizon. */
  twinkle: number
  /** Twinkle speed multiplier. */
  twinkleSpeed: number
  /** Star size in pixels (they're points, so keep it ~1). */
  size: number
  /** Colour saturation of star tints, 0 (white) .. 2. */
  saturation: number
  /** Sky luminance (renderer units) of a truly dark sky; brighter skies lower the limiting magnitude. */
  darkSky: number
  /** Milky Way settings. */
  milkyWay: MilkyWayOptions
}

/** Defaults: a rich dark-site sky. */
export const DEFAULT_STARS: StarsOptions = {
  enabled: true,
  seed: 1,
  brightness: 1,
  magnitudeLimit: 7,
  density: 1,
  twinkle: 0.6,
  twinkleSpeed: 1,
  size: 1,
  saturation: 1,
  darkSky: 1e-4,
  milkyWay: DEFAULT_MILKY_WAY,
}

/** Input for {@link Stars}: any subset of {@link StarsOptions}. */
export type StarsInput = DeepPartial<StarsOptions>

/** Creates the star-field uniforms. */
export function createStarUniforms() {
  return {
    /** Brightness multiplier (0 = off). */
    brightness: uniform(1),
    /** Effective limiting magnitude right now (after sky brightness). */
    limit: uniform(7),
    /** Density multiplier. */
    density: uniform(1),
    /** Twinkle strength. */
    twinkle: uniform(0.6),
    /** Twinkle speed. */
    twinkleSpeed: uniform(1),
    /** Size in pixels. */
    size: uniform(1),
    /** Tint saturation. */
    saturation: uniform(1),
    /** Seed folded into the cell hash. */
    seed: uniform(0),
    /** Black-body colours for 3200, 4300, 5500, 7000, 10000 and 20000 K. */
    palette: [3200, 4300, 5500, 7000, 10000, 20000].map((k) => uniform(new Vector3(...kelvinToRgb(k)))),
  }
}

/** Star-field uniforms (`stars.starUniforms`). */
export type StarUniforms = ReturnType<typeof createStarUniforms>

// Dave Hoskins' sinless hash: same result on every GPU.
const hash33 = (p: any): any => {
  const q: any = fract(p.mul(vec3(0.1031, 0.103, 0.0973)))
  const r: any = q.add(dot(q, q.yxz.add(33.33)))
  return fract(r.xxy.add(r.yxx).mul(r.zyx))
}

/** One layer of stars: one candidate per cube-face cell, placed in the cell's centre half so no neighbour checks are needed. */
function layer(s: StarUniforms, cel: any, face: { uv: any; id: any; isX: any; isY: any; sign: any }, px: any, cells: number, fill: number, mBright: number, mFaint: number, salt: number, boost: any) {
  const g = face.uv.mul(0.5).add(0.5).mul(cells)
  const cell: any = floor(g)
  const h1 = hash33(vec3(cell.x, cell.y, face.id.add(s.seed).add(salt)))
  const h2 = hash33(h1.mul(113.7).add(vec3(cell.y, cell.x, salt + 7)))
  const present = step(h1.x, s.density.mul(fill).mul(boost))
  const suv: any = cell.add(h1.yz.mul(0.5).add(0.25)).div(cells).mul(2).sub(1)
  const dir = normalize(select(face.isX, vec3(face.sign, suv.x, suv.y), select(face.isY, vec3(suv.x, face.sign, suv.y), vec3(suv.x, suv.y, face.sign))))
  const ang = length(cel.sub(dir))
  // N(<m) ∝ 10^(0.5 m): invert the cumulative distribution between mBright and mFaint.
  const lo = Math.pow(10, 0.5 * (mBright - mFaint))
  const m = float(mFaint).add(log(mix(float(lo), float(1), h2.x)).mul(2 / Math.LN10))
  const flux = exp(m.mul(-0.4 * Math.LN10)).mul(smoothstep(s.limit.add(0.5), s.limit.sub(0.5), m))
  const sigma = px.mul(s.size).mul(float(0.5).add(max(float(2).sub(m), 0).mul(0.12)))
  const core = exp(ang.mul(ang).div(sigma.mul(sigma).mul(-2)))
  // Colour: piecewise between black-body stops; most naked-eye stars are white to orange.
  const t = h2.y
  const stops = [0, 0.12, 0.42, 0.62, 0.82, 1]
  let col: any = s.palette[0]
  for (let k = 1; k < stops.length; k++) col = mix(col, s.palette[k], smoothstep(stops[k - 1], stops[k], t))
  const luma = dot(col, vec3(0.2126, 0.7152, 0.0722))
  col = mix(vec3(luma), col, s.saturation)
  return { color: col.mul(flux.mul(core).mul(present)), phase: h2.z }
}

/** Builds the star-field + Milky Way colour node for the far dome. */
export function starsColorNode(u: SkyUniforms, s: StarUniforms, mw: MilkyWayUniforms): any {
  const d = domeDirection()
  const cel = normalize(u.celestialMatrix.mul(d))
  const px = max(length(fwidth(cel)), 1e-5)
  const moonMask = float(1).sub(moonCoverage(u, d).coverage)

  // Cube-face coordinates of the celestial direction.
  const a = abs(cel)
  const isX = a.x.greaterThanEqual(a.y).and(a.x.greaterThanEqual(a.z))
  const isY = isX.not().and(a.y.greaterThanEqual(a.z))
  const face = {
    isX, isY,
    uv: select(isX, cel.yz.div(a.x), select(isY, cel.xz.div(a.y), cel.xy.div(a.z))),
    sign: select(isX, cel.x.sign(), select(isY, cel.y.sign(), cel.z.sign())),
    id: select(isX, cel.x.sign().add(1), select(isY, cel.y.sign().add(5), cel.z.sign().add(9))),
  }
  const milky = milkyWayNode(mw, cel)
  const boost = milky.band.mul(3).add(1)
  const l0 = layer(s, cel, face, px, 48, 0.9, -1.5, 6, 0, float(1))
  const l1 = layer(s, cel, face, px, 128, 0.35, 6, 7.5, 17, boost)
  const l2 = layer(s, cel, face, px, 320, 0.12, 7.5, 9, 41, boost.mul(boost))

  // Atmosphere: planet occlusion, airmass extinction and scintillation.
  const o = u.cameraToPlanet
  const b = dot(o, d)
  const p = o.sub(d.mul(b))
  const hG2 = u.planetRadius.mul(u.planetRadius).sub(dot(p, p))
  const visible = hG2.greaterThan(0).and(b.negate().sub(sqrt(max(hG2, 0))).greaterThan(0)).select(0, 1)
  const r = length(o)
  const alt = max(r.sub(u.planetRadius), 0)
  const mu = max(dot(d, o.div(r)), 0)
  const airmass = float(1).div(mu.add(float(0.025).mul(exp(mu.mul(-11)))))
  const column = u.rayleigh.mul(u.rayleighScaleHeight).mul(exp(alt.div(u.rayleighScaleHeight).negate()))
    .add(u.mie.add(u.mieAbsorption).mul(u.mieScaleHeight).mul(exp(alt.div(u.mieScaleHeight).negate()))).mul(u.density)
  const ext = exp(column.mul(airmass).negate())
  const scint = s.twinkle.mul(smoothstep(1, 12, airmass).mul(0.85).add(0.15)).mul(column.y.mul(8).clamp(0, 1))
  const tw = (ph: any) => float(1).add(scint.mul(sin(time.mul(s.twinkleSpeed).mul(7.3).add(ph.mul(40))).mul(0.6).add(sin(time.mul(s.twinkleSpeed).mul(17.1).add(ph.mul(91))).mul(0.4))))
  const stars = l0.color.mul(tw(l0.phase)).add(l1.color.mul(tw(l1.phase))).add(l2.color).mul(s.brightness).mul(3)
  const mwVisible = smoothstep(3.5, 6.5, s.limit)
  const total = stars.add(milky.color.mul(mwVisible))
  return total.mul(ext).mul(visible).mul(moonMask)
}

/**
 * The star field and Milky Way. Created by `Sky` for you; use it directly for a space scene or a sky
 * without atmosphere.
 *
 * @example
 * ```ts
 * const stars = new Stars({ seed: 7, magnitudeLimit: 8 })
 * scene.add(stars.object)
 * // each frame, optionally with a SkyState to turn the sky and fade with daylight:
 * stars.update(state)
 * ```
 */
export class Stars {
  /** The far-dome mesh. Add it to your scene. */
  readonly object: Mesh<SphereGeometry, NodeMaterial>
  /** Sky uniforms read by the star shader (shared with `Sky` when created by it). */
  readonly uniforms: SkyUniforms
  /** Star-field uniforms. */
  readonly starUniforms: StarUniforms = createStarUniforms()
  /** Milky Way uniforms. */
  readonly milkyWay: MilkyWayUniforms = createMilkyWayUniforms()
  /** Resolved settings. Change them with {@link Stars.set} / {@link Stars.reset}. */
  settings: StarsOptions = structuredClone(DEFAULT_STARS)
  private skyLuminance = 0
  private readonly ownsUniforms: boolean

  /**
   * @param input Settings.
   * @param uniforms Shared sky uniforms (from `Sky`). Omit for a standalone field: it then shows a
   *   fixed night sky until you pass a `SkyState` to {@link Stars.update}.
   */
  constructor(input: StarsInput = {}, uniforms?: SkyUniforms) {
    this.ownsUniforms = !uniforms
    this.uniforms = uniforms ?? createSkyUniforms()
    if (!uniforms) {
      // No planet and no air: the whole sphere is visible and nothing dims it.
      this.uniforms.cameraToPlanet.value.set(0, 1, 0)
      this.uniforms.planetRadius.value = 0
      this.uniforms.density.value = 0
    }
    const material = new NodeMaterial()
    material.side = BackSide
    material.transparent = true
    material.blending = AdditiveBlending
    material.depthWrite = false
    material.fog = false
    material.vertexNode = farDomePosition()
    material.colorNode = vec4(starsColorNode(this.uniforms, this.starUniforms, this.milkyWay), 1)
    this.object = new Mesh(new SphereGeometry(1, 48, 24), material)
    this.object.name = 'Stars'
    this.object.frustumCulled = false
    this.object.renderOrder = -999
    this.set(input)
  }

  /** Merges settings (nested `milkyWay` merges too). */
  set(input: StarsInput): this {
    merge(this.settings, input)
    return this.apply()
  }

  /** Replaces all settings; anything not given goes back to {@link DEFAULT_STARS}. */
  reset(input: StarsInput = {}): this {
    this.settings = merge(structuredClone(DEFAULT_STARS), input)
    return this.apply()
  }

  private apply(): this {
    const o = this.settings, s = this.starUniforms
    const seed = seedOf(o.seed)
    s.brightness.value = o.enabled ? o.brightness : 0
    s.density.value = o.density
    s.twinkle.value = o.twinkle
    s.twinkleSpeed.value = o.twinkleSpeed
    s.size.value = o.size
    s.saturation.value = o.saturation
    s.seed.value = (((seed % 9973) + 9973) % 9973) * 0.731
    applyMilkyWay(this.milkyWay, o.milkyWay, seed)
    this.object.visible = o.enabled
    this.updateLimit()
    return this
  }

  private updateLimit() {
    const o = this.settings
    // Limiting magnitude drops by 2.5·log10 of how much brighter than a dark sky it is.
    this.starUniforms.limit.value = o.magnitudeLimit - 2.5 * Math.log10(1 + Math.max(0, this.skyLuminance) / Math.max(o.darkSky, 1e-9))
  }

  /**
   * Turns and fades the field. Pass the `Sky`'s state (or one from `observe()`); standalone fields
   * can be called without arguments.
   */
  update(state?: SkyState): void {
    if (!state) return
    if (this.ownsUniforms) applySkyState(this.uniforms, state)
    this.skyLuminance = state.skyLuminance
    this.updateLimit()
  }

  /** Frees GPU resources. */
  dispose(): void {
    this.object.removeFromParent()
    this.object.geometry.dispose()
    this.object.material.dispose()
  }
}
