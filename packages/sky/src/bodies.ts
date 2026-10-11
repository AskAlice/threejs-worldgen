/**
 * Celestial bodies and the star system model: a star, the home planet, its moon and a few seeded
 * procedural planets, with Keplerian orbits and spin. Pure maths in float64, positions in metres in
 * the star's y-up ecliptic frame (see `kepler.ts`). No three.js.
 *
 * Body-fixed frame (the same as `threejs-biomes` planets): +Y is the north pole, longitude 0 is on +Z
 * and longitude grows towards +X (east).
 */
import { apsides, apsisNames, orbitalPeriod, orbitState, type Apsides, type OrbitalElements, type OrbitState } from './kepler.ts'
import { DEG, merge, mulberry32, mulMat, mulVecT, rotationX, rotationY, seedOf, hash3, type DeepPartial, type Mat3, type Vec3 } from './util.ts'

/** Gravitational constant, m³ kg⁻¹ s⁻². */
export const G = 6.6743e-11
/** One astronomical unit, metres. */
export const AU = 1.495978707e11

/** What a body is, which picks its default look. */
export type BodyKind = 'star' | 'planet' | 'moon'

/** Procedural surface style used by the solar-system view. */
export type SurfaceStyle = 'star' | 'ocean' | 'rocky' | 'desert' | 'gas' | 'ice' | 'moon'

/** Planetary rings, in multiples of the body radius. */
export interface RingOptions {
  /** Inner edge, × radius. */
  inner: number
  /** Outer edge, × radius. */
  outer: number
  /** Base colour (`#rrggbb`). */
  color: string
  /** Overall opacity, 0..1. */
  opacity: number
}

/** Thin atmosphere glow drawn around a body in the solar-system view. */
export interface BodyAtmosphere {
  /** Glow colour (`#rrggbb`). */
  color: string
  /** Glow strength, 0..2. */
  density: number
}

/** One body of a star system. Plain JSON. */
export interface BodyOptions {
  /** Unique name. The defaults are `'sun'`, `'home'` and `'moon'`. */
  name: string
  /** Star, planet or moon. */
  kind: BodyKind
  /** Name of the body it orbits; `null` for the central star. */
  parent: string | null
  /** Mean radius, metres. */
  radius: number
  /** Gravitational parameter GM, m³/s² (the mass that children orbit). */
  gm: number
  /** Orbit around `parent`; `null` for the central star. */
  orbit: OrbitalElements | null
  /** Obliquity: tilt of the spin axis from the orbit's reference plane, degrees. */
  axialTilt: number
  /** Rotation period relative to the stars, seconds. Negative spins retrograde, 0 doesn't spin. */
  siderealDay: number
  /** Spin angle at the J2000 epoch, degrees. */
  rotationAtEpoch: number
  /** Always shows the same face to its parent (spin follows the orbit). */
  tidallyLocked: boolean
  /** Procedural surface style for the solar-system view. */
  surface: SurfaceStyle
  /** Three surface colours for the procedural style (`#rrggbb`). */
  colors: [string, string, string]
  /** Black-body temperature, kelvin (stars: sets the light colour). */
  temperature: number
  /** Bond albedo, 0..1 (moons: how bright the lit disc is). */
  albedo: number
  /** Optional rings. */
  rings: RingOptions | null
  /** Optional atmosphere glow in the solar-system view. */
  atmosphere: BodyAtmosphere | null
}

/** A star system: the star, the home planet, an optional moon, and seeded extra planets. Plain JSON. */
export interface SystemOptions {
  /** Seed for the procedural planets. */
  seed: number | string
  /** The central star (overrides on {@link DEFAULT_STAR}). */
  star: BodyOptions
  /** The planet you stand on (overrides on {@link DEFAULT_HOME}). Its radius should match the World's. */
  home: BodyOptions
  /** The home planet's moon (overrides on {@link DEFAULT_MOON}), or `null` for none. */
  moon: BodyOptions | null
  /** How many procedural planets to add around the star (seeded). */
  planets: number
  /** Extra bodies, appended as given (their `parent` must name an earlier body). */
  bodies: BodyOptions[]
}

/** Input accepted by {@link StarSystem}: any subset of {@link SystemOptions}, merged deeply. */
export type SystemInput = Omit<DeepPartial<SystemOptions>, 'moon' | 'bodies'> & {
  /** Moon overrides, or `null` for no moon. */
  moon?: DeepPartial<BodyOptions> | null
  /** Extra bodies (complete definitions). */
  bodies?: BodyOptions[]
}

/** A Sun-like star. */
export const DEFAULT_STAR: BodyOptions = {
  name: 'sun', kind: 'star', parent: null, radius: 6.957e8, gm: 1.32712440018e20, orbit: null,
  axialTilt: 7.25, siderealDay: 2192832, rotationAtEpoch: 0, tidallyLocked: false,
  surface: 'star', colors: ['#fff4e0', '#ffb347', '#ff7a1a'], temperature: 5772, albedo: 0, rings: null, atmosphere: null,
}

/**
 * An Earth-like home planet with Earth's J2000 orbit, tilt and spin, so dates give real seasons and
 * real times of sunrise. Change the radius to match a planet `World`.
 */
export const DEFAULT_HOME: BodyOptions = {
  name: 'home', kind: 'planet', parent: 'sun', radius: 6.371e6, gm: 3.986004418e14,
  orbit: {
    semiMajorAxis: AU, eccentricity: 0.0167086, inclination: 0, longitudeOfAscendingNode: -11.26064,
    argumentOfPeriapsis: 114.20783, meanAnomalyAtEpoch: 357.51716, period: 0,
  },
  axialTilt: 23.4393, siderealDay: 86164.0905, rotationAtEpoch: 10.46061837, tidallyLocked: false,
  surface: 'ocean', colors: ['#1d3f6e', '#3f6b35', '#c9b48a'], temperature: 288, albedo: 0.3, rings: null,
  atmosphere: { color: '#6fa8ff', density: 1 },
}

/** A Moon-like satellite with the Moon's mean J2000 orbit (phases match the real Moon to within about a day). */
export const DEFAULT_MOON: BodyOptions = {
  name: 'moon', kind: 'moon', parent: 'home', radius: 1.7374e6, gm: 4.9028e12,
  orbit: {
    semiMajorAxis: 3.84399e8, eccentricity: 0.0549, inclination: 5.145, longitudeOfAscendingNode: 125.045,
    argumentOfPeriapsis: 318.31, meanAnomalyAtEpoch: 134.963, period: 2360591.5,
  },
  axialTilt: 1.54, siderealDay: 2360591.5, rotationAtEpoch: 0, tidallyLocked: true,
  surface: 'moon', colors: ['#9a958c', '#5d5a55', '#c8c3b8'], temperature: 250, albedo: 0.12, rings: null, atmosphere: null,
}

/** Default system: the star, the home planet, its moon and five procedural planets. */
export const DEFAULT_SYSTEM: SystemOptions = {
  seed: 1,
  star: DEFAULT_STAR,
  home: DEFAULT_HOME,
  moon: DEFAULT_MOON,
  planets: 5,
  bodies: [],
}

/** A body resolved into a {@link StarSystem}. */
export interface Body extends BodyOptions {
  /** Index in {@link StarSystem.bodies}. */
  index: number
  /** Index of the parent, or -1. */
  parentIndex: number
}

const PALETTES: Record<'rocky' | 'desert' | 'gas' | 'ice', [string, string, string][]> = {
  rocky: [['#8a7f72', '#5b524a', '#b8ab98'], ['#9c5a3c', '#6b3a28', '#d08a5c'], ['#7d7f86', '#4a4c52', '#a9acb3']],
  desert: [['#c99a5b', '#8f6236', '#e3c48f'], ['#b5643a', '#7a3a1f', '#e0a070']],
  gas: [['#d9b98c', '#a67b52', '#f1e2c4'], ['#c9a46b', '#8c6a43', '#efe0bd'], ['#b9c6d6', '#7f8fa6', '#e6edf5'], ['#d7a37a', '#9c5e3c', '#f3d6b5']],
  ice: [['#9fd3e0', '#5f9fb5', '#d4f0f5'], ['#6f8fd8', '#4062b0', '#a9c0f0']],
}

/** Seeded procedural planets, spaced roughly geometrically (Titius–Bode-like), clear of the home orbit. */
function proceduralPlanets(seed: number, count: number, star: BodyOptions, home: BodyOptions): BodyOptions[] {
  const rand = mulberry32(hash3(seed, 0x51a7e7))
  const range = (a: number, b: number) => a + (b - a) * rand()
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]
  const homeA = home.orbit?.semiMajorAxis ?? AU
  const scale = Math.sqrt(Math.max(star.temperature, 1000) / 5772) * (star.radius / 6.957e8) // brighter stars push zones out
  const out: BodyOptions[] = []
  let a = range(0.3, 0.45) * AU * scale
  for (let i = 0; out.length < count && i < count * 4; i++) {
    const near = a / homeA
    if (near > 0.75 && near < 1.33) { a *= range(1.5, 1.8); continue } // keep the home orbit clear
    const zone = a / (AU * scale)
    const kind: 'rocky' | 'desert' | 'gas' | 'ice' = zone < 1.8 ? (rand() < 0.5 ? 'rocky' : 'desert') : zone < 12 ? 'gas' : 'ice'
    const radius = kind === 'gas' ? range(2.5e7, 7.2e7) : kind === 'ice' ? range(2.0e7, 2.6e7) : range(2.0e6, 7.5e6)
    const density = kind === 'gas' ? 1300 : kind === 'ice' ? 1650 : range(3900, 5500)
    const ringed = (kind === 'gas' || kind === 'ice') && rand() < 0.45
    out.push({
      name: `planet-${out.length + 1}`, kind: 'planet', parent: star.name, radius,
      gm: G * (4 / 3) * Math.PI * radius ** 3 * density,
      orbit: {
        semiMajorAxis: a, eccentricity: range(0, 0.09), inclination: range(0, 3.5), longitudeOfAscendingNode: range(0, 360),
        argumentOfPeriapsis: range(0, 360), meanAnomalyAtEpoch: range(0, 360), period: 0,
      },
      axialTilt: kind === 'ice' && rand() < 0.3 ? range(60, 98) : range(0, 30),
      siderealDay: (kind === 'gas' || kind === 'ice' ? range(9, 18) * 3600 : range(0.6, 60) * 86400) * (rand() < 0.15 ? -1 : 1),
      rotationAtEpoch: range(0, 360), tidallyLocked: false,
      surface: kind, colors: pick(PALETTES[kind]), temperature: 0, albedo: range(0.1, 0.5),
      rings: ringed ? { inner: range(1.25, 1.5), outer: range(1.9, 2.6), color: pick(['#d9c7a2', '#bfb4a0', '#a9b4c2']), opacity: range(0.45, 0.85) } : null,
      atmosphere: kind === 'rocky' && rand() < 0.3 ? { color: '#ffcf9a', density: range(0.3, 0.8) } : kind === 'gas' || kind === 'ice' ? { color: PALETTES[kind][0][2], density: 0.5 } : null,
    })
    a *= range(1.45, 1.95)
  }
  return out
}

/**
 * A star system: resolved bodies plus their positions, velocities and orientations at any time.
 * Positions are in the star's frame (the star sits at the origin), float64 metres.
 *
 * @example
 * ```ts
 * const system = new StarSystem({ home: { radius: world.radius }, planets: 6, seed: 'kepler' })
 * system.position('moon', t)            // [x, y, z] metres from the star
 * system.orientation('home', t)         // body → star-frame rotation (Mat3)
 * ```
 */
export class StarSystem {
  /** Resolved options. */
  readonly options: SystemOptions
  /** Every body: star first, then home, moon, procedural planets and extra bodies. */
  readonly bodies: Body[]
  private readonly byName = new Map<string, Body>()
  private readonly s: OrbitState = { position: [0, 0, 0], velocity: [0, 0, 0] }

  /** Builds a system; anything not given uses {@link DEFAULT_SYSTEM}. */
  constructor(input: SystemInput = {}) {
    const o = merge(structuredClone({ ...DEFAULT_SYSTEM, moon: null, bodies: [] }) as SystemOptions, { ...input, moon: undefined, bodies: undefined })
    o.moon = input.moon === null ? null : merge(structuredClone(DEFAULT_MOON), input.moon ?? {})
    o.bodies = input.bodies ? structuredClone(input.bodies) : []
    o.home.parent = o.star.name
    if (o.moon) o.moon.parent = o.home.name
    this.options = o
    const list = [o.star, o.home, ...(o.moon ? [o.moon] : []), ...proceduralPlanets(seedOf(o.seed), o.planets, o.star, o.home), ...o.bodies]
    this.bodies = list.map((b, index) => {
      const parentIndex = b.parent == null ? -1 : list.findIndex((p) => p.name === b.parent)
      if (b.parent != null && (parentIndex < 0 || parentIndex >= index)) throw new Error(`threejs-sky: body "${b.name}" needs an earlier parent "${b.parent}"`)
      if (index > 0 && !b.orbit) throw new Error(`threejs-sky: body "${b.name}" needs an orbit`)
      return { ...b, index, parentIndex }
    })
    for (const b of this.bodies) this.byName.set(b.name, b)
  }

  /** Looks up a body by name or index. @throws If there is no such body. */
  get(body: string | number): Body {
    const b = typeof body === 'number' ? this.bodies[body] : this.byName.get(body)
    if (!b) throw new Error(`threejs-sky: no body "${body}"`)
    return b
  }

  /** The central star. */
  get star(): Body { return this.bodies[0] }
  /** The home planet. */
  get home(): Body { return this.bodies[1] }
  /** The home planet's moon, if any. */
  get moon(): Body | undefined { return this.byName.get(this.options.moon?.name ?? '') }

  /** Orbital period of a body around its parent, seconds (0 for the star). */
  period(body: string | number): number {
    const b = this.get(body)
    if (!b.orbit) return 0
    return b.orbit.period > 0 ? b.orbit.period : orbitalPeriod(b.orbit.semiMajorAxis, this.bodies[b.parentIndex].gm)
  }

  /**
   * Periapsis/apoapsis of a body's orbit around its parent, with their conventional names
   * (perigee/apogee for the home planet's moons, perihelion/aphelion around the star). `null` for the star.
   */
  apsides(body: string | number, from = 0): (Apsides & { names: [string, string] }) | null {
    const b = this.get(body)
    if (!b.orbit) return null
    const parent = this.bodies[b.parentIndex]
    return { ...apsides(b.orbit, parent.gm + b.gm, from), names: apsisNames(parent.index === 1 ? 'home' : parent.kind) }
  }

  /** Length of a body's solar day (noon to noon), seconds. For moons, relative to their parent's star. */
  solarDay(body: string | number = 1): number {
    const b = this.get(body)
    let year = this.period(b.index)
    for (let p = b; p.parentIndex > 0; p = this.bodies[p.parentIndex]) year = this.period(this.bodies[p.parentIndex].index)
    const sid = b.siderealDay
    if (sid === 0 || !year) return Math.abs(sid)
    return Math.abs(1 / (1 / sid - 1 / year))
  }

  /** Position relative to the parent at `time` (seconds since J2000), metres. */
  localState(body: string | number, time: number, out?: OrbitState): OrbitState {
    const b = this.get(body)
    out ??= { position: [0, 0, 0], velocity: [0, 0, 0] }
    if (!b.orbit) {
      out.position.fill(0); out.velocity.fill(0)
      return out
    }
    return orbitState(b.orbit, this.bodies[b.parentIndex].gm + b.gm, time, out)
  }

  /** Position in the star frame at `time`, metres. */
  position(body: string | number, time: number, out: Vec3 = [0, 0, 0]): Vec3 {
    out[0] = out[1] = out[2] = 0
    for (let b = this.get(body); b.parentIndex >= 0; b = this.bodies[b.parentIndex]) {
      const p = this.localState(b.index, time, this.s).position
      out[0] += p[0]; out[1] += p[1]; out[2] += p[2]
    }
    return out
  }

  /** Velocity in the star frame at `time`, m/s. */
  velocity(body: string | number, time: number, out: Vec3 = [0, 0, 0]): Vec3 {
    out[0] = out[1] = out[2] = 0
    for (let b = this.get(body); b.parentIndex >= 0; b = this.bodies[b.parentIndex]) {
      const v = this.localState(b.index, time, this.s).velocity
      out[0] += v[0]; out[1] += v[1]; out[2] += v[2]
    }
    return out
  }

  /** Spin angle (radians) about the body's own +Y axis at `time`. */
  spin(body: string | number, time: number): number {
    const b = this.get(body)
    if (b.tidallyLocked && b.parentIndex >= 0) {
      // Face +Z (longitude 0) towards the parent.
      const d = this.localState(b.index, time, this.s).position
      const t = mulVecT(rotationX(-b.axialTilt * DEG), [-d[0], -d[1], -d[2]])
      return Math.atan2(t[0], t[2]) + b.rotationAtEpoch * DEG
    }
    return b.rotationAtEpoch * DEG + (b.siderealDay ? (2 * Math.PI * time) / b.siderealDay : 0)
  }

  /**
   * Orientation at `time`: the rotation taking body-fixed vectors into the star frame (tilt, then
   * spin). The tilt leans the north pole towards ecliptic longitude 90° (−Z), like Earth's.
   */
  orientation(body: string | number, time: number): Mat3 {
    const b = this.get(body)
    return mulMat(rotationX(-b.axialTilt * DEG), rotationY(this.spin(b.index, time)))
  }
}
