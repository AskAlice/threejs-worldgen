import { MeshStandardNodeMaterial } from 'three/webgpu'
import { abs, attribute, cos, float, floor, fract, fwidth, hash, mx_noise_float, normalLocal, positionLocal, smoothstep, vec3, vec4 } from 'three/tsl'
import { weatherSurface, type CityUniforms } from './facade-material.ts'
import { band, type N } from './shader-utils.ts'

/** Field shading (from `FarmOptions`). */
export interface FieldShading {
  /** ± brightness of the large-scale drift across fields (soil and moisture). */
  variation: number
  /** Contrast of the streaks cultivation leaves along the rows (seen from afar). */
  streaks: number
  /** Width of the headland band round a cropped field (where the tractor turns), metres. */
  headland: number
}

/**
 * Field material: the field's colour, its rows (furrows, drill rows) and tramlines, streaks along the rows, a headland
 * band round the edge, and a gentle multi-scale brightness drift (soil and moisture). Every pattern fades out by its
 * screen footprint (`fwidth`) before it could alias or sparkle; none is thresholded. Snow and rain follow the road
 * weather. Geometry: `fieldGeometry`.
 */
export function createFieldMaterial(u: CityUniforms, o: FieldShading): MeshStandardNodeMaterial {
  const f = attribute('field', 'vec4') as N
  const tint = attribute('tint', 'vec3') as N
  const tram = attribute('tram', 'float') as N
  const edge = attribute('edge', 'float') as N
  const p = positionLocal as N
  const cropped = f.z.greaterThan(0).select(float(1), float(0))
  // Metres along and across the rows.
  const along = p.x.mul(f.x).add(p.z.mul(f.y))
  const across = p.x.mul(f.y.negate()).add(p.z.mul(f.x))
  const a = across.div(f.z.max(1e-3))
  const rows = cos(a.mul(Math.PI * 2)).mul(0.5).add(0.5).mul(f.w).mul(float(1).sub(smoothstep(0.2, 0.45, fwidth(a)))).mul(cropped)
  // Tramlines: a pair of wheel tracks 1.8 m apart every `tram` metres.
  const t = fract(across.div(tram.max(1e-3))).sub(0.5).mul(tram)
  const tracks = band(abs(t).sub(0.9), float(0.22)).mul(float(1).sub(smoothstep(0.1, 0.3, fwidth(across)))).mul(tram.greaterThan(0).select(float(1), float(0)))
  // Streaks along the rows: noise stretched 10:1 along the cultivation direction, fading as it shrinks on screen.
  const sv = across.div(3)
  const streak = mx_noise_float(vec3(along.div(30), sv, 7.5)).mul(float(1).sub(smoothstep(0.25, 0.6, fwidth(sv)))).mul(o.streaks).mul(cropped)
  // Headland: the strip round the edge, worked across the rows, a shade apart.
  const head = float(1).sub(smoothstep(o.headland - 1.5, o.headland, edge)).mul(cropped).mul(0.06)
  // Large, low-contrast drift at two scales: never thresholded, so no blotches.
  const drift = mx_noise_float(vec3(p.x.div(140), p.z.div(140), 0.5)).mul(0.65).add(mx_noise_float(vec3(p.x.div(35), p.z.div(35), 2.5)).mul(0.35)).mul(o.variation)
  // Gravel yard: stone speckle (fading out before it can shimmer) and darker, worn wheel paths.
  const gravel = f.w.lessThan(0).select(float(1), float(0))
  const speck = hash(floor(p.x.mul(12)).add(4096).add(floor(p.z.mul(12)).add(4096).mul(8191))).sub(0.5).mul(0.22).mul(float(1).sub(smoothstep(0.03, 0.09, fwidth(p.x))))
  const worn = mx_noise_float(vec3(p.x.div(6), p.z.div(6), 4.5)).mul(0.08)
  const color = tint.mul(float(1).sub(rows).add(streak).add(drift).sub(head).add(speck.add(worn).mul(gravel))).mul(float(1).sub(tracks.mul(0.18)))
  const s = weatherSurface({ color, roughness: float(0.95), metalness: float(0), emissive: vec3(0) }, u.roadWeather as N, p, (normalLocal as N).y)
  const m = new MeshStandardNodeMaterial()
  m.colorNode = vec4(s.color, 1)
  m.roughnessNode = s.roughness
  m.metalnessNode = s.metalness
  // Drawn over the terrain it hugs.
  m.polygonOffset = true
  m.polygonOffsetFactor = -1
  m.polygonOffsetUnits = -4
  return m
}
