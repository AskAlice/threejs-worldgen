import { Color, DataTexture, MeshStandardNodeMaterial, RGBAFormat, UnsignedByteType, Vector4 } from 'three/webgpu'
import {
  abs, attribute, clamp, float, floor, fract, fwidth, hash, int, ivec2, max, mix, mx_noise_float, normalLocal,
  positionLocal, sin, smoothstep, step, textureLoad, uniform, uniformArray, uv, vec3, vec4,
} from 'three/tsl'
import { BUILDING_STYLES } from './buildings.ts'
import type { FacadeOptions, Weather, WeatherOptions } from './options.ts'

import { band, bond, eq, type N } from './shader-utils.ts'

/**
 * Creates the uniforms shared by a city's facade, roof and road materials. `City` drives them from
 * its options; read or tweak them directly for custom effects.
 */
export function createCityUniforms() {
  return {
    /** 0 = day, 1 = night: lit windows glow. */
    night: uniform(0),
    /** Lit window colour. */
    windowLight: uniform(new Color('#ffd59a')),
    /** Lit window brightness. */
    lightIntensity: uniform(2),
    /** Window glass colour. */
    glass: uniform(new Color('#33465a')),
    /** Window frame colour. */
    frame: uniform(new Color('#e8e4dc')),
    /** Per building style: bay width, window width, window height, sill. */
    windowA: uniformArray(BUILDING_STYLES.map(() => new Vector4(3, 1.4, 1.6, 0.9)), 'vec4'),
    /** Per building style: frame width, lit share, floor height, unused. */
    windowB: uniformArray(BUILDING_STYLES.map(() => new Vector4(0.1, 0.3, 3, 0)), 'vec4'),
    /** Pattern size multiplier (bricks, planks, tiles). */
    patternScale: uniform(1),
    /** Wall weather: wetness, snow, burn, damage. */
    wallWeather: uniform(new Vector4()),
    /** Roof weather: wetness, snow, burn, damage. */
    roofWeather: uniform(new Vector4()),
    /** Road weather: wetness, snow, burn, damage. */
    roadWeather: uniform(new Vector4()),
    /** Road base colour per surface (asphalt, cobblestone, gravel, dirt). */
    roadColors: uniformArray([new Color(), new Color(), new Color(), new Color()], 'color'),
    /** Sidewalk colour. */
    sidewalk: uniform(new Color('#a8a49c')),
    /** Kerb colour. */
    kerb: uniform(new Color('#bdb8ae')),
    /** Lane marking colour. */
    marking: uniform(new Color('#e9e9e2')),
    /** Arterial centre line colour. */
    centerLine: uniform(new Color('#e2b842')),
    /** Bridge concrete colour. */
    concrete: uniform(new Color('#9d9a93')),
    /** 1 = paint markings, 0 = none. */
    markings: uniform(1),
    /** Road wear 0..1. */
    wear: uniform(0.5),
  }
}

/** Shader uniforms of a city (`city.uniforms`). */
export type CityUniforms = ReturnType<typeof createCityUniforms>

/** Copies facade and weather options into the uniforms. */
export function applyFacadeUniforms(u: CityUniforms, f: FacadeOptions, floorHeight: Record<string, number>, weather: WeatherOptions): void {
  u.night.value = f.night
  u.windowLight.value.set(f.windowLight)
  u.lightIntensity.value = f.lightIntensity
  u.glass.value.set(f.glass)
  u.frame.value.set(f.frame)
  u.patternScale.value = f.patternScale
  BUILDING_STYLES.forEach((s, i) => {
    const w = f.windows[s]
    ;(u.windowA.array[i] as Vector4).set(w.bayWidth, w.windowWidth, w.windowHeight, w.sill)
    ;(u.windowB.array[i] as Vector4).set(w.frame, w.lit, floorHeight[s], 0)
  })
  const v = (w: Weather) => new Vector4(w.wetness, w.snow, w.burn, w.damage)
  u.wallWeather.value.copy(v(weather.walls))
  u.roofWeather.value.copy(v(weather.roofs))
  u.roadWeather.value.copy(v(weather.roads))
}

/**
 * Per-building weather overrides: one RGBA texel per building (wetness, snow, burn, damage as
 * 0..255). The shaders take the larger of this and the global material weather.
 */
export class BuildingWeather {
  /** The data texture (bind it into custom materials if you like). */
  readonly texture: DataTexture
  /** Texels per row. */
  readonly width: number

  /** Room for `count` buildings. */
  constructor(count: number) {
    this.width = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, count))))
    const h = Math.max(1, Math.ceil(Math.max(1, count) / this.width))
    this.texture = new DataTexture(new Uint8Array(this.width * h * 4), this.width, h, RGBAFormat, UnsignedByteType)
    this.texture.needsUpdate = true
  }

  /** Sets one building's weather (unspecified fields keep their value). */
  set(id: number, w: Partial<Weather>): void {
    const d = this.texture.image.data as Uint8Array
    const k = id * 4
    if (k + 3 >= d.length) return
    const b = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255)
    if (w.wetness !== undefined) d[k] = b(w.wetness)
    if (w.snow !== undefined) d[k + 1] = b(w.snow)
    if (w.burn !== undefined) d[k + 2] = b(w.burn)
    if (w.damage !== undefined) d[k + 3] = b(w.damage)
    this.texture.needsUpdate = true
  }

  /** Reads one building's weather. */
  get(id: number): Weather {
    const d = this.texture.image.data as Uint8Array
    const k = id * 4
    return { wetness: (d[k] ?? 0) / 255, snow: (d[k + 1] ?? 0) / 255, burn: (d[k + 2] ?? 0) / 255, damage: (d[k + 3] ?? 0) / 255 }
  }

  /** Clears every override. */
  clear(): void {
    ;(this.texture.image.data as Uint8Array).fill(0)
    this.texture.needsUpdate = true
  }

  /** Frees the texture. */
  dispose(): void {
    this.texture.dispose()
  }
}

/** Per-building weather: max(global, the building's texel). */
function buildingWeather(global: N, w: BuildingWeather): N {
  const id = int(attribute('bid', 'float'))
  const size = int(w.width)
  return max(global, textureLoad(w.texture, ivec2(id.mod(size), id.div(size))))
}

/** A shaded surface as TSL nodes (input and output of {@link weatherSurface}). */
export interface SurfaceShading {
  /** Albedo (vec3). */
  color: N
  /** Roughness (float). */
  roughness: N
  /** Metalness (float). */
  metalness: N
  /** Emission (vec3). */
  emissive: N
}

/**
 * Applies weather to a surface: wet darkening and gloss, snow on upward faces, char and embers,
 * cracks and holes. `p` is a position in metres (object space), `up` how much the surface faces up.
 */
export function weatherSurface(s: SurfaceShading, w: N, p: N, up: N, porosity: N = float(1)): SurfaceShading {
  const wet = w.x, snow = w.y, burn = w.z, damage = w.w
  let color = s.color.mul(float(1).sub(wet.mul(0.45).mul(porosity)))
  let roughness = s.roughness.mul(float(1).sub(wet.mul(0.7)))
  let metalness = s.metalness
  let emissive = s.emissive
  // Damage: thin cracks plus missing patches showing a dark interior.
  const n1 = mx_noise_float(p.mul(0.9))
  const crack = float(1).sub(smoothstep(0, damage.mul(0.04), abs(n1))).mul(step(0.01, damage))
  const hole = smoothstep(float(1).sub(damage.mul(0.5)), float(1.02).sub(damage.mul(0.5)), mx_noise_float(p.mul(0.23)).mul(0.5).add(0.5)).mul(step(0.01, damage))
  color = mix(color, color.mul(0.35), crack.mul(0.8))
  color = mix(color, vec3(0.02), hole)
  roughness = mix(roughness, float(1), hole)
  emissive = emissive.mul(float(1).sub(hole))
  // Burn: soot patches spreading with `burn`, embers glowing in the worst of it.
  const soot = mx_noise_float(p.mul(0.35).add(17.3)).mul(0.5).add(0.5)
  const char = smoothstep(float(1).sub(burn), float(1.15).sub(burn), soot.add(burn.mul(0.25)))
  color = mix(color, vec3(0.025, 0.022, 0.02), char)
  roughness = mix(roughness, float(1), char)
  metalness = mix(metalness, float(0), char)
  emissive = emissive.mul(float(1).sub(char)).add(vec3(1, 0.32, 0.06).mul(smoothstep(0.8, 1, burn).mul(smoothstep(0.92, 1, soot)).mul(3)))
  // Snow settles on upward faces, thinning with noise near its edge.
  const lie = smoothstep(0.35, 0.8, up.add(mx_noise_float(p.mul(0.5)).mul(0.15))).mul(smoothstep(0, 0.3, snow))
  const cover = clamp(lie.mul(snow.mul(1.6)), 0, 1)
  color = mix(color, vec3(0.92, 0.94, 0.97), cover)
  roughness = mix(roughness, float(0.75), cover)
  metalness = mix(metalness, float(0), cover)
  emissive = emissive.mul(float(1).sub(cover.mul(0.6)))
  return { color, roughness: clamp(roughness, 0.02, 1), metalness, emissive }
}

/**
 * Wall material: per-style window grids (lit cells hashed per window, glowing with `night`), frames
 * and mullions, shopfronts, and a procedural pattern per wall material (plaster, brick, wood planks,
 * stone, concrete panels, glass spandrels, adobe, corrugated metal), with weather.
 *
 * Geometry attributes: `uv` (metres along the wall, metres above the ground floor), `tint` (wall
 * colour), `facade` (style code (+8 = shops), per-wall seed, wall length (0 = no windows), material),
 * `bid` (building id).
 */
export function createFacadeMaterial(u: CityUniforms, weather: BuildingWeather): MeshStandardNodeMaterial {
  const f = attribute('facade', 'vec4') as N
  const tint = attribute('tint', 'vec3') as N
  const wuv = uv() as N
  const shops = step(7.5, f.x)
  const style = int(f.x.sub(shops.mul(8)))
  const A = (u.windowA as N).element(style), B = (u.windowB as N).element(style)
  const len = f.z, bayW = A.x, fh = max(B.z, 1)
  const nBays = floor(len.div(bayW))
  const lu = wuv.x.sub(len.sub(nBays.mul(bayW)).mul(0.5))
  const bayIdx = floor(lu.div(bayW))
  const fu = lu.sub(bayIdx.mul(bayW)).sub(bayW.mul(0.5))
  const v = wuv.y
  const floorIdx = floor(v.div(fh))
  const fv = v.sub(floorIdx.mul(fh))
  const shop = shops.mul(float(1).sub(step(0.5, floorIdx)))
  const ww = mix(A.y, bayW.mul(0.86), shop), wh = mix(A.z, fh.mul(0.72), shop), sill = mix(A.w, float(0.25), shop)
  const inside = step(0, lu).mul(step(lu, nBays.mul(bayW))).mul(step(0, v)).mul(step(0.5, nBays))
  const dx = abs(fu).sub(ww.mul(0.5)), dy = abs(fv.sub(sill.add(wh.mul(0.5)))).sub(wh.mul(0.5))
  const d = max(dx, dy)
  const aa = fwidth(v).add(0.003)
  const win = float(1).sub(smoothstep(aa.negate(), aa, d)).mul(inside)
  const frameW = B.x
  const ring = smoothstep(frameW.negate().sub(aa), frameW.negate().add(aa), d)
  const mullion = float(1).sub(smoothstep(frameW.mul(0.5).sub(aa), frameW.mul(0.5).add(aa), abs(fu))).mul(step(0.95, ww))
  const frame = max(ring, mullion).mul(win)
  const glassMask = win.sub(frame).max(0)
  const h1 = hash(bayIdx.add(500).add(floorIdx.mul(613)).add(f.y.mul(1e5)))
  const h2 = hash(h1.mul(65536).add(77))
  const lit = step(h1, B.y.add(shop.mul(0.45)))

  // Wall material patterns.
  const mat = f.w
  const s = u.patternScale
  const p = positionLocal as N
  const grain = mx_noise_float(p.mul(1.7)).mul(0.04)
  const brick = bond(wuv.x, v, s.mul(0.24), s.mul(0.075), s.mul(0.008))
  const stone = bond(wuv.x, v, s.mul(0.9), s.mul(0.45), s.mul(0.02))
  const plankRow = floor(v.div(s.mul(0.2)))
  const plank = float(1).sub(band(fract(v.div(s.mul(0.2))).sub(0.5), float(0.42))).mul(float(1).sub(smoothstep(0.1, 0.4, fwidth(v).div(s.mul(0.2)))))
  const panel = max(float(1).sub(band(fract(wuv.x.div(3)).sub(0.5).mul(3), float(1.48))), float(1).sub(band(fract(v.div(fh)).sub(0.5).mul(fh), fh.mul(0.5).sub(0.02))))
  const corrugation = sin(wuv.x.mul(Math.PI * 2).div(s.mul(0.15))).mul(0.06).mul(float(1).sub(smoothstep(0.03, 0.08, fwidth(wuv.x))))
  const stain = mx_noise_float(p.mul(0.15)).mul(0.08)
  let factor: N = float(1).add(grain).add(stain)
  factor = factor.add(eq(mat, 1).mul(brick.cell.sub(0.5).mul(0.22).mul(brick.fade).add(brick.joint.mul(0.3))))
  factor = factor.add(eq(mat, 2).mul(hash(plankRow.add(31)).sub(0.5).mul(0.16).sub(plank.mul(0.35))))
  factor = factor.add(eq(mat, 3).mul(stone.cell.sub(0.5).mul(0.28).mul(stone.fade).sub(stone.joint.mul(0.3))))
  factor = factor.add(eq(mat, 4).mul(panel.mul(-0.18)))
  factor = factor.add(eq(mat, 6).mul(float(1).sub(smoothstep(0, 0.7, v)).mul(-0.15).add(mx_noise_float(p.mul(0.4)).mul(0.06))))
  factor = factor.add(eq(mat, 7).mul(corrugation))
  const wallRough = mix(float(0.9), float(0.3), eq(mat, 5)).sub(eq(mat, 7).mul(0.45))
  const wallMetal = eq(mat, 5).mul(0.35).add(eq(mat, 7).mul(0.45))

  const glass = mix(u.glass, u.glass.mul(1.6), h2.mul(0.5))
  let color: N = mix(tint.mul(factor), glass, glassMask)
  color = mix(color, u.frame.mul(mix(float(1), tint.mul(0.8), eq(mat, 5))), frame)
  const roughness = mix(wallRough, float(0.12), glassMask)
  const metalness = mix(wallMetal, float(0.55), glassMask)
  const glow = u.windowLight.mul(u.lightIntensity).mul(u.night).mul(lit).mul(glassMask).mul(h2.mul(0.8).add(0.4))
  const w = buildingWeather(u.wallWeather, weather)
  const ws = weatherSurface({ color, roughness, metalness, emissive: glow }, w, p, (normalLocal as N).y, mix(float(1), float(0.3), glassMask))

  const m = new MeshStandardNodeMaterial()
  m.colorNode = vec4(ws.color, 1)
  m.roughnessNode = ws.roughness
  m.metalnessNode = ws.metalness
  m.emissiveNode = ws.emissive
  return m
}

/**
 * Roof and detail material: tiles, slates, shingles, standing-seam metal, thatch and concrete
 * patterns for roof surfaces (by `facade.w`), fixed colours for rooftop plant, glazing, chimneys,
 * metal, wood and railings (by `facade.x`, see `ROOF_PARTS`), with weather (snow settles here).
 * Pass `weather: null` for instanced details (global roof weather only). `shade` (float node) scales
 * the colour before weather, e.g. a per-instance shade: unlike a BatchedMesh instance colour, which
 * three.js multiplies in after `colorNode`, it leaves snow and ash untinted.
 */
export function createRoofMaterial(u: CityUniforms, weather: BuildingWeather | null, shade: N = float(1)): MeshStandardNodeMaterial {
  const f = attribute('facade', 'vec4') as N
  const tint = attribute('tint', 'vec3') as N
  const ruv = uv() as N
  const p = positionLocal as N
  const part = f.x, mat = f.w
  const s = u.patternScale
  const tile = bond(ruv.x, ruv.y, s.mul(0.25), s.mul(0.32), s.mul(0.01))
  const tileShade = sin(fract(ruv.x.div(s.mul(0.25))).mul(Math.PI)).mul(0.18).mul(tile.fade)
  const slate = bond(ruv.x, ruv.y, s.mul(0.35), s.mul(0.25), s.mul(0.012))
  const shingle = bond(ruv.x, ruv.y, s.mul(0.3).mul(hash(floor(ruv.y.div(s.mul(0.2))).add(16384)).add(0.6)), s.mul(0.2), s.mul(0.01))
  const seam = float(1).sub(band(fract(ruv.x.div(s.mul(0.5))).sub(0.5), float(0.47))).mul(float(1).sub(smoothstep(0.1, 0.4, fwidth(ruv.x).div(s.mul(0.5)))))
  const fibres = mx_noise_float(vec3(ruv.x.mul(9), ruv.y.mul(0.6), 3.1)).mul(0.18)
  const gravel = mx_noise_float(p.mul(3)).mul(0.05).add(mx_noise_float(p.mul(0.2)).mul(0.08))
  let factor: N = float(1)
  factor = factor.add(eq(mat, 0).mul(tile.cell.sub(0.5).mul(0.18).add(tileShade).sub(tile.joint.mul(0.3))))
  factor = factor.add(eq(mat, 1).mul(slate.cell.sub(0.5).mul(0.16).sub(slate.joint.mul(0.35))))
  factor = factor.add(eq(mat, 2).mul(shingle.cell.sub(0.5).mul(0.2).sub(shingle.joint.mul(0.3))))
  factor = factor.add(eq(mat, 3).mul(seam.mul(0.25)))
  factor = factor.add(eq(mat, 4).mul(fibres))
  factor = factor.add(eq(mat, 5).mul(gravel))
  const roofRough = mix(float(0.8), float(0.35), eq(mat, 3))
  const roofMetal = eq(mat, 3).mul(0.5)

  const isRoof = eq(part, 0)
  let color: N = tint.mul(factor).mul(isRoof)
  color = color.add(eq(part, 1).mul(vec3(0.6, 0.6, 0.58).mul(float(1).add(gravel))))
  color = color.add(eq(part, 2).mul(u.glass))
  const chimney = bond(p.x.add(p.z), p.y, float(0.24), float(0.075), float(0.008))
  color = color.add(eq(part, 3).mul(vec3(0.42, 0.2, 0.15).mul(float(1).sub(chimney.joint.mul(0.3)))))
  color = color.add(eq(part, 4).mul(vec3(0.55, 0.57, 0.58)))
  color = color.add(eq(part, 5).mul(vec3(0.24, 0.17, 0.11)))
  color = color.add(eq(part, 6).mul(vec3(0.12, 0.13, 0.14)))
  const roughness = isRoof.mul(roofRough).add(eq(part, 2).mul(0.1)).add(eq(part, 4).mul(0.4)).add(eq(part, 6).mul(0.35)).add(eq(part, 1).add(eq(part, 3)).add(eq(part, 5)).mul(0.9))
  const metalness = isRoof.mul(roofMetal).add(eq(part, 2).mul(0.6)).add(eq(part, 4).mul(0.6)).add(eq(part, 6).mul(0.5))
  const glow = u.windowLight.mul(u.lightIntensity).mul(u.night).mul(eq(part, 2)).mul(0.5)
  const w = weather ? buildingWeather(u.roofWeather, weather) : u.roofWeather
  const ws = weatherSurface({ color: color.mul(shade), roughness, metalness, emissive: glow }, w, p, (normalLocal as N).y)

  const m = new MeshStandardNodeMaterial()
  m.colorNode = vec4(ws.color, 1)
  m.roughnessNode = ws.roughness
  m.metalnessNode = ws.metalness
  m.emissiveNode = ws.emissive
  return m
}

