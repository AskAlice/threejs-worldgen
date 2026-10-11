/**
 * Two-body Keplerian orbits: Kepler's equation, position and velocity from orbital elements.
 *
 * Frame: the parent's ecliptic frame in three.js orientation, **y up**. The reference plane is XZ,
 * +Y is ecliptic north, +X points to the vernal equinox and −Z is 90° of ecliptic longitude further on
 * (an astronomical (x, y, z) maps to (x, z, −y) here). Distances in metres, times in seconds since J2000.
 */
import { DEG, type Vec3 } from './util.ts'

/** Classical orbital elements, at the J2000 epoch. Angles in degrees. Plain JSON. */
export interface OrbitalElements {
  /** Semi-major axis, metres. */
  semiMajorAxis: number
  /** Eccentricity, 0 (circle) ≤ e < 1. */
  eccentricity: number
  /** Inclination to the parent's reference plane, degrees. */
  inclination: number
  /** Longitude of the ascending node (Ω), degrees. */
  longitudeOfAscendingNode: number
  /** Argument of periapsis (ω), degrees. */
  argumentOfPeriapsis: number
  /** Mean anomaly at the epoch (M₀), degrees. */
  meanAnomalyAtEpoch: number
  /** Orbital period, seconds. 0 = derive it from the parent's gravitational parameter (GM). */
  period: number
}

/** Position and velocity relative to the parent body. */
export interface OrbitState {
  /** Position, metres. */
  position: Vec3
  /** Velocity, metres per second. */
  velocity: Vec3
}

/** Orbital period `2π √(a³ / GM)`, seconds. */
export function orbitalPeriod(semiMajorAxis: number, gm: number): number {
  return 2 * Math.PI * Math.sqrt((semiMajorAxis * semiMajorAxis * semiMajorAxis) / gm)
}

/** Mean motion (radians per second) of an orbit around a parent with gravitational parameter `gm`. */
export function meanMotion(el: OrbitalElements, gm: number): number {
  return el.period > 0 ? (2 * Math.PI) / el.period : Math.sqrt(gm / (el.semiMajorAxis * el.semiMajorAxis * el.semiMajorAxis))
}

/**
 * Solves Kepler's equation `M = E − e·sin E` for the eccentric anomaly E (radians), for 0 ≤ e < 1.
 * Newton iteration from Danby's starting value, safeguarded by bisection so it converges for any M,
 * including eccentricities up to 0.99 and beyond.
 */
export function solveKepler(meanAnomaly: number, e: number, tolerance = 1e-14): number {
  // Reduce M to [-π, π]; E is then in [M - e, M + e] with the same sign.
  const twoPi = 2 * Math.PI
  const turns = Math.round(meanAnomaly / twoPi)
  const M = meanAnomaly - turns * twoPi
  if (e === 0) return meanAnomaly
  let lo = M - e, hi = M + e
  let E = M + 0.85 * e * Math.sign(Math.sin(M))
  for (let i = 0; i < 100; i++) {
    const f = E - e * Math.sin(E) - M
    if (f === 0) break
    if (f > 0) hi = E
    else lo = E
    let next = E - f / (1 - e * Math.cos(E))
    if (!(next >= lo && next <= hi)) next = 0.5 * (lo + hi) // Newton left the bracket: bisect instead
    if (Math.abs(next - E) <= tolerance * Math.max(1, Math.abs(E))) {
      E = next
      break
    }
    E = next
  }
  return E + turns * twoPi
}

/** Fills the in-plane unit vectors P (towards periapsis) and Q (90° ahead) in the y-up frame. */
function perifocal(el: OrbitalElements, P: Vec3, Q: Vec3) {
  const O = el.longitudeOfAscendingNode * DEG, w = el.argumentOfPeriapsis * DEG, i = el.inclination * DEG
  const cO = Math.cos(O), sO = Math.sin(O), cw = Math.cos(w), sw = Math.sin(w), ci = Math.cos(i), si = Math.sin(i)
  // Astronomical z-up components, then (x, y, z) → (x, z, -y).
  const px = cO * cw - sO * sw * ci, py = sO * cw + cO * sw * ci, pz = sw * si
  const qx = -cO * sw - sO * cw * ci, qy = -sO * sw + cO * cw * ci, qz = cw * si
  P[0] = px; P[1] = pz; P[2] = -py
  Q[0] = qx; Q[1] = qz; Q[2] = -qy
}

const _P: Vec3 = [0, 0, 0], _Q: Vec3 = [0, 0, 0]

/**
 * Position and velocity at `time` (seconds since J2000) relative to the parent.
 * @param gm Parent's gravitational parameter, m³/s². Only used when `el.period` is 0.
 */
export function orbitState(el: OrbitalElements, gm: number, time: number, out: OrbitState = { position: [0, 0, 0], velocity: [0, 0, 0] }): OrbitState {
  const a = el.semiMajorAxis, e = el.eccentricity
  const n = meanMotion(el, gm)
  const E = solveKepler(el.meanAnomalyAtEpoch * DEG + n * time, e)
  const cE = Math.cos(E), sE = Math.sin(E)
  const b = a * Math.sqrt(1 - e * e)
  const x = a * (cE - e), y = b * sE
  const k = n / (1 - e * cE)
  const vx = -a * sE * k, vy = b * cE * k
  perifocal(el, _P, _Q)
  const p = out.position, v = out.velocity
  for (let j = 0; j < 3; j++) {
    p[j] = _P[j] * x + _Q[j] * y
    v[j] = _P[j] * vx + _Q[j] * vy
  }
  return out
}

/** Unit normal of the orbital plane (direction of the angular momentum) in the y-up frame. */
export function orbitNormal(el: OrbitalElements): Vec3 {
  perifocal(el, _P, _Q)
  const [px, py, pz] = _P, [qx, qy, qz] = _Q
  return [py * qz - pz * qy, pz * qx - px * qz, px * qy - py * qx]
}

/**
 * Points along the whole ellipse (relative to the parent), for drawing orbit lines. Spaced evenly in
 * eccentric anomaly, which puts more points near periapsis where the path bends most.
 * @returns `segments` points as a flat [x, y, z, …] array, metres.
 */
export function orbitPath(el: OrbitalElements, segments = 256): Float64Array {
  const a = el.semiMajorAxis, e = el.eccentricity, b = a * Math.sqrt(1 - e * e)
  perifocal(el, _P, _Q)
  const out = new Float64Array(segments * 3)
  for (let s = 0; s < segments; s++) {
    const E = (s / segments) * 2 * Math.PI
    const x = a * (Math.cos(E) - e), y = b * Math.sin(E)
    for (let j = 0; j < 3; j++) out[s * 3 + j] = _P[j] * x + _Q[j] * y
  }
  return out
}

/** The two apsides of an orbit (relative to the parent). */
export interface Apsides {
  /** Closest distance (periapsis: perigee around a planet, perihelion around a star), metres. */
  periapsis: number
  /** Farthest distance (apoapsis: apogee / aphelion), metres. */
  apoapsis: number
  /** Periapsis position relative to the parent, metres. */
  periapsisPosition: Vec3
  /** Apoapsis position relative to the parent, metres. */
  apoapsisPosition: Vec3
  /** Next time at or after `from` the body passes periapsis, seconds since J2000. */
  nextPeriapsis: number
  /** Next time at or after `from` the body passes apoapsis, seconds since J2000. */
  nextApoapsis: number
}

/**
 * Periapsis and apoapsis of an orbit: distances, positions and the next passage times after `from`.
 * @param gm Parent's gravitational parameter (only used when `el.period` is 0).
 */
export function apsides(el: OrbitalElements, gm: number, from = 0): Apsides {
  const a = el.semiMajorAxis, e = el.eccentricity
  perifocal(el, _P, _Q)
  const n = meanMotion(el, gm)
  const twoPi = 2 * Math.PI
  const M = el.meanAnomalyAtEpoch * DEG + n * from
  const until = (target: number) => ((((target - M) % twoPi) + twoPi) % twoPi) / n
  return {
    periapsis: a * (1 - e),
    apoapsis: a * (1 + e),
    periapsisPosition: [_P[0] * a * (1 - e), _P[1] * a * (1 - e), _P[2] * a * (1 - e)],
    apoapsisPosition: [-_P[0] * a * (1 + e), -_P[1] * a * (1 + e), -_P[2] * a * (1 + e)],
    nextPeriapsis: from + until(0),
    nextApoapsis: from + until(Math.PI),
  }
}

/** Conventional names of the apsides around a parent: perigee/apogee (home planet), perihelion/aphelion (star), else periapsis/apoapsis. */
export function apsisNames(parentKind: 'star' | 'planet' | 'moon' | 'home'): [string, string] {
  return parentKind === 'home' ? ['perigee', 'apogee'] : parentKind === 'star' ? ['perihelion', 'aphelion'] : ['periapsis', 'apoapsis']
}
