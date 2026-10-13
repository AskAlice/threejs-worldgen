import {
  BufferGeometry, DataTexture, Float32BufferAttribute, Group, InstancedBufferAttribute, InstancedBufferGeometry, LinearFilter, Mesh, ShapeUtils, Sphere, Vector2, Vector3,
  type Camera, type DirectionalLight, type MeshPhysicalNodeMaterial, type Object3D,
} from 'three/webgpu'
import { createHeightSampler, type HeightFn, type Terrain } from 'threejs-heightfield'
import { FlattenMap, PLANT_STRIDE, bounds, plantRows, pointInPolygon, type CornField } from './corn-layout.ts'
import { CORN_MODEL_HEIGHT, createCanopyMaterial, createCornMaterial, createCornUniforms, type CornUniforms } from './corn-material.ts'
import { findSun, interactorObject, writeInteractors, writeSun, type GrassRenderer, type Interactor, type WindOptions } from './grass.ts'
import { hash2 } from './random.ts'

/** One of the four levels of detail of a {@link Corn} field. Density is interpolated between consecutive levels. */
export interface CornLOD {
  /** Distance from the camera (metres, 3D) at which this level is fully reached. */
  distance: number
  /** Fraction (0..1) of the plants kept at this distance; the canopy surface stands in for the rest. */
  density: number
}

/** Every setting of a {@link Corn} field. All are optional on input; see {@link CornInput}. */
export interface CornSettings {
  /** The fields to plant, e.g. from threejs-city's farm planner. */
  fields: CornField[]
  /** Distance between plants along a row, in metres. */
  plantSpacing: number
  /** Layout seed: the same seed always plants the same fields. */
  seed: number
  /** Growth stage: 0 seedling, ~0.65 full height, 0.8 mature (tassels and ears), 1 dry and brown. */
  growth: number
  /** Harvested: only stubble is left. */
  harvested: boolean
  /** Stubble height in metres after harvest. */
  stubbleHeight: number
  /** Mature plant height in metres, tassel included (1.5–3 m). */
  height: number
  /** 0..1 random height spread per plant. */
  heightVariation: number
  /** Mature leaf colour (any CSS colour). */
  leafColor: string
  /** Young leaf colour. */
  youngColor: string
  /** Dry leaf, husk and stubble colour. */
  dryColor: string
  /** Tassel colour. */
  tasselColor: string
  /** Soil colour between young rows and under the canopy. */
  soilColor: string
  /** 0..1 per-plant brightness variation. */
  colorVariation: number
  /** 0..1 field-scale brightness and dryness variation. */
  patchiness: number
  /** 0..1 how much sunlight shines through back-lit leaves. */
  translucency: number
  /** Higher = less wind and interaction bending. */
  stiffness: number
  /** Procedural wind, shared with grass (see {@link WindOptions}). */
  wind: WindOptions
  /** Up to 16 objects that push corn aside and flatten what they drive over (tractor wheels, harvesters…). */
  interactors: Interactor[]
  /** Global multiplier on how strongly interactors push and flatten corn. 0 = not at all. */
  interactionStrength: number
  /** Texel size (metres) of the map remembering where corn was flattened. */
  flattenResolution: number
  /** Edge length (metres) of the chunks plants are built in around the camera. */
  chunkSize: number
  /** Grid size (metres) of the canopy surface that stands in for far plants. */
  canopyResolution: number
  /** Exactly four levels of detail, near → far. Plants end at the last distance; the canopy covers the rest. */
  lods: CornLOD[]
  /** Whether plants within `shadowDistance` cast shadows. */
  castShadow: boolean
  /** Radius (metres) around the camera in which plants cast shadows. */
  shadowDistance: number
  /** Whether plants and canopy receive shadows. */
  receiveShadow: boolean
  /** Light used for back-lit translucency. `null` = first DirectionalLight found in the scene. */
  sun: DirectionalLight | null
  /** Tints corn by level of detail (red, yellow, green; canopy red → blue as it rises). */
  debugLods: boolean
  /** Milliseconds per frame spent building chunks, nearest first. */
  buildBudget: number
}

/** Partial settings accepted by {@link Corn.create}, {@link Corn.set} and the `<Corn>` component. */
export type CornInput = Partial<Omit<CornSettings, 'wind'>> & {
  /** Wind settings to change; unspecified fields keep their current value. */
  wind?: Partial<WindOptions>
}

/** Options for {@link Corn.create}. */
export interface CornOptions extends CornInput {
  /** The camera whose distance drives levels of detail. */
  camera: Camera
  /** If given, corn is added to it and updates itself every frame via `scene.onBeforeRender`. */
  scene?: Object3D
  /** Must be a WebGPURenderer (`three/webgpu`). Initialised if needed. */
  renderer?: GrassRenderer
  /** Mesh/group to grow on, a `(x, z) => y` function, or omit for flat ground. */
  terrain?: Terrain
}

/** Live counters of a {@link Corn} field. */
export interface CornStats {
  /** Chunks of plants currently built around the camera. */
  chunks: number
  /** Plant instances currently drawn (before per-plant thinning in the shader). */
  plants: number
}

/** Default {@link CornSettings}: a mature field of 2.4 m dent corn, 0.18 m apart in its rows. */
export const DEFAULT_CORN: CornSettings = {
  fields: [],
  plantSpacing: 0.18,
  seed: 1,
  growth: 0.8,
  harvested: false,
  stubbleHeight: 0.3,
  height: 2.4,
  heightVariation: 0.1,
  leafColor: '#3e6c14',
  youngColor: '#6d9a35',
  dryColor: '#a88d5c',
  tasselColor: '#b8a46a',
  soilColor: '#5a4532',
  colorVariation: 0.08,
  patchiness: 0.5,
  translucency: 0.6,
  stiffness: 1,
  wind: { direction: [1, 0.35], strength: 0.35, scale: 0.03, speed: 0.7 },
  interactors: [],
  interactionStrength: 1,
  flattenResolution: 0.5,
  chunkSize: 16,
  canopyResolution: 1,
  lods: [
    { distance: 10, density: 1 },
    { distance: 30, density: 0.6 },
    { distance: 60, density: 0.35 },
    { distance: 100, density: 0.2 },
  ],
  castShadow: true,
  shadowDistance: 25,
  receiveShadow: true,
  sun: null,
  debugLods: false,
  buildBudget: 3,
}

interface Chunk {
  ix: number
  iz: number
  /** Plant ranks, ascending: the first `n` plants are an even thinning. */
  ranks: Float32Array
  mesh: Mesh<InstancedBufferGeometry, MeshPhysicalNodeMaterial> | null
  attributes: InstancedBufferAttribute[]
  geometries: (InstancedBufferGeometry | undefined)[]
  minY: number
  maxY: number
  seen: number
}

/**
 * Corn fields: a threejs-grass variant of tall stalks planted in straight rows inside field polygons, with the
 * grass wind, and the grass {@link Interactor}s pushing plants aside and flattening the ones they drive over (the
 * flattened corn stays down; see {@link Corn.flattened}). Plants are built in chunks around the camera, thinned
 * by four levels of detail, and a canopy surface stands in for the plants that thinning drops, so whole fields
 * render from the air.
 *
 * @example
 * ```ts
 * const corn = await Corn.create({ camera, scene, renderer, terrain, fields: [{ polygon, rowDirection: 0, rowSpacing: 0.76 }] })
 * corn.set({ interactors: tractor.wheels.map((object) => ({ object, radius: 0.4 })) })
 * ```
 */
export class Corn {
  /** Root of the canopy and all plant chunks. Added to `scene` for you when one is passed to {@link Corn.create}. */
  readonly object = new Group()
  /** Shader uniforms, for advanced tweaks. */
  readonly uniforms: CornUniforms = createCornUniforms()
  /** Live counters, refreshed on every {@link Corn.update}. */
  readonly stats: CornStats = { chunks: 0, plants: 0 }
  /** Camera the levels of detail follow. Can be swapped at any time. */
  camera: Camera
  /** Resolved settings (defaults ← your input). Read-only: change them with {@link Corn.set}. */
  settings!: CornSettings
  /** Terrain height at world (x, z); NaN where there is no terrain. */
  sampleHeight: HeightFn
  /** Where corn has been flattened. Replaced (cleared) when the fields change. */
  flattenMap!: FlattenMap

  private input: CornInput = {}
  private materials: MeshPhysicalNodeMaterial[] = []
  private canopyMaterial: MeshPhysicalNodeMaterial | null = null
  private canopy: Mesh<BufferGeometry, MeshPhysicalNodeMaterial> | null = null
  private baseGeometries: BufferGeometry[] = []
  private flattenTexture: DataTexture | null = null
  private flattenVersion = -1
  private chunks = new Map<string, Chunk>()
  private layoutKey = ''
  private canopyKey = ''
  private flattenKey = ''
  private fieldBounds = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 }
  private frame = 0
  private retired: { attributes: InstancedBufferAttribute[]; geometries: InstancedBufferGeometry[]; frame: number }[] = []
  private previous = new WeakMap<Object3D, Vector3>()
  private sunSearched = false
  private autoSun: DirectionalLight | null = null
  private unhook = () => {}

  /**
   * Creates a corn field and builds the chunks in view so the first frame is complete.
   * @throws If `renderer` is not a WebGPURenderer.
   */
  static async create(options: CornOptions): Promise<Corn> {
    const { renderer } = options
    if (renderer && !renderer.isWebGPURenderer) throw new Error('Corn requires WebGPURenderer from "three/webgpu".')
    if (renderer?.hasInitialized?.() === false) await renderer.init?.()
    const corn = new Corn(options)
    corn.update(Infinity)
    return corn
  }

  /** Prefer {@link Corn.create}, which also validates/initialises the renderer and pre-builds chunks. */
  constructor({ camera, scene, renderer: _renderer, terrain, ...input }: CornOptions) {
    this.camera = camera
    this.sampleHeight = createHeightSampler(terrain)
    this.object.name = 'Corn'
    this.baseGeometries = [0, 1, 2].map((d) => createCornGeometry(d))
    this.materials = [0, 1, 2].map((d) => createCornMaterial(this.uniforms, d))
    this.canopyMaterial = createCanopyMaterial(this.uniforms)
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
   * Changes settings at runtime, merging into what was set before. Looks, growth, harvest, wind and interaction
   * apply instantly through uniforms; fields, spacing, seed and chunk size rebuild the plants. `undefined` values
   * are ignored; `wind` merges field by field. {@link Corn.reset} drops earlier overrides.
   */
  set(input: CornInput): this {
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue
      if (k === 'wind') this.input.wind = { ...this.input.wind, ...(v as Partial<WindOptions>) }
      else (this.input as any)[k] = v
    }
    return this.apply()
  }

  /** Replaces all settings with `input`: anything not given falls back to the defaults. */
  reset(input: CornInput = {}): this {
    this.input = {}
    return this.set(input)
  }

  private apply(): this {
    const s: CornSettings = { ...DEFAULT_CORN, ...(this.input as any), wind: { ...DEFAULT_CORN.wind, ...this.input.wind } }
    if (s.lods.length !== 4) throw new Error('Corn: `lods` must contain exactly 4 levels.')
    this.settings = s
    const u = this.uniforms
    u.height.value = s.height
    u.heightVariation.value = s.heightVariation
    u.growth.value = Math.min(1, Math.max(0, s.growth))
    u.harvested.value = s.harvested ? 1 : 0
    u.stubbleHeight.value = s.stubbleHeight
    u.leafColor.value.set(s.leafColor)
    u.youngColor.value.set(s.youngColor)
    u.dryColor.value.set(s.dryColor)
    u.tasselColor.value.set(s.tasselColor)
    u.soilColor.value.set(s.soilColor)
    u.colorVariation.value = s.colorVariation
    u.patchiness.value = s.patchiness
    u.translucency.value = s.translucency
    u.stiffness.value = Math.max(0.05, s.stiffness)
    u.windDirection.value.set(...s.wind.direction).normalize()
    u.windStrength.value = s.wind.strength
    u.windScale.value = s.wind.scale
    u.windSpeed.value = s.wind.speed
    u.lodDistances.value.set(...(s.lods.map((l) => l.distance) as [number, number, number, number]))
    u.lodDensities.value.set(...(s.lods.map((l) => l.density) as [number, number, number, number]))
    u.interactionStrength.value = s.interactionStrength
    u.debugLods.value = s.debugLods ? 1 : 0

    const fieldsKey = JSON.stringify(s.fields)
    const layoutKey = JSON.stringify([fieldsKey, s.plantSpacing, s.seed, s.chunkSize])
    if (layoutKey !== this.layoutKey) {
      this.layoutKey = layoutKey
      this.clearChunks()
    }
    const flattenKey = JSON.stringify([fieldsKey, s.flattenResolution])
    if (flattenKey !== this.flattenKey) {
      this.flattenKey = flattenKey
      this.createFlattenMap()
    }
    const canopyKey = JSON.stringify([fieldsKey, s.canopyResolution])
    if (canopyKey !== this.canopyKey) {
      this.canopyKey = canopyKey
      this.buildCanopy()
    }
    if (this.canopy) this.canopy.receiveShadow = s.receiveShadow
    return this
  }

  /** Swaps the terrain (mesh or height function) and rebuilds plants and canopy. */
  setTerrain(terrain?: Terrain): void {
    this.sampleHeight = createHeightSampler(terrain)
    this.clearChunks()
    this.buildCanopy()
  }

  /**
   * Flattens corn in a disk of `radius` metres around (x, z), falling along (dirX, dirZ) (e.g. a vehicle's
   * heading; omit to fall outwards). Interactors do this every frame; call it for anything else that knocks
   * corn down. Flattened corn stays down until {@link Corn.clearFlattened}.
   */
  flatten(x: number, z: number, radius: number, dirX = 0, dirZ = 0): void {
    this.flattenMap.stamp(x, z, radius, dirX, dirZ)
  }

  /** How flattened the corn at world (x, z) is: 0 standing … 1 flat. */
  flattened(x: number, z: number): number {
    return this.flattenMap.sample(x, z)
  }

  /** Stands all flattened corn back up. */
  clearFlattened(): void {
    this.flattenMap.clear()
  }

  /** Fraction (0..1) of plants kept at a distance from the camera: the CPU mirror of the shader's LOD curve. */
  densityAt(dist: number): number {
    const l = this.settings.lods
    const seg = (a: number, b: number) => Math.min(1, Math.max(0, (dist - a) / Math.max(b - a, 1e-3)))
    const mix = (a: number, b: number, t: number) => a + (b - a) * t
    return mix(mix(mix(l[0].density, l[1].density, seg(l[0].distance, l[1].distance)), l[2].density, seg(l[1].distance, l[2].distance)), l[3].density, seg(l[2].distance, l[3].distance))
  }

  /**
   * Streams plant chunks around the camera, flattens corn under interactors and refreshes the shader state.
   * Called automatically when a `scene` was given (and by the `<Corn>` component); otherwise call it once per frame.
   * @param budget Milliseconds allowed for chunk builds this frame. Defaults to `settings.buildBudget`.
   */
  update(budget: number = this.settings.buildBudget): void {
    const s = this.settings
    const frame = ++this.frame
    const cam = this.camera.getWorldPosition(_v)
    const reach = s.lods[3].distance
    const cs = s.chunkSize
    const b = this.fieldBounds
    const pending: { ix: number; iz: number; dist: number }[] = []
    let plants = 0
    if (s.fields.length && Number.isFinite(b.minX)) {
      const i0 = Math.floor(Math.max(b.minX, cam.x - reach) / cs), i1 = Math.floor(Math.min(b.maxX, cam.x + reach) / cs)
      const j0 = Math.floor(Math.max(b.minZ, cam.z - reach) / cs), j1 = Math.floor(Math.min(b.maxZ, cam.z + reach) / cs)
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const chunk = this.chunks.get(`${i},${j}`)
          const dx = Math.max(i * cs - cam.x, 0, cam.x - (i + 1) * cs)
          const dz = Math.max(j * cs - cam.z, 0, cam.z - (j + 1) * cs)
          // Height above (or below) the chunk's plants, so a camera high above a field doesn't build its plants.
          let low = chunk?.mesh ? chunk.minY : this.sampleHeight((i + 0.5) * cs, (j + 0.5) * cs)
          if (low !== low) low = cam.y
          const high = (chunk?.mesh ? chunk.maxY : low) + s.height
          const dist = Math.hypot(dx, dz, Math.max(cam.y - high, 0, low - cam.y))
          if (dist >= reach) continue
          if (!chunk) {
            pending.push({ ix: i, iz: j, dist })
            continue
          }
          chunk.seen = frame
          if (chunk.mesh) plants += this.showChunk(chunk, dist)
        }
      }
    }
    pending.sort((a, c) => a.dist - c.dist)
    const start = performance.now()
    for (const p of pending) {
      if (performance.now() - start > budget) break
      const chunk = this.buildChunk(p.ix, p.iz)
      chunk.seen = frame
      if (chunk.mesh) plants += this.showChunk(chunk, p.dist)
    }
    for (const [key, chunk] of this.chunks) {
      if (chunk.seen !== frame) {
        this.removeChunk(chunk)
        this.chunks.delete(key)
      }
    }
    this.flushRetired()

    this.flattenUnderInteractors()
    if (this.flattenTexture && this.flattenVersion !== this.flattenMap.version) {
      this.flattenVersion = this.flattenMap.version
      this.flattenTexture.needsUpdate = true
    }
    this.uniforms.viewPosition.value.copy(this.camera.getWorldPosition(_v))
    if (!s.sun && !this.sunSearched && this.object.parent) {
      this.sunSearched = true
      this.autoSun = findSun(this.object)
    }
    writeSun(this.uniforms, s.sun ?? this.autoSun)
    writeInteractors(this.uniforms, s.interactors)
    this.stats.chunks = this.chunks.size
    this.stats.plants = plants
  }

  /** Removes the corn from the scene and frees its GPU resources. */
  dispose(): void {
    this.unhook()
    this.clearChunks()
    this.flushRetired(true)
    for (const m of this.materials) m.dispose()
    this.canopyMaterial?.dispose()
    this.canopy?.geometry.dispose()
    this.flattenTexture?.dispose()
    for (const g of this.baseGeometries) g.dispose()
    this.object.removeFromParent()
  }

  /** Sets a chunk's level of detail and plant count for its distance; returns the plants drawn. */
  private showChunk(chunk: Chunk, dist: number) {
    const s = this.settings
    const mesh = chunk.mesh!
    const detail = dist < s.lods[1].distance ? 0 : dist < s.lods[2].distance ? 1 : 2
    const geometry = (chunk.geometries[detail] ??= this.chunkGeometry(chunk, detail))
    mesh.geometry = geometry
    mesh.material = this.materials[detail]
    // Ranks are sorted, so the plants this distance keeps are a prefix (the shader fades the last 20%).
    geometry.instanceCount = upperBound(chunk.ranks, this.densityAt(dist))
    mesh.visible = geometry.instanceCount > 0
    mesh.castShadow = s.castShadow && dist < s.shadowDistance
    mesh.receiveShadow = s.receiveShadow
    return geometry.instanceCount
  }

  private buildChunk(ix: number, iz: number): Chunk {
    const s = this.settings
    const cs = s.chunkSize
    const x0 = ix * cs
    const z0 = iz * cs
    const raw = plantRows(s.fields, x0, z0, x0 + cs, z0 + cs, { plantSpacing: s.plantSpacing, seed: s.seed })
    const n = raw.length / PLANT_STRIDE
    const offsets = new Float32Array(n * 4)
    const params = new Float32Array(n * 2)
    const ranks = new Float32Array(n)
    let count = 0
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < n; i++) {
      const o = i * PLANT_STRIDE
      const y = this.sampleHeight(raw[o], raw[o + 1])
      if (y !== y) continue
      offsets.set([raw[o] - x0, y, raw[o + 1] - z0, raw[o + 2]], count * 4)
      params.set([raw[o + 3], raw[o + 4]], count * 2)
      ranks[count] = raw[o + 4]
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      count++
    }
    const chunk: Chunk = { ix, iz, ranks: ranks.subarray(0, count), mesh: null, attributes: [], geometries: [], minY, maxY, seen: 0 }
    this.chunks.set(`${ix},${iz}`, chunk)
    if (!count) return chunk
    chunk.attributes = [new InstancedBufferAttribute(offsets.subarray(0, count * 4), 4), new InstancedBufferAttribute(params.subarray(0, count * 2), 2)]
    const mesh = new Mesh(this.chunkGeometry(chunk, 0), this.materials[0])
    chunk.geometries[0] = mesh.geometry
    mesh.position.set(x0, 0, z0)
    mesh.updateMatrix()
    mesh.matrixAutoUpdate = false
    chunk.mesh = mesh
    this.object.add(mesh)
    return chunk
  }

  private chunkGeometry(chunk: Chunk, detail: number) {
    const s = this.settings
    const cs = s.chunkSize
    const base = this.baseGeometries[detail]
    const g = new InstancedBufferGeometry()
    g.setIndex(base.index)
    for (const name of ['position', 'normal', 'uv', 'aPart']) g.setAttribute(name, base.getAttribute(name))
    g.setAttribute('aOffset', chunk.attributes[0])
    g.setAttribute('aPlant', chunk.attributes[1])
    g.instanceCount = 0
    // Instanced geometry can't compute its own bounds; a fallen plant reaches about its height sideways.
    g.boundingSphere = new Sphere(new Vector3(cs / 2, (chunk.minY + chunk.maxY) / 2, cs / 2), Math.hypot(cs / Math.SQRT2, (chunk.maxY - chunk.minY) / 2) + s.height * 1.4)
    return g
  }

  private removeChunk(chunk: Chunk) {
    if (!chunk.mesh) return
    chunk.mesh.removeFromParent()
    this.retired.push({ attributes: chunk.attributes, geometries: chunk.geometries.filter((g): g is InstancedBufferGeometry => !!g), frame: this.frame })
  }

  private clearChunks() {
    for (const chunk of this.chunks.values()) this.removeChunk(chunk)
    this.chunks.clear()
  }

  /** Freed a while after removal: WebGPU may still be building a pipeline that reads them (see Grass). */
  private flushRetired(all = false) {
    while (this.retired.length && (all || this.frame - this.retired[0].frame > 60)) {
      for (const g of this.retired.shift()!.geometries) {
        for (const name of ['position', 'normal', 'uv', 'aPart']) g.deleteAttribute(name)
        g.setIndex(null)
        g.dispose()
      }
    }
  }

  private createFlattenMap() {
    const s = this.settings
    const b = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity }
    for (const f of s.fields) {
      const fb = bounds(f.polygon)
      b.minX = Math.min(b.minX, fb.minX); b.minZ = Math.min(b.minZ, fb.minZ); b.maxX = Math.max(b.maxX, fb.maxX); b.maxZ = Math.max(b.maxZ, fb.maxZ)
    }
    this.fieldBounds = b
    const margin = 4
    const empty = !Number.isFinite(b.minX)
    this.flattenMap = empty ? new FlattenMap(0, 0, 1, 1, 1) : new FlattenMap(b.minX - margin, b.minZ - margin, b.maxX + margin, b.maxZ + margin, s.flattenResolution)
    const m = this.flattenMap
    this.flattenTexture?.dispose()
    const tex = new DataTexture(m.data, m.width, m.height)
    tex.magFilter = LinearFilter
    tex.minFilter = LinearFilter
    tex.needsUpdate = true
    this.flattenTexture = tex
    this.flattenVersion = m.version
    this.uniforms.flatten.value = tex
    this.uniforms.flattenBounds.value.set(m.minX, m.minZ, m.width * m.texel, m.height * m.texel)
  }

  /** Stamps every interactor near the ground into the flatten map, along the path it moved since last frame. */
  private flattenUnderInteractors() {
    const s = this.settings
    if (s.interactionStrength <= 0) return
    for (const it of s.interactors) {
      const obj = interactorObject(it)
      if (!obj || !(it.radius > 0)) continue
      const p = obj.getWorldPosition(_p)
      const ground = this.sampleHeight(p.x, p.z)
      const last = this.previous.get(obj)
      if (!last) this.previous.set(obj, p.clone())
      if (ground !== ground || p.y - ground > s.height + it.radius) {
        last?.copy(p)
        continue
      }
      const from = last ?? p
      const dx = p.x - from.x
      const dz = p.z - from.z
      const steps = Math.min(64, Math.ceil(Math.hypot(dx, dz) / (it.radius * 0.5)))
      for (let k = 1; k <= Math.max(1, steps); k++) {
        const t = steps ? k / steps : 1
        this.flattenMap.stamp(from.x + dx * t, from.z + dz * t, it.radius, dx, dz)
      }
      last?.copy(p)
    }
  }

  private buildCanopy() {
    if (this.canopy) {
      this.canopy.removeFromParent()
      this.canopy.geometry.dispose()
      this.canopy = null
    }
    const s = this.settings
    if (!s.fields.length) return
    const geometry = createCanopyGeometry(s.fields, s.canopyResolution, this.sampleHeight)
    if (!geometry.getAttribute('position').count) return
    geometry.computeBoundingSphere()
    // The canopy rises up to the plant height in the shader.
    geometry.boundingSphere!.radius += s.height * 2
    this.canopy = new Mesh(geometry, this.canopyMaterial!)
    this.canopy.name = 'CornCanopy'
    this.canopy.receiveShadow = s.receiveShadow
    this.object.add(this.canopy)
  }
}

const _v = new Vector3()
const _p = new Vector3()

/** Index of the first value > x in an ascending array (the count of values ≤ x). */
function upperBound(sorted: Float32Array, x: number) {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

// ---- Geometry ----

/** Top of the stalk (where the tassel starts) in the model, metres. */
const STALK_TOP = 2.05

class Builder {
  pos: number[] = []
  nrm: number[] = []
  uv: number[] = []
  part: number[] = []
  index: number[] = []
  vertex(p: Vector3, n: Vector3, u: number, v: number, part: number, node: number) {
    this.pos.push(p.x, p.y, p.z)
    this.nrm.push(n.x, n.y, n.z)
    this.uv.push(u, v)
    this.part.push(part, node)
    return this.pos.length / 3 - 1
  }
  quad(a: number, b: number, c: number, d: number) {
    this.index.push(a, b, c, b, d, c)
  }
  /** A flat ribbon through `points`, `widths[i]` wide across `sides[i]`, facing `normals[i]`. */
  ribbon(points: Vector3[], sides: Vector3[], widths: number[], normals: Vector3[], part: number, node: number) {
    let prev = -1
    points.forEach((p, i) => {
      const v = i / (points.length - 1)
      const a = this.vertex(p.clone().addScaledVector(sides[i], -widths[i] / 2), normals[i], 0, v, part, node)
      this.vertex(p.clone().addScaledVector(sides[i], widths[i] / 2), normals[i], 1, v, part, node)
      if (prev >= 0) this.quad(prev, prev + 1, a, a + 1)
      prev = a
    })
  }
  /** A tube around `points` with `radii`, `sides` around; a zero last radius closes it to a point. */
  tube(points: Vector3[], radii: number[], sides: number, part: number, node: number) {
    const axis = points[points.length - 1].clone().sub(points[0]).normalize()
    const a1 = new Vector3(0, 1, 0).cross(axis)
    if (a1.lengthSq() < 1e-6) a1.set(1, 0, 0)
    a1.normalize()
    const a2 = axis.clone().cross(a1).normalize()
    let prev = -1
    points.forEach((p, i) => {
      const first = this.pos.length / 3
      for (let k = 0; k < sides; k++) {
        const ang = (k / sides) * Math.PI * 2
        const n = a1.clone().multiplyScalar(Math.cos(ang)).addScaledVector(a2, Math.sin(ang))
        this.vertex(p.clone().addScaledVector(n, radii[i]), n, k / sides, i / (points.length - 1), part, node)
      }
      if (prev >= 0) for (let k = 0; k < sides; k++) this.quad(prev + k, prev + ((k + 1) % sides), first + k, first + ((k + 1) % sides))
      prev = first
    })
  }
  build() {
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('uv', new Float32BufferAttribute(this.uv, 2))
    g.setAttribute('aPart', new Float32BufferAttribute(this.part, 2))
    g.setIndex(this.index)
    return g
  }
}

const UP = new Vector3(0, 1, 0)

/**
 * One corn plant, modelled 2.4 m tall (instances scale it): a tapering stalk, alternating arching leaves with a
 * folded midrib and wavy margins, a branched tassel and up to two ears with silk. `detail` 0 (near) … 2 (far) uses
 * fewer, wider leaves and drops the small parts. Attributes: position, normal, uv, aPart = (part, node height
 * 0..1), see {@link createCornMaterial}. Exposed for custom instancing; Corn creates these for you.
 */
export function createCornGeometry(detail: number): BufferGeometry {
  const b = new Builder()
  const d = Math.min(2, Math.max(0, Math.round(detail)))

  // Stalk.
  const rings = [6, 3, 1][d]
  const stalk = Array.from({ length: rings + 1 }, (_, r) => new Vector3(0, (STALK_TOP * r) / rings, 0))
  b.tube(stalk, stalk.map((_, r) => 0.016 * (1 - (0.55 * r) / rings)), [5, 3, 3][d], 0, 0)

  // Leaves: alternating (two ranks, 180° apart, slightly spiralled), longest in the middle of the plant.
  const leaves = [12, 9, 6][d]
  const segs = [7, 4, 2][d]
  const widen = Math.sqrt(12 / leaves)
  const leafAzimuth: number[] = []
  for (let i = 0; i < leaves; i++) {
    const f = i / (leaves - 1)
    const nodeY = STALK_TOP * (0.04 + 0.84 * Math.pow(f, 1.15))
    const length = 0.38 + 0.6 * Math.sin(Math.PI * (0.15 + 0.8 * f))
    const width = 0.1 * (0.7 + 0.3 * Math.sin(Math.PI * f)) * widen
    const phi = i * Math.PI + i * 0.08 + ((hash2(i, 7) / 4294967296) - 0.5) * 0.6
    leafAzimuth.push(phi)
    const dir = new Vector3(Math.cos(phi), 0, Math.sin(phi))
    const side0 = new Vector3(-dir.z, 0, dir.x)
    const theta0 = 0.5 + 0.2 * (1 - f)
    const theta1 = theta0 + 1.0 + 0.5 * (1 - f)
    const twist = i % 2 ? 1 : -1
    const c = new Vector3(0, nodeY, 0).addScaledVector(dir, 0.014)
    let prev = -1
    for (let k = 0; k <= segs; k++) {
      const s = k / segs
      const theta = theta0 + (theta1 - theta0) * Math.pow(s, 1.1)
      const tangent = dir.clone().multiplyScalar(Math.sin(theta)).addScaledVector(UP, Math.cos(theta))
      const tw = 0.35 * s * twist
      const side = side0.clone().multiplyScalar(Math.cos(tw)).addScaledVector(tangent.clone().cross(side0), Math.sin(tw)).normalize()
      const normal = side.clone().cross(tangent).normalize()
      if (k === segs) {
        const tip = b.vertex(c, normal, 0.5, 1, 1, nodeY / STALK_TOP)
        b.index.push(prev, prev + 1, tip, prev + 2, prev + 3, tip)
        break
      }
      const w = width * Math.pow(1 - s, 0.7) * (0.5 + 0.5 * Math.min(1, s / 0.25))
      const wave = Math.sin(s * 22 + i * 1.7) * 0.006 * Math.min(1, Math.max(0, (s - 0.15) / 0.25))
      const node = nodeY / STALK_TOP
      const nl = normal.clone().addScaledVector(side, 0.35).normalize()
      const nr = normal.clone().addScaledVector(side, -0.35).normalize()
      const mid = c.clone().addScaledVector(normal, -0.1 * w)
      const first = b.vertex(c.clone().addScaledVector(side, -w / 2).addScaledVector(normal, wave), nl, 0, s, 1, node)
      b.vertex(mid, nl, 0.5, s, 1, node)
      b.vertex(mid, nr, 0.5, s, 1, node)
      b.vertex(c.clone().addScaledVector(side, w / 2).addScaledVector(normal, -wave), nr, 1, s, 1, node)
      if (prev >= 0) {
        b.quad(prev, prev + 1, first, first + 1)
        b.quad(prev + 2, prev + 3, first + 2, first + 3)
      }
      prev = first
      c.addScaledVector(tangent, length / segs)
    }
  }

  // Tassel (up close only: far away its thin strands would only sparkle): a central spike and drooping branches.
  if (d === 0) {
    const spike = [0, 1, 2, 3].map((k) => new Vector3(0, STALK_TOP + (k / 3) * 0.36, 0))
    const widths = spike.map((_, k) => 0.012 * (1 - k / 4))
    for (const a of [0, Math.PI / 2]) {
      const side = new Vector3(Math.cos(a), 0, Math.sin(a))
      const n = new Vector3(-side.z, 0.3, side.x).normalize()
      b.ribbon(spike, spike.map(() => side), widths, spike.map(() => n), 2, 1)
    }
  }
  if (d === 0) {
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + 0.4
      const dir = new Vector3(Math.cos(a), 0, Math.sin(a))
      const side = new Vector3(-dir.z, 0, dir.x)
      const p = new Vector3(0, STALK_TOP + 0.06 + k * 0.025, 0)
      const pts: Vector3[] = []
      for (let j = 0; j <= 3; j++) {
        pts.push(p.clone())
        const theta = 0.75 + 0.8 * (j / 3)
        p.addScaledVector(dir.clone().multiplyScalar(Math.sin(theta)).addScaledVector(UP, Math.cos(theta)), 0.065)
      }
      b.ribbon(pts, pts.map(() => side), pts.map((_, j) => 0.007 * (1 - j / 4)), pts.map(() => UP), 2, 1)
    }
  }

  // Ears: from leaf axils halfway up, leaning out from the stalk, with silk at the tip.
  if (d < 2) {
    const ears: [part: number, nodeY: number, length: number][] = [[3, 0.95, 0.25], [4, 0.76, 0.2]]
    for (const [part, nodeY, length] of ears) {
      const leaf = leafAzimuth.reduce((best, phi, i) => {
        const y = STALK_TOP * (0.04 + 0.84 * Math.pow(i / (leaves - 1), 1.15))
        return Math.abs(y - nodeY) < best.dy ? { dy: Math.abs(y - nodeY), phi } : best
      }, { dy: Infinity, phi: 0 }).phi
      const out = new Vector3(Math.cos(leaf), 0, Math.sin(leaf))
      const axis = out.clone().multiplyScalar(Math.sin(0.45)).addScaledVector(UP, Math.cos(0.45))
      const n = [5, 3][d]
      const pts = Array.from({ length: n + 1 }, (_, k) => new Vector3(0, nodeY, 0).addScaledVector(out, 0.015).addScaledVector(axis, (k / n) * length))
      const radii = pts.map((_, k) => {
        const s = k / n
        return s < 0.15 ? 0.012 : k === n ? 0.004 : 0.03 * Math.pow(Math.sin(Math.PI * (0.1 + 0.85 * s)), 0.7) * (length / 0.25)
      })
      b.tube(pts, radii, [5, 3][d], part, nodeY / STALK_TOP)
      if (d === 0 && part === 3) {
        const tip = pts[n]
        const silk = [0, 1, 2].map((k) => tip.clone().addScaledVector(axis, k * 0.03).addScaledVector(out, k * k * 0.008))
        for (const a of [0, Math.PI / 2]) {
          const side = new Vector3().crossVectors(axis, out).applyAxisAngle(axis, a).normalize()
          b.ribbon(silk, silk.map(() => side), [0.022, 0.016, 0.006], silk.map(() => UP), 5, nodeY / STALK_TOP)
        }
      }
    }
  }
  return b.build()
}

/**
 * The canopy surface of a set of fields: each field's polygon on a `resolution` m grid (cells clipped exactly at
 * the outline), draped on the terrain, plus a wall skirt along the outline. See {@link createCanopyMaterial}.
 */
export function createCanopyGeometry(fields: readonly CornField[], resolution: number, height: HeightFn): BufferGeometry {
  const pos: number[] = []
  const nrm: number[] = []
  const attr: number[] = []
  const index: number[] = []
  const h = (x: number, z: number) => {
    const y = height(x, z)
    return y === y ? y : 0
  }
  const normalAt = (x: number, z: number) => {
    const e = 0.5
    return new Vector3(h(x - e, z) - h(x + e, z), 2 * e, h(x, z - e) - h(x, z + e)).normalize()
  }
  const res = Math.max(0.25, resolution)
  for (const field of fields) {
    const poly = field.polygon
    if (poly.length < 3 || !(field.rowSpacing > 0)) continue
    const bx = -Math.sin(field.rowDirection), bz = Math.cos(field.rowDirection)
    const v0 = poly[0][0] * bx + poly[0][1] * bz
    const rows = (x: number, z: number) => (x * bx + z * bz - v0) / field.rowSpacing
    const along = (x: number, z: number) => x * bz - z * bx // metres along the rows
    const top = (x: number, z: number) => {
      const n = normalAt(x, z)
      pos.push(x, h(x, z), z)
      nrm.push(n.x, n.y, n.z)
      attr.push(rows(x, z), along(x, z), 0, 0)
      return pos.length / 3 - 1
    }
    const fb = bounds(poly)
    const nx = Math.ceil((fb.maxX - fb.minX) / res)
    const nz = Math.ceil((fb.maxZ - fb.minZ) / res)
    // Cells the outline passes through get clipped; the rest are fully in or out.
    const edge = new Uint8Array(nx * nz)
    poly.forEach(([ax, az], i) => {
      const [cx, cz] = poly[(i + 1) % poly.length]
      const steps = Math.ceil((Math.hypot(cx - ax, cz - az) / res) * 2) + 1
      for (let k = 0; k <= steps; k++) {
        const ci = Math.floor((ax + ((cx - ax) * k) / steps - fb.minX) / res)
        const cj = Math.floor((az + ((cz - az) * k) / steps - fb.minZ) / res)
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = ci + di, jj = cj + dj
          if (ii >= 0 && jj >= 0 && ii < nx && jj < nz) edge[jj * nx + ii] = 1
        }
      }
    })
    const grid = new Map<number, number>()
    const corner = (i: number, j: number) => {
      const key = j * (nx + 1) + i
      let v = grid.get(key)
      if (v === undefined) grid.set(key, (v = top(fb.minX + i * res, fb.minZ + j * res)))
      return v
    }
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x0 = fb.minX + i * res, z0 = fb.minZ + j * res
        if (!edge[j * nx + i]) {
          if (pointInPolygon(poly, x0 + res / 2, z0 + res / 2)) {
            const a = corner(i, j), b = corner(i + 1, j), c = corner(i, j + 1), d = corner(i + 1, j + 1)
            index.push(a, c, b, b, c, d)
          }
          continue
        }
        const clipped = clipToRect(poly, x0, z0, x0 + res, z0 + res)
        if (clipped.length < 3) continue
        const contour = clipped.map(([x, z]) => new Vector2(x, z))
        const first = pos.length / 3
        for (const [x, z] of clipped) top(x, z)
        for (const [a, b, c] of ShapeUtils.triangulateShape(contour, [])) index.push(first + a, first + b, first + c)
      }
    }
    // Wall skirt along the outline, facing out; the shader raises its top edge with the canopy.
    let area = 0
    poly.forEach(([ax, az], i) => {
      const [cx, cz] = poly[(i + 1) % poly.length]
      area += ax * cz - cx * az
    })
    const sign = area > 0 ? 1 : -1
    let edgeLength = 0
    poly.forEach(([ax, az], i) => {
      const [cx, cz] = poly[(i + 1) % poly.length]
      const len = Math.hypot(cx - ax, cz - az)
      if (len < 1e-6) return
      const nxo = (sign * (cz - az)) / len, nzo = (-sign * (cx - ax)) / len
      const steps = Math.max(1, Math.ceil(len / res))
      let prev = -1
      for (let k = 0; k <= steps; k++) {
        const x = ax + ((cx - ax) * k) / steps, z = az + ((cz - az) * k) / steps
        const y = h(x, z)
        const dAlong = edgeLength + (len * k) / steps
        const first = pos.length / 3
        for (const w of [0, 1]) {
          pos.push(x, y, z)
          nrm.push(nxo, 0, nzo)
          attr.push(rows(x, z), dAlong, 1, w)
        }
        if (prev >= 0) index.push(prev, first, prev + 1, prev + 1, first, first + 1)
        prev = first
      }
      edgeLength += len
    })
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new Float32BufferAttribute(nrm, 3))
  g.setAttribute('aCanopy', new Float32BufferAttribute(attr, 4))
  g.setIndex(index)
  return g
}

/** Clips a polygon to an axis-aligned rectangle (Sutherland–Hodgman). */
function clipToRect(poly: readonly (readonly [number, number])[], minX: number, minZ: number, maxX: number, maxZ: number) {
  let out: [number, number][] = poly.map(([x, z]) => [x, z])
  const planes: [axis: 0 | 1, value: number, keepAbove: boolean][] = [[0, minX, true], [0, maxX, false], [1, minZ, true], [1, maxZ, false]]
  for (const [axis, value, above] of planes) {
    const input = out
    out = []
    const inside = (p: [number, number]) => (above ? p[axis] >= value : p[axis] <= value)
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]
      const prev = input[(i + input.length - 1) % input.length]
      const cin = inside(cur), pin = inside(prev)
      if (cin !== pin) {
        const t = (value - prev[axis]) / (cur[axis] - prev[axis])
        out.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t])
      }
      if (cin) out.push(cur)
    }
    if (!out.length) break
  }
  return out
}
