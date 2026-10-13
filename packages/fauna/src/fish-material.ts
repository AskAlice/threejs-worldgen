import { Color, MeshPhysicalNodeMaterial, Vector2, Vector3, Vector4 } from 'three/webgpu'
import { abs, attribute, cos, float, floor, fract, hash, hue, length, luminance, mix, positionGeometry, sign, sin, smoothstep, step, uniform, vec2, vec3 } from 'three/tsl'
import { DEFAULT_STATES, deformBeforeInstancing, type MaterialStates } from './common.ts'
import type { FishMeshData } from './fish-geometry.ts'
import type { FishSpecies } from './fish-species.ts'

/**
 * Creates the uniforms of one species' fish material. The fauna classes create and drive these; the
 * function is exported so {@link FishUniforms} is documented in full.
 */
export function createFishUniforms() {
  return {
    /** Back colour. */
    back: uniform(new Color()),
    /** Belly colour. */
    belly: uniform(new Color()),
    /** Fin colour. */
    fin: uniform(new Color()),
    /** Stripe colour. */
    stripeColor: uniform(new Color()),
    /** Spot colour. */
    spotColor: uniform(new Color()),
    /** Iris colour. */
    eyeColor: uniform(new Color()),
    /** x = countershade, y = shade line. */
    shade: uniform(new Vector2()),
    /** x = count, y = width, z = direction, w = wobble. */
    stripes: uniform(new Vector4()),
    /** x = region min, y = region max, z = edge darkness. */
    stripeRegion: uniform(new Vector3()),
    /** x = density, y = size, z = region min, w = region max. */
    spots: uniform(new Vector4()),
    /** x = eye z, y = eye y, z = radius (mesh units). */
    eye: uniform(new Vector3()),
    /** x = mouth line y, y = mouth length (in s), z = body depth. */
    mouth: uniform(new Vector3()),
    /** x = amplitude, y = wave number (rad per body length), z = fin flutter. */
    swim: uniform(new Vector3()),
    /** x = iridescence, y = metalness, z = roughness. */
    surface: uniform(new Vector3()),
    /** x = wetness, y = snow, z = burn, w = damage. */
    states: uniform(new Vector4()),
  }
}

/** Uniforms of a fish material (one per species). */
export type FishUniforms = ReturnType<typeof createFishUniforms>

/** Copies a species' pattern and swim style (and the face positions from its mesh) into the uniforms. */
export function applyFishSpecies(u: FishUniforms, species: FishSpecies, mesh: FishMeshData): void {
  const p = species.pattern
  u.back.value.set(p.back)
  u.belly.value.set(p.belly)
  u.fin.value.set(p.fin)
  u.stripeColor.value.set(p.stripes.color)
  u.spotColor.value.set(p.spots.color)
  u.eyeColor.value.set(p.eye)
  u.shade.value.set(p.countershade, p.shadeLine)
  u.stripes.value.set(p.stripes.count, p.stripes.width, p.stripes.direction, p.stripes.wobble)
  u.stripeRegion.value.set(p.stripes.region[0], p.stripes.region[1], p.stripes.edge)
  u.spots.value.set(p.spots.density, Math.min(0.25, p.spots.size), p.spots.region[0], p.spots.region[1])
  u.eye.value.set(...mesh.eye)
  u.mouth.value.set(mesh.mouth[0], mesh.mouth[1], species.shape.depth)
  u.swim.value.set(species.swim.amplitude, (Math.PI * 2) / Math.max(0.2, species.swim.wavelength), species.swim.flutter)
  u.surface.value.set(p.iridescence, p.metalness, p.roughness)
}

/** Copies material states into the uniforms. */
export function applyStates(u: { states: { value: Vector4 } }, s: MaterialStates = DEFAULT_STATES): void {
  u.states.value.set(s.wetness, s.snow, s.burn, s.damage)
}

const band = (x: any, lo: any, hi: any) => smoothstep(lo.sub(0.05), lo.add(0.05), x).mul(float(1).sub(smoothstep(hi.sub(0.05), hi.add(0.05), x)))

/**
 * The fish material: swimming as vertex animation and the colour pattern, both in TSL, no textures.
 *
 * Geometry attribute `fauna` = (s, h, part, w) (see `buildFishMesh`). Per-instance attributes:
 * `faunaMotion` = (tail-beat phase, amplitude scale, turning bend, fin phase) and `faunaLook` =
 * (hue shift, brightness, pattern phase, random). Body wave: lateral offset
 * `A(s)·sin(k·s − phase)` with `A` growing toward the tail, plus `bend·s²` while turning; paired fins
 * flutter on their own phase.
 */
export function createFishMaterial(u: FishUniforms): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial()
  const f = attribute('fauna', 'vec4')
  const motion = attribute('faunaMotion', 'vec4')
  const look = attribute('faunaLook', 'vec4')
  const s = f.x, h = f.y, part = f.z, w = f.w
  const p = positionGeometry

  // --- swimming ---
  const envelope = s.mul(0.15).add(s.mul(s).mul(0.85))
  const wave = sin(s.mul(u.swim.y).sub(motion.x)).mul(envelope).mul(u.swim.x).mul(motion.y)
  const bend = motion.z.mul(s.mul(s))
  const paired = step(2.5, part).mul(step(part, 3.5))
  const flutter = sin(motion.w).mul(u.swim.z).mul(w).mul(paired).mul(0.05)
  deformBeforeInstancing(m, vec3(p.x.add(wave).add(bend).add(flutter.mul(sign(p.x))), p.y.add(flutter.mul(0.6)), p.z))

  // --- colour ---
  const isFin = step(0.5, part)
  const isBody = float(1).sub(isFin)
  const shaded = mix(u.belly, u.back, smoothstep(u.shade.y.sub(0.3), u.shade.y.add(0.3), h))
  let col: any = mix(u.back, shaded, u.shade.x)

  // Stripes: bars across (direction 0) or lines along (1) the body, optionally wavy.
  const st = u.stripes
  const coord = mix(s, h.mul(0.5), st.z).add(st.w.mul(sin(mix(h, s, st.z).mul(9)))).add(look.z.mul(0.04))
  const wave01 = cos(coord.mul(st.x).mul(Math.PI * 2)).mul(0.5).add(0.5)
  const thr = float(1).sub(st.y)
  const stripe = smoothstep(thr.sub(0.04), thr.add(0.04), wave01)
  const onStripes = step(0.5, st.x).mul(band(h, u.stripeRegion.x, u.stripeRegion.y))
  const edge = smoothstep(thr.sub(0.3), thr.sub(0.04), wave01).sub(stripe).max(0).mul(u.stripeRegion.z)
  col = mix(col, u.stripeColor, stripe.mul(onStripes).mul(isBody))
  col = col.mul(float(1).sub(edge.mul(onStripes).mul(isBody).mul(0.9)))

  // Fins.
  col = mix(col, u.fin, isFin.mul(0.75))

  // Spots: one jittered spot per cell (cell coordinates kept positive for the integer hash).
  const sp = u.spots
  const q = vec2(s, h.mul(u.mouth.z).mul(0.5)).mul(sp.x).add(look.z.mul(7)).add(100)
  const cell = floor(q)
  const seed = cell.x.add(cell.y.mul(157))
  const jitter = vec2(hash(seed), hash(seed.add(31))).mul(0.5).add(0.25)
  const d = length(fract(q).sub(jitter))
  const spot = float(1).sub(smoothstep(sp.y.mul(0.75), sp.y, d)).mul(step(hash(seed.add(71)), 0.8)).mul(step(0.5, sp.x)).mul(band(h, sp.z, sp.w))
  col = mix(col, u.spotColor, spot.mul(isBody))

  // Eye (projected sideways) and mouth line.
  const de = length(vec2(p.z.sub(u.eye.x), p.y.sub(u.eye.y)))
  const iris = float(1).sub(smoothstep(u.eye.z.mul(0.85), u.eye.z, de)).mul(isBody)
  const pupil = float(1).sub(smoothstep(u.eye.z.mul(0.45), u.eye.z.mul(0.55), de)).mul(isBody)
  col = mix(col, u.eyeColor, iris)
  col = mix(col, vec3(0.01, 0.01, 0.012), pupil)
  const mouth = float(1).sub(smoothstep(0.003, 0.008, abs(p.y.sub(u.mouth.x)))).mul(float(1).sub(step(u.mouth.y, s))).mul(isBody)
  col = col.mul(float(1).sub(mouth.mul(0.8)))

  // Per-fish variety, then weathering states.
  col = hue(col, look.x).mul(look.y)
  col = mix(col, vec3(0.03, 0.025, 0.02), u.states.z.mul(0.9))
  col = mix(col, vec3(luminance(col)), u.states.w.mul(0.6)).mul(float(1).sub(u.states.w.mul(0.3)))

  m.colorNode = col
  m.roughnessNode = u.surface.z.mul(float(1).sub(u.states.x.mul(0.3)))
  m.metalnessNode = u.surface.y.mul(isBody)
  m.iridescenceNode = u.surface.x.mul(smoothstep(-0.8, 0.4, h)).mul(isBody)
  return m
}
