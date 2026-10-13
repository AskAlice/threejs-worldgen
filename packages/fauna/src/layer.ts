import { BufferGeometry, DynamicDrawUsage, Euler, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Sphere, Vector3, type Camera, type Material, type Object3D } from 'three/webgpu'
import { hash4, mulberry32, seedOf, type LocalFrame, type World } from 'threejs-biomes'
import { DEFAULT_BOIDS, Flock, type BoidParams, type PredatorPoint } from './boids.ts'
import { Clock, DEFAULT_STATES, hookScene, mergeInput, placeInFrame, worldToFrame, type FaunaRenderer, type MaterialStates, type Predator } from './common.ts'
import { spawnTile, type GroupSpawn, type Habitat } from './placement.ts'

/** Boid weights shared by every group of a layer (each species sets its own distances and speeds). */
export type BoidWeights = Pick<BoidParams, 'separation' | 'alignment' | 'cohesion' | 'wander' | 'wanderRate' | 'avoid' | 'flee' | 'verticalDamping' | 'lookAhead'>

/** Settings every fauna layer has. All JSON except `predators`. */
export interface FaunaLayerSettings {
  /** Seed: the same seed, world and settings always spawn the same groups. */
  seed: number | string
  /** World position that is (0, 0, 0) in render space (floating origin). */
  origin: [x: number, y: number, z: number]
  /** Edge length of a streaming tile, metres. */
  tileSize: number
  /** Groups farther than this from the camera are dropped (and nothing spawns while the camera is higher than this). */
  maxDistance: number
  /** Groups farther than this are drawn but not simulated. */
  simDistance: number
  /** Group candidates per km²; candidates in unsuitable places are dropped. */
  density: number
  /** Samples per side of each group's environment grid. */
  gridResolution: number
  /** Skip world detail smaller than this (metres) when sampling. */
  minWavelength: number
  /** Milliseconds per frame spent spawning groups, nearest first. */
  buildBudget: number
  /** Fixed simulation steps per second. */
  stepRate: number
  /** Planets: distance (metres) from the frame's centre at which a new frame is centred on the camera. */
  reframeDistance: number
  /** Boid weights. */
  boids: BoidWeights
  /** Material states (wetness, snow, burn, damage). */
  states: MaterialStates
  /** Whether animals cast shadows. */
  castShadow: boolean
  /** Whether animals receive shadows. */
  receiveShadow: boolean
  /** Objects animals flee from (not JSON: objects or React refs). */
  predators: Predator[]
}

/** Default {@link FaunaLayerSettings}. */
export const DEFAULT_LAYER: FaunaLayerSettings = {
  seed: 1,
  origin: [0, 0, 0],
  tileSize: 64,
  maxDistance: 250,
  simDistance: 150,
  density: 150,
  gridResolution: 5,
  minWavelength: 1,
  buildBudget: 3,
  stepRate: 30,
  reframeDistance: 20_000,
  boids: {
    separation: DEFAULT_BOIDS.separation, alignment: DEFAULT_BOIDS.alignment, cohesion: DEFAULT_BOIDS.cohesion, wander: DEFAULT_BOIDS.wander,
    wanderRate: DEFAULT_BOIDS.wanderRate, avoid: DEFAULT_BOIDS.avoid, flee: DEFAULT_BOIDS.flee, verticalDamping: DEFAULT_BOIDS.verticalDamping, lookAhead: DEFAULT_BOIDS.lookAhead,
  },
  states: { ...DEFAULT_STATES },
  castShadow: false,
  receiveShadow: true,
  predators: [],
}

/** Options for a layer's `create()`. */
export interface FaunaLayerOptions {
  /** Camera groups stream around. */
  camera: Camera
  /** World that decides where animals live. Groups respawn when it changes. */
  world: World
  /** If given, the layer is added to it and updates whenever it renders. */
  scene?: Object3D
  /** A WebGPURenderer; initialised if needed. */
  renderer?: FaunaRenderer
}

/** Live counters of a fauna layer. */
export interface FaunaStats {
  /** Tiles in range. */
  tiles: number
  /** Groups spawned in them. */
  groups: number
  /** Animals drawn. */
  animals: number
  /** Tiles waiting to spawn. */
  pending: number
}

/** One group at runtime. */
export interface FaunaGroup {
  /** What spawned it. */
  spawn: GroupSpawn
  /** Its boids. */
  flock: Flock
  /** Per member: x/y/z scale. */
  scale: Float32Array
  /** Per member: (hue, brightness, pattern phase, random). */
  look: Float32Array
  /** Per member: (phase, amplitude, bend, second phase) for the shader. */
  motion: Float32Array
  /** Per member: heading and smoothed heading rate, for bending and banking. */
  turn: Float32Array
  /** Distance from the camera, metres. */
  dist: number
}

interface Tile { ix: number; iz: number; built: string; groups: FaunaGroup[]; seen: number; dist: number }

/** What a layer draws for one species: one instanced mesh and its per-instance buffers. */
export interface SpeciesView {
  /** Instanced mesh (count = animals drawn this frame). */
  mesh: InstancedMesh
  /** Rebuild key of the geometry. */
  key: string
  /** Instances the buffers hold. */
  capacity: number
  /** Per-instance (phase, amplitude, bend, second phase). */
  motion: InstancedBufferAttribute
  /** Per-instance (hue, brightness, pattern phase, random). */
  look: InstancedBufferAttribute
  /** Instances needed this frame. */
  need: number
  /** Instances written this frame. */
  written: number
  /** Bounds of this frame's instance positions (anchor-relative). */
  min: Vector3
  /** Bounds of this frame's instance positions (anchor-relative). */
  max: Vector3
  /** Largest instance scale this frame. */
  reach: number
}

/** A new geometry sharing `g`'s static attributes (index, position, normal, fauna) and bounds; no GPU copy. */
function shareStatic(g: BufferGeometry): BufferGeometry {
  const out = new BufferGeometry()
  out.setIndex(g.index)
  for (const name of STATIC) out.setAttribute(name, g.getAttribute(name))
  out.boundingSphere = g.boundingSphere
  return out
}

/** Detaches the shared static attributes so disposing `g` frees only its own (instance) buffers. */
function detachStatic(g: BufferGeometry): void {
  g.setIndex(null)
  for (const name of STATIC) g.deleteAttribute(name)
}

const STATIC = ['position', 'normal', 'fauna'] as const

/**
 * Base class of a streamed animal layer ({@link FishSchools}, {@link BirdFlocks}; land herds later):
 * deterministic per-tile spawning around the camera, one {@link Flock} per group, fixed-step
 * simulation near the camera, and one instanced mesh per species. Subclasses supply the species
 * table, the habitat rules, the mesh and material, and the per-member look and animation.
 *
 * Coordinates are the world's local frame (re-centred on the camera on planets); instance matrices
 * are relative to an anchor near the camera, so GPU data stays small at any distance from the origin.
 */
export abstract class FaunaLayer<S, T extends FaunaLayerSettings> {
  /** Root object (placed in the current frame). */
  readonly object = new Group()
  /** Live counters, refreshed by `update()`. */
  readonly stats: FaunaStats = { tiles: 0, groups: 0, animals: 0, pending: 0 }
  /** Camera the tiles follow. */
  camera: Camera
  /** The world. */
  world: World
  /** Resolved settings. Change them with `set()` / `reset()`. */
  settings!: T
  /** Seconds simulated. */
  time = 0
  /** The frame groups live in (the world itself on flat worlds). */
  frame: LocalFrame

  /** Separates this kind's spawns from other kinds with the same seed. */
  protected abstract readonly salt: number
  /** Default settings of this kind. */
  protected abstract defaults(): T
  /** The species table. */
  protected abstract species(): Readonly<Record<string, S>>
  /** Placement rules. */
  protected abstract habitat(): Habitat<S>
  /** Whatever about a species changes placement (JSON-compared). */
  protected abstract placementOf(species: S): unknown
  /** Boid parameters for a group of a species. */
  protected abstract boidParams(species: S): BoidParams
  /** Sets member `i`'s scale (xyz into `scale`) and look (4 into `look`) from `rand`. */
  protected abstract initMember(species: S, rand: () => number, scale: Float32Array, look: Float32Array, i: number): void
  /** Advances member `i`'s animation (`motion`, 4 floats) and returns its roll (bank) angle. */
  protected abstract animate(species: S, group: FaunaGroup, i: number, dt: number, speed: number, turnRate: number): number
  /** Steepest pitch, radians. */
  protected abstract maxPitch(species: S): number
  /** Creates the geometry for a species (called when `geometryKey` changes). */
  protected abstract createGeometry(species: S): BufferGeometry
  /** Geometry rebuild key of a species. */
  protected abstract geometryKey(species: S): string
  /** Creates the material for a species. */
  protected abstract createMaterial(id: string): Material
  /** Pushes a species' look (and the layer's states) into its material. */
  protected abstract applyLook(id: string, species: S, geometry: BufferGeometry): void

  /** Input so far (merged by `set`). */
  protected input: Partial<T> = {}
  /** Per-species meshes. */
  protected readonly views = new Map<string, SpeciesView>()
  private readonly local = new Group()
  private tiles = new Map<string, Tile>()
  private job: { tile: Tile; key: string; steps: Generator<void, GroupSpawn[]> } | null = null
  private layoutKey = ''
  private frameId = 0
  private frameVersion = -1
  private sphere = false
  private latLon: [number, number] | null = null
  private frameCount = 0
  private accumulator = 0
  private clock = new Clock()
  private unhook = () => {}
  private trash: { frame: number; dispose: () => void }[] = []
  private groundAt: [number, number, number] = [NaN, NaN, 0]
  private habitatCache: Habitat<S> | null = null

  /** Prefer the subclass's `create()`. */
  constructor({ camera, world, scene }: FaunaLayerOptions) {
    this.camera = camera
    this.world = world
    this.frame = world.frame
    this.object.matrixAutoUpdate = false
    this.object.add(this.local)
    if (scene) {
      scene.add(this.object)
      this.unhook = hookScene(scene, () => this.update())
    }
  }

  /** Changes settings, merging into earlier ones (nested objects merge, arrays replace). Looks apply at once; placement changes respawn groups. */
  set(input: Partial<T> | object): this {
    mergeInput(this.input, input)
    const s = mergeInput(this.defaultsCopy(), this.input) as T
    this.settings = s
    this.habitatCache = null
    const table = this.species()
    const ids = Object.keys(table).sort()
    this.layoutKey = JSON.stringify([s.seed, s.tileSize, s.density, s.gridResolution, s.minWavelength, ids.map((id) => [id, this.placementOf(table[id])]), this.layoutExtra()])
    for (const [id, view] of this.views) {
      const sp = table[id]
      if (!sp) {
        const mesh = view.mesh
        mesh.removeFromParent()
        this.later(() => { mesh.geometry.dispose(); (mesh.material as Material).dispose(); mesh.dispose() })
        this.views.delete(id)
        continue
      }
      const key = this.geometryKey(sp)
      if (key !== view.key) {
        view.key = key
        const old = view.mesh.geometry
        const next = this.createGeometry(sp)
        next.setAttribute('faunaMotion', view.motion)
        next.setAttribute('faunaLook', view.look)
        view.mesh.geometry = next
        old.deleteAttribute('faunaMotion') // moved to the new geometry
        old.deleteAttribute('faunaLook')
        this.later(() => old.dispose())
      }
      this.applyLook(id, sp, view.mesh.geometry)
      view.mesh.castShadow = s.castShadow
      view.mesh.receiveShadow = s.receiveShadow
    }
    const weights = s.boids
    for (const t of this.tiles.values()) for (const g of t.groups) Object.assign(g.flock.params, weights)
    return this
  }

  /** Replaces all settings: anything not in `input` goes back to the defaults. */
  reset(input: Partial<T> | object = {}): this {
    this.input = {}
    return this.set(input)
  }

  /** Extra placement-relevant settings of a subclass (JSON-compared). */
  protected layoutExtra(): unknown {
    return null
  }

  private defaultsCopy(): T {
    const d = this.defaults()
    const { predators, ...rest } = d
    return { ...structuredClone(rest), predators } as T
  }

  /** Every group currently spawned. */
  groups(): FaunaGroup[] {
    const out: FaunaGroup[] = []
    for (const t of this.tiles.values()) out.push(...t.groups)
    return out
  }

  /**
   * Streams tiles around the camera, spawns within the time budget, steps the flocks at a fixed rate
   * and writes the instances. Called automatically when a `scene` was given; otherwise once per frame.
   * @param delta Seconds since the last frame; measured if omitted.
   * @param budget Milliseconds for spawning this frame. Defaults to `settings.buildBudget`.
   */
  update(delta: number = this.clock.tick(), budget: number = this.settings.buildBudget): void {
    const s = this.settings
    const frameNo = ++this.frameCount
    const [ox, oy, oz] = s.origin
    const cam = this.camera.getWorldPosition(_v)
    const px = cam.x + ox, py = cam.y + oy, pz = cam.z + oz

    const sphere = this.world.options.surface === 'sphere'
    if (sphere !== this.sphere) {
      this.sphere = sphere
      this.setFrame(this.world.frame)
      this.latLon = null
    }
    if (!sphere) this.frame = this.world.frame
    else if (!this.latLon || (worldToFrame(this.frame, px, py, pz, _l), Math.hypot(_l[0], _l[2])) > s.reframeDistance) {
      const len = Math.hypot(px, py, pz) || 1
      this.latLon = [(Math.asin(py / len) * 180) / Math.PI, (Math.atan2(px, pz) * 180) / Math.PI]
      this.setFrame(this.world.frameAt(...this.latLon))
    } else if (this.frameVersion !== this.world.version) {
      this.frame = this.world.frameAt(...this.latLon)
    }
    if (this.frameVersion !== this.world.version) {
      this.groundAt[0] = NaN
      this.habitatCache = null // habitats may read the world's biome table
    }
    this.frameVersion = this.world.version
    placeInFrame(this.object, this.frame, s.origin)
    const [cx, cy, cz] = worldToFrame(this.frame, px, py, pz, _l)

    // Tiles in range (nothing near while the camera is far above the ground).
    const ts = s.tileSize
    const key = `${this.layoutKey}|${this.world.version}|${this.frameId}`
    const pending: Tile[] = []
    if (!(Math.hypot(cx - this.groundAt[0], cz - this.groundAt[1]) < 8)) this.groundAt = [cx, cz, this.frame.height(cx, cz)]
    const ground = this.groundAt[2]
    if (!(Math.abs(cy - ground) > s.maxDistance)) {
      const r = Math.ceil(s.maxDistance / ts)
      const ci = Math.floor(cx / ts), cj = Math.floor(cz / ts)
      for (let i = ci - r; i <= ci + r; i++) {
        for (let j = cj - r; j <= cj + r; j++) {
          const dist = Math.hypot(Math.max(i * ts - cx, 0, cx - (i + 1) * ts), Math.max(j * ts - cz, 0, cz - (j + 1) * ts))
          if (dist >= s.maxDistance) continue
          const id = `${i},${j}`
          let tile = this.tiles.get(id)
          if (!tile) this.tiles.set(id, (tile = { ix: i, iz: j, built: '', groups: [], seen: 0, dist: 0 }))
          tile.seen = frameNo
          tile.dist = dist
          if (tile.built !== key) pending.push(tile)
        }
      }
    }
    for (const [id, tile] of this.tiles) {
      if (tile.seen === frameNo) continue
      this.tiles.delete(id)
      if (this.job?.tile === tile) this.job = null
    }

    // Spawn nearest first, resuming the tile in progress, until the budget is spent.
    pending.sort((a, b) => a.dist - b.dist)
    const start = performance.now()
    let next = 0
    while (performance.now() - start < budget) {
      if (!this.job || this.job.key !== key) {
        let tile = pending[next++]
        while (tile && tile.built === key) tile = pending[next++]
        if (!tile) break
        this.habitatCache ??= this.habitat()
        const o = { seed: seedOf(s.seed), salt: this.salt, tileSize: ts, density: s.density, gridResolution: s.gridResolution, minWavelength: s.minWavelength }
        this.job = { tile, key, steps: spawnTile(tile.ix, tile.iz, this.species(), this.habitatCache, this.frame, o) }
      }
      const step = this.job.steps.next()
      if (step.done) {
        this.job.tile.groups = step.value.map((g) => this.createGroup(g))
        this.job.tile.built = key
        this.job = null
      }
    }

    // Simulate at a fixed rate (at most 4 steps a frame).
    this.time += delta
    this.accumulator += delta
    const dt = 1 / Math.max(1, s.stepRate)
    let steps = Math.floor(this.accumulator / dt)
    if (steps > 4) { steps = 4; this.accumulator = 0 } else this.accumulator -= steps * dt
    const predators = this.predatorPoints()
    const table = this.species()
    let groups = 0
    for (const t of this.tiles.values()) {
      for (const g of t.groups) {
        groups++
        g.dist = Math.hypot(g.spawn.home[0] - cx, g.spawn.home[2] - cz)
        if (g.dist < s.simDistance) for (let k = 0; k < steps; k++) g.flock.step(dt, predators)
      }
    }
    this.draw(table, cx, cy, cz, delta)
    while (this.trash.length && frameNo - this.trash[0].frame > 60) this.trash.shift()!.dispose()
    this.stats.tiles = this.tiles.size
    this.stats.groups = groups
    let waiting = 0
    for (const t of pending) if (t.built !== key) waiting++
    this.stats.pending = waiting
  }

  /** Moves the floating origin. Same as `set({ origin })`. */
  setOrigin(origin: readonly number[]): this {
    return this.set({ origin: [origin[0], origin[1], origin[2]] } as Partial<T>)
  }

  /** Removes the layer from the scene and frees its GPU resources. */
  dispose(): void {
    this.unhook()
    for (const t of this.trash) t.dispose()
    this.trash = []
    for (const { mesh } of this.views.values()) {
      mesh.geometry.dispose()
      ;(mesh.material as Material).dispose()
      mesh.dispose()
    }
    this.views.clear()
    this.tiles.clear()
    this.object.removeFromParent()
  }

  private createGroup(spawn: GroupSpawn): FaunaGroup {
    const sp = this.species()[spawn.species]
    const flock = new Flock(spawn.seed, spawn.count, spawn.home, { ...this.boidParams(sp), ...this.settings.boids }, spawn.environment)
    const n = spawn.count
    const g: FaunaGroup = { spawn, flock, scale: new Float32Array(n * 3), look: new Float32Array(n * 4), motion: new Float32Array(n * 4), turn: new Float32Array(n * 2), dist: 0 }
    const rand = mulberry32(hash4(spawn.seed, 17, 0, 0))
    for (let i = 0; i < n; i++) {
      this.initMember(sp, rand, g.scale, g.look, i)
      g.motion[i * 4] = rand() * Math.PI * 2
      g.motion[i * 4 + 3] = rand() * Math.PI * 2
      g.turn[i * 2] = Math.atan2(flock.velocity[i * 3], flock.velocity[i * 3 + 2])
    }
    return g
  }

  private predatorBuf: PredatorPoint[] = []
  /** Predator positions in frame coordinates (reuses its objects; no per-frame allocation). */
  private predatorPoints(): PredatorPoint[] {
    const out = this.predatorBuf
    const o = this.settings.origin
    let n = 0
    for (const p of this.settings.predators) {
      const obj = 'isObject3D' in p.object ? p.object : p.object.current
      if (!obj) continue
      obj.getWorldPosition(_v)
      worldToFrame(this.frame, _v.x + o[0], _v.y + o[1], _v.z + o[2], _l)
      const q = (out[n++] ??= { x: 0, y: 0, z: 0, radius: 0 })
      q.x = _l[0]; q.y = _l[1]; q.z = _l[2]; q.radius = p.radius
    }
    out.length = n
    return out
  }

  /** Writes every member's transform and animation straight into the species' instance buffers. */
  private draw(table: Readonly<Record<string, S>>, cx: number, cy: number, cz: number, delta: number) {
    // Anchor near the camera: instance positions stay small numbers on the GPU.
    const ax = Math.round(cx / 64) * 64, ay = Math.round(cy / 64) * 64, az = Math.round(cz / 64) * 64
    this.local.position.set(ax, ay, az)
    this.local.updateMatrixWorld()
    for (const v of this.views.values()) { v.need = 0; v.written = 0; v.min.set(Infinity, Infinity, Infinity); v.max.set(-Infinity, -Infinity, -Infinity); v.reach = 0 }
    for (const t of this.tiles.values()) {
      for (const g of t.groups) {
        const sp = table[g.spawn.species]
        if (sp) this.view(g.spawn.species, sp, 0).need += g.flock.count
      }
    }
    for (const [id, v] of this.views) if (v.need > v.capacity) this.view(id, table[id], v.need)
    for (const t of this.tiles.values()) {
      for (const g of t.groups) {
        const sp = table[g.spawn.species]
        const view = this.views.get(g.spawn.species)
        if (!sp || !view) continue
        const mat = view.mesh.instanceMatrix.array as Float32Array
        const motion = view.motion.array as Float32Array
        const look = view.look.array as Float32Array
        const f = g.flock, maxPitch = this.maxPitch(sp)
        let w = view.written
        for (let i = 0; i < f.count; i++, w++) {
          const vx = f.velocity[i * 3], vy = f.velocity[i * 3 + 1], vz = f.velocity[i * 3 + 2]
          const speed = Math.hypot(vx, vy, vz)
          const yaw = Math.atan2(vx, vz)
          let dy = yaw - g.turn[i * 2]
          dy -= Math.PI * 2 * Math.round(dy / (Math.PI * 2))
          g.turn[i * 2] = yaw
          const rate = delta > 0 ? dy / delta : 0
          g.turn[i * 2 + 1] += (rate - g.turn[i * 2 + 1]) * Math.min(1, delta * 4)
          const roll = this.animate(sp, g, i, delta, speed, g.turn[i * 2 + 1])
          const pitch = Math.max(-maxPitch, Math.min(maxPitch, -Math.asin(Math.max(-1, Math.min(1, vy / Math.max(speed, 1e-6))))))
          const px = f.position[i * 3] - ax, py = f.position[i * 3 + 1] - ay, pz = f.position[i * 3 + 2] - az
          const sx = g.scale[i * 3], sy = g.scale[i * 3 + 1], sz = g.scale[i * 3 + 2]
          _m.makeRotationFromEuler(_e.set(pitch, yaw, roll, 'YXZ'))
          _m.scale(_s.set(sx, sy, sz))
          _m.setPosition(px, py, pz)
          _m.toArray(mat, w * 16)
          for (let k = 0; k < 4; k++) {
            motion[w * 4 + k] = g.motion[i * 4 + k]
            look[w * 4 + k] = g.look[i * 4 + k]
          }
          view.min.set(Math.min(view.min.x, px), Math.min(view.min.y, py), Math.min(view.min.z, pz))
          view.max.set(Math.max(view.max.x, px), Math.max(view.max.y, py), Math.max(view.max.z, pz))
          view.reach = Math.max(view.reach, sx, sy, sz)
        }
        view.written = w
      }
    }
    let animals = 0
    for (const view of this.views.values()) {
      const n = view.written
      const mesh = view.mesh
      mesh.count = n
      mesh.visible = n > 0
      animals += n
      if (!n) continue
      // Explicit bounds (members' box + one body size for the mesh and its animation), so frustum culling works.
      const sphere = (mesh.boundingSphere ??= new Sphere())
      sphere.center.addVectors(view.min, view.max).multiplyScalar(0.5)
      sphere.radius = view.min.distanceTo(view.max) * 0.5 + view.reach * 1.5
      for (const attr of [mesh.instanceMatrix, view.motion, view.look]) {
        attr.clearUpdateRanges()
        attr.addUpdateRange(0, n * attr.itemSize)
        attr.needsUpdate = true
      }
    }
    this.stats.animals = animals
  }

  /**
   * The species' mesh with room for `n` instances. Growing (by 1.5×) makes a new instanced mesh whose
   * geometry shares the species' static attributes; only the old instance buffers are freed, a while later.
   */
  private view(id: string, sp: S, n: number): SpeciesView {
    let view = this.views.get(id)
    if (view && view.capacity >= n) return view
    const capacity = Math.ceil(n * 1.5) + 8
    const geometry = view ? shareStatic(view.mesh.geometry) : this.createGeometry(sp)
    const motion = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    const look = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    motion.setUsage(DynamicDrawUsage)
    look.setUsage(DynamicDrawUsage)
    geometry.setAttribute('faunaMotion', motion)
    geometry.setAttribute('faunaLook', look)
    const material = view ? (view.mesh.material as Material) : this.createMaterial(id)
    const mesh = new InstancedMesh(geometry, material, capacity)
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    mesh.count = 0
    mesh.castShadow = this.settings.castShadow
    mesh.receiveShadow = this.settings.receiveShadow
    mesh.name = id
    if (view) {
      const old = view.mesh
      old.removeFromParent()
      // WebGPU may still be building a pipeline with it: free its instance buffers later, never the shared ones.
      this.later(() => { detachStatic(old.geometry); old.geometry.dispose(); old.dispose() })
    }
    this.local.add(mesh)
    const next: SpeciesView = { mesh, key: view?.key ?? this.geometryKey(sp), capacity, motion, look, need: view?.need ?? 0, written: 0, min: new Vector3(), max: new Vector3(), reach: 0 }
    this.views.set(id, next)
    if (!view) this.applyLook(id, sp, geometry)
    return next
  }

  /** Frees GPU resources a while later (a pipeline still being compiled may reference them). */
  private later(dispose: () => void) {
    this.trash.push({ frame: this.frameCount, dispose })
  }

  private setFrame(frame: LocalFrame) {
    this.frame = frame
    this.frameId++
    this.groundAt[0] = NaN
    this.tiles.clear()
    this.job = null
  }
}

const _v = new Vector3()
const _s = new Vector3()
const _m = new Matrix4()
const _e = new Euler()
const _l: [number, number, number] = [0, 0, 0]
