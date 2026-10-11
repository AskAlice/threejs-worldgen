/**
 * What an observer on the home planet sees: sun and moon directions, elevations, the moon's phase,
 * and the rotation from render space to the fixed stars. Pure maths, no three.js.
 *
 * Render space is one of:
 * - `'local'`: a flat tangent frame at the observer — x east, y up, z south (three.js: −z is north).
 *   Use it for flat worlds and for terrain built in a `threejs-biomes` `LocalFrame`. A flat world is
 *   treated as sitting at `latitude`/`longitude` on a virtual planet the size of the home planet.
 * - `'planet'`: the home planet's body-fixed frame (planet-centred, +Y north pole, longitude 0 on +Z),
 *   translated so the planet centre is at `planetCenter`. The observer is wherever the camera is.
 */
import type { StarSystem } from './bodies.ts'
import type { LayerName } from './layers.ts'
import { DEG, clamp, fromColumns, identity, mulMat, mulVec, mulVecT, normalize, sub, transpose, type Mat3, type Vec3 } from './util.ts'

/** How render space maps onto the home planet; see the module docs. */
export type SkyFrame = 'local' | 'planet'

/** Where the observer is. Plain JSON. */
export interface ObserverOptions {
  /** `'local'` (flat tangent frame) or `'planet'` (planet-centred body frame). */
  frame: SkyFrame
  /** Observer latitude, degrees (local frame only; the planet frame uses the camera position). */
  latitude: number
  /** Observer longitude, degrees east (local frame only). */
  longitude: number
  /** Planet frame: render-space position of the planet centre, metres. Move it for a floating origin. */
  planetCenter: [number, number, number]
}

/** Default observer: 45° N on the prime meridian, in a local frame. */
export const DEFAULT_OBSERVER: ObserverOptions = { frame: 'local', latitude: 45, longitude: 0, planetCenter: [0, 0, 0] }

/** Everything the sky knows about one instant, as seen from the camera. Directions are unit render-space vectors. */
export interface SkyState {
  /** Simulation seconds since J2000. */
  time: number
  /** Render-space convention in use. */
  frame: SkyFrame
  /** Observer latitude, degrees. */
  latitude: number
  /** Observer longitude, degrees. */
  longitude: number
  /** Camera height above the planet's base sphere, metres. */
  altitude: number
  /** Home planet radius, metres. */
  planetRadius: number
  /** Camera position minus planet centre, render space, metres (feed this to ray-marchers). */
  cameraToPlanet: Vec3
  /** Local up at the observer. */
  up: Vec3
  /** Local east at the observer. */
  east: Vec3
  /** Local north at the observer. */
  north: Vec3
  /** Towards the sun. */
  sunDirection: Vec3
  /** Towards the moon (topocentric: includes parallax). */
  moonDirection: Vec3
  /** Sun elevation above the horizon, degrees. */
  sunElevation: number
  /** Sun azimuth, degrees from north through east. */
  sunAzimuth: number
  /** Moon elevation, degrees. */
  moonElevation: number
  /** Moon azimuth, degrees. */
  moonAzimuth: number
  /** Distance to the sun, metres. */
  sunDistance: number
  /** Distance to the moon, metres (Infinity without a moon). */
  moonDistance: number
  /** Apparent radius of the sun disc, radians. */
  sunAngularRadius: number
  /** Apparent radius of the moon disc, radians (0 without a moon). */
  moonAngularRadius: number
  /** Lit fraction of the moon disc, 0 (new) .. 1 (full). */
  moonIllumination: number
  /** Sun–moon–observer angle, degrees: 180 at new moon, 0 at full. */
  moonPhaseAngle: number
  /** Position in the lunar cycle, 0..1: 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter. */
  moonPhase: number
  /** Local apparent solar time at the observer, hours 0..24 (12 = sun on the meridian). */
  solarTime: number
  /** Rotation from render space to the star frame (fixed stars). Stars use it; it turns with sidereal time. */
  celestialMatrix: Mat3
  /** Rotation from render space into the home planet's body frame (identity in the planet frame). */
  bodyMatrix: Mat3
  /** Rotation from render space into the moon's body frame (keeps its maria facing the planet). */
  moonMatrix: Mat3
  /** 0 by day … 1 at night (set by `Sky` from its twilight settings). */
  night: number
  /** Luminance of the sky at the zenith, in renderer units (set by `Sky`). */
  skyLuminance: number
  /** Atmosphere layer the camera is in (set by `Sky`). */
  layer: LayerName
}

/** A neutral state: noon-ish sun, no moon, identity rotation, full night for stars. Used by standalone layers. */
export function defaultSkyState(): SkyState {
  return {
    time: 0, frame: 'local', latitude: 45, longitude: 0, altitude: 0, planetRadius: 6.371e6, cameraToPlanet: [0, 6.371e6, 0],
    up: [0, 1, 0], east: [1, 0, 0], north: [0, 0, -1], sunDirection: [0, 1, 0], moonDirection: [0, -1, 0],
    sunElevation: 90, sunAzimuth: 0, moonElevation: -90, moonAzimuth: 0, sunDistance: 1.496e11, moonDistance: Infinity,
    sunAngularRadius: 0.00465, moonAngularRadius: 0, moonIllumination: 0, moonPhaseAngle: 180, moonPhase: 0, solarTime: 12,
    celestialMatrix: identity(), bodyMatrix: identity(), moonMatrix: identity(), night: 1, skyLuminance: 0, layer: 'troposphere',
  }
}

/** Body-frame up/east/north at a latitude/longitude (same convention as `threejs-biomes`). */
export function surfaceFrame(latitude: number, longitude: number): { up: Vec3; east: Vec3; north: Vec3 } {
  const la = latitude * DEG, lo = longitude * DEG
  const up: Vec3 = [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)]
  const east: Vec3 = [Math.cos(lo), 0, -Math.sin(lo)]
  const north: Vec3 = [-Math.sin(la) * Math.sin(lo), Math.cos(la), -Math.sin(la) * Math.cos(lo)]
  return { up, east, north }
}

const _a: Vec3 = [0, 0, 0], _b: Vec3 = [0, 0, 0], _c: Vec3 = [0, 0, 0]
const _sun: Vec3 = [0, 0, 0], _moon: Vec3 = [0, 0, 0], _home: Vec3 = [0, 0, 0], _obs: Vec3 = [0, 0, 0]

/**
 * Computes the sky as seen from the camera at `time`.
 * @param camera Camera position in render space (metres). In the local frame its y is the altitude.
 */
export function observe(system: StarSystem, time: number, observer: ObserverOptions, camera: Vec3 = [0, 0, 0], out: SkyState = defaultSkyState()): SkyState {
  const home = system.home
  const R = home.radius
  out.time = time
  out.frame = observer.frame
  out.planetRadius = R

  // Observer on the planet, in body coordinates, and the render → body rotation.
  let renderToBody: Mat3
  let obsBody: Vec3
  if (observer.frame === 'planet') {
    const rel = sub(camera, observer.planetCenter, _a)
    const r = Math.hypot(rel[0], rel[1], rel[2]) || R
    out.latitude = Math.asin(clamp(rel[1] / r, -1, 1)) / DEG
    out.longitude = Math.atan2(rel[0], rel[2]) / DEG
    const f = surfaceFrame(out.latitude, out.longitude)
    out.up = f.up; out.east = f.east; out.north = f.north
    out.altitude = r - R
    out.cameraToPlanet = [rel[0], rel[1], rel[2]]
    renderToBody = identity()
    obsBody = r === 0 ? [0, R, 0] : [rel[0], rel[1], rel[2]]
  } else {
    out.latitude = observer.latitude
    out.longitude = observer.longitude
    const f = surfaceFrame(observer.latitude, observer.longitude)
    out.up = [0, 1, 0]; out.east = [1, 0, 0]; out.north = [0, 0, -1]
    out.altitude = camera[1]
    out.cameraToPlanet = [0, R + camera[1], 0] // a virtual planet right under the camera
    renderToBody = fromColumns(f.east, f.up, [-f.north[0], -f.north[1], -f.north[2]])
    obsBody = [f.up[0] * (R + camera[1]), f.up[1] * (R + camera[1]), f.up[2] * (R + camera[1])]
  }

  const bodyToStar = system.orientation(home.index, time)
  const C = mulMat(bodyToStar, renderToBody)
  out.celestialMatrix = C
  out.bodyMatrix = renderToBody

  const homePos = system.position(home.index, time, _home)
  const obs = mulVec(bodyToStar, obsBody, _obs)
  obs[0] += homePos[0]; obs[1] += homePos[1]; obs[2] += homePos[2]

  // Sun.
  const sunPos = system.position(0, time, _sun)
  const toSun = sub(sunPos, obs, _b)
  out.sunDistance = Math.hypot(toSun[0], toSun[1], toSun[2])
  out.sunDirection = normalize(mulVecT(C, toSun, [0, 0, 0]))
  out.sunAngularRadius = Math.asin(Math.min(1, system.star.radius / out.sunDistance))
  ;[out.sunElevation, out.sunAzimuth] = horizontal(out, out.sunDirection)

  // Solar time from the sun's longitude in the body frame.
  const sunBody = mulVecT(bodyToStar, sub(sunPos, homePos, _c), _c)
  const sunLon = Math.atan2(sunBody[0], sunBody[2]) / DEG
  out.solarTime = (((12 + (out.longitude - sunLon) / 15) % 24) + 24) % 24

  // Moon.
  const moon = system.moon
  if (moon) {
    const moonPos = system.position(moon.index, time, _moon)
    const toMoon = sub(moonPos, obs, _c)
    out.moonDistance = Math.hypot(toMoon[0], toMoon[1], toMoon[2])
    out.moonDirection = normalize(mulVecT(C, toMoon, [0, 0, 0]))
    out.moonAngularRadius = Math.asin(Math.min(1, moon.radius / out.moonDistance))
    ;[out.moonElevation, out.moonAzimuth] = horizontal(out, out.moonDirection)
    const phase = moonPhase(sunPos, moonPos, obs, homePos)
    out.moonPhaseAngle = phase.phaseAngle
    out.moonIllumination = phase.illumination
    out.moonPhase = phase.cycle
    out.moonMatrix = mulMat(transpose(system.orientation(moon.index, time)), C)
  } else {
    out.moonDistance = Infinity
    out.moonAngularRadius = 0
    out.moonIllumination = 0
    out.moonElevation = -90
  }
  return out
}

/** Elevation and azimuth (degrees) of a render-space direction in the observer's horizon frame. */
export function horizontal(state: Pick<SkyState, 'up' | 'east' | 'north'>, dir: Vec3): [elevation: number, azimuth: number] {
  const u = dir[0] * state.up[0] + dir[1] * state.up[1] + dir[2] * state.up[2]
  const e = dir[0] * state.east[0] + dir[1] * state.east[1] + dir[2] * state.east[2]
  const n = dir[0] * state.north[0] + dir[1] * state.north[1] + dir[2] * state.north[2]
  return [Math.asin(clamp(u, -1, 1)) / DEG, ((Math.atan2(e, n) / DEG) + 360) % 360]
}

/** Moon phase quantities from positions (any common frame, y-up ecliptic for `cycle`). */
export interface MoonPhase {
  /** Sun–moon–observer angle, degrees (0 = full, 180 = new). */
  phaseAngle: number
  /** Lit fraction of the disc, `(1 + cos phaseAngle) / 2`. */
  illumination: number
  /** Lunar cycle position 0..1 from the moon–sun elongation in ecliptic longitude (0 new, 0.5 full). */
  cycle: number
}

/**
 * Moon phase from geometry alone: the lit fraction follows from the angle at the moon between the
 * sun and the observer. `planet` is the planet centre, used for the waxing/waning cycle.
 */
export function moonPhase(sun: Vec3, moon: Vec3, observer: Vec3, planet: Vec3 = observer): MoonPhase {
  const s = normalize([sun[0] - moon[0], sun[1] - moon[1], sun[2] - moon[2]])
  const o = normalize([observer[0] - moon[0], observer[1] - moon[1], observer[2] - moon[2]])
  const cosA = clamp(s[0] * o[0] + s[1] * o[1] + s[2] * o[2], -1, 1)
  // Ecliptic longitude in the y-up frame: atan2(-z, x).
  const lon = (v: Vec3) => Math.atan2(-(v[2] - planet[2]), v[0] - planet[0])
  const elong = (lon(moon) - lon(sun)) / (2 * Math.PI)
  return { phaseAngle: Math.acos(cosA) / DEG, illumination: (1 + cosA) / 2, cycle: ((elong % 1) + 1) % 1 }
}

/** Common names of the moon's phases for a cycle value 0..1. */
export function moonPhaseName(cycle: number): string {
  const names = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent']
  return names[Math.round((((cycle % 1) + 1) % 1) * 8) % 8]
}

/** Sun elevation (degrees) seen from latitude/longitude on the home planet's surface at `time`. */
export function sunElevationAt(system: StarSystem, time: number, latitude: number, longitude: number): number {
  return observe(system, time, { frame: 'local', latitude, longitude, planetCenter: [0, 0, 0] }).sunElevation
}

/** Times of sunrise and sunset found by {@link sunTimes}; `null` when the sun doesn't cross (polar day or night). */
export interface SunTimes {
  /** Next sunrise after `from`, simulation seconds since J2000. */
  sunrise: number | null
  /** Next sunset after `from`, simulation seconds since J2000. */
  sunset: number | null
}

/**
 * Next sunrise and sunset within one solar day after `from`, by scanning the sun's elevation and
 * bisecting the crossings. `horizon` defaults to −0.833° (upper limb plus standard refraction).
 */
export function sunTimes(system: StarSystem, from: number, latitude: number, longitude: number, horizon = -0.833): SunTimes {
  const day = system.solarDay()
  const steps = 96
  const f = (t: number) => sunElevationAt(system, t, latitude, longitude) - horizon
  const out: SunTimes = { sunrise: null, sunset: null }
  let t0 = from, f0 = f(t0)
  for (let i = 1; i <= steps && (out.sunrise === null || out.sunset === null); i++) {
    const t1 = from + (day * i) / steps, f1 = f(t1)
    if (f0 <= 0 !== f1 <= 0) {
      let lo = t0, hi = t1, flo = f0
      for (let k = 0; k < 50; k++) {
        const mid = 0.5 * (lo + hi), fm = f(mid)
        if (fm <= 0 === flo <= 0) { lo = mid; flo = fm } else hi = mid
      }
      const t = 0.5 * (lo + hi)
      if (f0 <= 0) out.sunrise ??= t
      else out.sunset ??= t
    }
    t0 = t1; f0 = f1
  }
  return out
}
