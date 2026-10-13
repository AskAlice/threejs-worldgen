import { BufferAttribute, BufferGeometry, Group, Mesh, Sphere, Vector3, type Camera, type MeshStandardNodeMaterial, type Object3D } from 'three/webgpu'
import { buildChunk, chunkId, chunkIndex, type ChunkData, type ChunkKey, type ChunkSettings } from './chunk.ts'
import { selectChunks, type ChunkBounds, type LodSettings } from './lod.ts'
import { createTerrainMaterial, DEFAULT_TERRAIN_MATERIAL, type TerrainMaterialOptions, type TerrainUniforms } from './terrain-material.ts'
import type { Vec3 } from './noise.ts'
import type { World, WorldRegion } from './world.ts'

/** Every terrain setting (plain data). Change at runtime with {@link WorldTerrain.set}. */
export interface TerrainOptions extends LodSettings, ChunkSettings {
  /** Milliseconds per frame spent building chunks on the main thread (when there are no workers). */
  buildBudget: number
  /** Chunk jobs in flight per worker. */
  jobsPerWorker: number
  /** Frames an unused chunk stays cached before it is freed. */
  keepAlive: number
  /** Terrain casts shadows. */
  castShadow: boolean
  /** Terrain receives shadows. */
  receiveShadow: boolean
  /**
   * Floating origin: the world position that sits at render-space (0, 0, 0). Keep it near the camera
   * (see `FloatingOrigin`) so float32 GPU precision holds from orbit down to ant scale.
   */
  origin: Vec3
  /** Surface look (see `TerrainMaterialOptions`). */
  material: TerrainMaterialOptions
}

/** Recursive partial input for {@link WorldTerrain.set}. */
export type TerrainInput = Partial<Omit<TerrainOptions, 'material'>> & { material?: Partial<TerrainMaterialOptions> }

/** Default terrain settings: 33² vertex chunks, 4 km roots, metre-scale detail at the camera. */
export const DEFAULT_TERRAIN: TerrainOptions = {
  resolution: 33,
  rootSize: 4096,
  skirt: 0.03,
  lodFactor: 2,
  minChunkSize: 1,
  viewDistance: 24_000,
  buildBudget: 6,
  jobsPerWorker: 2,
  keepAlive: 240,
  castShadow: false,
  receiveShadow: true,
  origin: [0, 0, 0],
  material: { ...DEFAULT_TERRAIN_MATERIAL },
}

/** Options for {@link WorldTerrain.create}. */
export interface TerrainCreateOptions extends TerrainInput {
  /** The world to render. */
  world: World
  /** Camera that drives the level of detail. */
  camera: Camera
  /** Optional scene: the terrain adds itself and updates before each render. */
  scene?: Object3D
  /**
   * Creates a build worker (e.g. `() => new TerrainWorker()` with Vite's `?worker` import of
   * `threejs-biomes/worker`). Without it, chunks build on the main thread within `buildBudget`.
   */
  createWorker?: () => Worker
  /** How many workers to start when `createWorker` is given. Default: cores − 1, at most 4. */
  workers?: number
}

/** Live counters, refreshed by {@link WorldTerrain.update}. */
export interface TerrainStats {
  /** Chunks drawn this frame. */
  visible: number
  /** Chunks kept in memory. */
  cached: number
  /** Chunks waiting to be built. */
  queued: number
  /** Chunk builds running in workers. */
  building: number
  /** Triangles drawn this frame. */
  triangles: number
  /** Deepest quadtree level drawn. */
  deepest: number
}

interface Entry {
  key: ChunkKey
  data?: ChunkData
  mesh?: Mesh<BufferGeometry, MeshStandardNodeMaterial>
  stale: boolean
  building: boolean
  lastSeen: number
}

const DETAIL_PERIOD = 4096

/**
 * Streaming level-of-detail terrain for a {@link World}: a grid of quadtrees on flat worlds, a cube-sphere
 * of quadtrees on planets. Chunks split as the camera approaches (down to `minChunkSize`), build in Web
 * Workers or within a main-thread budget, never leave holes while they swap, and rebuild only the
 * region a world change touched. Geometry is stored relative to each chunk's centre and placed relative
 * to a floating `origin`, so it stays precise from orbit to ant scale.
 *
 * @example
 * ```ts
 * const world = new World({ surface: 'sphere', radius: 60_000 })
 * const terrain = await WorldTerrain.create({ world, camera, scene })
 * terrain.set({ material: { debug: 'biomes' } })
 * ```
 */
export class WorldTerrain {
  /** Root of all chunk meshes. */
  readonly object = new Group()
  /** Live counters. */
  readonly stats: TerrainStats = { visible: 0, cached: 0, queued: 0, building: 0, triangles: 0, deepest: 0 }
  /** Shader uniforms of the shared terrain material. */
  readonly uniforms: TerrainUniforms
  /** The shared terrain material. */
  readonly material: MeshStandardNodeMaterial
  /** Resolved settings. */
  options: TerrainOptions
  /** Camera that drives the level of detail. */
  camera: Camera
  /** The world being rendered. */
  readonly world: World

  private entries = new Map<string, Entry>()
  private frame = 0
  private workers: Worker[] = []
  private jobs = new Map<number, Entry>()
  private nextJob = 1
  private workerLoad: number[] = []
  private unsubscribe: () => void
  private unhook = () => {}
  private camPos = new Vector3()
  private input: TerrainInput
  private setDebug: (debug: TerrainMaterialOptions['debug']) => void

  /** Creates the terrain, starts workers and builds the first view so the first frame has ground. */
  static async create(options: TerrainCreateOptions): Promise<WorldTerrain> {
    const t = new WorldTerrain(options)
    t.update(options.createWorker ? 0 : 250)
    return t
  }

  /** Prefer {@link WorldTerrain.create}. */
  constructor({ world, camera, scene, createWorker, workers, ...input }: TerrainCreateOptions) {
    this.world = world
    this.camera = camera
    this.input = input
    this.options = resolve(input)
    const { material, uniforms, setDebug } = createTerrainMaterial(this.options.material)
    this.material = material
    this.uniforms = uniforms
    this.setDebug = setDebug
    this.object.name = 'WorldTerrain'
    if (createWorker) {
      const count = workers ?? Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1))
      for (let i = 0; i < count; i++) {
        const w = createWorker()
        w.onmessage = (e) => this.onWorkerMessage(e.data)
        this.workers.push(w)
        this.workerLoad.push(0)
      }
      this.sendWorld()
    }
    this.syncGround()
    this.unsubscribe = world.onChange((_, region) => {
      this.syncGround()
      this.invalidate(region)
    })
    if (scene) {
      scene.add(this.object)
      const previous = scene.onBeforeRender
      scene.onBeforeRender = (...args) => {
        previous.apply(scene, args)
        this.update()
      }
      this.unhook = () => { scene.onBeforeRender = previous }
    }
  }

  /** Merges settings (nested `material` merges too). Geometry settings rebuild chunks; look settings apply instantly. */
  set(input: TerrainInput): this {
    this.input = { ...this.input, ...input, material: { ...this.input.material, ...input.material } }
    return this.apply()
  }

  /** Replaces all settings; anything not given goes back to {@link DEFAULT_TERRAIN}. */
  reset(input: TerrainInput = {}): this {
    this.input = input
    return this.apply()
  }

  private apply(): this {
    const before = this.options
    this.options = resolve(this.input)
    const o = this.options
    const m = o.material
    if (before.material.debug !== m.debug) this.setDebug(m.debug)
    this.uniforms.detail.value = m.detail
    this.uniforms.detailScale.value = m.detailScale
    this.uniforms.detailDistance.value = m.detailDistance
    this.uniforms.bump.value = m.bump
    this.uniforms.brightness.value = m.brightness
    this.uniforms.saturation.value = m.saturation
    if (this.material.wireframe !== m.wireframe) { this.material.wireframe = m.wireframe; this.material.needsUpdate = true }
    if (before.resolution !== o.resolution || before.rootSize !== o.rootSize || before.skirt !== o.skirt) this.clear()
    if (before.origin.join() !== o.origin.join()) this.placeMeshes()
    for (const e of this.entries.values()) if (e.mesh) { e.mesh.castShadow = o.castShadow; e.mesh.receiveShadow = o.receiveShadow }
    return this
  }

  /** Moves the floating origin (planet-centred position that maps to render-space zero). */
  setOrigin(origin: Vec3): this {
    return this.set({ origin: [origin[0], origin[1], origin[2]] })
  }

  /**
   * Picks chunks for the camera, schedules builds and swaps meshes. Call once per frame (done for you
   * when a `scene` was passed). `budgetMs` overrides `buildBudget` for main-thread builds.
   */
  update(budgetMs = this.options.buildBudget): void {
    this.frame++
    const o = this.options
    this.camera.getWorldPosition(this.camPos)
    const cam: Vec3 = [this.camPos.x + o.origin[0], this.camPos.y + o.origin[1], this.camPos.z + o.origin[2]]
    const maxElevation = this.maxElevation()
    const bounds = (k: ChunkKey): ChunkBounds | undefined => {
      const d = this.entries.get(chunkId(k))?.data
      return d ? { center: d.center, radius: d.radius, maxElevation: d.maxElevation } : undefined
    }
    const { show, need } = selectChunks(this.world, cam, o, bounds, maxElevation)

    // Stale chunks keep drawing until their rebuild lands; queue them behind missing ones.
    const queue = need.map((k) => this.entry(k))
    for (const k of show) {
      const e = this.entry(k)
      e.lastSeen = this.frame
      if (e.stale) queue.push(e)
    }
    for (const e of queue) e.lastSeen = this.frame

    // Visibility.
    const shown = new Set(show.map(chunkId))
    let triangles = 0, deepest = 0
    for (const [id, e] of this.entries) {
      const visible = shown.has(id)
      if (e.mesh) e.mesh.visible = visible
      if (visible && e.data) { triangles += e.data.index.length / 3; deepest = Math.max(deepest, e.key.level) }
    }

    // Build.
    const todo = queue.filter((e) => !e.building)
    if (this.workers.length) {
      for (const e of todo) {
        const w = this.leastLoaded()
        if (w < 0) break
        this.dispatch(e, w)
      }
    } else {
      const start = performance.now()
      for (const e of todo) {
        this.finish(e, buildChunk(this.world, e.key, o))
        if (performance.now() - start > budgetMs) break
      }
    }

    // Free chunks nobody has needed for a while.
    for (const [id, e] of this.entries) {
      if (!e.building && !shown.has(id) && this.frame - e.lastSeen > o.keepAlive) this.drop(id, e)
    }

    const s = this.stats
    s.visible = show.length
    s.cached = this.entries.size
    s.queued = todo.length
    s.building = this.jobs.size
    s.triangles = triangles
    s.deepest = deepest
  }

  /** Frees all GPU resources, stops workers and detaches from the scene and world. */
  dispose(): void {
    this.unhook()
    this.unsubscribe()
    for (const w of this.workers) w.terminate()
    this.workers = []
    this.clear()
    this.material.dispose()
    this.object.removeFromParent()
  }

  // --- internals ------------------------------------------------------------------------------------

  // The shader's ground overrides follow the world's ground settings.
  private syncGround() {
    const g = this.world.options.ground
    const u = this.uniforms
    u.rockSlope.value = g.rockSlope
    u.snowTemperature.value = g.snowTemperature
    u.sandBand.value = g.sandBand
    u.rockColor.value.set(g.colors.rock)
    u.snowColor.value.set(g.colors.snow)
    u.sandColor.value.set(g.colors.sand)
    u.mudColor.value.set(g.colors.mud)
  }

  private entry(k: ChunkKey): Entry {
    const id = chunkId(k)
    let e = this.entries.get(id)
    if (!e) {
      e = { key: k, stale: false, building: false, lastSeen: this.frame }
      this.entries.set(id, e)
    }
    return e
  }

  private maxElevation(): number {
    const w = this.world.options
    return w.mountains.height + w.volcanoes.height + w.hills.height + w.continents.curve.reduce((m, p) => Math.max(m, p[1]), 0)
  }

  private leastLoaded(): number {
    let best = -1, load = this.options.jobsPerWorker
    this.workerLoad.forEach((l, i) => { if (l < load) { load = l; best = i } })
    return best
  }

  private dispatch(e: Entry, worker: number) {
    const id = this.nextJob++
    e.building = true
    e.stale = false
    this.jobs.set(id, e)
    this.workerLoad[worker]++
    const o = this.options
    this.workers[worker].postMessage({ type: 'build', id, worker, key: e.key, settings: { resolution: o.resolution, rootSize: o.rootSize, skirt: o.skirt } })
  }

  private onWorkerMessage(msg: { type: string; id: number; worker: number; data: ChunkData }) {
    if (msg.type !== 'built') return
    this.workerLoad[msg.worker] = Math.max(0, this.workerLoad[msg.worker] - 1)
    const e = this.jobs.get(msg.id)
    this.jobs.delete(msg.id)
    if (!e) return
    e.building = false
    const data = msg.data
    data.index = chunkIndex(this.options.resolution, data.index as unknown as boolean)
    if (data.version !== this.world.version && this.staleSince(e, data.version)) e.stale = true
    if (this.entries.get(chunkId(e.key)) === e) this.finish(e, data, false)
  }

  // Region changes only stale what they touch; full changes stale everything (tracked via versions).
  private regionVersions: { version: number; region?: WorldRegion }[] = []
  private staleSince(e: Entry, version: number): boolean {
    for (const c of this.regionVersions) if (c.version > version && (!c.region || this.touches(e, c.region))) return true
    return false
  }

  private finish(e: Entry, data: ChunkData, clearStale = true) {
    e.data = data
    e.building = false
    if (clearStale) e.stale = false
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(data.positions, 3))
    geometry.setAttribute('normal', new BufferAttribute(data.normals, 3))
    geometry.setAttribute('color', new BufferAttribute(data.colors, 3))
    geometry.setAttribute('climate', new BufferAttribute(data.climate, 4))
    geometry.setAttribute('biomeColor', new BufferAttribute(data.biomeColors, 3))
    geometry.setIndex(new BufferAttribute(data.index, 1))
    geometry.boundingSphere = new Sphere(new Vector3(), data.radius)
    const old = e.mesh
    const mesh = new Mesh(geometry, this.material)
    mesh.name = `chunk ${chunkId(e.key)}`
    mesh.castShadow = this.options.castShadow
    mesh.receiveShadow = this.options.receiveShadow
    mesh.matrixAutoUpdate = true
    mesh.userData.level = e.key.level
    mesh.userData.detailOffset = new Vector3(mod(data.center[0], DETAIL_PERIOD), mod(data.center[1], DETAIL_PERIOD), mod(data.center[2], DETAIL_PERIOD))
    mesh.visible = old?.visible ?? false
    this.place(mesh, data)
    e.mesh = mesh
    this.object.add(mesh)
    if (old) {
      old.removeFromParent()
      old.geometry.dispose()
    }
  }

  private place(mesh: Mesh, data: ChunkData) {
    const o = this.options.origin
    mesh.position.set(data.center[0] - o[0], data.center[1] - o[1], data.center[2] - o[2])
  }

  private placeMeshes() {
    for (const e of this.entries.values()) if (e.mesh && e.data) this.place(e.mesh, e.data)
  }

  private drop(id: string, e: Entry) {
    if (e.mesh) {
      e.mesh.removeFromParent()
      e.mesh.geometry.dispose()
    }
    this.entries.delete(id)
  }

  private clear() {
    for (const [id, e] of this.entries) this.drop(id, e)
    this.jobs.clear()
    this.workerLoad.fill(0)
  }

  private sendWorld() {
    const msg = { type: 'world', options: this.world.options, version: this.world.version }
    for (const w of this.workers) w.postMessage(msg)
  }

  private invalidate(region?: WorldRegion) {
    this.regionVersions.push({ version: this.world.version, region })
    if (this.regionVersions.length > 64) this.regionVersions.shift()
    this.sendWorld()
    for (const e of this.entries.values()) if (!region || this.touches(e, region)) e.stale = true
  }

  private touches(e: Entry, r: WorldRegion): boolean {
    const d = e.data
    if (!d) return true
    const sphere = this.world.options.surface === 'sphere'
    // Flat worlds compare x/z only (modifier heights live in y); planets compare the full 3D box.
    const [cx, cy, cz] = d.center
    const rad = d.radius
    if (cx + rad < r.min[0] || cx - rad > r.max[0] || cz + rad < r.min[2] || cz - rad > r.max[2]) return false
    if (sphere && (cy + rad < r.min[1] || cy - rad > r.max[1])) return false
    return true
  }
}

function mod(x: number, p: number): number {
  return ((x % p) + p) % p
}

function resolve(input: TerrainInput): TerrainOptions {
  const o = { ...DEFAULT_TERRAIN, ...input, material: { ...DEFAULT_TERRAIN.material, ...input.material } } as TerrainOptions
  for (const k of Object.keys(o) as (keyof TerrainOptions)[]) if (o[k] === undefined) (o as any)[k] = DEFAULT_TERRAIN[k]
  return o
}
