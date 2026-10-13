import { Euler, Matrix4, Quaternion, Vector3 } from 'three/webgpu'
import { hash01, hash4, seedOf } from 'threejs-biomes'
import { InstanceStates, type MaterialStates } from 'threejs-weathering'
import { createWaves, sampleWaves, type Wave, type WaveOptions, type WaveSample } from 'threejs-water'
import { rgb } from './mesh.ts'
import { buildVehicle, VEHICLE_KINDS, type VehicleModel, type VehicleParams, type VehicleType } from './models.ts'
import { Path, RoadNavigator, circlePoints, createPathSample, type RoadNetwork, type RoadPose } from './paths.ts'

/** Where a group of vehicles goes. Plain JSON. */
export type RouteSpec =
  /** Follow a polyline (smoothed into a spline). Closed paths loop; open ones are driven back and forth. */
  | { kind: 'path'; points: [x: number, y: number, z: number][]; closed?: boolean; smooth?: number }
  /** Circle round `center` at height `center[1]` (holding patterns, harbour loops, test tracks). */
  | { kind: 'circle'; center: [x: number, y: number, z: number]; radius: number; clockwise?: boolean }
  /** Random walk over the fleet's road network (threejs-city `RoadGraph`), keeping to the lane. */
  | { kind: 'roads' }
  /** Parked in a row along x from `position` (galleries, car parks); parts still animate with speed. */
  | { kind: 'static'; position: [x: number, y: number, z: number]; heading?: number; spacing?: number }
  /** Rocket launch pad: countdown, launch, stage separation, repeat every `period` seconds. */
  | { kind: 'pad'; position: [x: number, y: number, z: number]; heading?: number; period?: number; delay?: number; countdown?: number }
  /** Parked on the host spots of another group's vehicles (jets on a carrier deck). */
  | { kind: 'host'; group: number }

/** One group of vehicles of one type sharing a route. Plain JSON. */
export interface FleetGroup {
  /** Vehicle type. */
  type: VehicleType
  /** Units: vehicles, or whole trains (locomotive plus `params.wagons` wagons). */
  count: number
  /** Type parameters (see `VEHICLE_KINDS`). */
  params?: VehicleParams
  /** Distinct generated models the units cycle through (more = more variety, more draw calls). Default 4. */
  variants?: number
  /** Route. */
  route: RouteSpec
  /** Cruise speed range, m/s. Default depends on the type. */
  speed?: [min: number, max: number]
  /** Metres to the right of a path (roads use their own lanes). */
  lane?: number
  /** Paint every unit this colour (`#rrggbb`) instead of picking from the model's palette. */
  tint?: string
}

/** How vehicles weather: rain and snow exposure, drying, snow shed at speed, catching fire. */
export interface ExposureSettings {
  /** Rain everywhere, 0…1 (used when no `Weather` is passed to `update`). */
  rain: number
  /** Snowfall everywhere, 0…1. */
  snowfall: number
  /** Wetting rate towards the rain level, 1/s. */
  wetRate: number
  /** Drying rate, wetness per second. */
  dryRate: number
  /** Snow settling rate, 1/s (only below `shedSpeed`). */
  snowRate: number
  /** Snow melt, cover per second. */
  meltRate: number
  /** Above this speed (m/s) snow blows off. */
  shedSpeed: number
  /** Snow blown off per second above `shedSpeed`. */
  shedRate: number
  /** Fire heat (0…1) that sets a vehicle alight. */
  ignition: number
  /** Burn gained per second while on fire. */
  burnRate: number
  /** Seconds a vehicle fire lasts. */
  burnTime: number
  /** Damage gained per second while on fire. */
  fireDamage: number
  /** Seconds of full wetness to put a fire out. */
  douseTime: number
  /** Damage above which land and sea vehicles stop. */
  stopDamage: number
  /** Vehicles sampled per frame against weather, fire and state fields (round robin). */
  budget: number
}

/** Rocket flight profile. */
export interface RocketFlight {
  /** Vertical acceleration, m/s². */
  accel: number
  /** Gravity-turn radius, metres: downrange = altitude² / (2 · turn). */
  turn: number
  /** Flight seconds at which stage 0, 1, … separate. */
  separation: number[]
  /** Seconds a spent stage is drawn falling. */
  fallTime: number
}

/** All fleet settings. Plain JSON. */
export interface FleetSettings {
  /** Seed: same seed and groups, same fleet. */
  seed: number | string
  /** Vehicle groups. Changing them rebuilds the fleet. */
  groups: FleetGroup[]
  /** Simulation speed multiplier. */
  timeScale: number
  /** Headlights and lit windows, 0…1 (drive it from the sky's `night`). */
  lights: number
  /** How much damage crumples bodies (metres of dent at full damage). */
  crumple: number
  /** Body roll and sink from damage, 0…1. */
  tilt: number
  /** Drive on the left on road networks. */
  leftHand: boolean
  /** Waves boats bob on (match your threejs-water `Ocean`'s `waves`), or null for flat water. */
  waves: WaveOptions | null
  /** Draw wakes behind boats. */
  wakes: boolean
  /** Draw rocket plumes and afterburners. */
  exhaust: boolean
  /** Draw flames on burning vehicles. */
  flames: boolean
  /** Cast shadows. */
  castShadow: boolean
  /** Receive shadows. */
  receiveShadow: boolean
  /** Applied to every vehicle whenever set (wetness, snow, burn, damage, and `heat` = on fire). */
  states: MaterialStates & { heat: number }
  /** Weather exposure. */
  exposure: ExposureSettings
  /** Rocket flight profile. */
  rocket: RocketFlight
}

/** Recursive partial; arrays are replaced, not merged. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object | null ? DeepPartial<T[K]> : T[K] }

/** Partial settings accepted by `Fleet`, `set` and `reset`. */
export type FleetInput = DeepPartial<FleetSettings>

/** Default fleet: a ring of mixed traffic. */
export const DEFAULT_FLEET: FleetSettings = {
  seed: 1,
  groups: [{ type: 'car', count: 16, route: { kind: 'circle', center: [0, 0, 0], radius: 60 } }],
  timeScale: 1,
  lights: 0,
  crumple: 0.12,
  tilt: 1,
  leftHand: false,
  waves: null,
  wakes: true,
  exhaust: true,
  flames: true,
  castShadow: true,
  receiveShadow: true,
  states: { wetness: 0, snow: 0, burn: 0, damage: 0, heat: 0 },
  exposure: {
    rain: 0, snowfall: 0, wetRate: 0.4, dryRate: 1 / 300, snowRate: 1 / 40, meltRate: 1 / 600, shedSpeed: 12, shedRate: 0.05,
    ignition: 0.35, burnRate: 1 / 25, burnTime: 90, fireDamage: 1 / 40, douseTime: 30, stopDamage: 0.6, budget: 400,
  },
  rocket: { accel: 9, turn: 5000, separation: [32, 70], fallTime: 40 },
}

/** Default cruise speeds (m/s) by type. */
export const DEFAULT_SPEEDS: Record<VehicleType, [number, number]> = {
  car: [9, 15], pickup: [9, 15], truck: [14, 24], bicycle: [4, 7], train: [18, 26],
  'fishing-boat': [3, 5], 'cruise-liner': [6, 9], speedboat: [12, 20], hovercraft: [10, 15], 'aircraft-carrier': [5, 8],
  airplane: [70, 85], 'fighter-jet': [140, 190], rocket: [0, 0],
}

/** Something with weather on the ground (threejs-weathering `Weather`). */
export interface WeatherSource {
  /** Accumulated wetness and snow at (x, z) and time. */
  surfaceAt(x: number, z: number, time: number): { wetness: number; snow: number }
}
/** Something burning (threejs-weathering `Wildfire`). */
export interface FireSource {
  /** Fire heat 0…1 at (x, z). */
  heatAt(x: number, z: number): number
}
/** A ground state field (threejs-weathering `StateField`): storm and impact damage, wetness, snow. */
export interface StateSource {
  /** States at (x, z). */
  sample(x: number, z: number): MaterialStates
}

/** What the fleet reacts to this frame (all optional; positions are fleet-local). */
export interface FleetEnvironment {
  /** Weather: wetness and snow. */
  weather?: WeatherSource
  /** Weather time (seconds, the weather's clock). Default: the fleet's own time. */
  time?: number
  /** A wildfire: vehicles caught in it burn. */
  fire?: FireSource
  /** Ground states: storm damage (and wetness/snow without a `weather`). */
  field?: StateSource
}

/** Position and attitude of a rocket at flight time `t` (pad-relative). */
export interface RocketState {
  /** Altitude, metres. */
  altitude: number
  /** Downrange distance, metres. */
  downrange: number
  /** Tilt from vertical towards downrange, radians. */
  tilt: number
  /** Vertical speed, m/s. */
  vUp: number
  /** Downrange speed, m/s. */
  vDown: number
}

/**
 * Analytic gravity-turn ascent: altitude ½·a·t², downrange altitude²/(2·turn), so the rocket rises
 * straight off the pad and pitches over smoothly. Pure, so any instant can be scrubbed to.
 */
export function rocketAt(t: number, flight: Pick<RocketFlight, 'accel' | 'turn'>, out: RocketState = { altitude: 0, downrange: 0, tilt: 0, vUp: 0, vDown: 0 }): RocketState {
  const tt = Math.max(0, t)
  const h = 0.5 * flight.accel * tt * tt, vh = flight.accel * tt
  out.altitude = h
  out.downrange = (h * h) / (2 * flight.turn)
  out.vUp = vh
  out.vDown = (h / flight.turn) * vh
  out.tilt = Math.atan2(h, flight.turn)
  return out
}

interface GroupRuntime {
  spec: FleetGroup
  units: number[]
  vehicles: number[]
  path: Path | null
  nav: RoadNavigator | null
}

const G = 9.81
const tmpSample = createPathSample()
const tmpRoad: RoadPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }
const tmpWave: WaveSample = { height: 0, nx: 0, ny: 1, nz: 0 }
const tmpRocket: RocketState = { altitude: 0, downrange: 0, tilt: 0, vUp: 0, vDown: 0 }
const _m = new Matrix4(), _m2 = new Matrix4(), _q = new Quaternion(), _e = new Euler(0, 0, 0, 'YXZ'), _v = new Vector3(), _s = new Vector3(1, 1, 1)

const wrap = (a: number) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2))

/** Trailers behind each truck of a group (0 for rigid trucks). */
function trailerCount(params: VehicleParams | undefined): number {
  if (String(params?.body ?? 'tractor') === 'rigid') return 0
  return Math.max(1, Math.min(3, Math.round(Number(params?.trailers ?? VEHICLE_KINDS.truck.params.trailers.default))))
}

/** Number of vehicles a group expands to (trains: locomotive + wagons per unit; trucks: tractor + trailers). */
export function groupVehicleCount(g: FleetGroup): number {
  const per = g.type === 'train' ? 1 + Math.max(0, Math.round(Number(g.params?.wagons ?? VEHICLE_KINDS.train.params.wagons.default)))
    : g.type === 'truck' ? 1 + trailerCount(g.params) : 1
  return Math.max(0, Math.floor(g.count)) * per
}

/**
 * The pure core of a fleet (no GPU): generates the models, expands groups into units and vehicles,
 * and moves them every step — paths, road networks, launch pads, carrier decks — with steering,
 * banking, wave bobbing, damage and weather exposure, all in typed arrays.
 */
export class FleetSim {
  /** Settings it was built with. */
  settings: FleetSettings
  /** Generated models (shared between vehicles with the same type, parameters and variant). */
  readonly models: VehicleModel[] = []
  /** Number of vehicles. */
  readonly count: number
  /** Model index per vehicle. */
  readonly model: Int32Array
  /** Group index per vehicle. */
  readonly group: Int32Array
  /** Unit (vehicle, or whole train) per vehicle. */
  readonly unit: Int32Array
  /** Distance behind the unit leader, metres (wagons). */
  readonly offset: Float32Array
  /** Linear RGB tint per vehicle. */
  readonly tint: Float32Array
  /**
   * Pose per vehicle, 8 floats: x, y, z, yaw (rotation about y), pitch (rotation about x), roll
   * (about z), steering angle, throttle 0…1. Rotation order YXZ; +z is forward.
   */
  readonly pose: Float32Array
  /** Speed per vehicle, m/s. */
  readonly speed: Float32Array
  /** Distance travelled per vehicle (drives wheel spin). */
  readonly travel: Float64Array
  /** "On fire" heat per vehicle, 0…1. */
  readonly heat: Float32Array
  /** Material states per vehicle (wetness, snow, burn, damage). */
  readonly states: InstanceStates
  /** Rocket flight time per vehicle (NaN for everything else); negative = countdown. */
  readonly flightTime: Float32Array
  /** Anchor per vehicle (x, y, z, heading): the launch pad for rockets, the pose position otherwise. */
  readonly anchor: Float32Array
  /** Leader vehicle of each unit. */
  readonly unitLeader: Int32Array
  /** Distance along the route of each unit. */
  readonly unitS: Float64Array
  /** Current speed of each unit. */
  readonly unitSpeed: Float32Array
  /** Cruise speed of each unit. */
  readonly unitCruise: Float32Array
  /** Simulation time, seconds. */
  time = 0
  /** Road network for `roads` routes. */
  roads: RoadNetwork | null
  /** Ground height for road nodes without `y`. */
  height: ((x: number, z: number) => number) | null
  private groups: GroupRuntime[] = []
  private waves: Wave[] = []
  private turn: Float32Array
  private prevYaw: Float32Array
  private tiltDir: Float32Array
  private navSlot: Int32Array
  private exposed: Float64Array
  /** Trailer axle positions (x, z) per vehicle, NaN until placed: the articulation state. */
  private trail: Float64Array
  private cursor = 0

  /** Builds every model and places every vehicle at time 0. */
  constructor(settings: FleetSettings, roads: RoadNetwork | null = null, height: ((x: number, z: number) => number) | null = null) {
    this.settings = settings
    this.roads = roads
    this.height = height
    const seed = seedOf(settings.seed)
    const cache = new Map<string, number>()
    const modelOf = (type: VehicleType, params: VehicleParams, variantSeed: number) => {
      const key = `${type}|${JSON.stringify(params)}|${variantSeed}`
      let i = cache.get(key)
      if (i === undefined) {
        i = this.models.length
        this.models.push(buildVehicle(type, params, variantSeed))
        cache.set(key, i)
      }
      return i
    }
    // Expand groups → units → vehicles.
    const vModel: number[] = [], vGroup: number[] = [], vUnit: number[] = [], vOffset: number[] = [], vTint: number[] = []
    const unitLeader: number[] = [], unitCruise: number[] = []
    settings.groups.forEach((spec, g) => {
      const rt: GroupRuntime = { spec, units: [], vehicles: [], path: null, nav: null }
      this.groups.push(rt)
      const variants = Math.max(1, Math.round(spec.variants ?? 4))
      const params = spec.params ?? {}
      const [smin, smax] = spec.speed ?? DEFAULT_SPEEDS[spec.type]
      const count = Math.max(0, Math.floor(spec.count))
      const sameSpeed = spec.type === 'train' && spec.route.kind !== 'static'
      for (let u = 0; u < count; u++) {
        const unit = unitLeader.length
        rt.units.push(unit)
        unitLeader.push(vModel.length)
        unitCruise.push(sameSpeed ? smin : smin + (smax - smin) * hash01(seed, g, u, 0x5eed))
        const members: { type: VehicleType; params: VehicleParams; salt: number }[] = []
        if (spec.type === 'train') {
          const wagons = Math.max(0, Math.round(Number(params.wagons ?? VEHICLE_KINDS.train.params.wagons.default)))
          const cargo = String(params.cargo ?? 'passenger')
          members.push({ type: 'train', params: { ...params, car: 'locomotive' }, salt: 0 })
          for (let w = 0; w < wagons; w++) {
            const car = cargo === 'mixed' ? (hash01(seed, g, u * 131 + w, 0xca) < 0.5 ? 'passenger' : 'freight') : cargo
            members.push({ type: 'train', params: { ...params, car }, salt: car === 'freight' ? w + 1 : 1 })
          }
        } else if (spec.type === 'truck') {
          members.push({ type: 'truck', params: { ...params, piece: 'tractor' }, salt: 0 })
          const n = trailerCount(params)
          for (let w = 0; w < n; w++) members.push({ type: 'truck', params: { ...params, piece: 'trailer', slot: w, trailers: n }, salt: w + 1 })
        } else members.push({ type: spec.type, params, salt: 0 })
        let behind = 0
        members.forEach((mem, k) => {
          const variant = hash4(seed, g, u * 977 + mem.salt, 0x7a) % variants
          const mi = modelOf(mem.type, mem.params, hash4(seed, g, variant, mem.salt + 0x11))
          const len = this.models[mi].size[2]
          if (k > 0) behind += len / 2 + 0.8
          vModel.push(mi); vGroup.push(g); vUnit.push(unit); vOffset.push(behind)
          behind += len / 2
          const palette = this.models[mi].palette
          const hex = spec.tint || palette[hash4(seed, g, u, mem.salt * 31 + 0x3) % palette.length]
          vTint.push(...rgb(hex))
          rt.vehicles.push(vModel.length - 1)
        })
      }
    })
    const n = (this.count = vModel.length)
    this.model = Int32Array.from(vModel)
    this.group = Int32Array.from(vGroup)
    this.unit = Int32Array.from(vUnit)
    this.offset = Float32Array.from(vOffset)
    this.tint = Float32Array.from(vTint)
    this.pose = new Float32Array(n * 8)
    this.speed = new Float32Array(n)
    this.travel = new Float64Array(n)
    this.heat = new Float32Array(n)
    this.flightTime = new Float32Array(n).fill(NaN)
    this.anchor = new Float32Array(n * 4)
    this.states = new InstanceStates(n)
    this.turn = new Float32Array(n)
    this.prevYaw = new Float32Array(n).fill(NaN)
    this.tiltDir = new Float32Array(n)
    for (let i = 0; i < n; i++) this.tiltDir[i] = hash01(seed, i, 0, 0x711) < 0.5 ? -1 : 1
    this.exposed = new Float64Array(n)
    this.trail = new Float64Array(n * 2).fill(NaN)
    const units = unitLeader.length
    this.unitLeader = Int32Array.from(unitLeader)
    this.unitCruise = Float32Array.from(unitCruise)
    this.unitSpeed = Float32Array.from(unitCruise)
    this.unitS = new Float64Array(units)
    this.navSlot = new Int32Array(units).fill(-1)
    this.setWaves(settings.waves)
    // Routes.
    this.groups.forEach((rt, g) => {
      const r = rt.spec.route
      if (r.kind === 'path' && r.points.length >= 2) rt.path = new Path(r.points, r.closed ?? true, r.smooth ?? 8)
      if (r.kind === 'circle') rt.path = new Path(circlePoints(r.center, r.radius, 64, r.clockwise), true, 1)
      if (rt.path) {
        const L = rt.path.length
        rt.units.forEach((u, k) => { this.unitS[u] = (k / Math.max(1, rt.units.length)) * L + hash01(seed, g, k, 0x9) * (L / Math.max(1, rt.units.length)) * 0.3 })
      }
      if (r.kind === 'roads') this.placeOnRoads(rt, g)
      if (rt.path) for (const u of rt.units) this.primeTrailers(u, rt)
    })
    this.step(0)
  }

  /**
   * Drags a rig's trailers into place along a path before the first frame: the tractor is walked up
   * to its start over the length of the rig, so the trailers start on the path, not straight behind.
   */
  private primeTrailers(u: number, rt: GroupRuntime): void {
    const lead = this.unitLeader[u], n = this.count
    if (lead + 1 >= n || this.unit[lead + 1] !== u || !this.models[this.model[lead + 1]].hitch?.kingpin || !rt.path) return
    let span = 0
    for (let v = lead; v < n && this.unit[v] === u; v++) span += this.models[this.model[v]].size[2]
    const p = this.pose, lane = rt.spec.lane ?? 0
    for (let d = span + 10; d >= 0; d -= 0.5) {
      const ps = rt.path.sample(this.unitS[u] - d, tmpSample)
      const hl = Math.hypot(ps.tx, ps.tz) || 1
      p[lead * 8] = ps.x - (ps.tz / hl) * lane; p[lead * 8 + 1] = ps.y; p[lead * 8 + 2] = ps.z + (ps.tx / hl) * lane
      p[lead * 8 + 3] = Math.atan2(ps.tx, ps.tz)
      for (let v = lead + 1; v < n && this.unit[v] === u; v++) this.placeTrailer(v)
    }
  }

  /**
   * Places trailer `v` behind the vehicle in front of it: its kingpin sits on that vehicle's coupling
   * and its axle is dragged towards it (a tractrix), so trailers cut inside on turns (off-tracking).
   */
  private placeTrailer(v: number): void {
    const p = this.pose, prev = v - 1, po = prev * 8, o = v * 8
    const pm = this.models[this.model[prev]], m = this.models[this.model[v]]
    const c = pm.hitch?.coupling ?? -pm.size[2] / 2
    const yawP = p[po + 3]
    const hx = p[po] + Math.sin(yawP) * c, hz = p[po + 2] + Math.cos(yawP) * c
    const kp = m.hitch?.kingpin ?? 0, len = Math.max(0.5, kp - (m.hitch?.axle ?? 0))
    const t = this.trail
    if (!(t[v * 2] === t[v * 2])) { t[v * 2] = hx - Math.sin(yawP) * len; t[v * 2 + 1] = hz - Math.cos(yawP) * len }
    const dx = hx - t[v * 2], dz = hz - t[v * 2 + 1], d = Math.hypot(dx, dz) || 1
    t[v * 2] = hx - (dx / d) * len; t[v * 2 + 1] = hz - (dz / d) * len
    const yaw = Math.atan2(dx, dz)
    p[o] = hx - Math.sin(yaw) * kp; p[o + 1] = p[po + 1]; p[o + 2] = hz - Math.cos(yaw) * kp
    p[o + 3] = yaw; p[o + 4] = 0; p[o + 5] = 0; p[o + 6] = 0; p[o + 7] = p[po + 7]
    this.setAnchor(v, p[o], p[o + 1], p[o + 2], yaw)
  }

  private placeOnRoads(rt: GroupRuntime, g: number): void {
    if (!this.roads) return
    for (const v of rt.vehicles) this.trail[v * 2] = this.trail[v * 2 + 1] = NaN
    const nav = (rt.nav = new RoadNavigator(this.roads, rt.units.length, hash4(seedOf(this.settings.seed), g, 0, 0x60ad)))
    nav.leftHand = this.settings.leftHand
    nav.height = this.height
    rt.units.forEach((u, k) => { if (nav.place(k)) this.navSlot[u] = k })
  }

  /** Swaps the road network (re-places `roads` groups). */
  setRoads(roads: RoadNetwork | null): void {
    this.roads = roads
    this.groups.forEach((rt, g) => { if (rt.spec.route.kind === 'roads') { rt.nav = null; this.placeOnRoads(rt, g) } })
  }

  /** Changes the waves boats bob on. */
  setWaves(waves: WaveOptions | null): void {
    this.waves = waves ? createWaves(waves) : []
  }

  /** Spawn positions of a group's vehicles (indices into the per-vehicle arrays). */
  vehiclesOf(group: number): readonly number[] {
    return this.groups[group]?.vehicles ?? []
  }

  /** Advances the simulation by `dt` seconds and reacts to `env` (weather, fire, ground states). */
  step(dt: number, env: FleetEnvironment = {}): void {
    const s = this.settings
    this.time += dt
    const n = this.count
    const states = this.states.array
    for (let gi = 0; gi < this.groups.length; gi++) {
      const rt = this.groups[gi]
      const route = rt.spec.route
      for (let k = 0; k < rt.units.length; k++) {
        const u = rt.units[k]
        const lead = this.unitLeader[u]
        const domain = this.models[this.model[lead]].domain
        // Disabled by damage or fire: land, rail and sea units roll to a stop.
        let disabled = false
        if (domain !== 'air' && domain !== 'space') {
          for (let v = lead; v < n && this.unit[v] === u; v++) {
            if (states[v * 4 + 3] > s.exposure.stopDamage || this.heat[v] > 0.5) disabled = true
          }
        }
        const target = disabled ? 0 : this.unitCruise[u]
        const accel = domain === 'air' ? 20 : domain === 'sea' ? 0.8 : 3
        const sp = this.unitSpeed[u]
        this.unitSpeed[u] = sp + Math.max(-accel * 2 * dt, Math.min(accel * dt, target - sp))
        const ds = this.unitSpeed[u] * dt
        this.unitS[u] += ds
        if (route.kind === 'roads' && rt.nav && this.navSlot[u] >= 0) rt.nav.advance(this.navSlot[u], ds)
        for (let v = lead; v < n && this.unit[v] === u; v++) {
          this.speed[v] = this.unitSpeed[u]
          this.travel[v] += ds
          this.placeVehicle(v, u, k, rt, dt)
        }
      }
    }
    this.expose(dt, env)
  }

  private placeVehicle(v: number, u: number, k: number, rt: GroupRuntime, dt: number): void {
    const route = rt.spec.route
    const p = this.pose
    const o = v * 8
    const model = this.models[this.model[v]]
    if (model.hitch?.kingpin !== undefined && v !== this.unitLeader[u]) return this.placeTrailer(v)
    let rate = NaN
    let x = 0, y = 0, z = 0, yaw = 0, pitch = 0, roll = 0, throttle = Math.min(1, this.speed[v] / Math.max(1, this.unitCruise[u]))
    switch (route.kind) {
      case 'path': case 'circle': {
        if (!rt.path) break
        const ps = rt.path.sample(this.unitS[u] - this.offset[v], tmpSample)
        const lane = rt.spec.lane ?? 0
        const hl = Math.hypot(ps.tx, ps.tz) || 1
        x = ps.x - (ps.tz / hl) * lane; y = ps.y; z = ps.z + (ps.tx / hl) * lane
        yaw = Math.atan2(ps.tx, ps.tz)
        pitch = Math.asin(Math.max(-1, Math.min(1, ps.ty)))
        // Turn rate from the path's curvature (look-ahead), not frame differences: smooth on polylines.
        const d = Math.max(3, this.speed[v] * 0.8), at = this.unitS[u] - this.offset[v]
        const ahead = rt.path.sample(at + d, tmpSample)
        const ya = Math.atan2(ahead.tx, ahead.tz)
        const behind = rt.path.sample(at - d, tmpSample)
        rate = (wrap(ya - Math.atan2(behind.tx, behind.tz)) / (2 * d)) * this.speed[v]
        break
      }
      case 'roads': {
        const slot = this.navSlot[u]
        if (!rt.nav || slot < 0) break
        rt.nav.pose(slot, tmpRoad)
        x = tmpRoad.x; y = tmpRoad.y; z = tmpRoad.z; yaw = tmpRoad.yaw; pitch = tmpRoad.pitch
        break
      }
      case 'static': {
        const h = route.heading ?? 0, spacing = route.spacing ?? Math.max(4, model.size[0] * 1.5)
        const along = -this.offset[v], across = k * spacing
        x = route.position[0] + Math.sin(h) * along + Math.cos(h) * across
        y = route.position[1]
        z = route.position[2] + Math.cos(h) * along - Math.sin(h) * across
        yaw = h
        break
      }
      case 'pad': {
        const h = route.heading ?? 0, period = route.period ?? 120, countdown = route.countdown ?? 10
        const units = rt.units.length
        const t = ((((this.time - (route.delay ?? 0) - (k / units) * period) % period) + period) % period) - countdown
        this.flightTime[v] = t
        const f = rocketAt(t, this.settings.rocket, tmpRocket)
        const px = route.position[0] + k * 120 * Math.cos(h), pz = route.position[2] - k * 120 * Math.sin(h)
        this.setAnchor(v, px, route.position[1], pz, h)
        x = px + Math.sin(h) * f.downrange; y = route.position[1] + f.altitude; z = pz + Math.cos(h) * f.downrange
        yaw = h
        pitch = -f.tilt // stored as a nose-up angle; for a rocket standing on its tail, "nose up" tilts the top downrange
        throttle = t > -2 ? Math.min(1, (t + 2) / 2) : 0
        this.speed[v] = Math.hypot(f.vUp, f.vDown)
        break
      }
      case 'host': {
        const host = this.groups[route.kind === 'host' ? route.group : -1]
        if (!host || !host.vehicles.length) break
        const hv = host.vehicles[Math.floor(k / Math.max(1, this.models[this.model[host.vehicles[0]]].hosts.length || 1)) % host.vehicles.length]
        const spots = this.models[this.model[hv]].hosts
        const spot = spots.length ? spots[k % spots.length] : { position: [0, 0, 0] as const, yaw: 0 }
        const ho = hv * 8
        _m.compose(_v.set(p[ho], p[ho + 1], p[ho + 2]), _q.setFromEuler(_e.set(p[ho + 4], p[ho + 3], p[ho + 5], 'YXZ')), _s.set(1, 1, 1))
        _m2.makeRotationY(spot.yaw).setPosition(spot.position[0], spot.position[1] - (model.parts[0].mesh.bounds[1] ?? 0), spot.position[2])
        _m.multiply(_m2)
        _m.decompose(_v, _q, _s)
        _e.setFromQuaternion(_q, 'YXZ')
        x = _v.x; y = _v.y; z = _v.z; yaw = _e.y; pitch = -_e.x; roll = _e.z
        throttle = 0
        p[o] = x; p[o + 1] = y; p[o + 2] = z; p[o + 3] = yaw; p[o + 4] = -pitch; p[o + 5] = roll; p[o + 6] = 0; p[o + 7] = 0
        this.setAnchor(v, x, y, z, yaw)
        return
      }
    }
    if (model.domain === 'space' && route.kind !== 'pad') throttle = 0 // rockets only fire on a pad route
    // Turn rate → steering, banking.
    const prev = this.prevYaw[v]
    if (rate !== rate) rate = dt > 0 && prev === prev ? wrap(yaw - prev) / dt : 0
    this.prevYaw[v] = yaw
    this.turn[v] += (rate - this.turn[v]) * Math.min(1, dt * 4)
    const speed = this.speed[v]
    const steer = model.wheelBase > 0 ? Math.max(-0.6, Math.min(0.6, Math.atan((model.wheelBase * this.turn[v]) / Math.max(speed, 0.5)))) : 0
    roll -= Math.max(-1.2, Math.min(1.2, Math.atan((speed * this.turn[v]) / G))) * model.bank
    // Boats: heave, pitch and roll from the waves under bow, stern and both sides.
    if (model.domain === 'sea') {
      const hover = model.type === 'hovercraft'
      if (this.waves.length) {
        const hl = model.size[2] * 0.4, hw = model.size[0] * 0.4
        const fx = Math.sin(yaw), fz = Math.cos(yaw)
        const at = (dx: number, dz: number) => sampleWaves(this.waves, x + dx, z + dz, this.time, tmpWave).height
        const bow = at(fx * hl, fz * hl), stern = at(-fx * hl, -fz * hl)
        const port = at(fz * hw, -fx * hw), star = at(-fz * hw, fx * hw)
        y += ((bow + stern + port + star) / 4) * (hover ? 0.6 : 1)
        pitch += Math.atan2(bow - stern, hl * 2) * (hover ? 0.4 : 1)
        roll += Math.atan2(port - star, hw * 2) * (hover ? 0.4 : 1)
      }
      if (hover) y += 0.25
      pitch += model.trim * 0.12 * Math.min(1, speed / 15)
    }
    // Damage: list, sink, slump.
    const dmg = this.states.array[v * 4 + 3] * this.settings.tilt
    if (dmg > 0 && model.domain !== 'air' && model.domain !== 'space') {
      roll += this.tiltDir[v] * dmg * (model.domain === 'sea' ? 0.22 : 0.07)
      pitch += this.tiltDir[v] * dmg * 0.03
      y -= dmg * dmg * (model.domain === 'sea' ? model.size[1] * 0.12 : 0.1)
    }
    p[o] = x; p[o + 1] = y; p[o + 2] = z; p[o + 3] = yaw; p[o + 4] = -pitch; p[o + 5] = roll; p[o + 6] = steer; p[o + 7] = throttle
    if (route.kind !== 'pad') this.setAnchor(v, x, y, z, yaw)
  }

  private setAnchor(v: number, x: number, y: number, z: number, heading: number): void {
    const a = this.anchor
    a[v * 4] = x; a[v * 4 + 1] = y; a[v * 4 + 2] = z; a[v * 4 + 3] = heading
  }

  /**
   * World matrix data of a separated rocket stage of vehicle `v` (position and Euler YXZ), or null
   * while the stage is still attached (or after it has fallen for `fallTime` seconds — then `hidden`).
   */
  stageState(v: number, stage: number, out: { x: number; y: number; z: number; rx: number; ry: number; rz: number; hidden: boolean }): typeof out | null {
    const t = this.flightTime[v]
    const sep = this.settings.rocket.separation[stage]
    if (!(t === t) || sep === undefined || t < sep) return null
    const tau = t - sep
    const f = rocketAt(sep, this.settings.rocket, tmpRocket)
    const a = this.anchor, px = a[v * 4], py = a[v * 4 + 1], pz = a[v * 4 + 2], h = a[v * 4 + 3]
    const d = f.downrange + f.vDown * tau
    out.x = px + Math.sin(h) * d
    out.z = pz + Math.cos(h) * d
    out.y = py + f.altitude + f.vUp * tau - 0.5 * G * tau * tau
    out.ry = h
    out.rx = f.tilt + tau * 0.35
    out.rz = tau * 0.1
    out.hidden = tau > this.settings.rocket.fallTime || out.y < py
    return out
  }

  /** Index of the lowest stage still attached to rocket `v` (stages fire in order). */
  activeStage(v: number): number {
    const t = this.flightTime[v]
    const seps = this.settings.rocket.separation
    let k = 0
    while (k < seps.length && t >= seps[k] && k < this.models[this.model[v]].stages - 1) k++
    return k
  }

  private expose(dt: number, env: FleetEnvironment): void {
    const n = this.count
    if (!n) return
    const e = this.settings.exposure
    const st = this.states.array
    const time = env.time ?? this.time
    const budget = Math.min(n, Math.max(1, Math.round(e.budget)))
    let changed = false
    for (let c = 0; c < budget; c++) {
      const v = this.cursor
      this.cursor = (this.cursor + 1) % n
      const el = this.time - this.exposed[v]
      this.exposed[v] = this.time
      if (el <= 0 && dt > 0) continue
      const x = this.pose[v * 8], z = this.pose[v * 8 + 2]
      const model = this.models[this.model[v]]
      const grounded = model.domain !== 'air' && (model.domain !== 'space' || !(this.flightTime[v] > 0))
      let wetT = e.rain, snowT = e.snowfall
      if (env.weather) {
        const w = env.weather.surfaceAt(x, z, time)
        wetT = Math.max(wetT, w.wetness); snowT = Math.max(snowT, w.snow)
      }
      const o = v * 4
      if (env.field) {
        const f = env.field.sample(x, z)
        if (!env.weather) { wetT = Math.max(wetT, f.wetness); snowT = Math.max(snowT, f.snow) }
        if (grounded) st[o + 3] = Math.max(st[o + 3], f.damage)
      }
      if (env.fire && grounded) {
        const h = env.fire.heatAt(x, z)
        if (h > e.ignition) this.heat[v] = Math.max(this.heat[v], h)
      }
      const heat = this.heat[v]
      // Wetness.
      let wet = st[o]
      wet = wetT > wet ? wet + (wetT - wet) * (1 - Math.exp(-e.wetRate * el)) : Math.max(wetT, wet - e.dryRate * el * (1 + heat * 20))
      // Snow settles on slow vehicles, blows off fast ones, melts when it stops falling or they burn.
      let snow = st[o + 1]
      const fast = this.speed[v] > e.shedSpeed
      if (snowT > snow && !fast && heat < 0.05) snow += (snowT - snow) * (1 - Math.exp(-e.snowRate * el))
      else snow = Math.max(0, snow - (e.meltRate * (snowT > 0.05 ? 0.2 : 1) + (fast ? e.shedRate : 0) + heat * 0.5) * el)
      // Fire.
      if (heat > 0) {
        st[o + 2] = Math.min(1, st[o + 2] + e.burnRate * heat * el)
        st[o + 3] = Math.min(1, st[o + 3] + e.fireDamage * heat * el)
        this.heat[v] = Math.max(0, heat - el / Math.max(1, e.burnTime) - (wet * el) / Math.max(1, e.douseTime))
      }
      st[o] = Math.min(1, Math.max(0, wet))
      st[o + 1] = Math.min(1, Math.max(0, snow))
      changed = true
    }
    if (changed) this.states.attribute.needsUpdate = true
  }
}
