import { Color, FrontSide, MeshBasicNodeMaterial, Vector2, Vector3, Vector4, type DirectionalLight, type Object3D, type Texture } from 'three/webgpu'
import {
  Fn, Loop, abs, attribute, cameraFar, cameraNear, cameraPosition, cameraViewMatrix, cos, cross, dot, exp, float, fract, int, length,
  logarithmicDepthToViewZ, max, min, mix, modelWorldMatrix, mx_noise_float, mx_noise_vec3, normalize, perspectiveDepthToViewZ, pmremTexture,
  positionGeometry, positionView, positionWorld, pow, reflect, screenSize, screenUV, select, sin, smoothstep, sqrt, uniform, uniformArray,
  varying, varyingProperty, vec2, vec3, vec4, viewportDepthTexture, viewportSharedTexture,
} from 'three/tsl'
import { MAX_WAVES, crestSharpness, type Wave } from './waves.ts'

/** How water looks: colour, clarity, reflections, foam and ripples. Shared by oceans, lakes and rivers. */
export interface WaterAppearance {
  /** Tint of light that crossed shallow water (`#rrggbb`). */
  shallowColor: string
  /** Colour of deep water: what you see where the bottom is out of sight. */
  deepColor: string
  /** Metres of water after which ~63% of the view through it is replaced by `deepColor`. */
  visibility: number
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
  /** Water depth (metres) below which shoreline foam appears. */
  foamWidth: number
  /** 0 … 1 overall foam amount (shoreline, whitecaps and rapids). */
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
  shallowColor: '#8fd8cf',
  deepColor: '#0b3247',
  visibility: 6,
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
  environment: null,
}

/**
 * Creates the uniforms of one water material. Each Ocean, Rivers and Lakes owns a set and drives
 * it from its settings; exported so the {@link WaterUniforms} type is documented in full.
 */
export function createWaterUniforms() {
  return {
    /** `shallowColor`. */
    shallowColor: uniform(new Color()),
    /** `deepColor`. */
    deepColor: uniform(new Color()),
    /** `visibility`, metres. */
    visibility: uniform(1),
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
    waveA: uniformArray(Array.from({ length: MAX_WAVES }, () => new Vector4()), 'vec4'),
    /** Per wave: horizontal amplitude (chop), phase (radians, includes −ωt), unused, unused. */
    waveB: uniformArray(Array.from({ length: MAX_WAVES }, () => new Vector4()), 'vec4'),
    /** Σ k·chop of the waves (normalises whitecaps). */
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
    /** tan(fov / 2) of the camera, for the per-pixel detail fade. */
    tanHalfFov: uniform(0.4),
    /** Seconds per flow-map cycle (rivers). */
    flowPeriod: uniform(2),
  }
}

/** Shader uniforms of a water material. Each entry is a TSL uniform node. */
export type WaterUniforms = ReturnType<typeof createWaterUniforms>

/** Copies the appearance settings into uniforms. */
export function applyAppearance(u: WaterUniforms, a: WaterAppearance): void {
  u.shallowColor.value.set(a.shallowColor)
  u.deepColor.value.set(a.deepColor)
  u.visibility.value = Math.max(1e-3, a.visibility)
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
    if (w) { a[i].set(w.dirX, w.dirZ, w.k, w.amplitude); b[i].set(w.chop, 0, 0, 0) } else { a[i].set(1, 0, 1, 0); b[i].set(0, 0, 0, 0) }
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
export function updateSun(u: WaterUniforms, light: DirectionalLight | null, object: Object3D, cache: { light: DirectionalLight | null; searched: boolean }): DirectionalLight | null {
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
  u.sunDirection.value.copy(_a.setFromMatrixPosition(sun.matrixWorld).sub(_b.setFromMatrixPosition(sun.target.matrixWorld)).normalize())
  u.sunColor.value.copy(sun.color).multiplyScalar(sun.intensity)
  return sun
}

const TAU = Math.PI * 2

/** View-space z of the opaque scene behind a screen position, for plain and logarithmic depth buffers. */
const sceneViewZ = (uv: any) => Fn((builder) => {
  const d = viewportDepthTexture(uv).x
  return builder.renderer.logarithmicDepthBuffer ? logarithmicDepthToViewZ(d, cameraNear, cameraFar) : perspectiveDepthToViewZ(d, cameraNear, cameraFar)
})()

/** Rotates a tangent-plane vector at planar offset `p` onto the sphere of `radius` (identity on flat surfaces). */
const tilt = (v: any, p: any, radius: any) => {
  const r = max(length(p), 1e-9)
  const th = r.div(radius)
  const k = vec3(p.y.div(r), 0, p.x.div(r).negate())
  const c = cos(th), s = sin(th)
  return v.mul(c).add(cross(k, v).mul(s)).add(k.mul(dot(k, v).mul(float(1).sub(c))))
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
 * Both share the shading: Fresnel reflection of the environment or sky, GGX sun glint, refraction of
 * the scene behind, depth-based absorption from shallow to deep colour, and shoreline foam.
 */
export function createWaterMaterial(u: WaterUniforms, kind: 'waves' | 'flow', environment: Texture | null = null): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({ side: FrontSide })
  material.transparent = true // draw after opaque geometry, so the depth and colour behind are available
  material.depthWrite = true
  material.name = kind === 'waves' ? 'Water (waves)' : 'Water (flow)'

  const vP = varyingProperty('vec2', 'vWaterP')
  if (kind === 'waves') {
    material.positionNode = Fn(() => {
      const local = positionGeometry.xz.mul(u.gridScale)
      const d = length(local)
      const dc = min(d, u.maxArc)
      const p = local.mul(dc.div(max(d, 1e-9))).toVar()
      vP.assign(p)
      const spacing = max(u.gridMinSpacing, dc.mul(u.gridAngle))
      const dx = float(0).toVar(), dy = float(0).toVar(), dz = float(0).toVar()
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
      const drop = select(small, r.mul(th).mul(float(0.5).sub(th2.div(24)).add(th2.mul(th2).div(720))), u.radius.mul(float(1).sub(cos(th))))
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
    // Metres per pixel along the surface, stretched at grazing angles, where detail aliases first.
    const footprint = dist.mul(u.tanHalfFov).mul(2).div(screenSize.y).div(max(dot(V, U), 0.12))
    // Keep a feature only while it spans several pixels (shading is nonlinear, so 2 is not enough).
    const keep = (wavelength: any) => smoothstep(3, 7, wavelength.div(footprint))
    const nx = float(0).toVar(), ny = float(1).toVar(), nz = float(0).toVar()
    const lost = float(0).toVar() // slope variance of detail too small to draw → extra roughness
    const surfaceFoam = float(0).toVar()

    if (kind === 'waves') {
      const crest = float(0).toVar()
      Loop({ start: int(0), end: u.waveCount, type: 'int', condition: '<' }, ({ i }: any) => {
        const a = u.waveA.element(i) as any
        const b = u.waveB.element(i) as any
        const fade = keep(float(TAU).div(a.z))
        const ph = dot(a.xy, p).mul(a.z).add(b.y)
        const s = sin(ph), c = cos(ph)
        const ka = a.z.mul(a.w)
        nx.subAssign(a.x.mul(ka).mul(c).mul(fade))
        nz.subAssign(a.y.mul(ka).mul(c).mul(fade))
        const kc = a.z.mul(b.x).mul(s).mul(fade)
        ny.subAssign(kc)
        crest.addAssign(kc)
        lost.addAssign(ka.mul(ka).mul(float(1).sub(fade)))
      })
      // Ripples: two drifting, slowly evolving noise layers.
      const drift = u.detailDirection.mul(u.time.mul(u.detailSpeed))
      const n1 = mx_noise_vec3(vec3(p.add(drift).div(u.detailScale), u.time.mul(0.15)))
      const n2 = mx_noise_vec3(vec3(p.sub(drift.mul(0.6)).div(u.detailScale.mul(0.43)), u.time.mul(0.23).add(7.1)))
      const f1 = keep(u.detailScale), f2 = keep(u.detailScale.mul(0.43))
      const ripple = n1.xy.mul(f1).add(n2.xy.mul(f2.mul(0.5))).mul(u.detail)
      nx.addAssign(ripple.x)
      nz.addAssign(ripple.y)
      lost.addAssign(u.detail.mul(u.detail).mul(float(2).sub(f1).sub(f2.mul(0.5))).mul(0.1))
      // Whitecaps where crests are sharpest, broken up by noise.
      const breakup = mx_noise_float(vec3(p.div(u.detailScale.mul(2.5)), u.time.mul(0.2))).mul(0.35)
      const crestN = crest.div(u.crest).add(breakup)
      surfaceFoam.assign(smoothstep(float(1).sub(u.whitecaps), float(1.15).sub(u.whitecaps), crestN).mul(smoothstep(0, 0.02, u.whitecaps)))
    } else {
      // Flow map: two noise layers advected downstream, half a cycle apart, cross-faded so neither
      // stretches too far before it resets.
      const flow = aFlow! as any
      const t0 = fract(u.time.div(u.flowPeriod))
      const t1 = fract(u.time.div(u.flowPeriod).add(0.5))
      const w0 = float(1).sub(abs(t0.mul(2).sub(1)))
      const f1 = keep(u.detailScale), f2 = keep(u.detailScale.div(2.3))
      const layer = (t: any, offset: number) => {
        const q = p.sub(flow.mul(t.mul(u.flowPeriod))).div(u.detailScale).add(offset)
        return mx_noise_vec3(vec3(q, 0.0)).xy.mul(f1).add(mx_noise_vec3(vec3(q.mul(2.3), 3.7)).xy.mul(f2.mul(0.5)))
      }
      const strength = u.detail.mul(float(1).add(length(flow).mul(0.3)))
      const ripple = mix(layer(t1, 17.3), layer(t0, 0), w0).mul(strength)
      nx.addAssign(ripple.x)
      nz.addAssign(ripple.y)
      lost.addAssign(strength.mul(strength).mul(float(2).sub(f1).sub(f2.mul(0.5))).mul(0.1))
      // Rapids: foam streaks where the water runs fast.
      const streak = mix(mx_noise_float(vec3(p.sub(flow.mul(t1.mul(u.flowPeriod))).div(u.detailScale.mul(1.7)), 1.3)), mx_noise_float(vec3(p.sub(flow.mul(t0.mul(u.flowPeriod))).div(u.detailScale.mul(1.7)), 1.3)), w0)
      surfaceFoam.assign(smoothstep(u.rapids, u.rapids.mul(1.8), length(flow)).mul(smoothstep(-0.1, 0.4, streak)))
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
    const F = u.reflectivity.add(float(1).sub(u.reflectivity).mul(pow(float(1).sub(NdotV), 5)))

    // Sun glint: GGX distribution with Schlick Fresnel.
    const H = normalize(L.add(V))
    const NdotH = max(dot(N, H), 0)
    const a2 = rough.mul(rough).mul(rough).mul(rough).max(1e-6)
    const denom = NdotH.mul(NdotH).mul(a2.sub(1)).add(1)
    const D = a2.div(denom.mul(denom).mul(Math.PI))
    const Fh = u.reflectivity.add(float(1).sub(u.reflectivity).mul(pow(float(1).sub(max(dot(H, V), 0)), 5)))
    const glint = u.sunColor.mul(D.mul(Fh).mul(max(dot(N, L), 0)).div(NdotV.mul(4)).mul(u.specular)).mul(smoothstep(-0.02, 0.05, sunUp))

    // What is behind the surface: refract, but never pick up things in front of the water.
    const viewZ = positionView.z
    const bend = cameraViewMatrix.mul(vec4(N.sub(U), 0)).xy
    const offset = vec2(bend.x, bend.y.negate()).mul(u.refraction).mul(min(float(1), float(10).div(dist)))
    const refractedUv = screenUV.add(offset)
    const uv = select(sceneViewZ(refractedUv).lessThan(viewZ), refractedUv, screenUV)
    const sceneZ = sceneViewZ(uv)
    const path = max(dist.mul(sceneZ.div(viewZ).sub(1)), 0) // metres of water the view ray crosses
    const depth = path.mul(max(dot(V, U), 0.02)) // ≈ vertical water depth
    const behind = viewportSharedTexture(uv).rgb
    const tint = mix(vec3(1), u.shallowColor, float(1).sub(exp(path.mul(-4).div(u.visibility))))
    const body = mix(behind.mul(tint), u.deepColor.mul(day), float(1).sub(exp(path.negate().div(u.visibility))))

    // Shoreline: soft edge, then foam that laps in bands.
    const edge = smoothstep(0, u.foamWidth.mul(0.2), depth)
    const foamNoise = mx_noise_float(vec3(p.div(u.detailScale.mul(0.8)), u.time.mul(0.3))).mul(keep(u.detailScale.mul(0.8)).mul(0.5)).add(0.5)
    const cut = depth.div(u.foamWidth).add(sin(u.time.mul(1.3).sub(depth.div(u.foamWidth).mul(5))).mul(0.12))
    const shore = smoothstep(cut.sub(0.15), cut.add(0.15), foamNoise)
    const foam = max(shore, surfaceFoam).mul(u.foam).clamp(0, 1)

    const lit = mix(body, sky, F.mul(edge)).add(glint.mul(edge))
    return vec4(mix(lit, u.foamColor.mul(day), foam), 1)
  })()

  return material
}
