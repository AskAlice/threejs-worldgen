import {
  BufferGeometry as BufferGeometryClass, Group, InstancedBufferAttribute, InstancedBufferGeometry, InstancedMesh, Mesh, Vector3,
  type BufferGeometry, type Camera, type Material, type Object3D, type Texture,
} from 'three/webgpu'
import { createHeightSampler, type HeightFn, type Terrain } from 'threejs-heightfield'
import { selectLod } from './lod.ts'
import { DEFAULT_PLACEMENT, groupSeed, INSTANCE_STRIDE, placeTile, type PlacementRules } from './placement.ts'

/**
 * One level of detail of a {@link ScatterLayer}: what to draw up to a distance.
 *
 * Mesh levels are drawn as `InstancedMesh`es whose geometry also carries a per-instance `scatterParams` attribute
 * (x = yaw, y = brightness tint, z = random 0..1, w = 0); read it in your material with `scatterParamsNode()` for
 * per-instance variation.
 */
export interface ScatterLOD {
  /** Instances closer to the camera than this (metres) and beyond the previous level's distance use this level. */
  distance: number
  /** Geometry of one instance, in its local space with the ground at y = 0. */
  geometry: BufferGeometry
  /** Its material, or one per geometry group (e.g. bark + leaves). */
  material: Material | Material[]
  /** Overrides the layer's `castShadow` for this level (e.g. `false` for far levels). */
  castShadow?: boolean
}

/**
 * One kind of scattered object (a tree species variant, a rock type, a shrub…): where it grows ({@link PlacementRules})
 * and how it is drawn at each distance. `lods`, `impostor` and a function `density` are the only non-JSON fields.
 */
export interface ScatterLayer extends PlacementRules {
  /** Mesh levels of detail, nearest first, with ascending `distance`. */
  lods: ScatterLOD[]
  /**
   * Far level drawn after the last mesh level, typically from `bakeImpostor()`. Unlike mesh levels it is not an
   * `InstancedMesh`: its material reads two per-instance attributes, `scatterPosition` (xyz = base position,
   * w = scale) and `scatterParams` (x = yaw, y = brightness tint, z = random 0..1).
   */
  impostor: ScatterLOD | null
  /** Whether instances cast shadows (can be overridden per level). */
  castShadow: boolean
  /** Whether instances receive shadows. */
  receiveShadow: boolean
}

/** A layer as accepted by {@link Scatter.set}: `name` is required, every other field has a default. */
export type ScatterLayerInput = Partial<ScatterLayer> & Pick<ScatterLayer, 'name'>

/** Every setting of a {@link Scatter}. */
export interface ScatterSettings {
  /** World seed. Same seed + same layers = same placement. */
  seed: number
  /** Edge length of a streaming tile, in metres. */
  tileSize: number
  /** Nothing is generated beyond this distance from the camera (each layer also stops at its last LOD distance). */
  maxDistance: number
  /** Milliseconds per frame spent generating tiles, nearest first. */
  buildBudget: number
  /** Fractional band around LOD distances that an instance must cross before switching level (stops flicker). */
  lodHysteresis: number
  /** How far (metres) the camera moves before instances are re-sorted into levels of detail. */
  refreshDistance: number
  /** The kinds of objects to scatter. */
  layers: ScatterLayer[]
}

/** Partial settings accepted by {@link Scatter.create}, {@link Scatter.set} and the `<Scatter>` component. */
export type ScatterInput = Partial<Omit<ScatterSettings, 'layers'>> & {
  /** Layers to scatter; replaces the previous list. Missing layer fields take their defaults. */
  layers?: ScatterLayerInput[]
}

/** Options for {@link Scatter.create}. */
export interface ScatterOptions extends ScatterInput {
  /** The camera tiles stream around and whose distance picks levels of detail. */
  camera: Camera
  /** If given, the scatter is added to it and updates itself whenever it renders (`scene.onBeforeRender`). */
  scene?: Object3D
  /** Mesh/group to scatter on (baked into a heightfield once), a `(x, z) => y` function, or omit for flat ground. */
  terrain?: Terrain
}

/** Live counters of a {@link Scatter}, refreshed on every {@link Scatter.update}. */
export interface ScatterStats {
  /** Tiles currently streamed in. */
  tiles: number
  /** Instances generated in those tiles. */
  instances: number
  /** Instances currently drawn (within some level of detail). */
  visible: number
  /** Pooled meshes drawing something (each is one draw call, plus shadow passes). */
  meshes: number
}

/** One placed instance, as returned by {@link Scatter.query}. */
export interface ScatterInstance {
  /** Name of the layer it belongs to. */
  layer: string
  /** World X of its base. */
  x: number
  /** World Y of its base (terrain height minus `sink`). */
  y: number
  /** World Z of its base. */
  z: number
  /** Uniform scale. */
  scale: number
  /** Rotation around the up axis, radians. */
  yaw: number
  /** Stable per-instance random number in [0, 1). */
  random: number
}

const DEFAULTS: Omit<ScatterSettings, 'layers'> = {
  seed: 1,
  tileSize: 64,
  maxDistance: 600,
  buildBudget: 4,
  lodHysteresis: 0.1,
  refreshDistance: 1,
}

const LAYER_DEFAULTS: Omit<ScatterLayer, 'name'> = { ...DEFAULT_PLACEMENT, lods: [], impostor: null, castShadow: true, receiveShadow: true }

/** Fills in defaults for a {@link ScatterLayerInput}. */
export function resolveLayer(input: ScatterLayerInput): ScatterLayer {
  const layer = { ...LAYER_DEFAULTS } as ScatterLayer
  for (const [k, v] of Object.entries(input)) if (v !== undefined) (layer as any)[k] = v
  return layer
}

interface LayerGroup {
  key: string
  /** Indices into `settings.layers`, in priority order. */
  layers: number[]
  /** Tiles nearer than this get this group's instances. */
  range: number
  /** Changes whenever placement would change. */
  placementKey: string
}

interface TileGroup {
  /** Per layer of the group: {@link INSTANCE_STRIDE} floats per instance. */
  data: Float32Array[]
  /** Per layer of the group: current level of detail per instance (-1 = hidden). */
  lod: Int8Array[]
}

interface Tile {
  ix: number
  iz: number
  dist: number
  seen: number
  groups: Map<string, TileGroup>
}

interface Pool {
  /** One single-material mesh per material group, all sharing one set of instance buffers. */
  meshes: (InstancedMesh | Mesh<InstancedBufferGeometry>)[]
  capacity: number
  impostor: boolean
}

/**
 * Streams instanced objects (trees, rocks, shrubs…) over terrain in camera-centred tiles.
 *
 * Each tile places every layer with seamless blue noise (see `poissonDisk`), filtered by density, slope, height and
 * clumping noise, so the world is a pure function of `seed` and position. Instances of each layer and level of detail
 * are pooled into one instanced mesh, so draw calls don't grow with the number of tiles.
 *
 * @example
 * ```ts
 * const scatter = Scatter.create({ camera, scene, terrain, layers: [
 *   { name: 'boulder', spacing: 12, lods: [{ distance: 150, geometry, material }], align: 1, scale: [0.6, 1.8] },
 * ] })
 * ```
 */
export class Scatter {
  /** Root of all pooled meshes. Added to `scene` for you when one is passed to {@link Scatter.create}. */
  readonly object = new Group()
  /** Live counters, refreshed on every {@link Scatter.update}. */
  readonly stats: ScatterStats = { tiles: 0, instances: 0, visible: 0, meshes: 0 }
  /** Camera the tiles follow. Can be swapped at any time. */
  camera: Camera
  /** Resolved settings. Read-only: change them with {@link Scatter.set} / {@link Scatter.reset}. */
  settings!: ScatterSettings
  /** Terrain height at world (x, z); NaN where there is no terrain. */
  sampleHeight: HeightFn

  private input: ScatterInput = {}
  private groups: LayerGroup[] = []
  private tiles = new Map<string, Tile>()
  private pools: (Pool | null)[][] = []
  private renderKeys: string[] = []
  private layoutKey = ''
  private frame = 0
  private dirty = true
  private lastRefresh = new Vector3(Infinity, 0, 0)
  private unhook = () => {}

  /** Creates a scatter and generates every tile in range, so the first frame is complete. */
  static create(options: ScatterOptions): Scatter {
    const scatter = new Scatter(options)
    scatter.update(Infinity)
    return scatter
  }

  /** Prefer {@link Scatter.create}, which also builds all tiles up front. */
  constructor({ camera, scene, terrain, ...input }: ScatterOptions) {
    this.camera = camera
    this.sampleHeight = createHeightSampler(terrain)
    this.object.name = 'Scatter'
    this.set(input)
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

  /**
   * Changes settings, merging into what was set before (`layers` is replaced as a whole). Only what changed is
   * redone: placement changes regenerate the affected layer groups, LOD/material changes only rebuild the pools.
   * Density functions are read when a tile is generated; call {@link Scatter.regenerate} after changing what one returns.
   */
  set(input: ScatterInput): this {
    for (const [k, v] of Object.entries(input)) if (v !== undefined) (this.input as any)[k] = v
    return this.apply()
  }

  /** Replaces all settings with `input`; anything not given falls back to its default. `<Scatter>` uses this. */
  reset(input: ScatterInput = {}): this {
    this.input = {}
    return this.set(input)
  }

  /** Swaps the terrain (mesh or height function) and regenerates every tile. */
  setTerrain(terrain?: Terrain): void {
    this.sampleHeight = createHeightSampler(terrain)
    this.regenerate()
  }

  /** Throws away all generated tiles; they are rebuilt (within the build budget) over the next frames. */
  regenerate(): void {
    this.tiles.clear()
    this.dirty = true
  }

  private apply(): this {
    const layers = (this.input.layers ?? []).map(resolveLayer)
    const s: ScatterSettings = { ...DEFAULTS, ...(this.input as any), layers }
    this.settings = s

    const layoutKey = JSON.stringify([s.seed, s.tileSize])
    if (layoutKey !== this.layoutKey) {
      this.layoutKey = layoutKey
      this.tiles.clear()
    }

    // Group layers that share a point set and work out how far each group streams.
    const byKey = new Map<string, number[]>()
    layers.forEach((l, i) => {
      const key = l.group ?? l.name
      byKey.set(key, [...(byKey.get(key) ?? []), i])
    })
    const old = new Map(this.groups.map((g) => [g.key, g.placementKey]))
    this.groups = [...byKey].map(([key, idx]) => ({
      key,
      layers: idx,
      range: Math.min(s.maxDistance, Math.max(...idx.map((i) => lastDistance(layers[i])))),
      placementKey: JSON.stringify(idx.map((i) => placementKey(layers[i]))),
    }))
    for (const g of this.groups) {
      if (old.get(g.key) === g.placementKey) continue
      for (const tile of this.tiles.values()) tile.groups.delete(g.key)
    }
    for (const tile of this.tiles.values()) {
      for (const key of tile.groups.keys()) if (!byKey.has(key)) tile.groups.delete(key)
    }

    // Pools only depend on what is drawn; keep them when a layer's LODs are unchanged.
    const renderKeys = layers.map(renderKey)
    for (let i = 0; i < Math.max(layers.length, this.pools.length); i++) {
      if (renderKeys[i] === this.renderKeys[i]) continue
      for (const pool of this.pools[i] ?? []) if (pool) this.retire(pool)
      this.pools[i] = []
    }
    this.pools.length = layers.length
    this.renderKeys = renderKeys
    this.dirty = true
    return this
  }

  /**
   * Streams tiles in and out around the camera, generates pending ones within the budget and, when the camera has
   * moved far enough or tiles changed, re-sorts instances into levels of detail. Called automatically when a `scene`
   * was given (and by `<Scatter>`); otherwise call it once per frame.
   * @param budget Milliseconds for tile generation this frame. Defaults to `settings.buildBudget`.
   */
  update(budget: number = this.settings.buildBudget): void {
    const s = this.settings
    const frame = ++this.frame
    const cam = this.camera.getWorldPosition(_v)
    const ts = s.tileSize
    const reach = Math.max(0, ...this.groups.map((g) => g.range))
    const r = Math.ceil(reach / ts)
    const ci = Math.floor(cam.x / ts)
    const cj = Math.floor(cam.z / ts)
    const pending: { tile: Tile; group: LayerGroup }[] = []
    const h = 1 + s.lodHysteresis

    for (let i = ci - r; i <= ci + r; i++) {
      for (let j = cj - r; j <= cj + r; j++) {
        const dist = Math.hypot(Math.max(i * ts - cam.x, 0, cam.x - (i + 1) * ts), Math.max(j * ts - cam.z, 0, cam.z - (j + 1) * ts))
        if (dist >= reach * h) continue
        const key = `${i},${j}`
        let tile = this.tiles.get(key)
        if (!tile) {
          tile = { ix: i, iz: j, dist, seen: 0, groups: new Map() }
          this.tiles.set(key, tile)
        }
        tile.seen = frame
        tile.dist = dist
        for (const group of this.groups) {
          const has = tile.groups.has(group.key)
          if (!has && dist < group.range) pending.push({ tile, group })
          else if (has && dist >= group.range * h) {
            tile.groups.delete(group.key)
            this.dirty = true
          }
        }
      }
    }
    for (const [key, tile] of this.tiles) {
      if (tile.seen !== frame) {
        this.tiles.delete(key)
        if (tile.groups.size) this.dirty = true
      }
    }

    pending.sort((a, b) => a.tile.dist - b.tile.dist)
    const start = performance.now()
    for (const { tile, group } of pending) {
      tile.groups.set(group.key, this.generate(tile.ix, tile.iz, group))
      this.dirty = true
      if (performance.now() - start > budget) break
    }

    if (this.dirty || cam.distanceToSquared(this.lastRefresh) > s.refreshDistance * s.refreshDistance) this.refresh(cam)
  }

  /**
   * Instances within `radius` of world (x, z), for gameplay and collision. Deterministic: tiles that are not streamed
   * in are generated on the fly (not cached), so results don't depend on where the camera is.
   */
  query(x: number, z: number, radius: number): ScatterInstance[] {
    const s = this.settings
    const ts = s.tileSize
    const out: ScatterInstance[] = []
    const r2 = radius * radius
    for (let i = Math.floor((x - radius) / ts); i <= Math.floor((x + radius) / ts); i++) {
      for (let j = Math.floor((z - radius) / ts); j <= Math.floor((z + radius) / ts); j++) {
        const tile = this.tiles.get(`${i},${j}`)
        for (const group of this.groups) {
          const tg = tile?.groups.get(group.key) ?? this.generate(i, j, group)
          group.layers.forEach((li, k) => {
            const data = tg.data[k]
            for (let o = 0; o < data.length; o += INSTANCE_STRIDE) {
              const dx = data[o + 12] - x
              const dz = data[o + 14] - z
              if (dx * dx + dz * dz > r2) continue
              out.push({ layer: s.layers[li].name, x: data[o + 12], y: data[o + 13], z: data[o + 14], scale: data[o + 17], yaw: data[o + 16], random: data[o + 19] })
            }
          })
        }
      }
    }
    return out
  }

  /** Removes the scatter from the scene and drops its pools (reclaimed by GC, see `retire`). Layer geometries and materials are yours to dispose. */
  dispose(): void {
    this.unhook()
    this.tiles.clear()
    for (const pools of this.pools) for (const pool of pools) if (pool) this.retire(pool)
    this.pools = []
    this.renderKeys = []
    this.object.removeFromParent()
  }

  private generate(ix: number, iz: number, group: LayerGroup): TileGroup {
    const s = this.settings
    const layers = group.layers.map((i) => s.layers[i])
    const data = placeTile(layers, ix * s.tileSize, iz * s.tileSize, s.tileSize, groupSeed(s.seed, group.key), this.sampleHeight)
    return { data, lod: data.map((d) => new Int8Array(d.length / INSTANCE_STRIDE).fill(-1)) }
  }

  /** Re-sorts every instance into its level of detail and refills the pooled meshes. */
  private refresh(cam: Vector3) {
    const s = this.settings
    this.lastRefresh.copy(cam)
    this.dirty = false
    const layerDistances = s.layers.map(distancesOf)
    const counts = s.layers.map((_, i) => new Int32Array(layerDistances[i].length))
    let instances = 0

    // Pass 1: pick levels (with hysteresis) and count.
    for (const tile of this.tiles.values()) {
      for (const group of this.groups) {
        const tg = tile.groups.get(group.key)
        if (!tg) continue
        group.layers.forEach((li, k) => {
          const data = tg.data[k]
          const lod = tg.lod[k]
          const dists = layerDistances[li]
          const c = counts[li]
          instances += lod.length
          for (let n = 0, o = 0; n < lod.length; n++, o += INSTANCE_STRIDE) {
            const d = Math.hypot(data[o + 12] - cam.x, data[o + 13] - cam.y, data[o + 14] - cam.z)
            const level = selectLod(d, dists, lod[n], s.lodHysteresis)
            lod[n] = level
            if (level >= 0) c[level]++
          }
        })
      }
    }

    // Size the pools, then pass 2: fill them.
    let visible = 0
    let meshes = 0
    const writers: (PoolWriter | null)[][] = s.layers.map((layer, li) =>
      Array.from(counts[li], (n, level) => {
        const pool = this.ensurePool(li, level, n)
        if (!pool) return null
        visible += n
        if (n) meshes += pool.meshes.length
        return writer(pool, layer.colorVariation > 0)
      }),
    )
    for (const tile of this.tiles.values()) {
      for (const group of this.groups) {
        const tg = tile.groups.get(group.key)
        if (!tg) continue
        group.layers.forEach((li, k) => {
          const data = tg.data[k]
          const lod = tg.lod[k]
          const w = writers[li]
          for (let n = 0, o = 0; n < lod.length; n++, o += INSTANCE_STRIDE) if (lod[n] >= 0) w[lod[n]]?.(data, o)
        })
      }
    }
    for (let li = 0; li < s.layers.length; li++) {
      counts[li].forEach((n, level) => {
        const pool = this.pools[li][level]
        if (pool) finishPool(pool, n)
      })
    }

    this.stats.tiles = this.tiles.size
    this.stats.instances = instances
    this.stats.visible = visible
    this.stats.meshes = meshes
  }

  /** The pool of layer `li` at `level`, grown to hold `count` instances (created on first use). */
  private ensurePool(li: number, level: number, count: number): Pool | null {
    const layer = this.settings.layers[li]
    const pools = this.pools[li]
    let pool = pools[level] ?? null
    if (!count && !pool) return null
    if (pool && pool.capacity >= count) return pool
    if (pool) this.retire(pool)
    const capacity = Math.max(MIN_CAPACITY, Math.ceil(count * 2)) // generous: every resize is a new GPU buffer
    const impostor = level >= layer.lods.length
    const lod = impostor ? layer.impostor! : layer.lods[level]
    const params = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    const meshes: Pool['meshes'] = []
    if (impostor) {
      const geometry = shareGeometry(lod.geometry, new InstancedBufferGeometry())
      geometry.setAttribute('scatterPosition', new InstancedBufferAttribute(new Float32Array(capacity * 4), 4))
      geometry.setAttribute('scatterParams', params)
      geometry.instanceCount = 0
      meshes.push(new Mesh(geometry, lod.material))
    } else {
      // One InstancedMesh per material group, never a material array: three.js draws every object with a single
      // override material in shadow passes, keyed by object, so the groups of a multi-material mesh would share one
      // shadow render object and rebuild it (and its binding buffers) for each group, every frame.
      const parts = Array.isArray(lod.material)
        ? lod.geometry.groups.map((g) => ({ material: (lod.material as Material[])[g.materialIndex ?? 0], start: g.start, count: g.count }))
        : [{ material: lod.material, start: 0, count: Infinity }]
      const matrices = new InstancedBufferAttribute(new Float32Array(capacity * 16), 16)
      const colors = layer.colorVariation > 0 ? new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3) : null
      for (const part of parts) {
        if (!part.material) continue
        // A per-part wrapper sharing the level's buffers, plus the pool's shared per-instance attributes.
        const geometry = shareGeometry(lod.geometry, new BufferGeometryClass(), false)
        geometry.setDrawRange(part.start, part.count)
        geometry.setAttribute('scatterParams', params)
        const mesh = new InstancedMesh(geometry, part.material, 0)
        mesh.instanceMatrix = matrices
        mesh.instanceColor = colors
        meshes.push(mesh)
      }
    }
    for (const mesh of meshes) {
      const material = mesh.material as Material
      mesh.name = `${layer.name}:${impostor ? 'impostor' : `lod${level}`}${meshes.length > 1 ? `:${material.name || meshes.indexOf(mesh)}` : ''}`
      mesh.frustumCulled = false // one pool spans the whole scatter
      mesh.matrixAutoUpdate = false
      mesh.castShadow = lod.castShadow ?? layer.castShadow
      mesh.receiveShadow = layer.receiveShadow
      this.object.add(mesh)
    }
    pool = { meshes, capacity, impostor }
    pools[level] = pool
    return pool
  }

  /**
   * Takes a pool out of the scene. Its meshes and geometries are deliberately not `dispose()`d: each geometry shares
   * the level's index and vertex buffers, and disposing it would free those GPU buffers while live pools still draw
   * with them. Unreferenced pools are reclaimed by garbage collection instead.
   */
  private retire(pool: Pool) {
    for (const mesh of pool.meshes) mesh.removeFromParent()
  }
}

/** A new geometry sharing `source`'s index, attributes, bounds and (optionally) groups; its own instance attributes go on top. */
function shareGeometry<T extends BufferGeometry>(source: BufferGeometry, target: T, groups = true): T {
  target.setIndex(source.index)
  for (const [name, attr] of Object.entries(source.attributes)) target.setAttribute(name, attr)
  if (groups) for (const g of source.groups) target.addGroup(g.start, g.count, g.materialIndex)
  target.boundingBox = source.boundingBox
  target.boundingSphere = source.boundingSphere
  return target
}

type PoolWriter = (data: Float32Array, offset: number) => void

/** Appends instances to a pool from the start; {@link finishPool} then uploads them. */
function writer(pool: Pool, tinted: boolean): PoolWriter {
  let n = 0
  if (pool.impostor) {
    const g = pool.meshes[0].geometry as InstancedBufferGeometry
    const pos = g.getAttribute('scatterPosition').array as Float32Array
    const par = g.getAttribute('scatterParams').array as Float32Array
    return (data, o) => {
      const w = n++ * 4
      pos[w] = data[o + 12]
      pos[w + 1] = data[o + 13]
      pos[w + 2] = data[o + 14]
      pos[w + 3] = data[o + 17]
      par[w] = data[o + 16]
      par[w + 1] = data[o + 18]
      par[w + 2] = data[o + 19]
    }
  }
  const mesh = pool.meshes[0] as InstancedMesh
  if (!mesh) return () => {}
  const m = mesh.instanceMatrix.array as Float32Array
  const par = mesh.geometry.getAttribute('scatterParams').array as Float32Array
  const c = tinted ? (mesh.instanceColor?.array as Float32Array | undefined) : undefined
  return (data, o) => {
    const w = n * 16
    for (let k = 0; k < 16; k++) m[w + k] = data[o + k]
    par[n * 4] = data[o + 16]
    par[n * 4 + 1] = data[o + 18]
    par[n * 4 + 2] = data[o + 19]
    if (c) c[n * 3] = c[n * 3 + 1] = c[n * 3 + 2] = data[o + 18]
    n++
  }
}

function finishPool(pool: Pool, count: number) {
  const upload = (attr: InstancedBufferAttribute | null | undefined) => {
    if (!attr) return
    attr.clearUpdateRanges()
    attr.addUpdateRange(0, Math.max(1, count) * attr.itemSize)
    attr.needsUpdate = true
  }
  const first = pool.meshes[0]
  if (!first) return
  // The instance buffers are shared by all of the pool's meshes: upload them once.
  upload(first.geometry.getAttribute('scatterParams') as InstancedBufferAttribute)
  if (pool.impostor) {
    upload(first.geometry.getAttribute('scatterPosition') as InstancedBufferAttribute)
  } else {
    upload((first as InstancedMesh).instanceMatrix)
    upload((first as InstancedMesh).instanceColor)
  }
  for (const mesh of pool.meshes) {
    if (pool.impostor) (mesh.geometry as InstancedBufferGeometry).instanceCount = count
    else (mesh as InstancedMesh).count = count
    mesh.visible = count > 0
  }
}

/** End distance of each level of a layer: mesh levels then the impostor. */
function distancesOf(layer: ScatterLayer): number[] {
  const d = layer.lods.map((l) => l.distance)
  if (layer.impostor) d.push(layer.impostor.distance)
  return d
}

function lastDistance(layer: ScatterLayer): number {
  const d = distancesOf(layer)
  return d.length ? d[d.length - 1] : 0
}

function placementKey(l: ScatterLayer): unknown[] {
  return [l.name, l.spacing, typeof l.density === 'number' ? l.density : 'fn', l.minSlope, l.maxSlope, l.minHeight, l.maxHeight, l.cluster, l.scale, l.align, l.randomYaw, l.tilt, l.sink, l.colorVariation]
    .map((v) => (v === Infinity ? 'inf' : v === -Infinity ? '-inf' : v))
}

const ids = new WeakMap<object, number>()
let nextId = 1
function idOf(o: object): number {
  let id = ids.get(o)
  if (!id) ids.set(o, (id = nextId++))
  return id
}

function renderKey(l: ScatterLayer): string {
  const lod = (d: ScatterLOD) => [d.distance, idOf(d.geometry), (Array.isArray(d.material) ? d.material : [d.material]).map(idOf), d.castShadow]
  return JSON.stringify([l.lods.map(lod), l.impostor && lod(l.impostor), l.castShadow, l.receiveShadow, l.colorVariation > 0])
}

/**
 * Disposes every geometry, material and material texture used by `layers` (each once). Handy when the layers were
 * generated just for one scatter, e.g. by `createVegetationLayers` in threejs-trees.
 */
export function disposeLayers(layers: readonly Pick<ScatterLayer, 'lods' | 'impostor'>[]): void {
  const done = new Set<object>()
  const free = (o: { dispose(): void } | null | undefined) => {
    if (!o || done.has(o)) return
    done.add(o)
    o.dispose()
  }
  for (const layer of layers) {
    for (const lod of [...layer.lods, ...(layer.impostor ? [layer.impostor] : [])]) {
      free(lod.geometry)
      for (const m of Array.isArray(lod.material) ? lod.material : [lod.material]) {
        for (const v of Object.values(m)) if ((v as Texture | null)?.isTexture) free(v as Texture)
        free(m)
      }
    }
  }
}

const _v = new Vector3()

/**
 * Minimum instances per pooled mesh. three.js draws instanced meshes whose matrices fit a uniform buffer (64 KB on
 * most WebGPU devices = 1024 matrices) through a uniform array baked into the shader; pools that later grow past that
 * share cached node state with the old one and its uniform buffer gets reallocated while still in use. Starting
 * above the limit keeps every pool on the vertex-attribute path.
 */
const MIN_CAPACITY = 1100
