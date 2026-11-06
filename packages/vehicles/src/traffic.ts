// Traffic pools: what drives where, and ambient traffic: a camera-centred manager that keeps a bounded,
// seeded set of vehicles alive on the roads (and rail) around the camera, spawning them out of view and
// retiring them once they are far away and out of view. Each pool is a weighted list of vehicle types and
// parameters; `trafficGroups` splits a vehicle count over one into fleet groups.
import { Frustum, Group, Matrix4, Sphere, Vector3, type Camera } from 'three/webgpu'
import { hash01, hash4, seedOf } from 'threejs-biomes'
import { Fleet } from './fleet.ts'
import { Path, createPathSample, type RoadNetwork, type RoadPose } from './paths.ts'
import { DEFAULT_SPEEDS, type FleetEnvironment, type FleetGroup, type RouteSpec } from './sim.ts'
import type { VehicleParams, VehicleParamsOf, VehicleType } from './models.ts'
import type { StateLook } from 'threejs-weathering'

/** Kinds of road a pool is for. */
export type TrafficPoolName = 'urban' | 'highway' | 'rural' | 'dirtRoad'

/** One entry of a traffic pool. */
export interface TrafficEntry {
  /** Vehicle type. */
  type: VehicleType
  /** Its parameters. */
  params: VehicleParams
  /** Relative share. */
  weight: number
}

/** A {@link TrafficEntry} of one known kind: its parameters are typed from that kind's definitions. */
export type TrafficEntryOf<K extends VehicleType> = Omit<TrafficEntry, 'type' | 'params'> & {
  type: K
  params: VehicleParamsOf<K>
}

/**
 * Weighted traffic by road kind: town streets (mixed cars, buses, a few pickups, box trucks and
 * bicycles), highways (semi-trailer rigs weigh in), rural roads (pickups, utes and tractors weigh in) and
 * dirt roads (mostly pickups, utes and tractors).
 */
export const TRAFFIC_POOLS: Record<TrafficPoolName, TrafficEntry[]> = {
  urban: [
    { type: 'car', params: { style: 'mixed' }, weight: 78 },
    { type: 'car', params: { style: 'bus' }, weight: 3 },
    { type: 'pickup', params: { style: 'mixed' }, weight: 7 },
    { type: 'truck', params: { body: 'rigid', cab: 'cabOver', sleeper: false, axles: 2 }, weight: 3 },
    { type: 'bicycle', params: { style: 'mixed' }, weight: 8 }
  ],
  highway: [
    { type: 'car', params: { style: 'mixed' }, weight: 74 },
    { type: 'pickup', params: { style: 'mixed' }, weight: 12 },
    { type: 'car', params: { style: 'bus' }, weight: 2 },
    { type: 'truck', params: { trailers: 1 }, weight: 12 },
    { type: 'truck', params: { trailers: 2 }, weight: 2 }
  ],
  rural: [
    { type: 'car', params: { style: 'mixed' }, weight: 46 },
    { type: 'pickup', params: { style: 'fullSize' }, weight: 26 },
    { type: 'pickup', params: { style: 'ute' }, weight: 8 },
    { type: 'pickup', params: { style: 'ute', ute: 'tray' }, weight: 5 },
    { type: 'pickup', params: { style: 'angular' }, weight: 2 },
    { type: 'truck', params: { trailers: 1 }, weight: 4 },
    { type: 'tractor', params: {}, weight: 3 }
  ],
  dirtRoad: [
    { type: 'pickup', params: { style: 'fullSize', lift: 0.12 }, weight: 30 },
    { type: 'pickup', params: { style: 'fullSize', cab: 'regular', bed: 'long', load: 'hay' }, weight: 12 },
    { type: 'pickup', params: { style: 'ute', ute: 'tray', load: 'crates' }, weight: 14 },
    { type: 'car', params: { style: 'suv' }, weight: 14 },
    { type: 'car', params: { style: 'mixed' }, weight: 12 },
    { type: 'car', params: { style: 'vintage' }, weight: 2 },
    { type: 'tractor', params: {}, weight: 6 },
    { type: 'tractor', params: { implement: 'trailer' }, weight: 3 }
  ]
}

/**
 * Splits `count` vehicles over a traffic pool into fleet groups sharing `route` (largest remainders,
 * so the counts always add up and the same inputs give the same groups).
 *
 * @example
 * ```ts
 * new Fleet({ groups: trafficGroups('rural', 60, { kind: 'roads' }) }, { roads: graph })
 * ```
 */
export function trafficGroups(
  pool: TrafficPoolName | TrafficEntry[],
  count: number,
  route: RouteSpec,
  extra: Partial<FleetGroup> = {}
): FleetGroup[] {
  const entries = typeof pool === 'string' ? TRAFFIC_POOLS[pool] : pool
  const total = entries.reduce((a, e) => a + Math.max(0, e.weight), 0)
  const n = Math.max(0, Math.floor(count))
  if (!total || !n) return []
  const exact = entries.map((e) => (Math.max(0, e.weight) / total) * n)
  const counts = exact.map(Math.floor)
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1])
  for (let k = 0, left = n - counts.reduce((a, b) => a + b, 0); k < left; k++) counts[order[k % order.length][1]]++
  return entries.flatMap((e, i) =>
    counts[i]
      ? [{ ...extra, type: e.type, count: counts[i], params: { ...e.params }, route: structuredClone(route) }]
      : []
  )
}

/** The pool a road edge draws from, from its width and how built up the area is (0 rural … 1 a town). */
export function edgePool(width: number, population = 0.5): TrafficPoolName {
  if (width >= 12) return 'highway'
  if (width >= 8) return 'urban'
  if (width >= 5 && population >= 0.5) return 'urban' // a residential street in a town
  return width >= 6 ? 'rural' : 'dirtRoad'
}

/** The `TrafficEntry`s of every pool, one per distinct type and parameters, weighted by their best pool share. */
function poolUnion(): TrafficEntry[] {
  const byKey = new Map<string, TrafficEntry>()
  for (const pool of Object.values(TRAFFIC_POOLS))
    for (const e of pool) {
      const key = entryKey(e.type, e.params),
        seen = byKey.get(key)
      if (!seen) byKey.set(key, { type: e.type, params: { ...e.params }, weight: e.weight })
      else seen.weight = Math.max(seen.weight, e.weight)
    }
  return [...byKey.values()]
}

const entryKey = (type: VehicleType, params: VehicleParams): string => `${type}|${JSON.stringify(params)}`

function nodeY(roads: RoadNetwork, n: number, height: ((x: number, z: number) => number) | null): number {
  const node = roads.nodes[n]
  return Number.isFinite(node.y) ? node.y : height ? height(node.x, node.z) : 0
}

/**
 * The lane pose `u` metres along edge `e` travelled from node `from`: the straight part of
 * `RoadNavigator.pose`, so a spawn can be checked for visibility before it is committed to.
 */
export function laneAt(
  roads: RoadNetwork,
  e: number,
  from: number,
  u: number,
  leftHand: boolean,
  height: ((x: number, z: number) => number) | null = null,
  out: RoadPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }
): RoadPose {
  const ed = roads.edges[e],
    a = roads.nodes[from],
    bId = ed.a === from ? ed.b : ed.a
  const b = roads.nodes[bId],
    len = Math.hypot(b.x - a.x, b.z - a.z) || 1
  const tx = (b.x - a.x) / len,
    tz = (b.z - a.z) / len
  const lane = (ed.width / 4) * (leftHand ? -1 : 1)
  const ya = nodeY(roads, from, height),
    yb = nodeY(roads, bId, height)
  out.x = a.x + tx * u - tz * lane
  out.z = a.z + tz * u + tx * lane
  out.y = ya + (yb - ya) * Math.max(0, Math.min(1, u / len))
  out.yaw = Math.atan2(tx, tz)
  out.pitch = Math.atan2(yb - ya, len)
  return out
}

/** Ambient traffic settings. Plain JSON. */
export interface TrafficSettings {
  /** Seed: the same seed, camera path and timings give the same traffic. */
  seed: number | string
  /** Vehicles alive at most (the pool size; wagons and trailers ride along). */
  max: number
  /** Nothing spawns or stays spawned closer than this to the camera, metres. */
  innerRadius: number
  /** Vehicles beyond this distance are retired once out of view, metres. */
  outerRadius: number
  /** Spawn attempts per second (it fills up over a few seconds). */
  spawnRate: number
  /** How built up the area is, 0…1: decides which pool a street draws from and where cars park. */
  population: number
  /** Fraction of town street spawns that are parked rather than moving. */
  parked: number
  /** Headway kept behind the vehicle in front, seconds. */
  headway: number
  /** Trains to keep running on `rail`. */
  trains: number
  /** Rail line trains stream along (a closed loop), or null. */
  rail: [number, number, number][] | null
  /** Cruise speed multiplier per road tier. */
  speeds: Record<TrafficPoolName, number>
}

/** Default ambient traffic: 200 vehicles in a 120–420 m ring, filling at 30 a second. */
export const DEFAULT_TRAFFIC: TrafficSettings = {
  seed: 1,
  max: 200,
  innerRadius: 120,
  outerRadius: 420,
  spawnRate: 30,
  population: 0.5,
  parked: 0.3,
  headway: 1.6,
  trains: 0,
  rail: null,
  speeds: { urban: 0.45, highway: 1, rural: 0.55, dirtRoad: 0.35 }
}

/** Non-JSON inputs of a {@link Traffic}. */
export interface TrafficOptions {
  /** Road network to stream traffic on (threejs-city's `city.graph`). */
  roads?: RoadNetwork | null
  /** Ground height for road nodes without a graded `y`. */
  height?: ((x: number, z: number) => number) | null
  /** Shared weathering look (threejs-weathering `StateLook`). */
  look?: StateLook
}

const _m4 = new Matrix4(),
  _v = new Vector3(),
  _sphere = new Sphere()
const tmpPose: RoadPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }
const tmpTail = createPathSample()
const VISIBLE = 6 // radius a vehicle counts as visible with, metres

/**
 * Ambient traffic around a camera, the way games have always done it: a fixed pool of vehicles that
 * spawns on road edges out of view just beyond an inner radius, drives the network keeping its lane,
 * a headway behind whatever is in front and stopping at busy junctions, and is retired once it is
 * past the outer radius and no longer in the frustum. Which vehicle shows up depends on the road: wide
 * roads take highway traffic, town streets take the urban pool and park some cars, country lanes take
 * pickups, utes and tractors. Trains stream along `rail` the same way. Pool slots are reused, so
 * spawning allocates nothing, and every choice is hashed from the seed, the road edge and a time slot.
 *
 * @example
 * ```ts
 * const traffic = new Traffic({ max: 150, population: 0.7, trains: 2, rail: railLoop }, { roads: city.graph })
 * scene.add(traffic.object)
 * renderer.setAnimationLoop(() => { traffic.update(undefined, camera); renderer.render(scene, camera) })
 * ```
 */
export class Traffic {
  /** The instanced vehicles (add this to your scene; it stays the same object when the pool is rebuilt). */
  readonly object = new Group()
  /** The fleet behind it: `set` lights, states and exposure here. */
  fleet!: Fleet
  /** Resolved settings. */
  settings: TrafficSettings
  private roads: RoadNetwork | null
  private height: ((x: number, z: number) => number) | null
  private look: StateLook | undefined
  private seed = 1
  private key = ''
  private lastRoads: RoadNetwork | null = null
  private clock = 0
  private last = -1
  private credits = 0
  private spawnCount = 0
  private frustum = new Frustum()
  private lead: Int32Array = new Int32Array(0)
  private end = new Int32Array(0)
  private group = new Int32Array(0)
  private kind = new Uint8Array(0) // 0 = road, 1 = rail
  private half = new Float32Array(0)
  private rig = new Float32Array(0) // length of a unit's whole rig, metres
  private cruise = new Float32Array(0)
  private parked = new Uint8Array(0)
  private target = new Float32Array(0)
  private nextNode = new Int32Array(0)
  private remain = new Float32Array(0)
  private edgeOf = new Int32Array(0)
  private live = new Int32Array(0)
  private lists: { key: string; units: number[] }[] = []
  private pools: Record<string, Int32Array> = {}
  private fill = new Int32Array(0)
  private railUnits: number[] = []
  private railPath: Path | null = null

  /** Creates traffic; anything not in `input` uses {@link DEFAULT_TRAFFIC}. */
  constructor(input: Partial<TrafficSettings> = {}, options: TrafficOptions = {}) {
    this.settings = mergeTraffic(DEFAULT_TRAFFIC, input)
    this.roads = options.roads ?? null
    this.height = options.height ?? null
    this.look = options.look
    this.build()
  }

  /** Merges `input` into the settings (a new seed, `max`, `trains` or `rail` rebuilds the pool). */
  set(input: Partial<TrafficSettings>): this {
    this.settings = mergeTraffic(this.settings, input)
    this.apply()
    return this
  }

  /** Replaces all settings: anything not in `input` goes back to {@link DEFAULT_TRAFFIC}. */
  reset(input: Partial<TrafficSettings> = {}): this {
    this.settings = mergeTraffic(DEFAULT_TRAFFIC, input)
    this.apply()
    return this
  }

  /** Swaps the road network (traffic already out is retired). */
  setRoads(roads: RoadNetwork | null): this {
    this.roads = roads
    this.apply()
    return this
  }

  /** Vehicles alive (units: a rig or a train counts once). */
  get count(): number {
    let n = 0
    for (let u = 0; u < this.lead.length; u++) if (this.isActive(u)) n++
    return n
  }

  /** Simulation time, seconds. */
  get time(): number {
    return this.clock
  }

  /**
   * Streams and drives the traffic. Call once per frame.
   * @param dt Seconds since the last call (measured if omitted).
   * @param camera Where the camera is and what it sees: spawns stay out of its frustum and its inner radius.
   * @param env Weather, fire and ground states the vehicles react to.
   */
  update(dt?: number, camera?: Camera | null, env: FleetEnvironment = {}): void {
    if (dt === undefined) {
      const now = typeof performance !== 'undefined' ? performance.now() / 1000 : 0
      dt = this.last < 0 ? 0 : Math.min(0.25, Math.max(0, now - this.last))
      this.last = now
    }
    this.clock += dt
    if (camera) this.stream(dt, camera)
    this.drive()
    this.fleet.update(dt, env)
  }

  /** Frees GPU resources. */
  dispose(): void {
    this.fleet.dispose()
  }

  private apply(): void {
    const key = JSON.stringify([this.settings.seed, this.settings.max, this.settings.trains, this.settings.rail])
    if (key === this.key && this.roads === this.lastRoads) return
    this.build()
  }

  private build(): void {
    const s = this.settings
    this.key = JSON.stringify([s.seed, s.max, s.trains, s.rail])
    this.seed = seedOf(s.seed)
    const groups: FleetGroup[] = trafficGroups(poolUnion(), s.max, { kind: 'roads' }, { variants: 2 })
    const ground = groups.length
    const trains = Math.max(0, Math.floor(s.trains))
    const rail =
      trains > 0 && s.rail && s.rail.length >= 3
        ? s.rail.map((p): [number, number, number] => [p[0], p[1], p[2]])
        : null
    if (rail) {
      groups.push({
        type: 'train',
        count: trains,
        variants: 1,
        params: { car: 'locomotive', wagons: 6, cargo: 'freight', traction: 'diesel' },
        route: { kind: 'path', points: rail, closed: true }
      })
    }
    const old = this.fleet
    this.fleet = new Fleet({ seed: s.seed, groups }, { roads: this.roads, height: this.height, look: this.look })
    this.object.clear()
    this.object.add(this.fleet.object)
    old?.dispose()
    this.railPath = rail ? new Path(rail, true) : null
    const sim = this.fleet.sim,
      units = sim.unitLeader.length
    this.lead = Int32Array.from(sim.unitLeader)
    this.lastRoads = this.roads
    this.end = new Int32Array(units)
    this.group = new Int32Array(units)
    this.kind = new Uint8Array(units)
    this.half = new Float32Array(units)
    this.rig = new Float32Array(units)
    this.cruise = new Float32Array(units)
    this.parked = new Uint8Array(units)
    this.target = new Float32Array(units)
    this.nextNode = new Int32Array(units).fill(-1)
    this.remain = new Float32Array(units)
    this.edgeOf = new Int32Array(units).fill(-1)
    this.live = new Int32Array(units)
    this.railUnits = []
    this.lists = groups.slice(0, ground).map((g) => ({ key: entryKey(g.type, g.params ?? {}), units: [] as number[] }))
    const byKey = new Map(this.lists.map((l, i) => [l.key, i]))
    this.pools = {}
    for (const [name, list] of Object.entries(TRAFFIC_POOLS))
      this.pools[name] = Int32Array.from(list.map((e) => byKey.get(entryKey(e.type, e.params)) ?? -1))
    this.fill = new Int32Array(ground)
    for (let u = 0; u < units; u++) {
      const v = this.lead[u]
      this.end[u] = u + 1 < units ? this.lead[u + 1] : sim.count
      const g = (this.group[u] = sim.group[v])
      this.kind[u] = g < ground ? 0 : 1
      this.half[u] = sim.models[sim.model[v]].size[2] / 2
      let rig = 0
      for (let w = v; w < this.end[u]; w++) rig += sim.models[sim.model[w]].size[2]
      this.rig[u] = rig + 0.8 * (this.end[u] - v - 1)
      if (this.kind[u] === 0) this.lists[g].units.push(u)
      else this.railUnits.push(u)
    }
    // Nothing is out until the manager spawns it (in the ring, out of view).
    sim.active.fill(0)
  }

  private isActive(u: number): boolean {
    return this.fleet.sim.active[this.lead[u]] === 1
  }

  private setActive(u: number, on: boolean): void {
    const sim = this.fleet.sim,
      a = on ? 1 : 0
    for (let v = this.lead[u]; v < this.end[u]; v++) sim.active[v] = a
    if (on) {
      sim.relocate(u)
      sim.unitSpeed[u] = this.cruise[u]
    }
  }

  private distance(u: number, cx: number, cy: number, cz: number): number {
    const p = this.fleet.sim.pose,
      o = this.lead[u] * 8
    return Math.hypot(p[o] - cx, p[o + 1] - cy, p[o + 2] - cz)
  }

  /** Whether any part of the unit is inside the view frustum. */
  private visible(u: number): boolean {
    const p = this.fleet.sim.pose
    for (let v = this.lead[u]; v < this.end[u]; v++) {
      _sphere.center.set(p[v * 8], p[v * 8 + 1] + 1, p[v * 8 + 2])
      _sphere.radius = VISIBLE
      if (this.frustum.intersectsSphere(_sphere)) return true
    }
    return false
  }

  // shortcut: visibility is the frustum only, not occlusion; upgrade if buildings start hiding spawns.
  /** Would a vehicle at this spot be inside the ring and off screen? */
  private inTheClear(x: number, y: number, z: number, cx: number, cy: number, cz: number): boolean {
    const d = Math.hypot(x - cx, y - cy, z - cz)
    if (!(d >= this.settings.innerRadius && d <= this.settings.outerRadius)) return false
    _sphere.center.set(x, y + 1, z)
    _sphere.radius = VISIBLE
    return !this.frustum.intersectsSphere(_sphere)
  }

  private stream(dt: number, camera: Camera): void {
    const s = this.settings
    camera.updateMatrixWorld()
    this.frustum.setFromProjectionMatrix(_m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
    _v.setFromMatrixPosition(camera.matrixWorld)
    const cx = _v.x,
      cy = _v.y,
      cz = _v.z
    for (let u = 0; u < this.lead.length; u++) {
      if (this.isActive(u) && this.distance(u, cx, cy, cz) > s.outerRadius && !this.visible(u)) this.setActive(u, false)
    }
    this.credits += s.spawnRate * dt
    let attempts = Math.floor(this.credits)
    this.credits -= attempts
    attempts = Math.min(attempts, 32)
    if (attempts <= 0) return
    const slot = Math.floor(this.clock * 2)
    for (let a = 0; a < attempts; a++) {
      const n = this.spawnCount++
      if (this.railPath && this.activeRail() < s.trains && this.spawnTrain(slot, n, cx, cy, cz)) continue
      this.spawnGround(slot, n, cx, cy, cz)
    }
  }

  private activeRail(): number {
    let n = 0
    for (const u of this.railUnits) if (this.isActive(u)) n++
    return n
  }

  /** Spawns a vehicle of the pool the edge calls for, if the edge is in the clear and a slot of that model is free. */
  private spawnGround(slot: number, n: number, cx: number, cy: number, cz: number): boolean {
    const roads = this.roads
    if (!roads || !roads.edges.length) return false
    const h = hash4(this.seed, slot, n, 0x5a17)
    const e = h % roads.edges.length
    const ed = roads.edges[e]
    const a = roads.nodes[ed.a],
      b = roads.nodes[ed.b]
    const len = Math.hypot(b.x - a.x, b.z - a.z)
    if (len < 18) return false
    // Stay clear of the rounded corners at either end, so the placement is exactly the straight lane pose.
    const r = Math.min(7, len / 2.5)
    const from = (h >>> 8) & 1 ? ed.a : ed.b
    const u = 2 + ((h >>> 9) / 8388608) * Math.max(0, len - r - 4)
    const pose = laneAt(roads, e, from, u, this.fleet.settings.leftHand, this.height, tmpPose)
    if (!this.inTheClear(pose.x, pose.y, pose.z, cx, cy, cz)) return false
    const pool = edgePool(ed.width, this.settings.population)
    const list = TRAFFIC_POOLS[pool]
    const total = list.reduce((sum, cand) => sum + Math.max(0, cand.weight), 0)
    let w = hash01(this.seed, slot, n, 0x9e37) * total,
      pickAt = list.length - 1
    for (let k = 0; k < list.length; k++) {
      w -= Math.max(0, list[k].weight)
      if (w <= 0) {
        pickAt = k
        break
      }
    }
    const entry = list[pickAt],
      g = this.pools[pool][pickAt]
    if (g < 0) return false
    const units = this.lists[g].units
    for (let k = 0; k < units.length; k++) {
      const unit = units[(this.fill[g] + k) % units.length]
      if (this.isActive(unit)) continue
      const slotIndex = this.fleet.sim.navSlot[unit]
      const nav = this.fleet.sim.navigator(this.group[unit])
      if (!nav || slotIndex < 0) return false
      // The whole rig has to fit on this edge and be in the clear, not just its tractor.
      const rear = u - this.rig[unit]
      if (rear < 2) continue
      const back = laneAt(roads, e, from, rear, this.fleet.settings.leftHand, this.height, tmpPose)
      if (!this.inTheClear(back.x, back.y, back.z, cx, cy, cz)) continue
      nav.placeAt(slotIndex, e, from, u)
      this.fill[g] = (this.fill[g] + k + 1) % units.length
      const [lo, hi] = DEFAULT_SPEEDS[entry.type]
      this.cruise[unit] = (lo + (hi - lo) * hash01(this.seed, unit, 0, 0x5eed)) * this.settings.speeds[pool]
      this.parked[unit] =
        pool === 'urban' && ed.width < 8 && hash01(this.seed, slot, n, 0x9a3) < this.settings.parked ? 1 : 0
      this.setActive(unit, true)
      this.fleet.sim.unitSpeed[unit] = this.cruise[unit] * (this.parked[unit] ? 0 : 1)
      return true
    }
    return false
  }

  private spawnTrain(slot: number, n: number, cx: number, cy: number, cz: number): boolean {
    const path = this.railPath
    if (!path) return false
    const unit = this.railUnits.find((u) => !this.isActive(u))
    if (unit === undefined) return false
    const d = hash01(this.seed, slot, n, 0x7b1) * path.length
    const ps = path.sample(d)
    if (!this.inTheClear(ps.x, ps.y, ps.z, cx, cy, cz)) return false
    const tail = path.sample(d - this.rig[unit], tmpTail)
    if (!this.inTheClear(tail.x, tail.y, tail.z, cx, cy, cz)) return false
    this.fleet.sim.unitS[unit] = d
    const [lo, hi] = DEFAULT_SPEEDS.train
    this.cruise[unit] = lo + (hi - lo) * hash01(this.seed, unit, 0, 0x5eed)
    this.parked[unit] = 0
    this.setActive(unit, true)
    return true
  }

  /** Per-unit target speeds this frame: car-following headway, junctions, parked cars, then the cruise. */
  private drive(): void {
    const sim = this.fleet.sim,
      p = sim.pose,
      t = this.target
    let live = 0
    for (let u = 0; u < this.lead.length; u++) {
      this.remain[u] = Infinity
      if (!this.isActive(u)) continue
      t[u] = this.parked[u] ? 0 : this.cruise[u]
      this.live[live++] = u
      if (this.kind[u] === 1) continue
      const nav = sim.navigator(this.group[u]),
        slot = sim.navSlot[u]
      if (!nav || slot < 0) continue
      const e = nav.edge[slot],
        from = nav.from[slot]
      if (e < 0) continue
      const ed = this.roads?.edges[e]
      this.edgeOf[u] = e
      this.nextNode[u] = ed ? (ed.a === from ? ed.b : ed.a) : -1
      this.remain[u] = nav.length(e) - nav.u[slot]
    }
    const roads = this.roads
    for (let a = 0; a < live; a++) {
      const u = this.live[a],
        ao = this.lead[u] * 8
      const fx = Math.sin(p[ao + 3]),
        fz = Math.cos(p[ao + 3]),
        ax = p[ao],
        az = p[ao + 2]
      const node = this.kind[u] === 0 && this.remain[u] < 14 && roads ? roads.nodes[this.nextNode[u]] : null
      for (let b = 0; b < live; b++) {
        if (a === b) continue
        const ub = this.live[b],
          bo = this.lead[ub] * 8
        const dx = p[bo] - ax,
          dz = p[bo + 2] - az
        const along = dx * fx + dz * fz
        // Headway: keep a gap to whatever is directly ahead in this lane.
        if (along > 0 && along < 60 + this.half[u] && Math.abs(dx * fz - dz * fx) < 3) {
          const room = along - this.half[u] - this.half[ub] - 3
          const speed = Math.max(0, room) / Math.max(0.5, this.settings.headway)
          if (speed < t[u]) t[u] = speed
        }
        // Junctions: a crossing vehicle in the one ahead of me makes me wait — lowest edge index first.
        if (node && this.edgeOf[ub] >= 0 && this.edgeOf[ub] !== this.edgeOf[u] && this.edgeOf[u] > this.edgeOf[ub]) {
          if (Math.hypot(p[bo] - node.x, p[bo + 2] - node.z) < 12) t[u] = 0
        }
      }
    }
    for (let k = 0; k < live; k++) sim.unitCruise[this.live[k]] = t[this.live[k]]
  }
}

function mergeTraffic(base: TrafficSettings, input: Partial<TrafficSettings>): TrafficSettings {
  const out = { ...base, ...input }
  out.speeds = { ...base.speeds, ...(input.speeds ?? {}) }
  out.rail =
    input.rail === undefined
      ? base.rail && base.rail.map((p): [number, number, number] => [p[0], p[1], p[2]])
      : input.rail && input.rail.map((p): [number, number, number] => [p[0], p[1], p[2]])
  return out
}
