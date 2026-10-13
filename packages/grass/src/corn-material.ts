import { Color, DataTexture, DoubleSide, MeshPhysicalNodeMaterial, Vector2, Vector3, Vector4, type Node } from 'three/webgpu'
import {
  Fn, Loop, abs, floor, attribute, cameraPosition, clamp, color, cos, dot, faceDirection, float, fract, fwidth, int, length, max, min, mix,
  modelWorldMatrix, mx_noise_float, normalGeometry, normalize, positionGeometry, positionWorld, pow, sin, smoothstep, step,
  texture, time, transformNormalToView, uniform, uniformArray, uv, varyingProperty, vec2, vec3, vec4,
} from 'three/tsl'
import { MAX_INTERACTORS, windGust } from './material.ts'

/** Height (metres) the corn geometry is modelled at; instances scale from it. */
export const CORN_MODEL_HEIGHT = 2.4

/** Nothing flattened: R = 0, direction +X. */
const standingMap = new DataTexture(new Uint8Array([0, 255, 128, 255]), 1, 1)
standingMap.needsUpdate = true

/**
 * Creates the uniform set shared by a Corn field's stalk and canopy materials. Corn calls this for you and drives
 * the values from `Corn.set()`; it is exported so the {@link CornUniforms} type is documented in full.
 */
export function createCornUniforms() {
  return {
    /** Mature stalk height in metres, tassel included. */
    height: uniform(2.4),
    /** 0..1 random height spread per plant. */
    heightVariation: uniform(0.1),
    /** Growth stage: 0 seedling … ~0.65 full height … 0.8 mature … 1 dry. */
    growth: uniform(0.8),
    /** 1 = harvested: stubble only. */
    harvested: uniform(0),
    /** Stubble height in metres after harvest. */
    stubbleHeight: uniform(0.3),
    /** Mature leaf colour. */
    leafColor: uniform(new Color()),
    /** Young leaf colour (seedlings). */
    youngColor: uniform(new Color()),
    /** Dry leaf, husk and stubble colour. */
    dryColor: uniform(new Color()),
    /** Tassel colour. */
    tasselColor: uniform(new Color()),
    /** Bare soil colour between young rows and under the canopy. */
    soilColor: uniform(new Color()),
    /** Per-plant brightness variation, 0..1. */
    colorVariation: uniform(0),
    /** Field-scale brightness and dryness variation, 0..1. */
    patchiness: uniform(0),
    /** Back-lit glow of the leaves. */
    translucency: uniform(0),
    /** Resistance to wind and interaction (never below 0.05). */
    stiffness: uniform(1),
    /** Normalised XZ wind direction. */
    windDirection: uniform(new Vector2(1, 0)),
    /** How far stalks bend in the wind. */
    windStrength: uniform(0),
    /** Gust noise frequency (1/metres). */
    windScale: uniform(0),
    /** Gust travel speed. */
    windSpeed: uniform(0),
    /** The four LOD distances (x, y, z, w = LOD 0..3); stalks end at w. */
    lodDistances: uniform(new Vector4()),
    /** The four LOD density fractions. */
    lodDensities: uniform(new Vector4(1, 1, 1, 1)),
    /** Position LOD is measured from (the Corn camera), so shadow passes see the same plants. */
    viewPosition: uniform(new Vector3()),
    /** Direction *towards* the sun. */
    sunDirection: uniform(new Vector3(0.4, 0.8, 0.3).normalize()),
    /** Sun colour × intensity. */
    sunColor: uniform(new Color(1, 1, 1)),
    /** Global multiplier on interactor push (and flattening). */
    interactionStrength: uniform(1),
    /** xyz = world position, w = radius (0 = unused slot). */
    interactors: uniformArray(Array.from({ length: MAX_INTERACTORS }, () => new Vector4()), 'vec4'),
    /** Number of active entries in `interactors`. */
    interactorCount: uniform(0, 'int'),
    /** Where corn was flattened (see `FlattenMap`). */
    flatten: texture(standingMap),
    /** minX, minZ, sizeX, sizeZ of the flatten map in world space. */
    flattenBounds: uniform(new Vector4(-1e6, -1e6, 2e6, 2e6)),
    /** 1 tints corn by level of detail. */
    debugLods: uniform(0),
  }
}

/** Shader uniforms of a Corn field (`corn.uniforms`). Each entry is a TSL uniform/texture node. */
export type CornUniforms = ReturnType<typeof createCornUniforms>

/** Piecewise-linear density over the four LOD distances (same curve as grass). */
function lodDensity(u: CornUniforms, dist: Node<'float'>) {
  const d = u.lodDistances
  const k = u.lodDensities
  const seg = (a: any, b: any) => dist.sub(a).div(max(b.sub(a), 1e-3)).clamp(0, 1)
  return mix(mix(mix(k.x, k.y, seg(d.x, d.y)), k.z, seg(d.y, d.z)), k.w, seg(d.z, d.w))
}

/** Flattened amount (x) and fall direction (yz) at a world XZ position; vertex stage. */
function sampleFlatten(u: CornUniforms, xz: Node<'vec2'>) {
  const p = xz.sub(u.flattenBounds.xy).div(u.flattenBounds.zw)
  const inside = step(0, p.x).mul(step(p.x, 1)).mul(step(0, p.y)).mul(step(p.y, 1))
  const s = u.flatten.sample(p).level(float(0))
  return { amount: s.r.mul(inside).mul(clamp(u.interactionStrength, 0, 1)), dir: normalize(s.gb.mul(2).sub(1).add(vec2(1e-4, 0))) }
}

/** Growth-derived shape and colour factors shared by stalks and canopy. */
function growthState(u: CornUniforms) {
  const g = u.growth
  return {
    g,
    /** 0 seedling … 1 full height. */
    grow: smoothstep(0, 0.62, g),
    /** Whole-plant drying after maturity. */
    dry: smoothstep(0.8, 0.98, g),
    /** Rows closed over (canopy cover). */
    closure: smoothstep(0.3, 0.68, g),
    /** Tassels out. */
    tassel: smoothstep(0.45, 0.56, g),
    /** Leaf colour before drying. */
    green: mix(u.youngColor, u.leafColor, smoothstep(0.15, 0.55, g)),
  }
}

/** Field-scale variation at a world XZ position: x = brightness (−1..1), y = dryness (0..1). Very low frequency
 *  (soil and moisture differences across a field), never thresholded. */
function fieldVariation(u: CornUniforms, xz: Node<'vec2'>) {
  const bright = mx_noise_float(xz.mul(0.011)).add(mx_noise_float(xz.mul(0.037).add(7.3)).mul(0.5)).add(mx_noise_float(xz.mul(0.11).add(3.1)).mul(0.25))
  const dryness = smoothstep(0.05, 0.75, mx_noise_float(xz.mul(0.006).add(vec2(31.7, -12.3))))
  return vec2(bright.mul(u.patchiness), dryness.mul(u.patchiness))
}

/** Rotates a point in the plane spanned by up and `dir` (unit XZ) by `angle`, about the origin. */
function bendPoint(p: any, dir: any, angle: any) {
  const along = dot(p.xz, dir)
  const perp = p.xz.sub(dir.mul(along))
  const c = cos(angle)
  const s = sin(angle)
  const xz = perp.add(dir.mul(along.mul(c).add(p.y.mul(s))))
  return vec3(xz.x, p.y.mul(c).sub(along.mul(s)), xz.y)
}

const rotateYaw = (p: any, yaw: any) => {
  const c = cos(yaw)
  const s = sin(yaw)
  return vec3(p.x.mul(c).sub(p.z.mul(s)), p.y, p.x.mul(s).add(p.z.mul(c)))
}

const LOD_COLORS = [new Color('#ff4d4d'), new Color('#ffd23f'), new Color('#4dd96b'), new Color('#4da6ff')]

/**
 * The material of corn plants (stalk, leaves, tassel, ears) in a Corn chunk. Instance attributes:
 *  aOffset = (x, y, z) local to the chunk, w = yaw
 *  aPlant  = seed (0..1), rank (0..1, LOD thinning order)
 * Vertex attributes of the plant model: position, normal, uv (x across a leaf, y along it), aPart = (part, node
 * height 0..1) with part 0 stalk, 1 leaf, 2 tassel, 3 first ear, 4 second ear, 5 silk.
 * `detail` (0..2) only tints the LOD debug view.
 */
export function createCornMaterial(u: CornUniforms, detail: number) {
  const aOffset = attribute('aOffset', 'vec4')
  const aPlant = attribute('aPlant', 'vec2')
  const aPart = attribute('aPart', 'vec2')
  const seed = aPlant.x
  const part = aPart.x
  const node = aPart.y
  const is = (k: number) => float(1).sub(step(0.5, abs(part.sub(k))))
  const isLeaf = is(1)
  const isStalk = is(0)
  const isTassel = is(2)
  const isEar = is(3).add(is(4))
  const isSilk = is(5)
  const st = growthState(u)

  const root = modelWorldMatrix.mul(vec4(aOffset.xyz, 1)).xyz
  const dist = length(u.viewPosition.sub(root))
  const density = lodDensity(u, dist)
  const thin = float(1).sub(smoothstep(density.mul(0.8), density, aPlant.y))
  const fade = float(1).sub(smoothstep(u.lodDistances.w.mul(0.6), u.lodDistances.w, dist))
  const visible = thin.mul(fade)
  // Fewer plants far away: spread the survivors a little wider, so the rows don't look thinned.
  const spread = clamp(pow(density.max(0.05), -0.4), 1, 2)

  const plantHeight = u.height.mul(float(1).add(fract(seed.mul(7.31)).mul(2).sub(1).mul(u.heightVariation))).mul(mix(0.06, 1, st.grow))
  const vScale = plantHeight.div(CORN_MODEL_HEIGHT)
  const hScale = pow(vScale, 0.7).mul(spread) // seedlings are leafier than a shrunk adult
  const harvested = u.harvested
  const secondEar = step(0.55, fract(seed.mul(3.3)))
  const earOut = smoothstep(0.5, 0.62, st.g)
  const partVisible = isStalk
    .add(isLeaf.mul(float(1).sub(harvested)))
    .add(isTassel.mul(st.tassel).mul(float(1).sub(harvested)).mul(float(1).sub(smoothstep(14, 24, dist))))
    .add(is(3).add(isSilk).mul(earOut).mul(float(1).sub(harvested)))
    .add(is(4).mul(earOut).mul(secondEar).mul(float(1).sub(harvested)))
  // Lower leaves dry first once the plant matures; everything dries towards harvest.
  const leafDry = clamp(st.dry.add(smoothstep(0, 0.2, st.g.sub(0.62).mul(1.4).sub(node))), 0, 1)

  const { gust, swirl } = windGust(u, root.xz)
  const flat = sampleFlatten(u, root.xz)
  // Fallen stalks splay a little around the fall direction.
  const spin = fract(seed.mul(5.7)).sub(0.5).mul(0.9)
  const fallDir = vec2(flat.dir.x.mul(cos(spin)).sub(flat.dir.y.mul(sin(spin))), flat.dir.x.mul(sin(spin)).add(flat.dir.y.mul(cos(spin))))
  const fallAngle = flat.amount.mul(fract(seed.mul(2.9)).mul(0.22).add(1.3))

  const interaction = Fn(() => {
    const push = vec2(0).toVar()
    Loop({ start: int(0), end: u.interactorCount, type: 'int', condition: '<' }, ({ i }) => {
      const it = u.interactors.element(i) as any
      const radius = max(it.w, 1e-4)
      const delta = root.xz.sub(it.xz)
      // Neighbours of the flattened strip are pushed aside, out to almost twice the radius.
      const falloff = float(1).sub(smoothstep(radius.mul(0.6), radius.mul(1.8), length(delta)))
      const gate = step(1e-4, it.w).mul(float(1).sub(smoothstep(radius.add(plantHeight), radius.mul(2).add(plantHeight), abs(root.y.sub(it.y)))))
      push.addAssign(normalize(delta.add(1e-5)).mul(falloff.mul(gate)))
    })
    return push.mul(u.interactionStrength).mul(0.7)
  })

  const vNormal = varyingProperty('vec3', 'vCornNormal')
  const vInfo = varyingProperty('vec4', 'vCornInfo') // height fraction, leaf dryness, flattened, farness
  const vField = varyingProperty('vec3', 'vCornField') // field brightness, field dryness, per-plant variation

  const position = Fn(() => {
    const flutterRate = fract(seed.mul(13.1)).mul(2).add(2)
    const flutter = sin(time.mul(flutterRate).add(seed.mul(40))).mul(gust.mul(0.1).add(0.05))
    const wind = u.windDirection.mul(gust.add(0.15).add(flutter)).add(swirl).mul(u.windStrength).mul(0.3).div(u.stiffness)
    const bend = fallDir.mul(fallAngle).add(wind.add(interaction().div(u.stiffness)).mul(float(1).sub(flat.amount))).toVar()
    const amount = min(length(bend), 1.5).toVar()
    const bendDir = bend.div(max(length(bend), 1e-4)).toVar()

    const base = positionGeometry.mul(vec3(hScale, vScale, hScale)).toVar()
    const s = uv().y
    // Dry leaves hang lower; all leaves flutter a little in gusts.
    const droop = isLeaf.mul(leafDry).mul(0.35).mul(s).mul(length(base.xz))
    const leafFlutter = isLeaf.mul(sin(time.mul(flutterRate.add(1.3)).add(seed.mul(40)).add(node.mul(11))).mul(0.03).mul(s).mul(vScale).mul(gust.mul(u.windStrength).add(0.1)))
    const grownY = base.y.sub(droop).add(leafFlutter)
    // Harvest: cut every stalk at stubble height (a little uneven); leaves, tassels and ears are gone.
    const stub = u.stubbleHeight.mul(fract(seed.mul(5.1)).mul(0.5).add(0.75))
    const y = mix(grownY, min(grownY, stub), harvested).toVar()
    const p = vec3(base.x, y, base.z)
    const t = clamp(y.div(max(plantHeight, 1e-3)), 0, 1)
    // Wind curves the stalk (more bend higher up); flattened stalks fall over rigidly from the base.
    const angle = amount.mul(mix(t, float(1), flat.amount))
    const bent = bendPoint(rotateYaw(p, aOffset.w), bendDir, angle).toVar()
    const lying = vec3(bent.x, max(bent.y, flat.amount.mul(0.04).add(0.01).mul(step(0.001, y))), bent.z)
    const n = bendPoint(rotateYaw(normalGeometry, aOffset.w), bendDir, angle)

    vNormal.assign(n)
    vInfo.assign(vec4(t, leafDry, flat.amount, smoothstep(15, 70, dist)))
    vField.assign(vec3(fieldVariation(u, root.xz), fract(seed.mul(91.7)).sub(0.5).mul(2)))
    return aOffset.xyz.add(lying.mul(partVisible).mul(visible))
  })

  const albedo = Fn(() => {
    const t = vInfo.x
    const dryLeaf = vInfo.y
    const farness = vInfo.w
    const s = uv().y
    const green = st.green
    const leaf = mix(green, u.dryColor, dryLeaf).toVar()
    // Pale midrib along the crease, and tips that dry first.
    const midrib = float(1).sub(smoothstep(0.02, 0.1, abs(uv().x.sub(0.5))))
    leaf.assign(mix(leaf, leaf.mul(vec3(1.25, 1.25, 1.05)), midrib.mul(0.5).mul(float(1).sub(farness))))
    leaf.assign(mix(leaf, u.dryColor, smoothstep(0.82, 1, s).mul(0.35).mul(st.grow)))
    const stalk = mix(green.mul(vec3(1.05, 1.12, 0.8)), u.dryColor.mul(0.85), max(st.dry, u.harvested))
    // Thin tassels turn to sub-pixel glints with distance: blend them into the leaf colour there.
    const tassel = mix(mix(u.tasselColor, u.dryColor.mul(0.8), st.dry.mul(0.5)), green, farness.mul(0.7))
    const husk = mix(green.mul(vec3(1.15, 1.2, 0.9)), u.dryColor.mul(1.05), smoothstep(0.84, 0.97, st.g))
    const silk = mix(vec3(0.62, 0.6, 0.3), vec3(0.32, 0.19, 0.1), smoothstep(0.58, 0.72, st.g))
    const c = leaf.mul(isLeaf).add(stalk.mul(isStalk)).add(tassel.mul(isTassel)).add(husk.mul(isEar)).add(silk.mul(isSilk)).toVar()
    // Per-plant and field-scale variation.
    c.mulAssign(float(1).add(vField.z.mul(u.colorVariation).mul(float(1).sub(farness.mul(0.6)))))
    c.mulAssign(float(1).add(vField.x.mul(0.16)))
    c.assign(mix(c, c.mul(vec3(1.18, 1.08, 0.7)), vField.y.mul(0.3)))
    // Leaf undersides (the side facing away from the leaf normal) are paler and greyer: they show in the wind.
    const viewDir = normalize(cameraPosition.sub(positionWorld))
    const underside = step(dot(normalize(vNormal), viewDir), 0).mul(isLeaf)
    c.assign(mix(c, c.mul(vec3(1.2, 1.28, 1.3)).add(0.012), underside.mul(0.55)))
    // Far away the thin tassels are gone; their tan haze tints the top leaves instead.
    c.assign(mix(c, u.tasselColor.mul(0.75), isLeaf.mul(smoothstep(0.75, 1, t)).mul(farness).mul(st.tassel).mul(float(1).sub(st.dry)).mul(0.25)))
    // Crushed corn: darker, browner, broken.
    c.assign(mix(c, c.mul(vec3(0.62, 0.55, 0.42)).add(u.dryColor.mul(0.12)), vInfo.z.mul(0.75)))
    // A closed canopy is dark inside.
    const occlusion = st.closure.mul(float(1).sub(u.harvested)).mul(float(1).sub(vInfo.z.mul(0.3)))
    c.mulAssign(mix(float(1), mix(float(0.22), float(1), smoothstep(0.05, 0.65, t)), occlusion))
    const lodColor = color(LOD_COLORS[detail])
    return vec4(mix(c, lodColor.mul(mix(float(0.4), float(1), t)), u.debugLods), 1)
  })

  const translucency = Fn(() => {
    const viewDir = normalize(cameraPosition.sub(positionWorld))
    const back = pow(max(dot(viewDir, u.sunDirection.negate()), 0), 4)
    const leaf = mix(st.green, u.dryColor, vInfo.y)
    return leaf.mul(u.sunColor).mul(back.mul(u.translucency).mul(0.15).mul(isLeaf).mul(vInfo.x)).mul(float(1).sub(u.debugLods))
  })

  const material = new MeshPhysicalNodeMaterial({ side: DoubleSide, roughness: 0.6, metalness: 0 })
  material.positionNode = position()
  material.normalNode = transformNormalToView(normalize(vNormal).mul(faceDirection))
  material.colorNode = albedo()
  material.emissiveNode = translucency()
  // Waxy leaves glint up close; far away the glints are sub-pixel sparkle, so they fade out.
  material.specularIntensityNode = mix(float(0.1), float(0.03), vInfo.w)
  material.specularColorNode = mix(st.green, vec3(1), 0.15)
  return material
}

/**
 * The material of a Corn field's canopy: one surface per field that stands in for the plants where levels of
 * detail have thinned or dropped them. Near the camera it lies on the ground as soil; with distance it rises to
 * the top of the leaves as the plants thin out, so a field reads the same from 2 m and from 2 km. Rows are drawn
 * with filtered stripes that fade to their average as they shrink below a pixel (no moiré). Vertex attributes:
 * position (world, on the ground), normal, aCanopy = (across-row coordinate in rows, metres along the outline for
 * walls, wall flag, wall height 0..1).
 */
export function createCanopyMaterial(u: CornUniforms) {
  const aCanopy = attribute('aCanopy', 'vec4')
  const aField = attribute('aField', 'vec3')
  const st = growthState(u)
  const wall = aCanopy.z
  const ground = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz
  const dist = length(u.viewPosition.sub(ground))
  const density = lodDensity(u, dist)
  // The canopy rises as plants start thinning (so the upper leaves of the survivors poke out of it) and is the
  // whole field past the last plant LOD, where plants sink into it as they fade.
  const lift = max(smoothstep(u.lodDistances.x, u.lodDistances.y, dist).mul(0.85).mul(float(1).sub(density.mul(0.15))), smoothstep(u.lodDistances.w.mul(0.6), u.lodDistances.w, dist))
  const top = mix(u.height.mul(0.8).mul(mix(0.06, 1, st.grow)), float(0.04), u.harvested)
  // Ragged field edge: plants along the outline stand at uneven heights (wall tops and outline vertices).
  const ragged = mx_noise_float(ground.xz.mul(1.3)).mul(0.14).add(mx_noise_float(ground.xz.mul(4.1)).mul(0.06)).add(0.97)

  const vCanopy = varyingProperty('vec4', 'vCanopy') // lift, flattened, rows, along
  const vFall = varyingProperty('vec2', 'vCanopyFall')
  const vField = varyingProperty('vec2', 'vCanopyField')

  const position = Fn(() => {
    const flat = sampleFlatten(u, ground.xz)
    const flatTop = mix(top, min(top, 0.25), flat.amount)
    // Outline vertices of the top (aCanopy.w = 1) and wall tops get the ragged height.
    const edgeTop = mix(float(1), ragged, aCanopy.w)
    // Kept a little above the terrain, more with distance, so the two never z-fight.
    const h = mix(flatTop.mul(edgeTop), top.mul(edgeTop).mul(aCanopy.w), wall).mul(lift).add(dist.mul(0.0005).add(0.03))
    vCanopy.assign(vec4(lift, flat.amount, aCanopy.x, aCanopy.y))
    vFall.assign(flat.dir)
    vField.assign(fieldVariation(u, ground.xz))
    return positionGeometry.add(vec3(0, h, 0))
  })

  const albedo = Fn(() => {
    const lifted = vCanopy.x
    const flat = vCanopy.y
    const rows = vCanopy.z
    const along = vCanopy.w
    const xz = positionWorld.xz
    const viewDir = normalize(cameraPosition.sub(positionWorld))
    const oblique = float(1).sub(abs(viewDir.y))
    // How much we look along the rows (down the furrows) rather than across them.
    const alongRows = abs(dot(normalize(viewDir.xz.add(vec2(1e-5, 0))), aField.xy)).mul(oblique)
    const green = st.green
    const noHarvest = float(1).sub(u.harvested)
    const soil = mix(u.soilColor, u.soilColor.mul(0.55), st.closure.mul(noHarvest)).toVar()
    soil.assign(mix(soil, mix(u.soilColor, u.dryColor, 0.55), u.harvested.mul(0.6)))

    // Foliage from above: leaf streaks lying across the rows (corn turns its leaves into the gaps), two octaves,
    // each faded out once it shrinks below a pixel; the dark gaps between leaves come with them.
    const leaf1 = vec2(along.mul(3.2), rows.mul(0.8))
    const leaf2 = vec2(along.mul(7.1), rows.mul(1.9)).add(13.1)
    const fade1 = float(1).sub(smoothstep(0.2, 0.7, length(fwidth(leaf1))))
    const fade2 = float(1).sub(smoothstep(0.2, 0.7, length(fwidth(leaf2))))
    const streaks = mx_noise_float(leaf1).mul(0.3).mul(fade1).add(mx_noise_float(leaf2).mul(0.2).mul(fade2))
    const foliage = mix(green, u.dryColor, st.dry).mul(float(1).add(streaks)).toVar()
    // Tassels: a tan haze over a mature canopy seen from above, stronger at grazing angles.
    const haze = st.tassel.mul(float(1).sub(st.dry)).mul(oblique.mul(0.06).add(0.05)).mul(smoothstep(0.7, 1, lifted))
    foliage.assign(mix(foliage, u.tasselColor.mul(0.6), haze))

    // Rows: plants cover `cover` of each row spacing from above, the rest is soil (young or harvested fields) or
    // shade between rows. Anti-aliased by the pixel footprint; averaged once rows get too thin. Looking down the
    // rows shows more of the shaded furrows, so each field's shade depends on its row direction and the view.
    const w = fwidth(rows)
    const q = abs(fract(rows).sub(0.5))
    const cover = mix(mix(float(0.12), float(1.05), smoothstep(0.08, 0.62, st.g)), float(0.14), u.harvested)
    const e = max(w, 0.02)
    const sharp = float(1).sub(smoothstep(cover.mul(0.5).sub(e), cover.mul(0.5).add(e), q))
    const rowMask = mix(sharp, clamp(cover, 0, 1), smoothstep(0.2, 0.55, w))
    const ridge = cos(fract(rows).sub(0.5).mul(6.2832)).mul(float(1).sub(smoothstep(0.12, 0.45, w))).mul(0.06).mul(st.closure)
    const plants = mix(foliage, mix(u.dryColor, green, 0.15).mul(0.8), u.harvested)
    const fromAbove = mix(soil, plants.mul(float(1).add(ridge)), rowMask).mul(float(1).sub(alongRows.mul(alongRows).mul(0.16)))
    // Planter passes (12 rows wide): each pass a slightly different shade, with a faint overlap line between
    // passes; both read more strongly looking along the rows. Faded out once a pass shrinks below a pixel.
    const passes = rows.div(12)
    const pass = floor(passes)
    const passFade = float(1).sub(smoothstep(0.25, 0.6, fwidth(passes)))
    const blend = smoothstep(0, 0.08, fract(passes))
    const shadeOf = (k: any) => fract(sin(k.mul(12.9898).add(aField.z.mul(78.233))).mul(43758.5453)).sub(0.5)
    const passShade = mix(shadeOf(pass.sub(1)), shadeOf(pass), blend).mul(0.12)
    const overlap = float(1).sub(smoothstep(0.01, 0.04, min(fract(passes), float(1).sub(fract(passes))))).mul(-0.07)
    const passTint = float(1).add(passShade.add(overlap).mul(alongRows.mul(0.6).add(0.4)).mul(passFade))
    // Per-field shade (variety, planting date).
    const fieldShade = float(1).add(aField.z.mul(0.08))
    const lit = fromAbove.mul(passTint).mul(fieldShade)
    // Near the camera the canopy is the soil the real plants stand on; lifted, the shaded leaf mass between the
    // survivors' tops; at full height the field's top as the plants average out.
    const c = mix(soil, lit.mul(mix(float(0.66), float(0.74), lifted)), smoothstep(0.03, 0.2, lifted)).toVar()

    // Walls (field edges from outside, behind the outer row of real plants): columns of stalks and leaves in the
    // shade, brighter and leafier towards the ragged top.
    const hgt = lifted.mul(top).mul(aCanopy.w)
    const cols = vec2(along.mul(5.5), hgt.mul(0.6))
    const leaves = vec2(along.mul(2.2), hgt.mul(2.4)).add(5.7)
    const colFade = float(1).sub(smoothstep(0.2, 0.7, length(fwidth(cols))))
    const leafFade = float(1).sub(smoothstep(0.2, 0.7, length(fwidth(leaves))))
    const wallTex = float(1).add(mx_noise_float(cols).mul(0.35).mul(colFade)).add(mx_noise_float(leaves).mul(0.3).mul(leafFade))
    const side = mix(green, u.dryColor, st.dry).mul(mix(float(0.25), float(0.8), pow(aCanopy.w, 0.7))).mul(wallTex)
    c.assign(mix(c, side, wall))

    // Flattened corn: crushed, browner stalks lying along the direction of travel, soil showing between them,
    // darker towards the standing edge.
    const across = vec2(vFall.y.negate(), vFall.x)
    const stalkCoord = vec2(dot(xz, across).mul(9), dot(xz, vFall).mul(0.8))
    const stalkFade = float(1).sub(smoothstep(0.25, 0.7, length(fwidth(stalkCoord))))
    const tangle = mx_noise_float(stalkCoord).mul(0.5).add(0.5)
    const stalkCover = mix(float(0.6), smoothstep(0.3, 0.6, tangle), stalkFade)
    const crushed = mix(u.soilColor.mul(0.8), mix(green.mul(0.5), u.dryColor.mul(0.55), 0.55), stalkCover)
    c.assign(mix(c, crushed, flat.mul(smoothstep(0.3, 1, lifted)).mul(noHarvest).mul(float(1).sub(wall))))
    c.mulAssign(float(1).sub(flat.mul(float(1).sub(flat)).mul(4).mul(0.35).mul(lifted)))
    c.mulAssign(float(1).add(vField.x.mul(0.16)))
    c.assign(mix(c, c.mul(vec3(1.18, 1.08, 0.7)), vField.y.mul(0.3)))
    const debug = mix(color(LOD_COLORS[0]), color(LOD_COLORS[3]), lifted)
    return vec4(mix(c, debug, u.debugLods), 1)
  })

  const material = new MeshPhysicalNodeMaterial({ side: DoubleSide, roughness: 0.8, metalness: 0, specularIntensity: 0.05 })
  material.positionNode = position()
  material.colorNode = albedo()
  material.normalNode = transformNormalToView(normalize(normalGeometry).mul(faceDirection))
  return material
}
