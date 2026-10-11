/**
 * City lights on the night side of the planet, seen from altitude and orbit. The lights come from a
 * field you provide — a `(latitude, longitude) => 0..1` callback (e.g. population per hex cell) baked
 * into an equirectangular texture, or a texture directly — or from a seeded procedural field. Glowing
 * dots are broken up at sub-texel scale, so they look like settlements rather than blurry blobs, and
 * fade with the local sun angle. Terrain that draws the planet itself can use {@link nightLightsNode}.
 */
import { ClampToEdgeWrapping, DataTexture, LinearFilter, RGBAFormat, RepeatWrapping, UnsignedByteType, Vector3, type Texture } from 'three/webgpu'
import { asin, atan, clamp, dot, float, mx_fractal_noise_float, mx_noise_float, smoothstep, texture, uniform, vec2, vec3 } from 'three/tsl'
import { DEG, hexToLinear } from './util.ts'

/** Night-light settings. Plain JSON. */
export interface NightLightsOptions {
  /** Show lights on the night side. */
  enabled: boolean
  /** Radiance of a fully lit area. */
  intensity: number
  /** Light colour (`#rrggbb`); sodium-orange by default. */
  color: string
  /** Procedural field (when no callback/texture is set): how much of the planet is settled, 0..1. */
  density: number
  /** Feature size of the procedural field relative to the planet (larger = more, smaller regions). */
  scale: number
  /** Sun elevations (degrees, at the lit point) between which lights switch on. */
  twilight: [number, number]
  /** Equirectangular resolution used to bake a lights callback, [width, height]. */
  resolution: [number, number]
}

/** Defaults. */
export const DEFAULT_NIGHT_LIGHTS: NightLightsOptions = {
  enabled: true,
  intensity: 1,
  color: '#ffb35c',
  density: 0.35,
  scale: 1,
  twilight: [3, -8],
  resolution: [1024, 512],
}

/** A night-lights field: brightness 0..1 at a latitude/longitude in degrees. */
export type LightsField = (latitude: number, longitude: number) => number

/**
 * Bakes a lights field into an equirectangular texture (u = longitude, 0 at the centre; v = latitude,
 * south at the bottom row). Longitude 0 is on the body frame's +Z, like `threejs-biomes` planets.
 */
export function bakeNightLights(field: LightsField, width = 1024, height = 512): DataTexture {
  const data = new Uint8Array(width * height * 4)
  for (let j = 0; j < height; j++) {
    const lat = -90 + ((j + 0.5) / height) * 180
    for (let i = 0; i < width; i++) {
      const lon = -180 + ((i + 0.5) / width) * 360
      const v = Math.max(0, Math.min(1, field(lat, lon) || 0)) * 255
      const k = (j * width + i) * 4
      data[k] = data[k + 1] = data[k + 2] = v
      data[k + 3] = 255
    }
  }
  const t = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType)
  t.wrapS = RepeatWrapping
  t.wrapT = ClampToEdgeWrapping
  t.minFilter = t.magFilter = LinearFilter
  t.needsUpdate = true
  return t
}

const blank = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
blank.needsUpdate = true

/** Creates the night-light uniforms. */
export function createNightLightUniforms() {
  return {
    /** Radiance of fully lit areas (0 = off). */
    intensity: uniform(0.6),
    /** Light colour (linear). */
    color: uniform(new Vector3(1, 0.6, 0.25)),
    /** 1 = use the texture, 0 = procedural. */
    useTexture: uniform(0),
    /** Lights texture (equirectangular). */
    map: texture(blank),
    /** Procedural coverage. */
    density: uniform(0.35),
    /** Procedural feature scale. */
    scale: uniform(1),
    /** Sun-elevation sines where lights switch on (start, full). */
    twilight: uniform(new Vector3(Math.sin(3 * DEG), Math.sin(-8 * DEG), 0)),
    /** Planet radius, metres (sets the size of the sparkle). */
    planetRadius: uniform(6.371e6),
  }
}

/** Night-light uniforms (`sky.nightLights`). */
export type NightLightUniforms = ReturnType<typeof createNightLightUniforms>

/** Copies options into the uniforms. */
export function applyNightLights(u: NightLightUniforms, o: NightLightsOptions) {
  u.intensity.value = o.enabled ? o.intensity : 0
  u.color.value.set(...hexToLinear(o.color))
  u.density.value = o.density
  u.scale.value = o.scale
  u.twilight.value.set(Math.sin(o.twilight[0] * DEG), Math.sin(o.twilight[1] * DEG), 0)
}

/** Points the uniforms at a lights texture (or back to the procedural field with `null`). */
export function setNightLightsTexture(u: NightLightUniforms, map: Texture | null) {
  u.map.value = map ?? blank
  u.useTexture.value = map ? 1 : 0
}

/**
 * Night-light radiance at a point on the planet. Use it in a planet terrain material's emissive.
 * @param bodyDir Unit direction from the planet centre in the body frame.
 * @param sunDir Unit direction to the sun in the same frame.
 */
export function nightLightsNode(u: NightLightUniforms, bodyDir: any, sunDir: any): any {
  const lon = atan(bodyDir.x, bodyDir.z)
  const lat = asin(clamp(bodyDir.y, -1, 1))
  const uv = vec2(lon.div(2 * Math.PI).add(0.5), lat.div(Math.PI).add(0.5))
  const fromMap = u.map.sample(uv).r
  // Procedural: settled regions avoid the poles and cluster along noise "coasts".
  const p = bodyDir.mul(u.scale)
  const regions = smoothstep(float(0.62).sub(u.density.mul(0.5)), float(0.8).sub(u.density.mul(0.5)), mx_fractal_noise_float(p.mul(3.1).add(vec3(4.2, 1.7, 9.3)), 4, 2, 0.5).mul(0.5).add(0.5))
  const towns = smoothstep(0.25, 0.6, mx_fractal_noise_float(p.mul(22).add(vec3(1.3, 8.1, 2.2)), 3, 2.2, 0.55).mul(0.5).add(0.5))
  const procedural = regions.mul(towns).mul(smoothstep(0.92, 0.7, bodyDir.y.abs()))
  const field = u.useTexture.greaterThan(0.5).select(fromMap, procedural)
  // Break the field into lit dots at ~20 km (scaled with the planet), so it reads as settlements.
  const sparkle = smoothstep(0.1, 0.55, mx_noise_float(bodyDir.mul(u.planetRadius.div(20_000)))).mul(0.85).add(0.15)
  const dark = smoothstep(u.twilight.x, u.twilight.y, dot(bodyDir, sunDir))
  return u.color.mul(field.mul(sparkle).mul(dark).mul(u.intensity))
}
