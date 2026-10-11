import {
  BufferAttribute, BufferGeometry, CylinderGeometry, DynamicDrawUsage, Euler, Group, InstancedBufferAttribute, InstancedMesh,
  Matrix4, PlaneGeometry, Quaternion, Sphere, Vector3, type MeshBasicNodeMaterial, type MeshStandardNodeMaterial, type Object3D,
} from 'three/webgpu'
import { InstanceStates, type MaterialStates, type StateLook } from 'threejs-weathering'
import { rgb, type MeshData } from './mesh.ts'
import { createFxMaterial, createVehicleMaterial, createVehicleUniforms, createWakeMaterial, type VehicleUniforms } from './material.ts'
import type { VehicleParams, VehicleType } from './models.ts'
import type { RoadNetwork } from './paths.ts'
import { DEFAULT_FLEET, FleetSim, type FleetEnvironment, type FleetInput, type FleetSettings } from './sim.ts'

/** Non-JSON inputs of a {@link Fleet}. */
export interface FleetOptions {
  /** Road network for `roads` routes (threejs-city's `city.graph`). */
  roads?: RoadNetwork | null
  /** Ground height for road nodes without a graded `y`. */
  height?: ((x: number, z: number) => number) | null
  /** Shared weathering look (threejs-weathering `StateLook`). */
  look?: StateLook
  /** Update itself whenever it renders (no `update()` calls needed). */
  autoUpdate?: boolean
}

/** What {@link Fleet.vehicle} reports. */
export interface VehicleInfo {
  /** Type. */
  type: VehicleType
  /** Resolved style. */
  style: string
  /** Group index. */
  group: number
  /** Position (fleet-local). */
  position: [number, number, number]
  /** Heading, radians. */
  heading: number
  /** Speed, m/s. */
  speed: number
  /** Material states. */
  states: MaterialStates
  /** On-fire heat, 0…1. */
  heat: number
}

interface PartView {
  mesh: InstancedMesh
  model: number
  part: number
  vehicles: number[]
  look: InstancedBufferAttribute
  states: InstanceStates
}

const _mv = new Matrix4(), _mm = new Matrix4(), _mr = new Matrix4(), _q = new Quaternion(), _e = new Euler(0, 0, 0, 'YXZ')
const _p = new Vector3(), _s = new Vector3(1, 1, 1), _d = new Vector3(), _up = new Vector3(0, 1, 0)
const ZERO = new Matrix4().makeScale(0, 0, 0)
const stage = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, hidden: false }

function toGeometry(data: MeshData): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(data.position, 3))
  g.setAttribute('normal', new BufferAttribute(data.normal, 3))
  g.setAttribute('color', new BufferAttribute(data.color, 3))
  g.setAttribute('vstyle', new BufferAttribute(data.style, 2))
  g.setIndex(new BufferAttribute(data.index, 1))
  const [x0, y0, z0, x1, y1, z1] = data.bounds
  g.boundingSphere = new Sphere(new Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2)
  return g
}

function merge<T extends object>(target: T, input: object): T {
  const t = target as Record<string, unknown>
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue
    const plain = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x)
    t[k] = plain(v) && plain(t[k]) ? merge({ ...(t[k] as object) }, v as object) : structuredClone(v)
  }
  return target
}

/**
 * Thousands of animated vehicles in a few draw calls: one `InstancedMesh` per model part (bodies, wheels,
 * fans, rocket stages), driven every frame from the typed arrays of a {@link FleetSim}. Cars and bikes
 * follow a road network or splines, trains pull their wagons along rails, boats bob, roll and leave wakes,
 * planes bank through their turns, rockets launch and drop stages, carriers carry parked jets. Every
 * vehicle gets wet, snowy, burnt and damaged through threejs-weathering's per-instance states.
 *
 * @example
 * ```ts
 * const fleet = new Fleet({ groups: [
 *   { type: 'car', count: 400, route: { kind: 'roads' } },
 *   { type: 'train', count: 1, params: { wagons: 8, cargo: 'freight' }, route: { kind: 'path', points: rail } },
 *   { type: 'airplane', count: 3, route: { kind: 'circle', center: [0, 600, 0], radius: 2500 } },
 * ] }, { roads: city.graph })
 * scene.add(fleet.object)
 * renderer.setAnimationLoop(() => { fleet.update(); renderer.render(scene, camera) })
 * fleet.set({ exposure: { snowfall: 1 } })   // parked cars collect snow, moving ones shed it
 * ```
 */
export class Fleet {
  /** Add this to your scene. */
  readonly object = new Group()
  /** Resolved settings. */
  settings: FleetSettings
  /** The simulation (typed arrays of every vehicle's pose and state). */
  sim!: FleetSim
  /** Live material uniforms. */
  readonly uniforms: VehicleUniforms
  /** The single material every part shares. */
  readonly material: MeshStandardNodeMaterial
  private fxMaterial: MeshBasicNodeMaterial
  private wakeMaterial: MeshBasicNodeMaterial
  private views: PartView[] = []
  private fx: InstancedMesh | null = null
  private wakes: InstancedMesh | null = null
  private roads: RoadNetwork | null
  private height: ((x: number, z: number) => number) | null
  private autoUpdate: boolean
  private key = ''
  private statesKey = ''
  private statesVersion = -1
  private hadHeat = true
  private last = -1
  private lastFrame = -1
  private bounds = new Sphere()

  /** Creates a fleet; anything not in `input` uses {@link DEFAULT_FLEET}. */
  constructor(input: FleetInput = {}, options: FleetOptions = {}) {
    this.settings = merge(structuredClone(DEFAULT_FLEET), input)
    this.roads = options.roads ?? null
    this.height = options.height ?? null
    this.autoUpdate = options.autoUpdate ?? false
    this.uniforms = createVehicleUniforms()
    this.material = createVehicleMaterial(this.uniforms, options.look)
    this.fxMaterial = createFxMaterial()
    this.wakeMaterial = createWakeMaterial()
    this.object.name = 'vehicles'
    this.apply(true)
  }

  /** Merges `input` into the settings. Groups and seed rebuild the fleet; everything else is live. */
  set(input: FleetInput): this {
    merge(this.settings, input)
    this.apply(false, input)
    return this
  }

  /** Replaces all settings: anything not in `input` goes back to {@link DEFAULT_FLEET}. */
  reset(input: FleetInput = {}): this {
    this.settings = merge(structuredClone(DEFAULT_FLEET), input)
    this.apply(false, this.settings)
    return this
  }

  private apply(first: boolean, input: FleetInput = {}): void {
    const s = this.settings
    const key = JSON.stringify([s.seed, s.groups, s.rocket.separation.length])
    if (key !== this.key) {
      this.key = key
      this.rebuild()
      this.statesKey = ''
      input = s
    } else {
      this.sim.settings = s
      if (input.waves !== undefined) this.sim.setWaves(s.waves)
      if (input.leftHand !== undefined) this.sim.setRoads(this.roads)
    }
    this.uniforms.lights.value = s.lights
    this.uniforms.crumple.value = s.crumple
    // Settings states apply when they change (not on every reset), so weathering picked up in the world sticks.
    const statesKey = JSON.stringify(s.states)
    if (input.states && statesKey !== this.statesKey) {
      this.statesKey = statesKey
      this.applyStates(s.states)
    }
    for (const v of this.views) {
      v.mesh.castShadow = s.castShadow
      v.mesh.receiveShadow = s.receiveShadow
    }
    if (first) this.update(0)
  }

  private applyStates(states: Partial<MaterialStates & { heat: number }>): void {
    const { heat, ...rest } = states
    this.sim.states.setAll(rest)
    if (heat !== undefined) this.sim.heat.fill(Math.max(0, Math.min(1, heat)))
  }

  private rebuild(): void {
    this.disposeMeshes()
    const time = this.sim?.time ?? 0
    this.sim = new FleetSim(this.settings, this.roads, this.height)
    this.sim.time = time
    const sim = this.sim
    const byModel: number[][] = sim.models.map(() => [])
    for (let v = 0; v < sim.count; v++) byModel[sim.model[v]].push(v)
    let fxCapacity = 0, wakeCapacity = 0
    sim.models.forEach((model, mi) => {
      const vehicles = byModel[mi]
      if (!vehicles.length) return
      fxCapacity += vehicles.length * (model.exhausts.length + 1)
      if (model.wake > 0) wakeCapacity += vehicles.length
      model.parts.forEach((part, pi) => {
        const capacity = vehicles.length * part.mounts.length
        const geometry = toGeometry(part.mesh)
        const look = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
        look.setUsage(DynamicDrawUsage)
        geometry.setAttribute('vehicleLook', look)
        const states = new InstanceStates(capacity).attach(geometry, 'vehicleStates')
        const mesh = new InstancedMesh(geometry, this.material, capacity)
        mesh.instanceMatrix.setUsage(DynamicDrawUsage)
        mesh.name = `${model.type}:${model.style}:${part.name}`
        mesh.boundingSphere = this.bounds
        for (let j = 0; j < vehicles.length; j++) {
          const v = vehicles[j]
          for (let k = 0; k < part.mounts.length; k++) look.array.set(sim.tint.subarray(v * 3, v * 3 + 3), (j * part.mounts.length + k) * 4)
        }
        this.views.push({ mesh, model: mi, part: pi, vehicles, look, states })
        this.object.add(mesh)
      })
    })
    if (fxCapacity) {
      const cone = new CylinderGeometry(0, 1, 1, 12, 1, true).translate(0, 0.5, 0)
      cone.setAttribute('fxLook', new InstancedBufferAttribute(new Float32Array(fxCapacity * 4), 4).setUsage(DynamicDrawUsage))
      this.fx = new InstancedMesh(cone, this.fxMaterial, fxCapacity)
      this.fx.instanceMatrix.setUsage(DynamicDrawUsage)
      this.fx.frustumCulled = false
      this.fx.renderOrder = 2
      this.fx.name = 'vehicle-fx'
      this.object.add(this.fx)
    }
    if (wakeCapacity) {
      const plane = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, -0.5)
      plane.setAttribute('wakeLook', new InstancedBufferAttribute(new Float32Array(wakeCapacity * 4), 4).setUsage(DynamicDrawUsage))
      this.wakes = new InstancedMesh(plane, this.wakeMaterial, wakeCapacity)
      this.wakes.instanceMatrix.setUsage(DynamicDrawUsage)
      this.wakes.frustumCulled = false
      this.wakes.renderOrder = 1
      this.wakes.name = 'vehicle-wakes'
      this.object.add(this.wakes)
    }
    this.statesVersion = -1
    this.hadHeat = true
    if (this.autoUpdate && this.views.length) {
      const hook = this.views[0].mesh
      hook.frustumCulled = false
      hook.onBeforeRender = (renderer) => {
        const frame = (renderer as unknown as { info?: { render?: { frame?: number } } }).info?.render?.frame ?? -1
        if (frame === this.lastFrame && frame !== -1) return
        this.lastFrame = frame
        this.update()
      }
    }
  }

  /** Swaps the road network (cars on `roads` routes are re-placed). */
  setRoads(roads: RoadNetwork | null): this {
    this.roads = roads
    this.sim.setRoads(roads)
    return this
  }

  /** Number of vehicles (wagons count one each). */
  get count(): number {
    return this.sim.count
  }

  /** Simulation time, seconds. */
  get time(): number {
    return this.sim.time
  }

  /** Draw calls the fleet costs (one per part mesh, plus fx and wakes). */
  get drawCalls(): number {
    return this.views.length + (this.fx ? 1 : 0) + (this.wakes ? 1 : 0)
  }

  /** What vehicle `i` is and where it is. */
  vehicle(i: number): VehicleInfo {
    const s = this.sim, m = s.models[s.model[i]], p = s.pose
    return {
      type: m.type, style: m.style, group: s.group[i], position: [p[i * 8], p[i * 8 + 1], p[i * 8 + 2]], heading: p[i * 8 + 3],
      speed: s.speed[i], states: s.states.get(i), heat: s.heat[i],
    }
  }

  /** Sets vehicle `i` on fire (`heat` 0…1); it burns, slows to a stop and chars until it burns out or rain douses it. */
  ignite(i: number, heat = 1): this {
    this.sim.heat[i] = Math.max(this.sim.heat[i], heat)
    return this
  }

  /** Sets states of vehicle `i` (wetness, snow, burn, damage). */
  setStates(i: number, states: Partial<MaterialStates>): this {
    this.sim.states.set(i, states)
    return this
  }

  /**
   * Advances and redraws the fleet. Call once per frame.
   * @param dt Seconds since the last call (measured if omitted).
   * @param env Weather, fire and ground states to react to.
   */
  update(dt?: number, env: FleetEnvironment = {}): void {
    if (dt === undefined) {
      const now = typeof performance !== 'undefined' ? performance.now() / 1000 : 0
      dt = this.last < 0 ? 0 : Math.min(0.25, Math.max(0, now - this.last))
      this.last = now
    }
    const sim = this.sim
    sim.step(dt * this.settings.timeScale, env)
    const pose = sim.pose
    // Per-instance states and heat, only when they changed.
    const version = sim.states.attribute.version
    let heat = false
    for (let i = 0; i < sim.count && !heat; i++) heat = sim.heat[i] > 0
    const statesChanged = version !== this.statesVersion
    const heatChanged = heat || this.hadHeat
    this.statesVersion = version
    this.hadHeat = heat
    // Bounds of every vehicle, shared by every part mesh for culling.
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity, reach = 0
    for (let v = 0; v < sim.count; v++) {
      const x = pose[v * 8], y = pose[v * 8 + 1], z = pose[v * 8 + 2]
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
    }
    for (const m of sim.models) reach = Math.max(reach, Math.hypot(...m.size))
    if (sim.count) {
      this.bounds.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2)
      this.bounds.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + reach
    }
    for (const view of this.views) {
      const model = sim.models[view.model]
      const part = model.parts[view.part]
      const arr = view.mesh.instanceMatrix.array as Float32Array
      const mounts = part.mounts
      for (let j = 0; j < view.vehicles.length; j++) {
        const v = view.vehicles[j], o = v * 8
        this.vehicleMatrix(v, _mv)
        const active = model.stages ? sim.activeStage(v) : 0
        for (let k = 0; k < mounts.length; k++) {
          const mount = mounts[k]
          const slot = (j * mounts.length + k) * 16
          if (mount.stage === -1) {
            const a = sim.anchor
            _mm.compose(_p.set(a[v * 4], a[v * 4 + 1], a[v * 4 + 2]), _q.setFromAxisAngle(_up, a[v * 4 + 3]), _s.set(1, 1, 1))
            _mm.toArray(arr, slot)
            continue
          }
          if (mount.stage !== undefined && mount.stage < active) {
            const st = sim.stageState(v, mount.stage, stage)
            if (!st || st.hidden) ZERO.toArray(arr, slot)
            else _mm.compose(_p.set(st.x, st.y, st.z), _q.setFromEuler(_e.set(st.rx, st.ry, st.rz, 'YXZ')), _s.set(1, 1, 1)).toArray(arr, slot)
            continue
          }
          _mm.copy(_mv).multiply(_mr.makeTranslation(mount.position[0], mount.position[1], mount.position[2]))
          if (mount.rotation) _mm.multiply(_mr.makeRotationFromEuler(_e.set(mount.rotation[0], mount.rotation[1], mount.rotation[2], 'YXZ')))
          if (mount.steer) _mm.multiply(_mr.makeRotationY(pose[o + 6] * mount.steer))
          if (mount.spin) {
            const a = mount.spin.by === 'distance' ? sim.travel[v] * mount.spin.rate : sim.time * mount.spin.rate * (0.25 + 0.75 * pose[o + 7])
            _mm.multiply(mount.spin.axis === 0 ? _mr.makeRotationX(a) : mount.spin.axis === 1 ? _mr.makeRotationY(a) : _mr.makeRotationZ(a))
          }
          _mm.toArray(arr, slot)
        }
      }
      view.mesh.count = view.vehicles.length * mounts.length
      view.mesh.instanceMatrix.needsUpdate = true
      if (statesChanged) {
        const src = sim.states.array, dst = view.states.array
        for (let j = 0; j < view.vehicles.length; j++) for (let k = 0; k < mounts.length; k++) dst.set(src.subarray(view.vehicles[j] * 4, view.vehicles[j] * 4 + 4), (j * mounts.length + k) * 4)
        view.states.attribute.needsUpdate = true
      }
      if (heatChanged) {
        const look = view.look.array as Float32Array
        for (let j = 0; j < view.vehicles.length; j++) for (let k = 0; k < mounts.length; k++) look[(j * mounts.length + k) * 4 + 3] = sim.heat[view.vehicles[j]]
        view.look.needsUpdate = true
      }
    }
    this.updateFx()
    this.updateWakes()
  }

  private vehicleMatrix(v: number, out: Matrix4): Matrix4 {
    const p = this.sim.pose, o = v * 8
    return out.compose(_p.set(p[o], p[o + 1], p[o + 2]), _q.setFromEuler(_e.set(p[o + 4], p[o + 3], p[o + 5], 'YXZ')), _s.set(1, 1, 1))
  }

  private updateFx(): void {
    const fx = this.fx
    if (!fx) return
    const sim = this.sim, s = this.settings
    const arr = fx.instanceMatrix.array as Float32Array
    const look = fx.geometry.getAttribute('fxLook') as InstancedBufferAttribute
    const la = look.array as Float32Array
    let n = 0
    const emit = (px: number, py: number, pz: number, dir: Vector3, radius: number, length: number, color: [number, number, number], intensity: number, seed: number) => {
      if (n >= fx.instanceMatrix.count || length <= 0.01) return
      _q.setFromUnitVectors(_up, dir)
      _mm.compose(_p.set(px, py, pz), _q, _s.set(radius, length, radius)).toArray(arr, n * 16)
      la[n * 4] = color[0] * intensity; la[n * 4 + 1] = color[1] * intensity; la[n * 4 + 2] = color[2] * intensity; la[n * 4 + 3] = seed
      n++
    }
    for (let v = 0; v < sim.count; v++) {
      const model = sim.models[sim.model[v]], o = v * 8
      if (s.exhaust && model.exhausts.length) {
        const throttle = sim.pose[o + 7]
        if (throttle > 0.01) {
          this.vehicleMatrix(v, _mv)
          const active = model.stages ? sim.activeStage(v) : -1
          for (const ex of model.exhausts) {
            if (ex.stage !== undefined && ex.stage !== active) continue
            _d.set(ex.position[0], ex.position[1], ex.position[2]).applyMatrix4(_mv)
            const px = _d.x, py = _d.y, pz = _d.z
            _d.set(ex.direction[0], ex.direction[1], ex.direction[2]).transformDirection(_mv)
            const flicker = model.stages ? 1 : 0.6 + 0.4 * throttle
            let length = ex.length * throttle * flicker
            if (model.stages) {
              // Near the pad the plume can't go through the ground: it spills sideways out of the flame trench.
              const alt = py - sim.anchor[v * 4 + 1]
              length = Math.min(length, Math.max(2, alt + ex.radius))
              const spill = (1 - alt / 80) * throttle
              if (ex.stage === 0 && spill > 0) {
                const h = sim.anchor[v * 4 + 3], c = Math.cos(h), sn = Math.sin(h), a = sim.anchor
                for (const side of [-1, 1]) emit(a[v * 4], a[v * 4 + 1] + 0.5, a[v * 4 + 2], _d.set(c * side, 0.25, -sn * side).normalize(), ex.radius * 2.5, model.size[1] * 0.5 * spill, rgb('#ffcf8a'), 2, v + side)
              }
              _d.set(ex.direction[0], ex.direction[1], ex.direction[2]).transformDirection(_mv)
            }
            emit(px, py, pz, _d, ex.radius * (0.8 + 0.2 * throttle), length, rgb(ex.color), model.stages ? 3 : 1.6, v * 0.37)
          }
        }
      }
      const heat = sim.heat[v]
      if (s.flames && heat > 0.02) {
        const h = model.size[1], w = Math.min(model.size[0], model.size[2])
        emit(sim.pose[o], sim.pose[o + 1] + h * 0.35, sim.pose[o + 2], _d.set(0, 1, 0), Math.min(12, w * 0.45), Math.min(30, h * (0.8 + 1.6 * heat)), FLAME, 1.4 * heat + 0.3, v * 0.71)
      }
    }
    fx.count = n
    fx.instanceMatrix.needsUpdate = true
    look.needsUpdate = true
  }

  private updateWakes(): void {
    const wakes = this.wakes
    if (!wakes) return
    const sim = this.sim
    const arr = wakes.instanceMatrix.array as Float32Array
    const look = wakes.geometry.getAttribute('wakeLook') as InstancedBufferAttribute
    const la = look.array as Float32Array
    let n = 0
    if (this.settings.wakes) for (let v = 0; v < sim.count; v++) {
      const model = sim.models[sim.model[v]], speed = sim.speed[v]
      if (!model.wake || speed < 0.5 || n >= wakes.instanceMatrix.count) continue
      const o = v * 8, yaw = sim.pose[o + 3]
      const back = model.size[2] * 0.45
      _q.setFromAxisAngle(_up, yaw)
      _mm.compose(
        _p.set(sim.pose[o] - Math.sin(yaw) * back, sim.pose[o + 1] + 0.06, sim.pose[o + 2] - Math.cos(yaw) * back), _q,
        _s.set(model.size[0] * model.wake * (1.2 + speed * 0.12), 1, (model.size[2] * 0.8 + speed * 6) * model.wake),
      ).toArray(arr, n * 16)
      la[n * 4] = Math.min(1, speed / 8); la[n * 4 + 1] = v * 1.3
      n++
    }
    wakes.count = n
    wakes.instanceMatrix.needsUpdate = true
    look.needsUpdate = true
  }

  private disposeMeshes(): void {
    for (const v of this.views) {
      v.mesh.geometry.dispose()
      v.mesh.dispose()
      this.object.remove(v.mesh)
    }
    this.views = []
    for (const m of [this.fx, this.wakes]) if (m) { m.geometry.dispose(); m.dispose(); this.object.remove(m) }
    this.fx = this.wakes = null
  }

  /** Frees GPU resources. */
  dispose(): void {
    this.disposeMeshes()
    this.material.dispose()
    this.fxMaterial.dispose()
    this.wakeMaterial.dispose()
  }
}

const FLAME = rgb('#ff6a1a')

/** Settings of a single {@link Vehicle}. Plain JSON. */
export interface VehicleSettings {
  /** Type. */
  type: VehicleType
  /** Seed: drives proportions, style and details. */
  seed: number | string
  /** Type parameters. */
  params: VehicleParams
  /** Speed its parts animate at (wheels, fans), m/s; it stays in place. */
  speed: number
  /** Body paint (`#rrggbb`), or '' for a seeded palette colour. */
  tint: string
  /** Heading, radians. */
  heading: number
  /** Rockets: launch (and relaunch every `period` seconds) instead of standing on the pad. */
  launch: boolean
  /** Launch period, seconds. */
  period: number
  /** Headlights and lit windows, 0…1. */
  lights: number
  /** Dent depth at full damage, metres. */
  crumple: number
  /** Wetness, snow, burn, damage and `heat` (on fire). */
  states: MaterialStates & { heat: number }
}

/** Default {@link VehicleSettings}. */
export const DEFAULT_VEHICLE: VehicleSettings = {
  type: 'car', seed: 1, params: {}, speed: 0, tint: '', heading: 0, launch: false, period: 90, lights: 0, crumple: 0.12,
  states: { wetness: 0, snow: 0, burn: 0, damage: 0, heat: 0 },
}

/**
 * One procedural vehicle (hero assets, galleries, spawned props): a {@link Fleet} of one, standing at
 * its origin with wheels, fans and propellers turning at `speed`.
 *
 * @example
 * ```ts
 * const bus = new Vehicle({ type: 'car', params: { style: 'bus' }, speed: 8, seed: 3 })
 * scene.add(bus.object)
 * bus.set({ states: { snow: 0.8 } })
 * ```
 */
export class Vehicle {
  /** The fleet behind it. */
  readonly fleet: Fleet
  /** Resolved settings. */
  settings: VehicleSettings

  /** Creates a vehicle; anything not in `input` uses {@link DEFAULT_VEHICLE}. */
  constructor(input: Partial<VehicleSettings> = {}, options: Omit<FleetOptions, 'roads'> = {}) {
    this.settings = merge(structuredClone(DEFAULT_VEHICLE), input)
    this.fleet = new Fleet(this.fleetInput(), options)
  }

  /** Add this to your scene. */
  get object(): Object3D {
    return this.fleet.object
  }

  private fleetInput(): FleetInput {
    const s = this.settings
    const rocketPad = s.type === 'rocket' && s.launch
    return {
      seed: s.seed, lights: s.lights, crumple: s.crumple, states: s.states,
      groups: [{
        type: s.type, count: 1, params: s.params, variants: 1, tint: s.tint, speed: [s.speed, s.speed],
        route: rocketPad ? { kind: 'pad', position: [0, 0, 0], heading: s.heading, period: s.period, countdown: 5 } : { kind: 'static', position: [0, 0, 0], heading: s.heading },
      }],
    }
  }

  /** Merges `input` into the settings. */
  set(input: Partial<VehicleSettings>): this {
    merge(this.settings, input)
    this.fleet.set(this.fleetInput())
    return this
  }

  /** Replaces all settings (missing ones go back to {@link DEFAULT_VEHICLE}). */
  reset(input: Partial<VehicleSettings> = {}): this {
    this.settings = merge(structuredClone(DEFAULT_VEHICLE), input)
    this.fleet.set(this.fleetInput())
    return this
  }

  /** Animates it. Call once per frame (seconds since the last call; measured if omitted). */
  update(dt?: number, env?: FleetEnvironment): void {
    this.fleet.update(dt, env)
  }

  /** Frees GPU resources. */
  dispose(): void {
    this.fleet.dispose()
  }
}
