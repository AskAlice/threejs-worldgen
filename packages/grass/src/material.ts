import { Color, DataTexture, DoubleSide, MeshPhysicalNodeMaterial, Vector2, Vector3, Vector4, type Node } from 'three/webgpu'
import {
  Discard, Fn, Loop, abs, atan, attribute, cameraPosition, clamp, color, cos, dot, faceDirection, float, floor, fract, hash, int, length, max, min, mix, sign,
  modelWorldMatrix, mx_noise_float, normalize, positionGeometry, positionWorld, pow, sin, smoothstep, sqrt, step,
  texture, time, transformNormalToView, uniform, uniformArray, uv, varying, varyingProperty, vec2, vec3, vec4,
} from 'three/tsl'

/** Maximum number of simultaneous {@link Interactor}s. Extra ones are ignored. */
export const MAX_INTERACTORS = 16

/** Neutral grass map: full coverage (R=1), default height (G=0.5 → 1x). */
const neutralMap = new DataTexture(new Uint8Array([255, 128, 0, 255]), 1, 1)
neutralMap.needsUpdate = true

/**
 * Creates the uniform set shared by a Grass field's materials. Grass calls this for you and drives the
 * values from `Grass.set()`; it is exported so the {@link GrassUniforms} type is documented in full.
 */
export function createGrassUniforms() {
  return {
    /** Blade colour at the root (from `baseColor`). */
    baseColor: uniform(new Color()),
    /** Blade colour at the tip (from `tipColor`). */
    tipColor: uniform(new Color()),
    /** Per-blade brightness variation, 0..1. */
    colorVariation: uniform(0),
    /** Field-scale light/dark and dry patches, 0..1. */
    patchiness: uniform(0),
    /** Back-lit glow strength. */
    translucency: uniform(0),
    /** Blade height in metres. */
    bladeHeight: uniform(0),
    /** Blade base width in metres. */
    bladeWidth: uniform(0),
    /** Natural droop, 0..1. */
    curvature: uniform(0),
    /** Resistance to wind and interaction (never below 0.05). */
    stiffness: uniform(1),
    /** Normalised XZ wind direction. */
    windDirection: uniform(new Vector2(1, 0)),
    /** How far blades bend in the wind. */
    windStrength: uniform(0),
    /** Gust noise frequency (1/metres). */
    windScale: uniform(0),
    /** Gust travel speed. */
    windSpeed: uniform(0),
    /** The four LOD distances (x, y, z, w = LOD 0..3). */
    lodDistances: uniform(new Vector4()),
    /** The four LOD density fractions (x, y, z, w = LOD 0..3). */
    lodDensities: uniform(new Vector4(1, 1, 1, 1)),
    /** Radius with grass; blades fade over its last 15%. */
    maxDistance: uniform(0),
    /** 1 tints grass by LOD, 0 = normal shading. */
    debugLods: uniform(0),
    /** Position LOD/fades are measured from. Set from the Grass camera on the CPU so shadow passes
     *  (which render from the light) see exactly the same blades as the main view. */
    viewPosition: uniform(new Vector3()),
    /** Direction *towards* the sun. Drives back-lit translucency. */
    sunDirection: uniform(new Vector3(0.4, 0.8, 0.3).normalize()),
    /** Sun colour × intensity. */
    sunColor: uniform(new Color(1, 1, 1)),
    /** minX, minZ, sizeX, sizeZ of the grass map in world space. */
    mapBounds: uniform(new Vector4(-1e6, -1e6, 2e6, 2e6)),
    /** Grass map texture (R = coverage, G = height); a neutral 1×1 texture when there is none. */
    map: texture(neutralMap),
    /** Global multiplier on interactor push. */
    interactionStrength: uniform(1),
    /** xyz = world position, w = radius (0 = unused slot). */
    interactors: uniformArray(Array.from({ length: MAX_INTERACTORS }, () => new Vector4()), 'vec4'),
    /** Number of active entries in `interactors`. */
    interactorCount: uniform(0, 'int'),
  }
}

/** Shader uniforms of a Grass field (`grass.uniforms`). Each entry is a TSL uniform/texture node. */
export type GrassUniforms = ReturnType<typeof createGrassUniforms>

/** TSL nodes returned by `grass.mapNode()`. */
export interface GrassMapSample {
  /** 0 = no grass, 1 = full coverage. 1 outside the map. */
  coverage: Node<'float'>
  /** Height multiplier, 0..2 (1 = preset height). 1 outside the map. */
  height: Node<'float'>
}

/**
 * Samples the grass map at a world XZ position. Outside the map: full coverage, 1x height.
 * Usable in any material — e.g. to show dirt on terrain where grass was erased.
 */
export function sampleGrassMap(u: GrassUniforms, worldXZ: Node<'vec2'>, vertexStage = false): GrassMapSample {
  const mapUv = worldXZ.sub(u.mapBounds.xy).div(u.mapBounds.zw)
  const inMap = step(0, mapUv.x).mul(step(mapUv.x, 1)).mul(step(0, mapUv.y)).mul(step(mapUv.y, 1))
  const s = vertexStage ? u.map.sample(mapUv).level(float(0)) : u.map.sample(mapUv)
  return { coverage: mix(float(1), s.r, inMap), height: mix(float(1), s.g.mul(2), inMap) }
}

/** Wind uniforms shared by grass and corn. */
export type WindUniforms = Pick<GrassUniforms, 'windDirection' | 'windScale' | 'windSpeed'>

/**
 * Wind at a world XZ position: `gust` (0..1) and a sideways `swirl` (XZ). Every vertex evaluates this, so it is
 * one noise call plus cheap trigonometry:
 * - gusts: domain-warped scrolling noise, shaped so calm troughs separate distinct gust fronts
 * - a travelling ripple along the wind direction
 * - sideways swirl, so fields don't sway in lockstep
 */
export function windGust(u: WindUniforms, xz: Node<'vec2'>) {
  const windUv0 = xz.mul(u.windScale).sub(u.windDirection.mul(time.mul(u.windSpeed)))
  const warp = vec2(sin(windUv0.y.mul(1.7).add(time.mul(0.23))), sin(windUv0.x.mul(1.3).sub(time.mul(0.31)))).mul(0.35)
  const gustNoise = mx_noise_float(windUv0.add(warp))
  const ripple = sin(dot(xz, u.windDirection).mul(u.windScale.mul(9)).sub(time.mul(u.windSpeed).mul(5)))
  const gust = clamp(smoothstep(-0.25, 0.7, gustNoise).mul(0.8).add(ripple.mul(0.2)).add(0.1), 0, 1)
  const across = vec2(u.windDirection.y.negate(), u.windDirection.x)
  const swirl = across.mul(sin(dot(xz, across).mul(u.windScale.mul(6)).add(time.mul(u.windSpeed).mul(1.7)).add(gustNoise.mul(3))).mul(0.25).mul(gust))
  return { gust, swirl }
}

const LOD_COLORS =[new Color('#ff4d4d'), new Color('#ffd23f'), new Color('#4dd96b'), new Color('#4da6ff')]

/**
 * One material, two shapes:
 *  - blades: tapered strips, yaw baked per instance
 *  - billboards: view-facing quads cut into a clump of strands in the fragment shader
 *
 * Instance attributes (filled by Grass tiles):
 *  aOffset = (x, y, z) local to tile, w = yaw
 *  aParams = heightScale, widthScale, rank (0..1, LOD thinning order), seed (0..1)
 *  aPatch  = field-scale brightness, dryness and flow-field noise (static, so baked on the CPU instead of per vertex)
 */
export function createGrassMaterial(u: GrassUniforms, billboard: boolean) {
  const aOffset = attribute('aOffset', 'vec4')
  const aParams = attribute('aParams', 'vec4')
  const aPatch = attribute('aPatch', 'vec3')
  const seed = aParams.w
  const t = positionGeometry.y // 0 at root, 1 at tip

  const root = modelWorldMatrix.mul(vec4(aOffset.xyz, 1)).xyz
  const toView = u.viewPosition.xz.sub(root.xz)
  const dist = length(toView)

  // Density fraction, piecewise-linear across the 4 LOD distances. Continuous in distance,
  // so thinning happens blade-by-blade instead of popping at tile boundaries.
  const d = u.lodDistances
  const k = u.lodDensities
  const seg = (a: any, b: any) => dist.sub(a).div(max(b.sub(a), 1e-3)).clamp(0, 1)
  const density = mix(mix(mix(k.x, k.y, seg(d.x, d.y)), k.z, seg(d.y, d.z)), k.w, seg(d.z, d.w))
  const thin = float(1).sub(smoothstep(density.mul(0.75), density, aParams.z))
  const widthCompensation = density.max(0.02).sqrt().reciprocal() // fewer blades → wider blades, same coverage
  const lodIndex = step(d.y, dist).add(step(d.z, dist)).add(step(d.w, dist))

  // Grass map: R = coverage, G = height. Blades thin out *and* shorten towards map edges,
  // so painted borders look like grass growing out rather than a hard cut.
  const map = sampleGrassMap(u, root.xz, true)
  const covered = float(1).sub(smoothstep(map.coverage.sub(0.08), map.coverage, fract(seed.mul(13.37))))
  const edgeTaper = mix(float(0.3), float(1), smoothstep(0, 0.75, map.coverage))

  const distanceFade = float(1).sub(smoothstep(u.maxDistance.mul(0.85), u.maxDistance, dist))
  const fade = thin.mul(covered).mul(distanceFade)

  const height = u.bladeHeight.mul(aParams.x).mul(map.height).mul(edgeTaper).mul(fade)
  const width = billboard
    ? u.bladeHeight.mul(1.4).mul(aParams.y).mul(widthCompensation).mul(fade)
    : u.bladeWidth.mul(aParams.y).mul(widthCompensation).mul(fade)

  const yaw = billboard ? atan(toView.x, toView.y) : aOffset.w
  const facing = vec2(sin(yaw), cos(yaw))
  // Blades twist a little along their length, so each catches light differently from root to tip.
  const twistedYaw = billboard ? yaw : yaw.add(fract(seed.mul(3.7)).sub(0.5).mul(1.6).mul(t))
  const facingT = vec2(sin(twistedYaw), cos(twistedYaw))
  const sideT = vec2(cos(twistedYaw), sin(twistedYaw).negate())

  const { gust, swirl } = windGust(u, root.xz)

  const interaction = Fn(() => {
    const push = vec2(0).toVar()
    Loop({ start: int(0), end: u.interactorCount, type: 'int', condition: '<' }, ({ i }) => {
      const it = u.interactors.element(i) as any
      const radius = max(it.w, 1e-4)
      const delta = root.xz.sub(it.xz)
      const falloff = float(1).sub(smoothstep(radius.mul(0.35), radius, length(delta)))
      const gate = step(1e-4, it.w).mul(float(1).sub(smoothstep(radius, radius.mul(2), abs(root.y.sub(it.y)))))
      push.addAssign(normalize(delta.add(1e-5)).mul(falloff.mul(gate)))
    })
    return push.mul(u.interactionStrength)
  })

  // How far (0..0.97) and which way each blade's tip is bent; shared by position and normals.
  const r = fract(seed.mul(7.1))
  // Blades lie along a meandering flow field (brushed swirls), which the prevailing wind
  // pulls further downwind the stronger it blows.
  const flowAngle = aPatch.z.mul(1.6)
  const flowDir = vec2(
    u.windDirection.x.mul(cos(flowAngle)).sub(u.windDirection.y.mul(sin(flowAngle))),
    u.windDirection.x.mul(sin(flowAngle)).add(u.windDirection.y.mul(cos(flowAngle))),
  )
  const comb = clamp(u.windStrength.mul(0.6).add(0.35), 0, 0.85)
  const droopDir = normalize(mix(facing, flowDir, comb))
  const droop = droopDir.mul(u.curvature.mul(r.mul(r).mul(1.5).add(0.25))) // most blades stand, a few flop over
  const flutterRate = fract(seed.mul(13.1)).mul(2.5).add(2.5)
  const flutter = sin(time.mul(flutterRate).add(seed.mul(40))).mul(gust.mul(0.1).add(0.05))
  const wind = u.windDirection.mul(gust.add(0.15).add(flutter)).add(swirl).add(facing.mul(flutter.mul(0.5))).mul(u.windStrength)
  const bendVec = Fn(() => droop.add(wind.div(u.stiffness)).add(interaction().mul(2.2)))()

  // Wind, bending and the blade frame are computed once per vertex inside `position` and handed to
  // the fragment stage through these varyings. Deriving separate varyings from the same node graph
  // would make TSL re-evaluate the noise and interactor loop for each of them.
  const vWind = varyingProperty('vec4', 'vGrassWind') // bend direction xz, bend amount, gust
  const vFrame = varyingProperty('vec4', 'vGrassFrame') // facing xz, side xz (twisted)
  const vExtra = varyingProperty('vec2', 'vGrassExtra') // LOD index, farness

  const position = Fn(() => {
    const bend = bendVec.toVar()
    const amount = min(length(bend), 0.97).toVar()
    const bendDir = bend.div(max(length(bend), 1e-4)).toVar()
    vWind.assign(vec4(bendDir, amount, gust))
    vFrame.assign(vec4(facingT, sideT))
    // 0 near, 1 far: per-blade detail fades so the distant field reads as a soft carpet, not noise.
    vExtra.assign(vec2(lodIndex, smoothstep(12, 70, dist)))

    // Bend the tip along `bendDir` while (approximately) preserving blade length.
    const offset = bendDir.mul(amount)
    // Folded blade: the midrib (uv.x = 0.5) sits behind the edges, giving a V cross-section.
    const midrib = float(1).sub(abs(uv().x.mul(2).sub(1)))
    const fold = billboard ? vec2(0) : facingT.mul(midrib.mul(width).mul(-0.22))
    const xz = sideT.mul(positionGeometry.x.mul(width)).add(fold).add(offset.mul(t.mul(t).mul(height)))
    const y = t.mul(height).mul(sqrt(float(1).sub(amount.mul(amount))))
    return aOffset.xyz.add(vec3(xz.x, y, xz.y))
  })

  // Gusts tilt normals downwind, so moving light/dark bands show the wind crossing the field.
  const windTilt = vec3(u.windDirection.x, 0, u.windDirection.y).mul(vWind.w.mul(u.windStrength).mul(0.9))
  const billboardNormal = Fn(() => normalize(vec3(0, 1, 0).add(windTilt)))
  const bladeNormal = Fn(() => {
    // The front face tilts up as the blade bends towards it.
    const facing3 = normalize(vec3(vFrame.x, dot(vFrame.xy, vWind.xy).mul(vWind.z).mul(t).mul(1.5), vFrame.y))
    const side3 = vec3(vFrame.z, 0, vFrame.w)
    // Which half of the fold this pixel is on. Each triangle lies on one side of the midrib,
    // so the interpolated uv.x gives a crisp crease: one half lit, the other in shade.
    const half = sign(uv().x.sub(0.5))
    const folded = normalize(facing3.sub(side3.mul(half.mul(0.6)))).mul(faceDirection)
    // Keep some of the up vector so the field still reads as one surface from a distance.
    return normalize(mix(folded, vec3(0, 1, 0).add(windTilt), 0.4))
  })

  // Static per-blade extras for the fragment stage: large-scale light/dark and dry patches.
  const patches = varying(vec2(aPatch.x, aPatch.y))
  const farness = vExtra.y

  const albedo = Fn(() => {
    let tipT: any = t
    if (billboard) {
      // Cut the quad into a clump of tapered, leaning strands.
      const strands = 17
      const sx = uv().x.mul(strands)
      const id = floor(sx)
      const strandHeight = hash(id.add(seed.mul(1000))).pow(0.6).mul(0.7).add(0.3)
      const lean = hash(id.mul(3.1).add(seed.mul(500))).sub(0.5).mul(2.4)
      const fx = fract(sx).sub(0.5).sub(lean.mul(t))
      const halfWidth = float(0.42).mul(float(1).sub(t.div(strandHeight)).pow(0.8))
      Discard(t.greaterThan(strandHeight).or(abs(fx).greaterThan(halfWidth)))
      tipT = t.div(strandHeight)
    }
    const variation = float(1).add(fract(seed.mul(91.7)).sub(0.5).mul(2).mul(u.colorVariation).mul(float(1).sub(farness)))
    let c: any = mix(u.baseColor, u.tipColor, pow(tipT, 1.2)).mul(variation)
    // Field-scale variation: brighter/darker patches and sun-dried yellowish areas.
    c = c.mul(float(1).add(patches.x.mul(u.patchiness).mul(0.7)))
    c = mix(c, c.mul(vec3(1.3, 1.12, 0.55)), smoothstep(0.05, 0.55, patches.y).mul(u.patchiness))
    // Bent blades catch more sky light.
    c = c.mul(float(1).add(vWind.w.mul(u.windStrength).mul(0.5).mul(tipT)))
    // Dense grass occludes its own base.
    c = c.mul(mix(mix(float(0.32), float(0.7), farness), float(1), smoothstep(0, 0.75, tipT)))
    const i = vExtra.x
    const lodColor = mix(mix(mix(color(LOD_COLORS[0]), color(LOD_COLORS[1]), step(0.5, i)), color(LOD_COLORS[2]), step(1.5, i)), color(LOD_COLORS[3]), step(2.5, i))
    return vec4(mix(c, lodColor.mul(mix(float(0.4), float(1), tipT)), u.debugLods), 1)
  })

  // Thin blades transmit sunlight: glow when looking towards the sun.
  const translucency = Fn(() => {
    const viewDir = normalize(cameraPosition.sub(positionWorld))
    const back = pow(max(dot(viewDir, u.sunDirection.negate()), 0), 4)
    const albedo = mix(u.baseColor, u.tipColor, t)
    return albedo.mul(u.sunColor).mul(back.mul(u.translucency).mul(t.mul(t)).mul(0.45)).mul(float(1).sub(u.debugLods))
  })

  // Physical only for its specular-intensity knob: grass is glossy, but full dielectric Fresnel at grazing
  // angles turns a whole field white when looking towards the sun.
  const material = new MeshPhysicalNodeMaterial({ side: DoubleSide, roughness: 0.5, metalness: 0, specularIntensity: billboard ? 0.18 : 0.24 })
  material.positionNode = position()
  material.normalNode = transformNormalToView(billboard ? billboardNormal() : bladeNormal())
  material.colorNode = albedo()
  material.emissiveNode = translucency()
  material.specularColorNode = mix(u.tipColor, vec3(1), 0.35) // sheen picks up the blade colour
  return material
}
