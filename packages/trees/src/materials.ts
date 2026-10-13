import {
  Color, DataTexture, DoubleSide, LinearFilter, LinearMipmapLinearFilter, MeshStandardNodeMaterial, RepeatWrapping, RGBAFormat, Vector2, Vector3,
  type DirectionalLight, type Node,
} from 'three/webgpu'
import {
  abs, attribute, cameraPosition, cos, cross, dot, float, fract, hue, max, min, mix, mx_fractal_noise_float, mx_noise_float, normalize,
  normalViewGeometry, normalWorld, positionGeometry, positionLocal, positionView, positionWorld, pow, saturation, select, sign, sin, smoothstep, step,
  texture, time, uniform, uv, vec2, vec3, vec4, vertexColor,
} from 'three/tsl'
import { scatterParamsNode, type ImpostorSurface } from 'threejs-scatter'
import { drawLeafImage } from './leaf-texture.ts'
import { DEFAULT_TREE_PARAMS, type LeafShape, type TreeParams } from './species.ts'

/**
 * Uniforms shared by every vegetation and rock material: one wind, one sun and one global weather state. Change them
 * through {@link setTreeEnvironment} (or `.value` directly). A material given its own {@link WeatherInputs} ignores
 * the global weather values it overrides.
 */
export const treeUniforms = {
  /** How far trees sway, 0 = still, 1 = strong wind. */
  windStrength: uniform(0.35),
  /** How fast gusts move. */
  windSpeed: uniform(1),
  /** Normalised XZ direction the wind blows towards. */
  windDirection: uniform(new Vector2(1, 0.3).normalize()),
  /** Direction towards the sun (drives leaf back-lighting). */
  sunDirection: uniform(new Vector3(0.4, 0.8, 0.3).normalize()),
  /** Sun colour × intensity. */
  sunColor: uniform(new Color(1, 1, 1)),
  /** Global wetness 0..1: darker albedo, lower roughness. */
  wetness: uniform(0),
  /** Global snow cover 0..1 on upward-facing surfaces. */
  snow: uniform(0),
  /** Global burn 0..1: charred bark, scorched and missing leaves. */
  burn: uniform(0),
  /** Global damage 0..1: broken branches, missing leaf mass. */
  damage: uniform(0),
}

/** Settings for {@link setTreeEnvironment}. Unspecified fields keep their value. */
export interface TreeEnvironment {
  /** Sway amount, 0 = still, ~0.35 = breeze, 1 = strong wind. */
  windStrength?: number
  /** Gust speed. */
  windSpeed?: number
  /** XZ direction the wind blows towards. */
  windDirection?: [x: number, z: number]
  /** Copies direction, colour and intensity from this light for leaf back-lighting. */
  sun?: DirectionalLight | null
  /** Global wetness, 0..1. */
  wetness?: number
  /** Global snow cover, 0..1. */
  snow?: number
  /** Global burn, 0..1. */
  burn?: number
  /** Global damage, 0..1. */
  damage?: number
}

/** Updates the shared wind, sun and global weather of all vegetation materials. */
export function setTreeEnvironment(env: TreeEnvironment): void {
  const u = treeUniforms
  if (env.windStrength !== undefined) u.windStrength.value = env.windStrength
  if (env.windSpeed !== undefined) u.windSpeed.value = env.windSpeed
  if (env.windDirection) u.windDirection.value.set(...env.windDirection).normalize()
  for (const k of ['wetness', 'snow', 'burn', 'damage'] as const) if (env[k] !== undefined) u[k].value = env[k]!
  if (env.sun) {
    env.sun.updateWorldMatrix(true, false)
    env.sun.target.updateWorldMatrix(true, false)
    u.sunDirection.value.setFromMatrixPosition(env.sun.matrixWorld).sub(new Vector3().setFromMatrixPosition(env.sun.target.matrixWorld)).normalize()
    u.sunColor.value.copy(env.sun.color).multiplyScalar(env.sun.intensity)
  }
}

/**
 * Optional TSL inputs (each a 0..1 float node) that override the global weather uniforms of `treeUniforms` for one
 * material. Pass a `uniform()` to drive it live, or any node: e.g. one sampling a world-space burn mask at
 * `positionWorld`, or one derived from `scatterParamsNode()` (threejs-scatter) for per-instance values.
 */
export interface WeatherInputs {
  /** Rain wetness: darker albedo, lower roughness. */
  wetness?: Node
  /** Snow cover on upward-facing surfaces. */
  snow?: Node
  /** Fire: bark chars black, leaves scorch brown and drop out. */
  burn?: Node
  /** Storm or age damage: side branches break off, leaf mass and fruit thin out. */
  damage?: Node
}

/** Options shared by the bark, leaf, fruit and rock materials. */
export interface MaterialOptions {
  /** Per-material weather inputs; anything left out follows the global `treeUniforms`. */
  weather?: WeatherInputs
}

type Weather = Record<keyof WeatherInputs, any>
function weatherOf(o: MaterialOptions): Weather {
  const u = treeUniforms
  const w = o.weather ?? {}
  return { wetness: w.wetness ?? u.wetness, snow: w.snow ?? u.snow, burn: w.burn ?? u.burn, damage: w.damage ?? u.damage }
}

/** TSL: albedo and roughness after wetness and snow (snow settles where `normal`, world space, faces up). */
function weathered(albedo: any, roughness: number, w: Weather, normal: any = normalWorld) {
  const wet = albedo.mul(mix(float(1), float(0.55), w.wetness))
  const up = normal.y.add(mx_noise_float(positionWorld.mul(1.7)).mul(0.25))
  const cover = smoothstep(0.15, 0.7, up).mul(w.snow).add(w.snow.mul(w.snow).mul(0.3)).clamp(0, 1)
  return {
    color: mix(wet, vec3(0.9, 0.93, 0.97), cover),
    roughness: mix(mix(float(roughness), float(0.3), w.wetness), float(0.65), cover),
  }
}

/**
 * TSL: `color` times the scatter's per-instance brightness tint (`colorVariation`; 1 on a lone mesh). Applied to the
 * base colour, before burn and weather, so char and snow stay untinted (three.js would multiply `instanceColor` in
 * after `colorNode`).
 */
function tinted(color: any): any {
  return color.mul(scatterParamsNode().y)
}

/** TSL: three independent per-instance randoms (stable per scattered instance; constant on a lone mesh). */
function instanceRandoms() {
  const r = scatterParamsNode().z
  return { a: fract(r.mul(91.7).add(0.13)), b: fract(r.mul(37.3).add(0.71)), c: fract(r.mul(53.9).add(0.37)) }
}

/** TSL: per-instance hue / saturation shift (`hueVariation`, `saturationVariation`), scaled by `amount`. */
function varied(color: any, p: TreeParams, amount = 1): any {
  const r = instanceRandoms()
  return saturation(hue(color, r.a.sub(0.5).mul(2 * p.hueVariation * amount)), r.b.sub(0.5).mul(2 * p.saturationVariation * amount).add(1))
}

/**
 * TSL: collapses every vertex of a card / frond / branch whose `cardRandom` (mixed with the instance random) falls
 * below `drop` to one point, so the whole part disappears without alpha testing. Parts with `cardRandom` < 0 (the
 * trunk) never drop.
 */
function dropped(position: any, drop: any): any {
  const card = attribute('cardRandom', 'float')
  const gone = step(0, card).mul(step(fract(card.add(instanceRandoms().c.mul(7.13))), drop))
  return select(gone.greaterThan(0.5), vec3(0, 0, 0), position)
}

/**
 * TSL: wind displacement for a vertex of a plant `height` metres tall. Bends quadratically with height, so the base
 * stays put; phase comes from the (instanced) world position, so whole trees sway coherently and bark and leaves move
 * together. `flutter` adds fast small motion (leaves).
 */
function windOffset(height: number, flutter: number): any {
  const u = treeUniforms
  const h = positionGeometry.y.div(Math.max(height, 0.1)).clamp(0, 1.5)
  const bend = h.mul(h)
  const t = time.mul(u.windSpeed)
  const xz = positionLocal.xz
  const gust = mx_noise_float(vec3(xz.mul(0.015).sub(u.windDirection.mul(t.mul(0.25))), 0)).mul(0.5).add(0.5)
  const wave = sin(t.mul(1.3).sub(dot(xz, u.windDirection).mul(0.2))).mul(0.3)
  const amount = u.windStrength.mul(bend).mul(gust.add(wave)).mul(0.05 * height)
  let offset: any = vec3(u.windDirection.x, 0, u.windDirection.y).mul(amount)
  if (flutter > 0) {
    const g = positionGeometry
    const phase = g.x.mul(7.3).add(g.y.mul(5.1)).add(g.z.mul(6.7))
    offset = offset.add(vec3(sin(t.mul(6.1).add(phase)), sin(t.mul(7.7).add(phase.mul(1.3))).mul(0.6), cos(t.mul(5.3).add(phase))).mul(u.windStrength.mul(flutter).mul(h.min(1))))
  }
  return offset
}

/** TSL: view-space normal perturbed by the screen-space slope of `height` (bump mapping without a texture). */
function bumpedNormal(height: any, strength: number): any {
  const dpdx = positionView.dFdx()
  const dpdy = positionView.dFdy()
  const n = normalViewGeometry
  const r1 = cross(dpdy, n)
  const r2 = cross(n, dpdx)
  const det = dot(dpdx, r1)
  const grad = sign(det).mul(r1.mul(height.dFdx()).add(r2.mul(height.dFdy())))
  return normalize(abs(det).mul(n).sub(grad.mul(strength)))
}

const STILL: TreeParams['kind'][] = ['cactus', 'succulent', 'lilyPad']
const GREEN: TreeParams['kind'][] = ['cactus', 'succulent', 'bamboo', 'lilyPad']

/** TSL: leaves scorch brown, then black, as `burn` rises. */
const scorched = (c: any, w: Weather) => mix(mix(c, vec3(0.22, 0.1, 0.03), smoothstep(0, 0.5, w.burn)), vec3(0.02, 0.018, 0.015), smoothstep(0.5, 1, w.burn))
/** TSL: share of leaf cards the weather removes (on top of the per-instance `densityVariation`). */
const leafLoss = (w: Weather) => w.damage.add(w.burn.mul(0.8))
const CHAR = vec3(0.025, 0.022, 0.02)

/**
 * Bark (and the solid parts of cacti, succulents, bamboo and lily pads): vertex colours from the generator, furrows
 * from seamless cylindrical noise with bump, optional dark birch marks, per-instance colour variation and wind sway.
 * Weather: wet bark darkens and shines, snow settles on top, burn chars it black along the furrows first, damage
 * breaks off side branches.
 */
export function createBarkMaterial(params: Partial<TreeParams> = {}, options: MaterialOptions = {}): MeshStandardNodeMaterial {
  const p = { ...DEFAULT_TREE_PARAMS, ...params }
  const w = weatherOf(options)
  const m = new MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 })
  m.name = 'bark'
  // Noise on the tube's cylinder (cos/sin of u) has no seam where u wraps from 1 to 0.
  const a = uv().x.mul(Math.PI * 2)
  const ring = vec2(cos(a), sin(a))
  const v = uv().y
  const furrows = mx_fractal_noise_float(vec3(ring.mul(1.6), v.mul(2.2)), 3, 2, 0.5).mul(0.5).add(0.5)
  const ridges = smoothstep(0.35, 0.75, furrows)
  let detail: any = mix(float(1 - p.barkContrast * 0.55), float(1), ridges)
  if (p.barkMarks > 0) {
    const marks = smoothstep(0.55, 0.7, mx_noise_float(vec3(ring.mul(1.2), v.mul(14))).mul(0.5).add(0.5))
    detail = detail.mul(float(1).sub(marks.mul(p.barkMarks * 0.75)))
  }
  // Green plants vary like foliage; wood only a little.
  let color: any = tinted(varied(vertexColor().rgb.mul(detail), p, GREEN.includes(p.kind) ? 1 : 0.3))
  color = mix(color, CHAR, smoothstep(furrows.sub(0.3), furrows.add(0.1), w.burn.mul(1.4)))
  const look = weathered(color, 0.92, w)
  m.colorNode = look.color
  m.roughnessNode = look.roughness
  m.normalNode = bumpedNormal(ridges, 0.35 * p.barkContrast)
  const swaying = STILL.includes(p.kind) ? positionLocal : positionLocal.add(windOffset(p.height, 0))
  m.positionNode = dropped(swaying, w.damage.mul(0.45))
  return m
}

/** Options of {@link createLeafMaterial} beyond the tree params. */
export interface LeafMaterialOptions extends MaterialOptions {
  /** Back-lit glow when looking towards the sun through the leaves, 0..1. */
  translucency?: number
  /** Leaf flutter amplitude in metres at full wind. */
  flutter?: number
}

const leafTextures = new Map<LeafShape, DataTexture>()
/**
 * The procedurally drawn card texture for a leaf shape (cached; shared by all leaf materials, never disposed).
 * Alpha is coverage, RGB a grey detail value multiplied by the leaf colour.
 */
export function getLeafTexture(shape: LeafShape): DataTexture {
  let tex = leafTextures.get(shape)
  if (!tex) {
    const { data, size } = drawLeafImage(shape)
    tex = new DataTexture(data, size, size, RGBAFormat)
    tex.wrapS = tex.wrapT = RepeatWrapping
    tex.minFilter = LinearMipmapLinearFilter
    tex.magFilter = LinearFilter
    tex.generateMipmaps = true
    tex.anisotropy = 4
    tex.needsUpdate = true
    leafTextures.set(shape, tex)
  }
  return tex
}

/**
 * Leaves: alpha-tested cards (texture drawn procedurally for `leafShape`), vertex colours with per-card variation,
 * per-instance hue / saturation shift and crown thinning (`densityVariation`), normals that are not flipped on back
 * faces (so a crown shades as one volume), back-lit translucency towards the sun, wind sway plus flutter. Weather:
 * wet leaves darken, snow settles, burn scorches them brown then black and drops them, damage drops leaf mass.
 */
export function createLeafMaterial(params: Partial<TreeParams> = {}, options: LeafMaterialOptions = {}): MeshStandardNodeMaterial {
  const p = { ...DEFAULT_TREE_PARAMS, ...params }
  const u = treeUniforms
  const w = weatherOf(options)
  const m = new MeshStandardNodeMaterial({ side: DoubleSide, roughness: 0.7, metalness: 0 })
  m.name = 'leaves'
  m.alphaTest = 0.5
  const sample = texture(getLeafTexture(p.leafShape === 'none' ? 'broad' : p.leafShape), uv())
  const base = varied(vertexColor().rgb.mul(sample.rgb), p)
  const albedo = scorched(base, w) // untinted: the back-lit glow below never had the instance tint
  const look = weathered(scorched(tinted(base), w), 0.7, w)
  m.colorNode = vec4(look.color, sample.a)
  m.roughnessNode = look.roughness
  m.normalNode = normalViewGeometry
  const viewDir = normalize(cameraPosition.sub(positionWorld))
  const back = pow(max(dot(viewDir, u.sunDirection.negate()), 0), 3)
  m.emissiveNode = albedo.mul(u.sunColor).mul(back.mul(options.translucency ?? 0.5).mul(0.5)).mul(float(1).sub(w.burn))
  const thin = min(instanceRandoms().b.mul(p.densityVariation).add(leafLoss(w)), 1.01)
  m.positionNode = dropped(positionLocal.add(windOffset(p.height, options.flutter ?? Math.min(0.05, p.leafSize * 0.06))), thin)
  return m
}

/**
 * Fruit, berries and flower heads: vertex colours with per-instance hue variation, glossy skin, wind sway. Weather:
 * wet, snow, burn darkens, damage (and burn) drop fruit.
 */
export function createFruitMaterial(params: Partial<TreeParams> = {}, options: MaterialOptions = {}): MeshStandardNodeMaterial {
  const p = { ...DEFAULT_TREE_PARAMS, ...params }
  const w = weatherOf(options)
  const m = new MeshStandardNodeMaterial({ side: DoubleSide, roughness: 0.45, metalness: 0 })
  m.name = 'fruit'
  const look = weathered(mix(tinted(varied(vertexColor().rgb, p)), vec3(0.03, 0.025, 0.02), w.burn), 0.45, w)
  m.colorNode = look.color
  m.roughnessNode = look.roughness
  m.positionNode = dropped(positionLocal.add(windOffset(p.height, 0.01)), w.damage.add(w.burn.mul(0.5)))
  return m
}

/**
 * Rocks: vertex colours with fine noise detail and bump in object space (stable under instancing). Weather: wet,
 * snow on top, burn leaves soot; `damage` has no effect on rock.
 */
export function createRockMaterial(options: MaterialOptions = {}): MeshStandardNodeMaterial {
  const w = weatherOf(options)
  const m = new MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 })
  m.name = 'rock'
  const grain = mx_fractal_noise_float(positionGeometry.mul(3.5), 4, 2, 0.5).mul(0.5).add(0.5)
  const color = tinted(vertexColor().rgb.mul(mix(float(0.8), float(1.12), grain))).mul(float(1).sub(w.burn.mul(0.75)))
  const look = weathered(color, 0.95, w)
  m.colorNode = look.color
  m.roughnessNode = look.roughness
  m.normalNode = bumpedNormal(grain, 0.25)
  return m
}

/** `bakeImpostor` mask for {@link applyImpostorWeather}: a leaf card's `cardRandom` (≥ 0.01) on foliage, 0 elsewhere. */
export function impostorFoliageMask(foliage: boolean): Node<'float'> | number {
  return foliage ? (attribute('cardRandom', 'float').clamp(0, 1).mul(0.99).add(0.01) as any) : 0
}

/**
 * Applies the same weather as the mesh materials to a baked impostor's material (threejs-scatter `bakeImpostor`),
 * in the same order: instance tint, then burn, then wetness and snow, from the same `treeUniforms` (or `weather`
 * inputs), so nothing pops at the mesh-to-impostor switch. Snow settles by the baked normal; with a foliage mask
 * ({@link impostorFoliageMask}) burn scorches leaves and chars bark separately, and burn and damage drop leaf cards.
 * Bake with clear weather. Bark branches broken by `damage` stay on the impostor.
 */
export function applyImpostorWeather(material: MeshStandardNodeMaterial, surface: ImpostorSurface, options: MaterialOptions & { rock?: boolean } = {}): void {
  const w = weatherOf(options)
  const s = surface as Record<keyof ImpostorSurface, any>
  let color: any
  let alpha: any = s.alpha
  if (options.rock) color = s.color.mul(float(1).sub(w.burn.mul(0.75)))
  else {
    const foliage = step(0.005, s.mask)
    // Bark chars along its furrows (~0.5 on average, see the bark material).
    color = mix(mix(s.color, CHAR, smoothstep(0.2, 0.6, w.burn.mul(1.4))), scorched(s.color, w), foliage)
    const gone = foliage.mul(step(fract(s.mask.add(instanceRandoms().c.mul(7.13))), leafLoss(w)))
    alpha = select(gone.greaterThan(0.5), float(0), alpha)
  }
  const look = weathered(color, 0.85, w, s.normal)
  material.colorNode = vec4(look.color, alpha)
  material.roughnessNode = look.roughness
}
