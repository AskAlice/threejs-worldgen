import {
  Color,
  FrontSide,
  MeshBasicNodeMaterial,
  Vector2,
  Vector3,
  Vector4,
  type DirectionalLight,
  type Object3D,
  type Texture
} from 'three/webgpu'
import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  attribute,
  bool,
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraProjectionMatrix,
  cameraProjectionMatrixInverse,
  cameraViewMatrix,
  cos,
  cross,
  dot,
  exp,
  float,
  fract,
  fwidth,
  getScreenPosition,
  getViewPosition,
  int,
  length,
  logarithmicDepthToViewZ,
  max,
  min,
  mix,
  modelWorldMatrix,
  mx_noise_float,
  mx_noise_vec3,
  normalize,
  perspectiveDepthToViewZ,
  pmremTexture,
  positionGeometry,
  positionView,
  positionWorld,
  pow,
  reflect,
  screenUV,
  select,
  sin,
  smoothstep,
  sqrt,
  uniform,
  uniformArray,
  varying,
  varyingProperty,
  vec2,
  vec3,
  vec4,
  viewportDepthTexture,
  viewportSharedTexture
} from 'three/tsl'
import type { WaterPrepass } from './prepass.ts'
import { MAX_WAVES, crestSharpness, type Wave } from './waves.ts'

/** How water looks: colour, clarity, reflections, foam and ripples. Shared by oceans, lakes and rivers. */
export interface WaterAppearance {
  /**
   * Per-channel absorption coefficients, 1/m, in R, G, B order: how fast each channel of the light
   * behind the surface is absorbed per metre of water. Red goes first, so a shallow bed reads turquoise
   * and deep water keeps only the `scatterColor`. `1 / absorption[c]` is the depth (m) at which that
   * channel is down to 37%.
   */
  absorption: [red: number, green: number, blue: number]
  /** Colour of the light scattered back out of the water body: what deep water looks like where the bottom is out of sight. */
  scatterColor: string
  /** Screen-space refraction strength (0 = none). */
  refraction: number
  /** Surface roughness 0 … 1 (blurs reflections and widens the sun glint). Grows by itself with distance. */
  roughness: number
  /** Reflectance looking straight down (Fresnel F0); water is 0.02. */
  reflectivity: number
  /** Sky colour reflected near the zenith when there is no `environment`. */
  skyColor: string
  /** Sky colour reflected near the horizon when there is no `environment`. */
  horizonColor: string
  /** Multiplier on `environment` reflections. */
  environmentIntensity: number
  /** Multiplier on the sun's glint. */
  specular: number
  /** Foam colour. */
  foamColor: string
  /** Water depth (metres) by which shoreline foam has faded out: full at the waterline, 0 here. */
  foamWidth: number
  /** 0 … 1 overall foam amount (shoreline, whitecaps, rapids and around obstacles). */
  foam: number
  /** Strength of the procedural ripple normals added on top of the waves. */
  detail: number
  /** Ripple wavelength, metres. */
  detailScale: number
  /** Ripple drift speed, m/s. */
  detailSpeed: number
  /** Light for the sun glint and daylight. `null` = the first DirectionalLight found in the scene. Object input. */
  sun: DirectionalLight | null
  /** Environment reflected (an equirect or cube texture, prefiltered for you). `null` = the sky colours. Object input. */
  environment: Texture | null
}

/** Default look: clear tropical-ish sea water. */
export const DEFAULT_APPEARANCE: WaterAppearance = {
  absorption: [0.37, 0.17, 0.1],
  scatterColor: '#0b3247',
  refraction: 0.035,
  roughness: 0.06,
  reflectivity: 0.02,
  skyColor: '#6e9fd6',
  horizonColor: '#cfe0ee',
  environmentIntensity: 1,
  specular: 1,
  foamColor: '#f3f7f8',
  foamWidth: 0.6,
  foam: 1,
  detail: 0.25,
  detailScale: 1.4,
  detailSpeed: 0.4,
  sun: null,
  environment: null
}

/**
 * Creates the uniforms of one water material. Each Ocean, Rivers and Lakes owns a set and drives
 * it from its settings; exported so the {@link WaterUniforms} type is documented in full.
 */
export function createWaterUniforms() {
  return {
    /** `absorption`, per-channel 1/m (R, G, B). */
    absorption: uniform(new Vector3(...DEFAULT_APPEARANCE.absorption)),
    /** `scatterColor`. */
    scatterColor: uniform(new Color()),
    /** `refraction`. */
    refraction: uniform(0),
    /** `roughness`. */
    roughness: uniform(0.05),
    /** `reflectivity` (F0). */
    reflectivity: uniform(0.02),
    /** `skyColor`. */
    skyColor: uniform(new Color()),
    /** `horizonColor`. */
    horizonColor: uniform(new Color()),
    /** `environmentIntensity`. */
    environmentIntensity: uniform(1),
    /** `specular`. */
    specular: uniform(1),
    /** `foamColor`. */
    foamColor: uniform(new Color()),
    /** `foamWidth`, metres. */
    foamWidth: uniform(0.5),
    /** `foam`, 0 … 1. */
    foam: uniform(1),
    /** Whitecap amount 0 … 1 (oceans and lakes). */
    whitecaps: uniform(0),
    /** Flow speed (m/s) where river rapids start foaming. */
    rapids: uniform(2.5),
    /** `detail`. */
    detail: uniform(0),
    /** `detailScale`, metres. */
    detailScale: uniform(1),
    /** `detailSpeed`, m/s. */
    detailSpeed: uniform(0.4),
    /** Unit drift direction of the ripples (x, z). */
    detailDirection: uniform(new Vector2(1, 0)),
    /** Direction *towards* the sun, world space. */
    sunDirection: uniform(new Vector3(0.3, 0.8, 0.2).normalize()),
    /** Sun colour × intensity. */
    sunColor: uniform(new Color(1, 1, 1)),
    /** Seconds, advanced by the owner's `update()`. */
    time: uniform(0),
    /** Active entries in `waveA`/`waveB`. */
    waveCount: uniform(0, 'int'),
    /** Per wave: direction x, direction z, wavenumber k, amplitude. */
    waveA: uniformArray(
      Array.from({ length: MAX_WAVES }, () => new Vector4()),
      'vec4'
    ),
    /** Per wave: horizontal amplitude (chop), phase (radians, includes −ωt), angular frequency ω (rad/s), unused. */
    waveB: uniformArray(
      Array.from({ length: MAX_WAVES }, () => new Vector4()),
      'vec4'
    ),
    /** Σ k·chop of the waves: surface steepness (1 = folding), which gates whitecap foam. */
    crest: uniform(1),
    /** Multiplier from geometry x/z to tangent-plane metres (the ocean's ring scale). */
    gridScale: uniform(1),
    /** Vertex spacing per metre of distance (2π / segments for the ocean rings; 0 = uniform grid). */
    gridAngle: uniform(0),
    /** Smallest vertex spacing, metres. Waves shorter than ~3 spacings fade out in the vertex stage. */
    gridMinSpacing: uniform(1),
    /** Sphere radius the surface bends to (sea radius on planets; huge = flat). */
    radius: uniform(1e15),
    /** Surface distance beyond which vertices are clamped (the horizon on planets). */
    maxArc: uniform(1e30),
    /** Seconds per flow-map cycle (rivers). */
    flowPeriod: uniform(2)
  }
}

/** Shader uniforms of a water material. Each entry is a TSL uniform node. */
export type WaterUniforms = ReturnType<typeof createWaterUniforms>

/** `absorption` as a plain triple, clamped to ≥ 0. */
export function absorptionCoefficients(a: Pick<WaterAppearance, 'absorption'>): [number, number, number] {
  return [Math.max(0, a.absorption[0]), Math.max(0, a.absorption[1]), Math.max(0, a.absorption[2])]
}

/**
 * Beer–Lambert transmittance exp(−σ·path) per channel: the fraction of the light behind the surface
 * that survives `path` metres of water. 1 = clear, 0 = fully absorbed.
 */
export function transmittance(absorption: readonly number[], path: number): [number, number, number] {
  return [Math.exp(-absorption[0] * path), Math.exp(-absorption[1] * path), Math.exp(-absorption[2] * path)]
}

/** What a water pixel reads behind itself, and how much water lies along that ray. */
export interface BehindSample {
  /** `'refracted'` = the offset sample, `'self'` = the pixel's own sample, `'none'` = no sample behind (the bed at the waterline). */
  uv: 'refracted' | 'self' | 'none'
  /** Metres of water along the view ray; 0 when the depth read sits at or in front of the surface (the waterline). */
  path: number
}

/**
 * Picks the sample behind a water fragment, rejecting foreground geometry: view-space z is negative in
 * front of the camera, so a sample is behind the surface only when it is more negative. The refracted
 * offset is used when it lands on the background, otherwise the pixel's own sample — so an object in
 * front never leaks through the surface.
 *
 * A depth read in front of the surface cannot be a real occluder (the depth test already dropped those
 * pixels): it is the bed at the waterline, read a fraction of a pixel off. The water there has no
 * thickness, so the path is 0, not a deep-water stand-in: the thickness then crosses zero continuously
 * with the depth read, instead of jumping per pixel where the surface meets the bed.
 */
export function behindSample(viewZ: number, refractedZ: number, ownZ: number, dist: number): BehindSample {
  const path = (z: number) => Math.max(0, dist * (z / viewZ - 1))
  if (refractedZ < viewZ) return { uv: 'refracted', path: path(refractedZ) }
  if (ownZ < viewZ) return { uv: 'self', path: path(ownZ) }
  return { uv: 'none', path: 0 }
}

/**
 * Schlick Fresnel reflectance of water: `reflectivity` (F0, 0.02 for water) looking straight down,
 * rising to 1 at grazing incidence. The shader's reflection mix mirrors this exactly.
 */
export function fresnel(nDotV: number, reflectivity: number): number {
  const c = 1 - Math.min(1, Math.max(0, nDotV))
  return reflectivity + (1 - reflectivity) * c ** 5
}

/**
 * How much of a reflection is traced in screen space rather than read from the environment/sky:
 * 1 for calm water (a sharp mirror), 0 for rough water, which blurs into the environment.
 */
export function screenReflectionWeight(roughness: number): number {
  const t = Math.min(1, Math.max(0, (roughness - 0.08) / 0.37))
  return 1 - t * t * (3 - 2 * t)
}

/**
 * Reflection weight of a screen-space hit by its distance from the frame's border (UV): 1 inside,
 * fading to 0 over `width` so a traced hit blends into the environment without a visible seam.
 */
export function screenEdgeFade(u: number, v: number, width = 0.08): number {
  const edge = Math.max(0, Math.min(u, 1 - u, v, 1 - v))
  const t = Math.min(1, edge / Math.max(width, 1e-6))
  return t * t * (3 - 2 * t)
}

/**
 * Half-width (or width) of an anti-aliased transition: the mask never changes over less than `pixels`
 * pixels of its own screen-space change (`step`, e.g. `fwidth` of the mask). A value that is already
 * smooth on screen keeps the `base` width, so near-camera detail stays crisp; a threshold that is
 * sub-pixel at a grazing angle or with distance widens until it spans a few pixels instead of aliasing.
 * The shader mirrors this as `aa(base, fwidth(signal))`.
 */
export function antiAlias(base: number, step: number, pixels = 2): number {
  return Math.max(base, Math.max(0, step) * pixels)
}

/**
 * Water-surface coverage over the shoreline depth band: 0 at the waterline, 1 at `band` metres of
 * depth. Fading alpha over this band is what makes the depth-test crossing with the bed — which MSAA
 * does not anti-alias — blend smoothly into the land instead of stair-stepping.
 */
export function shoreCoverage(depth: number, band: number): number {
  const t = Math.min(1, Math.max(0, depth / Math.max(band, 1e-9)))
  return t * t * (3 - 2 * t)
}

/** Hermite ease of `x` clamped to 0 … 1. */
function ease(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

/**
 * Whitecap coverage from the wave Jacobian: 0 on open water, rising on squeezed (steep) crests.
 *
 * `fold` is `1 − det J` (0 on flat water, → 1 as the surface folds over). `steepness` is the summed
 * `chop × k` of the sea (1 = folding): calm water cannot foam however high `whitecaps` is, and a
 * steeper sea breaks earlier. `whitecaps` moves the threshold into progressively milder crests.
 * `width` is the screen-space-widened ramp above the threshold; mirrors `antiAlias` in the shader.
 */
export function whitecapFoam(fold: number, whitecaps: number, steepness: number, width = 0.16): number {
  const amount = Math.min(1, Math.max(0, whitecaps))
  const cut = 0.08 + (1 - amount) * 0.28
  return ease((fold - cut) / Math.max(width, 1e-6)) * ease((steepness - 0.12) / 0.28) * ease(amount / 0.02)
}

/**
 * Foam that outlives the crest that made it: the stronger of the coverage now and a faded amount of
 * the coverage one lifetime ago. A breaking crest leaves a trail that decays instead of blinking off
 * in the frame the Jacobian relaxes.
 */
export function foamTrail(now: number, older: number, decay = 0.5): number {
  return Math.max(now, older * decay)
}

/**
 * Shoreline foam over the shallow depth band: full at the waterline, easing to 0 by `foamWidth` (m).
 * `noise` (0 … 1) breaks up the band without moving its outer edge, so foam stays at the shore
 * instead of covering a shallow shelf. `slope` (m of depth per m across the surface, default ∞) gates
 * the foam to a real bank: over near-flat ground the whole shelf is shallow, and foam there would
 * read as a white sheet instead of a shoreline.
 */
export function shoreFoam(depth: number, foamWidth: number, noise = 1, wobble = 0, slope = Infinity): number {
  if (depth < 0) return 0
  const levels = depth / Math.max(foamWidth, 1e-4) + wobble
  const bank = Math.min(1, Math.max(0, (slope - 0.005) / 0.025))
  return (
    (1 - ease((levels - 0.15) / 0.85)) *
    (0.55 + 0.45 * Math.min(1, Math.max(0, noise))) *
    (bank * bank * (3 - 2 * bank))
  )
}

/** Copies the appearance settings into uniforms. */
export function applyAppearance(u: WaterUniforms, a: WaterAppearance): void {
  const [r, g, b] = absorptionCoefficients(a)
  u.absorption.value.set(r, g, b)
  u.scatterColor.value.set(a.scatterColor)
  u.refraction.value = a.refraction
  u.roughness.value = Math.min(1, Math.max(0.01, a.roughness))
  u.reflectivity.value = a.reflectivity
  u.skyColor.value.set(a.skyColor)
  u.horizonColor.value.set(a.horizonColor)
  u.environmentIntensity.value = a.environmentIntensity
  u.specular.value = a.specular
  u.foamColor.value.set(a.foamColor)
  u.foamWidth.value = Math.max(1e-4, a.foamWidth)
  u.foam.value = a.foam
  u.detail.value = a.detail
  u.detailScale.value = Math.max(1e-4, a.detailScale)
  u.detailSpeed.value = a.detailSpeed
}

/** Uploads waves (directions, wavenumbers, amplitudes); phases are set every frame with {@link setWavePhases}. */
export function applyWaves(u: WaterUniforms, waves: readonly Wave[], windX: number, windZ: number): void {
  const a = u.waveA.array as unknown as Vector4[]
  const b = u.waveB.array as unknown as Vector4[]
  for (let i = 0; i < MAX_WAVES; i++) {
    const w = waves[i]
    if (w) {
      a[i].set(w.dirX, w.dirZ, w.k, w.amplitude)
      b[i].set(w.chop, 0, w.omega, 0)
    } else {
      a[i].set(1, 0, 1, 0)
      b[i].set(0, 0, 0, 0)
    }
  }
  u.waveCount.value = Math.min(MAX_WAVES, waves.length)
  u.crest.value = Math.max(1e-4, crestSharpness(waves))
  const l = Math.hypot(windX, windZ) || 1
  u.detailDirection.value.set(windX / l, windZ / l)
}

/** Sets each wave's phase (radians); `phase[i]` already includes −ωt and the grid origin's offset. */
export function setWavePhases(u: WaterUniforms, phase: ArrayLike<number>): void {
  const b = u.waveB.array as unknown as Vector4[]
  for (let i = 0; i < phase.length && i < MAX_WAVES; i++) b[i].y = phase[i]
}

const _a = new Vector3()
const _b = new Vector3()
/**
 * Reads the sun into uniforms. Without an explicit light, the first DirectionalLight in the scene
 * that `object` belongs to is used (searched once, once `object` is in a scene). Returns the light used.
 */
export function updateSun(
  u: WaterUniforms,
  light: DirectionalLight | null,
  object: Object3D,
  cache: { light: DirectionalLight | null; searched: boolean }
): DirectionalLight | null {
  let sun = light
  if (!sun && !cache.searched && object.parent) {
    cache.searched = true
    let root: Object3D = object
    while (root.parent) root = root.parent
    root.traverse((o) => {
      if (!cache.light && (o as DirectionalLight).isDirectionalLight) cache.light = o as DirectionalLight
    })
  }
  sun ??= cache.light
  if (!sun) return null
  sun.updateWorldMatrix(true, false)
  sun.target.updateWorldMatrix(true, false)
  u.sunDirection.value.copy(
    _a.setFromMatrixPosition(sun.matrixWorld).sub(_b.setFromMatrixPosition(sun.target.matrixWorld)).normalize()
  )
  u.sunColor.value.copy(sun.color).multiplyScalar(sun.intensity)
  return sun
}

const TAU = Math.PI * 2
/** Metres a screen-space reflection ray travels before it falls back to the environment. */
const REFLECTION_REACH = 250
/** March steps for one reflection ray; the depth crossing is then bisected a few times. */
const REFLECTION_STEPS = 24
/** Seconds foam lingers behind a breaking crest, and the fraction of the crest's coverage it keeps. */
const FOAM_LIFETIME = 0.35
const FOAM_DECAY = 0.5
/**
 * Screen-space taps (offset in pixels, weight) for contact foam: foam gathers where geometry stands
 * in front of the surface (banks, rocks, hulls), which is the only obstacle information a water
 * fragment has.
 */
const CONTACT_TAPS: readonly [x: number, y: number, weight: number][] = [
  [2, 0, 1],
  [-2, 0, 1],
  [0, 2, 1],
  [0, -2, 1],
  [3.5, 3.5, 0.6],
  [3.5, -3.5, 0.6],
  [-3.5, 3.5, 0.6],
  [-3.5, -3.5, 0.6]
]

/** View-space z of the opaque scene behind a screen position, for plain and logarithmic depth buffers. */
const sceneViewZ = (uv: any) =>
  Fn((builder) => {
    const d = viewportDepthTexture(uv).x
    return builder.renderer.logarithmicDepthBuffer
      ? logarithmicDepthToViewZ(d, cameraNear, cameraFar)
      : perspectiveDepthToViewZ(d, cameraNear, cameraFar)
  })()

/** Rotates a tangent-plane vector at planar offset `p` onto the sphere of `radius` (identity on flat surfaces). */
const tilt = (v: any, p: any, radius: any) => {
  const r = max(length(p), 1e-9)
  const th = r.div(radius)
  const k = vec3(p.y.div(r), 0, p.x.div(r).negate())
  const c = cos(th),
    s = sin(th)
  return v
    .mul(c)
    .add(cross(k, v).mul(s))
    .add(k.mul(dot(k, v).mul(float(1).sub(c))))
}

/**
 * Builds a water material.
 *
 * - `'waves'` (oceans, lakes): geometry x/z (× `gridScale`) are tangent-plane metres and y a base height;
 *   the vertex stage sums Gerstner waves on that grid and bends
 *   it onto the sea sphere; the fragment stage re-evaluates the waves per pixel for crisp normals,
 *   fading each wave once it is smaller than a few pixels (or vertices) so the far sea never aliases.
 * - `'flow'` (rivers): flat geometry with per-vertex `aFlow` (velocity, m/s, x/z) and `aLocal`
 *   (continuous x/z for noise); flow-mapped ripples and foam move downstream.
 *
 * Both share the shading: Fresnel reflection traced in screen space against the scene depth, falling
 * back to the environment or a sky gradient where the ray leaves the frame (and blurring into it as
 * the surface roughens), a GGX sun glint, refraction of the bed through the surface, Beer–Lambert
 * absorption of it by path length with a scattering tint, and foam where the water breaks: whitecaps
 * where the wave Jacobian says the surface is being squeezed to a break (with a short-lived trail
 * behind them), shoreline foam concentrated in the shallow band, and contact foam where geometry
 * (banks, rocks, hulls) stands in front of the surface. The surface's coverage fades out over the last
 * few centimetres of depth, so the waterline blends into the bed instead of stair-stepping, and every
 * procedural mask (foam, whitecaps, rapids, ripples) is filtered by its own screen-space change so it
 * cannot alias at a grazing angle or with distance.
 */
export function createWaterMaterial(
  u: WaterUniforms,
  kind: 'waves' | 'flow',
  environment: Texture | null = null,
  prepass: WaterPrepass | null = null
): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({ side: FrontSide })
  material.transparent = true // draw after opaque geometry, so the depth and colour behind are available
  material.depthWrite = true
  material.name = kind === 'waves' ? 'Water (waves)' : 'Water (flow)'
  // A scene prepass (optional) makes the scene's depth, view-space normals and colour available on
  // the material for shading that wants it. The shading below keeps the renderer's own full-resolution
  // depth and colour readback (so the shoreline never coarsens and attaching a pass never changes the look).
  material.userData.prepass = prepass

  const vP = varyingProperty('vec2', 'vWaterP')
  if (kind === 'waves') {
    material.positionNode = Fn(() => {
      const local = positionGeometry.xz.mul(u.gridScale)
      const d = length(local)
      const dc = min(d, u.maxArc)
      const p = local.mul(dc.div(max(d, 1e-9))).toVar()
      vP.assign(p)
      const spacing = max(u.gridMinSpacing, dc.mul(u.gridAngle))
      const dx = float(0).toVar(),
        dy = float(0).toVar(),
        dz = float(0).toVar()
      Loop({ start: int(0), end: u.waveCount, type: 'int', condition: '<' }, ({ i }: any) => {
        const a = u.waveA.element(i) as any
        const b = u.waveB.element(i) as any
        const fade = smoothstep(2, 4, float(TAU).div(a.z.mul(spacing)))
        const ph = dot(a.xy, p).mul(a.z).add(b.y)
        const c = cos(ph).mul(b.x).mul(fade)
        dx.addAssign(a.x.mul(c))
        dz.addAssign(a.y.mul(c))
        dy.addAssign(a.w.mul(sin(ph)).mul(fade))
      })
      // Bend onto the sphere. For small angles the series keep float32 exact (R·sinθ and R(1 − cosθ)
      // would lose metres to cancellation on an Earth-sized planet).
      const q = p.add(vec2(dx, dz))
      const r = max(length(q), 1e-9)
      const th = r.div(u.radius)
      const th2 = th.mul(th)
      const small = th.lessThan(0.3)
      const across = select(small, r.mul(float(1).sub(th2.div(6)).add(th2.mul(th2).div(120))), u.radius.mul(sin(th)))
      const drop = select(
        small,
        r.mul(th).mul(float(0.5).sub(th2.div(24)).add(th2.mul(th2).div(720))),
        u.radius.mul(float(1).sub(cos(th)))
      )
      const dir = q.div(r)
      const sinT = across.div(u.radius)
      const up = vec3(dir.x.mul(sinT), cos(th), dir.y.mul(sinT))
      return vec3(dir.x.mul(across), drop.negate(), dir.y.mul(across)).add(up.mul(dy.add(positionGeometry.y)))
    })()
  }

  const aFlow = kind === 'flow' ? varying(attribute('aFlow', 'vec2')) : null
  const aLocal = kind === 'flow' ? varying(attribute('aLocal', 'vec2')) : null

  material.colorNode = Fn(() => {
    const p = (kind === 'waves' ? vP : aLocal!) as any
    const upModel = kind === 'waves' ? tilt(vec3(0, 1, 0), p, u.radius) : vec3(0, 1, 0)
    const U = normalize(modelWorldMatrix.mul(vec4(upModel, 0)).xyz)
    const V = normalize(cameraPosition.sub(positionWorld))
    const dist = length(positionView)
    // Metres per pixel along the surface, from the screen derivative of the surface coordinate:
    // exact at grazing angles (a distance estimate flattens out there) and with distance. Every
    // procedural mask below is filtered by this so it cannot alias.
    const dp = fwidth(p) as any
    const footprint = max(max(dp.x, dp.y), 1e-4)
    // Keep a feature only while it spans several pixels (shading is nonlinear, so 2 is not enough).
    const keep = (wavelength: any) => smoothstep(3, 7, wavelength.div(footprint))
    // Anti-aliased half-width of a mask threshold: never changes over less than ~2 px. Mirrors `antiAlias`.
    const aa = (base: any, change: any) => max(base, change.mul(2))
    const nx = float(0).toVar(),
      ny = float(1).toVar(),
      nz = float(0).toVar()
    const lost = float(0).toVar() // slope variance of detail too small to draw → extra roughness
    const surfaceFoam = float(0).toVar()

    if (kind === 'waves') {
      // Jacobian of the Gerstner displacement: 1 on flat water, → 0 as a crest folds over. Repeating
      // it one foam lifetime ago gives the trail that fades behind a breaking crest.
      const jxx = float(1).toVar(),
        jxz = float(0).toVar(),
        jzz = float(1).toVar()
      const oxx = float(1).toVar(),
        oxz = float(0).toVar(),
        ozz = float(1).toVar()
      Loop({ start: int(0), end: u.waveCount, type: 'int', condition: '<' }, ({ i }: any) => {
        const a = u.waveA.element(i) as any
        const b = u.waveB.element(i) as any
        const fade = keep(float(TAU).div(a.z))
        const ph = dot(a.xy, p).mul(a.z).add(b.y)
        const s = sin(ph),
          c = cos(ph)
        const ka = a.z.mul(a.w)
        nx.subAssign(a.x.mul(ka).mul(c).mul(fade))
        nz.subAssign(a.y.mul(ka).mul(c).mul(fade))
        const kc = a.z.mul(b.x).mul(s).mul(fade)
        ny.subAssign(kc)
        lost.addAssign(ka.mul(ka).mul(float(1).sub(fade)))
        const wk = a.z.mul(b.x).mul(fade)
        const cur = wk.mul(s),
          prev = wk.mul(sin(ph.add(b.z.mul(FOAM_LIFETIME))))
        jxx.subAssign(cur.mul(a.x.mul(a.x)))
        jxz.subAssign(cur.mul(a.x).mul(a.y))
        jzz.subAssign(cur.mul(a.y.mul(a.y)))
        oxx.subAssign(prev.mul(a.x.mul(a.x)))
        oxz.subAssign(prev.mul(a.x).mul(a.y))
        ozz.subAssign(prev.mul(a.y.mul(a.y)))
      })
      // Ripples: two drifting, slowly evolving noise layers.
      const drift = u.detailDirection.mul(u.time.mul(u.detailSpeed))
      const n1 = mx_noise_vec3(vec3(p.add(drift).div(u.detailScale), u.time.mul(0.15)))
      const n2 = mx_noise_vec3(vec3(p.sub(drift.mul(0.6)).div(u.detailScale.mul(0.43)), u.time.mul(0.23).add(7.1)))
      const f1 = keep(u.detailScale),
        f2 = keep(u.detailScale.mul(0.43))
      const ripple = n1.xy
        .mul(f1)
        .add(n2.xy.mul(f2.mul(0.5)))
        .mul(u.detail)
      nx.addAssign(ripple.x)
      nz.addAssign(ripple.y)
      lost.addAssign(
        u.detail
          .mul(u.detail)
          .mul(float(2).sub(f1).sub(f2.mul(0.5)))
          .mul(0.1)
      )
      // Whitecaps: only where the surface is squeezed past the whitecap threshold. The noise warps the
      // threshold (not the foam) at a scale well below the crests, so crests break into ragged patches
      // instead of a per-pixel speckle, and the mask one lifetime ago leaves a fading trail.
      const fold = float(1).sub(jxx.mul(jzz).sub(jxz.mul(jxz)))
      const older = float(1).sub(oxx.mul(ozz).sub(oxz.mul(oxz)))
      const breakup = mx_noise_float(vec3(p.div(u.detailScale.mul(3)), u.time.mul(0.25)))
        .mul(keep(u.detailScale.mul(3)))
        .mul(0.05)
      const cut = float(0.08).add(float(1).sub(u.whitecaps).mul(0.28))
      // Widen the threshold upward only: anti-aliasing can make a crest fade in over a pixel or two,
      // but it can never make foam appear where the surface is not being squeezed.
      const foldAA = min(aa(0.06, fwidth(fold) as any), 0.25)
      const whitecap = smoothstep(cut, cut.add(foldAA.mul(2)), fold.add(breakup))
        .mul(smoothstep(0.12, 0.4, u.crest)) // calm water cannot whitecap
        .mul(smoothstep(0, 0.02, u.whitecaps))
      const whitecapOlder = smoothstep(cut, cut.add(foldAA.mul(2)), older.add(breakup))
        .mul(smoothstep(0.12, 0.4, u.crest))
        .mul(smoothstep(0, 0.02, u.whitecaps))
      surfaceFoam.assign(max(whitecap, whitecapOlder.mul(FOAM_DECAY)))
    } else {
      // Flow map: two noise layers advected downstream, half a cycle apart, cross-faded so neither
      // stretches too far before it resets.
      const flow = aFlow! as any
      const t0 = fract(u.time.div(u.flowPeriod))
      const t1 = fract(u.time.div(u.flowPeriod).add(0.5))
      const w0 = float(1).sub(abs(t0.mul(2).sub(1)))
      const f1 = keep(u.detailScale),
        f2 = keep(u.detailScale.div(2.3))
      const layer = (t: any, offset: number) => {
        const q = p
          .sub(flow.mul(t.mul(u.flowPeriod)))
          .div(u.detailScale)
          .add(offset)
        return mx_noise_vec3(vec3(q, 0.0))
          .xy.mul(f1)
          .add(mx_noise_vec3(vec3(q.mul(2.3), 3.7)).xy.mul(f2.mul(0.5)))
      }
      const strength = u.detail.mul(float(1).add(length(flow).mul(0.3)))
      const ripple = mix(layer(t1, 17.3), layer(t0, 0), w0).mul(strength)
      nx.addAssign(ripple.x)
      nz.addAssign(ripple.y)
      lost.addAssign(
        strength
          .mul(strength)
          .mul(float(2).sub(f1).sub(f2.mul(0.5)))
          .mul(0.1)
      )
      // Rapids: foam streaks where the water runs fast. The streak is filtered out once it is
      // sub-pixel (keep), and its threshold is widened by its screen derivative before that.
      const streak = mix(
        mx_noise_float(vec3(p.sub(flow.mul(t1.mul(u.flowPeriod))).div(u.detailScale.mul(1.7)), 1.3)),
        mx_noise_float(vec3(p.sub(flow.mul(t0.mul(u.flowPeriod))).div(u.detailScale.mul(1.7)), 1.3)),
        w0
      )
      const streakAA = aa(0.25, fwidth(streak) as any)
      surfaceFoam.assign(
        smoothstep(u.rapids, u.rapids.mul(1.8), length(flow))
          .mul(smoothstep(float(0.15).sub(streakAA), float(0.15).add(streakAA), streak))
          .mul(keep(u.detailScale.mul(1.7)))
      )
    }

    // Tangent-plane normal → model space (bent onto the sphere for oceans) → world.
    const nTangent = normalize(vec3(nx, ny, nz))
    const nModel = kind === 'waves' ? tilt(nTangent, p, u.radius) : nTangent
    const N = normalize(modelWorldMatrix.mul(vec4(nModel, 0)).xyz)
    const NdotV = max(dot(N, V), 1e-3)
    const L = u.sunDirection
    const sunUp = dot(L, U)
    const day = smoothstep(-0.12, 0.35, sunUp).mul(0.85).add(0.15)
    const rough = min(sqrt(u.roughness.mul(u.roughness).add(lost.mul(0.5))), 1)

    // Reflection: environment map, or a sky gradient around the local up.
    const R = reflect(V.negate(), N)
    const skyGradient = mix(u.horizonColor, u.skyColor, smoothstep(0, 0.45, max(dot(R, U), 0))).mul(day)
    const sky = environment ? pmremTexture(environment, R, rough).rgb.mul(u.environmentIntensity) : skyGradient
    const F = u.reflectivity.add(
      float(1)
        .sub(u.reflectivity)
        .mul(pow(float(1).sub(NdotV), 5))
    )

    // Screen-space reflection: march the mirrored view ray against the prepass depth and read the
    // scene colour where it crosses. It needs the prepass (same frame, water excluded, and the depth
    // of what the ray crosses); without one the reflection is the environment/sky only. A ray that
    // leaves the frame, finds nothing, or crosses something below the surface (the bed) falls back to
    // the environment/sky, and rough water blends into it.
    let reflection = sky as any
    if (prepass) {
      const mirrored = normalize(cameraViewMatrix.mul(vec4(R, 0)).xyz).toVar()
      const rayEnd = positionView.add(mirrored.mul(float(REFLECTION_REACH))).toVar()
      If(rayEnd.z.greaterThan(cameraNear.negate()), () => {
        // A ray coming back towards the camera stops at the near plane.
        rayEnd.assign(
          positionView.add(mirrored.mul(cameraNear.negate().sub(positionView.z).div(max(mirrored.z, 1e-6))))
        )
      })
      const rayEndUv = getScreenPosition(rayEnd, cameraProjectionMatrix).toVar()
      // View-space z at ray parameter s ∈ [0, 1]; in perspective it is linear in 1/z.
      const invStartZ = float(1).div(positionView.z)
      const invEndZ = float(1).div(rayEnd.z)
      const hit = bool(false).toVar()
      const hitUv = vec2(0).toVar()
      const from = float(0).toVar(),
        to = float(1).toVar()
      Loop({ start: int(1), end: int(REFLECTION_STEPS + 1), type: 'int', condition: '<' }, ({ i }: any) => {
        // Denser steps near the surface: near objects are what a reflection shows first.
        const s = pow(float(i).div(REFLECTION_STEPS), 2).toVar()
        const uv = mix(screenUV, rayEndUv, s).toVar()
        If(uv.x.lessThan(0).or(uv.x.greaterThan(1)).or(uv.y.lessThan(0)).or(uv.y.greaterThan(1)), () => Break())
        const rayZ = float(1)
          .div(invStartZ.add(s.mul(invEndZ.sub(invStartZ))))
          .toVar()
        // Depth is negative in front of the camera: the ray is behind the scene once it is more negative.
        If(rayZ.lessThanEqual(prepass.viewZ(uv)), () => {
          from.assign(pow(float(i).sub(1).div(REFLECTION_STEPS), 2))
          to.assign(s)
          hit.assign(true)
          hitUv.assign(uv)
          Break()
        })
      })
      // Bisect the bracket so the reflection lands on the object's edge, not the nearest whole step.
      If(hit, () => {
        Loop({ start: int(0), end: int(4), type: 'int', condition: '<' }, () => {
          const s = from.add(to).mul(0.5).toVar()
          const midUv = mix(screenUV, rayEndUv, s).toVar()
          const rayZ = float(1)
            .div(invStartZ.add(s.mul(invEndZ.sub(invStartZ))))
            .toVar()
          const crossed = rayZ.lessThanEqual(prepass.viewZ(midUv))
          to.assign(select(crossed, s, to))
          hitUv.assign(select(crossed, midUv, hitUv))
          from.assign(select(crossed, from, s))
        })
      })
      // Water reflects the air hemisphere only: a hit below the surface is the bed seen through the
      // water, not a reflection (the depth buffer has no water in it, so a ray passing above the
      // bed still "crosses" it). Reconstruct the hit and fade it out towards the surface plane, so
      // marginal hits do not speckle.
      const hitPos = getViewPosition(hitUv, prepass.depth(hitUv), cameraProjectionMatrixInverse)
      const above = dot(hitPos.sub(positionView), cameraViewMatrix.mul(vec4(U, 0)).xyz)
      // Weight by height above the water, distance to the frame's edge and roughness: a hit can
      // never pop against the environment, and rough water blurs into it.
      const edge = max(min(min(hitUv.x, float(1).sub(hitUv.x)), min(hitUv.y, float(1).sub(hitUv.y))), 0)
      const weight = max(smoothstep(0, 0.08, above), 0)
        .mul(smoothstep(0, 0.08, edge))
        .mul(smoothstep(0.08, 0.45, rough).oneMinus())
      const traced = select(hit, weight, float(0))
      reflection = mix(sky, prepass.colour(hitUv), traced)
    }

    // Sun glint: GGX distribution with Schlick Fresnel.
    const H = normalize(L.add(V))
    const NdotH = max(dot(N, H), 0)
    const a2 = rough.mul(rough).mul(rough).mul(rough).max(1e-6)
    const denom = NdotH.mul(NdotH).mul(a2.sub(1)).add(1)
    const D = a2.div(denom.mul(denom).mul(Math.PI))
    const Fh = u.reflectivity.add(
      float(1)
        .sub(u.reflectivity)
        .mul(pow(float(1).sub(max(dot(H, V), 0)), 5))
    )
    const glint = u.sunColor
      .mul(
        D.mul(Fh)
          .mul(max(dot(N, L), 0))
          .div(NdotV.mul(4))
          .mul(u.specular)
      )
      .mul(smoothstep(-0.02, 0.05, sunUp))

    // What is behind the surface: refract, but never pick up things in front of the water. View-space
    // z is negative in front of the camera, so a sample is behind the surface when it is more negative.
    const viewZ = positionView.z
    const bend = cameraViewMatrix.mul(vec4(N.sub(U), 0)).xy
    const offset = vec2(bend.x, bend.y.negate())
      .mul(u.refraction)
      .mul(min(float(1), float(10).div(dist)))
    const refractedUv = screenUV.add(offset)
    const refractedZ = sceneViewZ(refractedUv)
    const ownZ = sceneViewZ(screenUV)
    const useRefracted = refractedZ.lessThan(viewZ)
    const uv = select(useRefracted, refractedUv, screenUV)
    const sceneZ = select(useRefracted, refractedZ, ownZ)
    // A depth read in front of the surface is the bed at the waterline, read a fraction of a pixel off
    // (the depth buffer is coarser than the surface's own interpolated z), not an occluder: the water
    // there has no thickness. Clamping the read to the surface lets the thickness cross zero
    // continuously. Treating it as 10 km of water instead made that crossing a hard per-pixel switch —
    // wherever the bed is within the depth buffer's resolution of the surface, a dashed ring.
    const path = max(dist.mul(min(sceneZ, viewZ).div(viewZ).sub(1)), 0)
    // The shoreline stays on the full-resolution depth, so it does not coarsen.
    const depth = path.mul(max(dot(V, U), 0.02)) // ≈ vertical water depth
    const behind = viewportSharedTexture(uv).rgb
    // Beer–Lambert: each channel keeps exp(−σ·path) of the bed (red first), and the rest is light
    // scattered back out of the water body, so shallows show the bed tinted and deep water is scatter.
    const transmit = exp(path.negate().mul(u.absorption))
    const body = behind.mul(transmit).add(u.scatterColor.mul(day).mul(float(1).sub(transmit)))

    // Shoreline: the surface's coverage fades out over a depth band that is never thinner than a
    // couple of pixels of the depth buffer's own change across a pixel. The water/bed crossing is a
    // depth-test boundary, which MSAA does not anti-alias; fading alpha there is what makes the
    // waterline soft instead of stair-stepped, at any distance or grazing angle.
    const depthStep = fwidth(depth) as any
    const band = aa(u.foamWidth.mul(0.15), depthStep)
    const coverage = smoothstep(0, band, depth)
    // Shore foam: full at the waterline, gone by `foamWidth` of depth, broken up by a noise field and
    // lapping in and out with time. Its outer edge is widened by its own screen-space change so it
    // cannot alias; the noise only thins the foam, it never pushes it out into open water.
    const foamNoise = mx_noise_float(vec3(p.div(u.detailScale.mul(0.8)), u.time.mul(0.3)))
      .mul(keep(u.detailScale.mul(0.8)))
      .mul(0.5)
      .add(0.5)
    const levels = depth.div(u.foamWidth)
    const lap = sin(u.time.mul(1.3).sub(levels.mul(5)))
      .mul(0.12)
      .mul(smoothstep(0.1, 0.5, levels))
    const levelAA = min(aa(0.1, fwidth(levels) as any), 0.35)
    // Foam belongs to a bank, not a thin sheet over near-flat ground: require the bed to rise about
    // 0.5 … 3% across the surface, so a shallow flat shelf stays clear instead of foaming all over.
    const bank = smoothstep(0.005, 0.03, depthStep.div(max(footprint, 1e-4)))
    const shore = float(1)
      .sub(smoothstep(float(0.15).add(lap).sub(levelAA), float(1).add(lap).add(levelAA), levels))
      .mul(mix(0.55, 1, foamNoise))
      .mul(bank)
    // Contact foam: where geometry stands in front of the surface — banks, rocks, hulls — a few pixels
    // of foam gather. Obstacles reach the water only through the depth buffer, so this is what keeps
    // the waterline marked and puts foam around a hull instead of spreading it over the whole shelf.
    const pixel = fwidth(screenUV) as any
    const contact = float(0).toVar()
    for (const [tx, ty, weight] of CONTACT_TAPS) {
      const front = sceneViewZ(screenUV.add(pixel.mul(vec2(tx, ty)))).sub(viewZ)
      contact.assign(max(contact, smoothstep(0.02, 0.25, front).mul(weight)))
    }
    const contactFoam = contact.mul(mix(0.45, 1, foamNoise))
    const foam = max(max(shore, contactFoam), surfaceFoam).mul(u.foam).clamp(0, 1)

    const lit = mix(body, reflection, F.mul(coverage)).add(glint.mul(coverage))
    return vec4(mix(lit, u.foamColor.mul(day), foam), coverage)
  })()

  return material
}
