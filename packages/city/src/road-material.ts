import { MeshStandardNodeMaterial } from 'three/webgpu'
import { abs, attribute, exp, float, floor, fract, fwidth, hash, int, max, mix, mx_noise_float, normalLocal, positionLocal, smoothstep, step, uv, vec3, vec4 } from 'three/tsl'
import { weatherSurface, type CityUniforms } from './facade-material.ts'
import { band, bond, eq, type N } from './shader-utils.ts'

/**
 * Road material. Surfaces by `road.z`: asphalt (lane markings, worn tyre tracks, cracks and
 * patches), cobblestones, gravel and rutted dirt; plus paved sidewalks, kerb stones, bridge
 * concrete and junctions (by `road.w`, see `ROAD_PARTS`). Weather clears from tyre tracks first.
 *
 * Geometry attributes: `uv` (metres across from the centreline, metres along), `road` (half
 * carriageway width, class 0..2, surface 0..3, part).
 */
export function createRoadMaterial(u: CityUniforms): MeshStandardNodeMaterial {
  const r = attribute('road', 'vec4') as N
  const ruv = uv() as N
  const p = positionLocal as N
  const hw = r.x, type = r.y, surface = r.z, part = r.w
  const lat = ruv.x, along = ruv.y
  const alat = abs(lat)
  const wear = u.wear
  const base = (u.roadColors as N).element(int(surface))
  const fine = mx_noise_float(p.mul(4)).mul(0.05)
  const coarse = mx_noise_float(p.mul(0.12)).mul(0.07)

  // Tyre tracks: two per lane (arterials have two lanes each way).
  const lanes = mix(float(1), float(2), eq(type, 0))
  const laneW = hw.div(lanes)
  const inLane = fract(alat.div(laneW)).sub(0.5).mul(laneW)
  const track = exp(abs(abs(inLane).sub(0.85)).div(0.32).pow(2).negate()).mul(step(alat, hw)).mul(wear)

  // Asphalt: grain, polished tracks, cracks, patches.
  const crack = float(1).sub(smoothstep(0, 0.035, abs(mx_noise_float(p.mul(0.6))))).mul(wear).mul(0.5)
  const patch = smoothstep(0.55, 0.6, mx_noise_float(floor(p.mul(0.25)).add(0.5))).mul(wear)
  let asphalt: N = base.mul(float(1).add(fine).add(coarse).sub(track.mul(0.12)).sub(crack.mul(0.5)).add(patch.mul(0.12)))
  // Markings (asphalt carriageways only).
  const paint = u.markings.mul(eq(surface, 0)).mul(eq(part, 0))
  const dashes = (period: number, duty: number) => step(fract(along.div(period)), duty)
  const centreDouble = band(alat.sub(0.16), float(0.06)).mul(eq(type, 0))
  const centreDash = band(lat, float(0.06)).mul(dashes(9, 0.5)).mul(eq(type, 1))
  const laneDash = band(alat.sub(hw.mul(0.5)), float(0.06)).mul(dashes(12, 0.35)).mul(eq(type, 0))
  const edge = band(alat.sub(hw.sub(0.35)), float(0.07)).mul(float(1).sub(eq(type, 2)))
  const worn = float(1).sub(wear.mul(0.5).mul(mx_noise_float(p.mul(1.3)).mul(0.5).add(0.5)))
  const white = max(max(centreDash, laneDash), edge).mul(paint).mul(worn)
  const yellow = centreDouble.mul(paint).mul(worn)
  asphalt = mix(mix(asphalt, u.marking, white), u.centerLine, yellow)

  // Cobblestones: domed setts in offset rows.
  const sett = bond(lat, along, float(0.14), float(0.12), float(0.012))
  const cobble = base.mul(float(1).add(sett.cell.sub(0.5).mul(0.35).mul(sett.fade)).sub(sett.joint.mul(0.45)).add(fine))

  // Gravel: speckles; dirt: ruts and a grassy crown.
  const speck = hash(floor(p.x.mul(30)).add(1e5).add(floor(p.z.mul(30)).add(1e5).mul(1013))).sub(0.5).mul(0.3).mul(float(1).sub(smoothstep(0.01, 0.06, fwidth(p.x))))
  const gravel = base.mul(float(1).add(speck).add(coarse.mul(1.5)).sub(track.mul(0.08)))
  const rut = exp(abs(alat.sub(0.95)).div(0.3).pow(2).negate()).mul(wear.add(0.3))
  const crown = float(1).sub(smoothstep(0.25, 0.55, alat)).mul(0.5)
  const dirt = mix(base.mul(float(1).add(coarse.mul(2)).add(fine.mul(2)).sub(rut.mul(0.25))), vec3(0.3, 0.36, 0.18), crown.mul(step(0.5, wear)))

  let road: N = asphalt.mul(eq(surface, 0)).add(cobble.mul(eq(surface, 1))).add(gravel.mul(eq(surface, 2))).add(dirt.mul(eq(surface, 3)))
  const roadRough = mix(float(0.9), float(0.75), track.mul(eq(surface, 0)))

  // Sidewalk slabs, kerb, concrete.
  const slab = bond(along, alat, float(1), float(1), float(0.02))
  const sidewalk = u.sidewalk.mul(float(1).add(slab.cell.sub(0.5).mul(0.1)).sub(slab.joint.mul(0.25)).add(fine))
  road = mix(road, sidewalk, eq(part, 1))
  road = mix(road, u.kerb.mul(float(1).add(fine)), eq(part, 2))
  road = mix(road, u.concrete.mul(float(1).add(fine).add(coarse)), eq(part, 3))
  const rough = mix(roadRough, float(0.85), max(eq(part, 1), max(eq(part, 2), eq(part, 3))))

  // Weather: snow and wet first clear from where tyres run; puddles collect in ruts and low spots.
  const w = (u.roadWeather as N)
  const cleared = vec4(w.x, w.y.mul(float(1).sub(track.mul(1.2)).max(0)), w.z, w.w)
  const s = weatherSurface({ color: road, roughness: rough, metalness: float(0), emissive: vec3(0) }, cleared, p, (normalLocal as N).y)
  const puddle = smoothstep(0.35, 0.45, mx_noise_float(p.mul(0.18)).add(rut.mul(0.3))).mul(smoothstep(0.3, 0.8, w.x)).mul(eq(part, 0).add(eq(part, 4)))
  const m = new MeshStandardNodeMaterial()
  m.colorNode = vec4(mix(s.color, s.color.mul(0.5), puddle) as N, 1)
  m.roughnessNode = mix(s.roughness, float(0.03), puddle)
  m.metalnessNode = s.metalness
  return m
}
