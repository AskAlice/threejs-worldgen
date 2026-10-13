import {
  BufferGeometry, Float32BufferAttribute, Group, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, Sphere, Vector3,
  type Camera, type DirectionalLight, type MeshPhysicalNodeMaterial, type Node, type Object3D,
} from 'three/webgpu'
import { createGrassMaterial, createGrassUniforms, MAX_INTERACTORS, sampleGrassMap, type GrassMapSample, type GrassUniforms } from './material.ts'
import { presets, type GrassStyle, type PresetName } from './presets.ts'
import { createHeightSampler, slopeAt, type HeightFn, type Terrain } from 'threejs-heightfield'
import type { GrassMap } from './grass-map.ts'
import { hash2, mulberry32, valueNoise } from './random.ts'

/**
 * One of the four levels of detail. Density is interpolated linearly between consecutive LODs, so
 * blades thin out smoothly with distance instead of popping at tile borders.
 */
export interface GrassLOD {
  /** Distance from the camera (metres, XZ) at which this LOD is fully reached. */
  distance: number
  /** Fraction (0..1) of the full blade density kept at this distance. */
  density: number
  /** Vertical segments per blade (or billboard). More = smoother bending, more vertices. */
  segments: number
}

/** Procedural wind. Gusts are scrolling noise along `direction` plus a travelling ripple. */
export interface WindOptions {
  /** World-space XZ direction the wind blows towards. Normalised internally. */
  direction: [x: number, z: number]
  /** How far blades bend. 0 = still, ~0.35 = breeze, 1+ = storm. */
  strength: number
  /** Noise frequency in 1/metres. Smaller = broader gusts. */
  scale: number
  /** How fast gusts travel across the field. */
  speed: number
}

/** Something that pushes grass aside: characters, vehicles, balls… */
export interface Interactor {
  /** The object (or a React ref to it). Its world position is read every frame. */
  object: Object3D | {
    /** The referenced object; `null` until mounted. */
    current: Object3D | null
  }
  /** Influence radius in metres. Blades inside are bent away from the object. */
  radius: number
}

/** Every setting of a {@link Grass} field. All are optional on input; see {@link GrassInput}. */
export interface GrassSettings extends GrassStyle {
  /** Starting look; any {@link GrassStyle} field you pass overrides the preset's value. */
  preset: PresetName
  /** Detailed geometric blades, or lightweight view-facing billboard tufts. */
  type: 'blades' | 'billboards'
  /** Edge length of a streaming tile in metres. Tiles are re-centred around the camera. */
  tileSize: number
  /** Radius (metres) around the camera that has grass. Blades fade out over the last 15%. */
  maxDistance: number
  /** Exactly four levels of detail, ordered near → far. */
  lods: GrassLOD[]
  /** Procedural wind; see {@link WindOptions}. */
  wind: WindOptions
  /** Steepest terrain gradient (rise / run) that still grows grass. `Infinity` disables the check. */
  maxSlope: number
  /** Coverage/height control texture; see {@link GrassMap}. `null` = grass everywhere. */
  grassMap: GrassMap | null
  /** Up to 16 objects that push grass aside. */
  interactors: Interactor[]
  /** Global multiplier on how strongly interactors bend grass. */
  interactionStrength: number
  /** Whether grass within `shadowDistance` casts shadows (needs a shadow-casting light). */
  castShadow: boolean
  /** Radius (metres) around the camera in which grass casts shadows. Shadows are costly: keep it small. */
  shadowDistance: number
  /** Whether grass receives shadows. */
  receiveShadow: boolean
  /** Light used for back-lit translucency. `null` = first DirectionalLight found in the scene. */
  sun: DirectionalLight | null
  /** Tints grass by LOD (red, yellow, green, blue) to help tune `lods`. */
  debugLods: boolean
  /** Milliseconds per frame spent (re)building tiles, nearest first. Spreads work to avoid frame spikes. */
  buildBudget: number
}

/** Partial settings accepted by {@link Grass.create}, {@link Grass.set} and the `<Grass>` component. */
export type GrassInput = Partial<Omit<GrassSettings, 'wind'>> & {
  /** Wind settings to change; unspecified fields keep their current value. */
  wind?: Partial<WindOptions>
}

/** Minimal renderer shape Grass needs. Pass a `WebGPURenderer` from `three/webgpu`. */
export interface GrassRenderer {
  /** `true` on `WebGPURenderer`; anything else is rejected. */
  isWebGPURenderer?: boolean
  /** Whether `init()` has completed. */
  hasInitialized?: () => boolean
  /** Initialises the backend (WebGPU, or WebGL2 fallback). */
  init?: () => Promise<unknown>
}

/** Live counters of a {@link Grass} field. */
export interface GrassStats {
  /** Tiles currently streamed in around the camera. */
  tiles: number
  /** Blade (or billboard) instances currently allocated across all tiles. */
  instances: number
}

/** Options for {@link Grass.create}. */
export interface GrassOptions extends GrassInput {
  /** The camera the field is centred on and whose distance drives LOD. */
  camera: Camera
  /** If given, grass is added to it and updates itself every frame via `scene.onBeforeRender`. */
  scene?: Object3D
  /** Must be a WebGPURenderer (`three/webgpu`); it falls back to WebGL2 by itself. Initialised if needed. */
  renderer?: GrassRenderer
  /** Mesh/group to grow on (baked once into a heightfield), a `(x, z) => y` function, or omit for flat ground. */
  terrain?: Terrain
}

const DEFAULTS: Omit<GrassSettings, keyof GrassStyle | 'wind'> = {
  preset: 'kentuckyBluegrass',
  type: 'blades',
  tileSize: 25,
  maxDistance: 200,
  lods: [
    { distance: 8, density: 1, segments: 5 },
    { distance: 25, density: 0.25, segments: 3 },
    { distance: 60, density: 0.06, segments: 2 },
    { distance: 120, density: 0.03, segments: 1 },
  ],
  maxSlope: 1.2,
  grassMap: null,
  interactors: [],
  interactionStrength: 1,
  castShadow: true,
  shadowDistance: 20,
  receiveShadow: true,
  sun: null,
  debugLods: false,
  buildBudget: 3,
}
const DEFAULT_WIND: WindOptions = { direction: [1, 0.35], strength: 0.45, scale: 0.045, speed: 0.8 }

/** Billboard clumps hold ~9 strands, so they need far fewer instances for the same look. */
const BILLBOARD_DENSITY_RATIO = 1 / 5

interface CellCache {
  rand: () => number
  clumpX: Float32Array
  clumpZ: Float32Array
  clumpH: Float32Array
  /** Candidates drawn so far (some are rejected: off-terrain / too steep). */
  candidates: number
  /** Accepted blades, in candidate order. */
  count: number
  offsets: Float32Array
  params: Float32Array
  patches: Float32Array
}

interface Tile {
  ix: number
  iz: number
  /** Blade candidates currently built per cell. */
  built: Int32Array
  segments: number
  /** Generated blades per cell, kept so LOD changes are a copy instead of a regeneration. */
  cells: (CellCache | undefined)[]
  mesh: Mesh<InstancedBufferGeometry, MeshPhysicalNodeMaterial>
  minY: number
  maxY: number
  seen: number
  dist: number
}

/**
 * An infinite, camera-centred grass field.
 *
 * The world is divided into square tiles that stream in and out around the camera; each tile holds
 * instanced blades placed on the terrain, thinned by distance through four LODs.
 *
 * @example
 * ```ts
 * const grass = await Grass.create({ camera, scene, renderer, terrain, tileSize: 25, maxDistance: 200 })
 * // That's it — it updates itself whenever `scene` is rendered.
 * ```
 */
export class Grass {
  /** Root of all grass tiles. Added to `scene` for you when one is passed to {@link Grass.create}. */
  readonly object = new Group()
  /** Shader uniforms, for advanced tweaks or for reading grass state in your own TSL materials. */
  readonly uniforms: GrassUniforms = createGrassUniforms()
  /** Live counters, refreshed on every {@link Grass.update}. */
  readonly stats: GrassStats = { tiles: 0, instances: 0 }
  /** Camera the field follows. Can be swapped at any time. */
  camera: Camera
  /** Resolved settings (defaults ← preset ← your input). Read-only: change them with {@link Grass.set}. */
  settings!: GrassSettings
  /** Terrain height at world (x, z); NaN where there is no terrain. Handy for placing objects on the ground. */
  sampleHeight: HeightFn

  private input: GrassInput = {}
  private material: MeshPhysicalNodeMaterial | null = null
  private baseGeometries = new Map<string, BufferGeometry>()
  private tiles = new Map<string, Tile>()
  private layoutKey = ''
  private layoutTileSize = 0
  private frame = 0
  private unhook = () => {}

  /**
   * Creates a grass field and builds every visible tile so the first frame is complete.
   * @throws If `renderer` is not a WebGPURenderer.
   */
  static async create(options: GrassOptions): Promise<Grass> {
    const { renderer } = options
    if (renderer && !renderer.isWebGPURenderer) {
      throw new Error('Grass requires WebGPURenderer from "three/webgpu" (it uses WebGL2 automatically when WebGPU is unavailable).')
    }
    if (renderer?.hasInitialized?.() === false) await renderer.init?.()
    const grass = new Grass(options)
    grass.update(Infinity) // build every tile up front so the first frame is complete
    return grass
  }

  /** Prefer {@link Grass.create}, which also validates/initialises the renderer and pre-builds tiles. */
  constructor({ camera, scene, renderer: _renderer, terrain, ...input }: GrassOptions) {
    this.camera = camera
    this.sampleHeight = createHeightSampler(terrain)
    this.object.name = 'Grass'
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
   * Changes settings at runtime, merging into what was set before. Visual settings (colours, height,
   * wind, …) apply instantly through uniforms; layout settings (type, density, tileSize, lods, clumping,
   * variation, maxSlope) rebuild tiles. `undefined` values are ignored; `wind` merges field by field.
   * To drop earlier overrides (e.g. go back to a preset's colours), use {@link Grass.reset}.
   */
  set(input: GrassInput): this {
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue
      if (k === 'wind') this.input.wind = { ...this.input.wind, ...(v as Partial<WindOptions>) }
      else (this.input as any)[k] = v
    }
    return this.apply()
  }

  /**
   * Replaces all settings with `input`: anything not given falls back to the preset, then to defaults.
   * Use it to switch presets cleanly after overriding style fields. `<Grass>` uses it so props behave
   * declaratively (removing a prop reverts it).
   */
  reset(input: GrassInput = {}): this {
    this.input = {}
    return this.set(input)
  }

  private apply(): this {
    const preset = presets[this.input.preset ?? DEFAULTS.preset]
    const s: GrassSettings = { ...DEFAULTS, ...preset, ...(this.input as any), wind: { ...DEFAULT_WIND, ...this.input.wind } }
    if (s.lods.length !== 4) throw new Error('Grass: `lods` must contain exactly 4 levels.')
    this.settings = s

    const u = this.uniforms
    u.baseColor.value.set(s.baseColor)
    u.tipColor.value.set(s.tipColor)
    u.colorVariation.value = s.colorVariation
    u.bladeHeight.value = s.bladeHeight
    u.bladeWidth.value = s.bladeWidth
    u.curvature.value = s.curvature
    u.stiffness.value = Math.max(0.05, s.stiffness)
    u.windDirection.value.set(...s.wind.direction).normalize()
    u.windStrength.value = s.wind.strength
    u.windScale.value = s.wind.scale
    u.windSpeed.value = s.wind.speed
    u.lodDistances.value.set(...(s.lods.map((l) => l.distance) as [number, number, number, number]))
    u.lodDensities.value.set(...(s.lods.map((l) => l.density) as [number, number, number, number]))
    u.maxDistance.value = s.maxDistance
    u.interactionStrength.value = s.interactionStrength
    u.patchiness.value = s.patchiness
    u.translucency.value = s.translucency
    u.debugLods.value = s.debugLods ? 1 : 0
    if (s.grassMap) {
      u.map.value = s.grassMap.texture
      u.mapBounds.value.set(s.grassMap.minX, s.grassMap.minZ, s.grassMap.size, s.grassMap.size)
    } else {
      u.mapBounds.value.set(-1e6, -1e6, 2e6, 2e6) // neutral map stays bound; this just disables it
    }

    const layoutKey = JSON.stringify([s.type, s.tileSize, s.density, s.heightVariation, s.widthVariation, s.clumping, s.clumpSize, s.maxSlope, s.lods])
    if (layoutKey !== this.layoutKey) {
      const tileSizeChanged = this.settings && this.layoutTileSize !== s.tileSize
      this.layoutKey = layoutKey
      this.layoutTileSize = s.tileSize
      if (tileSizeChanged) this.clearTiles()
      else {
        // Keep showing the old blades until each tile is rebuilt, instead of the field blinking out.
        for (const tile of this.tiles.values()) {
          tile.cells = []
          tile.built = new Int32Array(0)
        }
      }
      this.material?.dispose()
      this.material = createGrassMaterial(this.uniforms, s.type === 'billboards')
    }
    for (const tile of this.tiles.values()) this.applyTileSettings(tile)
    return this
  }

  /** Swaps the terrain (mesh or height function) and regenerates all tiles. */
  setTerrain(terrain?: Terrain): void {
    this.sampleHeight = createHeightSampler(terrain)
    this.clearTiles()
  }

  /**
   * Re-centres the tiles on the camera, streams tiles in/out and refreshes interactors and the sun.
   * Called automatically when a `scene` was given (and by the `<Grass>` component); otherwise call it once per frame.
   * @param budget Milliseconds allowed for tile (re)builds this frame. Defaults to `settings.buildBudget`.
   */
  update(budget: number = this.settings.buildBudget): void {
    const s = this.settings
    const frame = ++this.frame
    const cam = this.camera.getWorldPosition(_v)
    const ts = s.tileSize
    const r = Math.ceil(s.maxDistance / ts)
    const ci = Math.floor(cam.x / ts)
    const cj = Math.floor(cam.z / ts)
    const pending: { tile: Tile; dist: number; needs: Int32Array; segments: number }[] = []

    for (let i = ci - r; i <= ci + r; i++) {
      for (let j = cj - r; j <= cj + r; j++) {
        const dx = Math.max(i * ts - cam.x, 0, cam.x - (i + 1) * ts)
        const dz = Math.max(j * ts - cam.z, 0, cam.z - (j + 1) * ts)
        const dist = Math.hypot(dx, dz)
        if (dist >= s.maxDistance) continue
        const key = `${i},${j}`
        let tile = this.tiles.get(key)
        if (!tile) {
          tile = this.createTile(i, j)
          this.tiles.set(key, tile)
        }
        tile.seen = frame
        tile.dist = dist
        const needs = this.cellNeeds(tile, cam)
        const segments = this.segmentsAt(dist)
        if (needsRebuild(tile, needs, segments)) pending.push({ tile, dist, needs: needs.slice(), segments })
      }
    }

    for (const [key, tile] of this.tiles) {
      if (tile.seen !== frame) {
        this.removeTile(tile)
        this.tiles.delete(key)
      }
    }
    this.flushRetired()

    pending.sort((a, b) => a.dist - b.dist)
    const start = performance.now()
    for (const p of pending) {
      this.buildTile(p.tile, p.needs, p.segments)
      if (performance.now() - start > budget) break
    }

    this.uniforms.viewPosition.value.copy(cam)
    this.updateSun()
    this.updateInteractors()
    let instances = 0
    for (const tile of this.tiles.values()) {
      instances += tile.mesh.geometry.instanceCount
      tile.mesh.castShadow = s.castShadow && tile.dist < s.shadowDistance
    }
    this.stats.tiles = this.tiles.size
    this.stats.instances = instances
  }

  /** Removes the grass from the scene and frees its GPU resources. */
  dispose(): void {
    this.unhook()
    this.clearTiles()
    this.flushRetired(true)
    this.material?.dispose()
    for (const g of this.baseGeometries.values()) g.dispose()
    this.baseGeometries.clear()
    this.object.removeFromParent()
  }

  /** Fraction (0..1) of full blade density at a distance from the camera — the CPU mirror of the shader's LOD curve. */
  densityAt(dist: number): number {
    const l = this.settings.lods
    const seg = (a: number, b: number) => Math.min(1, Math.max(0, (dist - a) / Math.max(b - a, 1e-3)))
    const mix = (a: number, b: number, t: number) => a + (b - a) * t
    return mix(mix(mix(l[0].density, l[1].density, seg(l[0].distance, l[1].distance)), l[2].density, seg(l[1].distance, l[2].distance)), l[3].density, seg(l[2].distance, l[3].distance))
  }

  /** Tiles are split into ~5 m cells, each holding only as many blades as its own distance needs.
   *  Without this, the tiles around the camera would carry full density across their whole area. */
  private get cellsPerSide() {
    return Math.max(1, Math.round(this.settings.tileSize / 5))
  }

  /** Full-density blade candidates per cell. */
  private get cellFull() {
    const s = this.settings
    const cs = s.tileSize / this.cellsPerSide
    return Math.ceil(s.density * cs * cs * (s.type === 'billboards' ? BILLBOARD_DENSITY_RATIO : 1))
  }

  private needScratch = new Int32Array(0)
  /** Blade candidates each cell of a tile needs for the current camera position. */
  private cellNeeds(tile: Tile, cam: Vector3) {
    const s = this.settings
    const n = this.cellsPerSide
    const cs = s.tileSize / n
    const full = this.cellFull
    if (this.needScratch.length !== n * n) this.needScratch = new Int32Array(n * n)
    const needs = this.needScratch
    for (let b = 0; b < n; b++) {
      for (let a = 0; a < n; a++) {
        const x0 = tile.ix * s.tileSize + a * cs
        const z0 = tile.iz * s.tileSize + b * cs
        const dist = Math.hypot(Math.max(x0 - cam.x, 0, cam.x - x0 - cs), Math.max(z0 - cam.z, 0, cam.z - z0 - cs))
        needs[b * n + a] = dist >= s.maxDistance ? 0 : Math.ceil(full * Math.min(1, this.densityAt(dist)))
      }
    }
    return needs
  }

  private segmentsAt(dist: number) {
    const lods = this.settings.lods
    let lod = 0
    while (lod < 3 && dist >= lods[lod + 1].distance) lod++
    return lods[lod].segments
  }

  private createTile(ix: number, iz: number): Tile {
    const geometry = new InstancedBufferGeometry()
    geometry.instanceCount = 0
    const mesh = new Mesh(geometry, this.material!)
    mesh.position.set(ix * this.settings.tileSize, 0, iz * this.settings.tileSize)
    mesh.updateMatrix()
    mesh.matrixAutoUpdate = false
    mesh.visible = false
    this.object.add(mesh)
    return { ix, iz, built: new Int32Array(0), segments: 0, cells: [], mesh, minY: 0, maxY: 0, seen: 0, dist: 0 }
  }

  private buildTile(tile: Tile, needs: Int32Array, segments: number) {
    const s = this.settings
    const billboard = s.type === 'billboards'
    const cs = s.tileSize / this.cellsPerSide
    const full = this.cellFull
    // Build with headroom so a camera creeping closer doesn't trigger a rebuild every frame.
    const counts = needs.map((need) => (need ? Math.min(full, Math.ceil(need * HEADROOM)) : 0))

    // Ensure each cell has generated enough candidates, then count how many accepted blades fall in
    // the first `counts[c]` candidates (rank encodes the candidate index).
    const take = counts.map((count, c) => {
      if (!count) return 0
      const cell = (tile.cells[c] ??= this.createCell(tile, c, cs))
      if (cell.candidates < count) this.generate(tile, cell, c, cs, full, count)
      let k = cell.count
      while (k > 0 && cell.params[(k - 1) * 4 + 2] * full > count) k--
      return k
    })
    const written = take.reduce((a, b) => a + b, 0)

    // Reuse the tile's GPU buffers when the new data fits; only grow (with slack) when it doesn't.
    // Allocating fresh buffers on every LOD change is what makes camera moves stutter.
    let geometry = tile.mesh.geometry
    const base = this.baseGeometry(segments, billboard)
    const current = geometry.getAttribute('aOffset') as InstancedBufferAttribute | undefined
    if (!current || current.count < written || geometry.attributes.position !== base.attributes.position) {
      const capacity = Math.ceil(written * 1.5) + 16
      const old = geometry
      geometry = new InstancedBufferGeometry()
      geometry.setIndex(base.index)
      geometry.setAttribute('position', base.attributes.position)
      geometry.setAttribute('uv', base.attributes.uv)
      geometry.setAttribute('aOffset', new InstancedBufferAttribute(new Float32Array(capacity * 4), 4))
      geometry.setAttribute('aParams', new InstancedBufferAttribute(new Float32Array(capacity * 4), 4))
      geometry.setAttribute('aPatch', new InstancedBufferAttribute(new Float32Array(capacity * 3), 3))
      tile.mesh.geometry = geometry
      this.retire(old)
    }
    const aOffset = geometry.getAttribute('aOffset') as InstancedBufferAttribute
    const aParams = geometry.getAttribute('aParams') as InstancedBufferAttribute
    const aPatch = geometry.getAttribute('aPatch') as InstancedBufferAttribute
    const offsets = aOffset.array as Float32Array
    const params = aParams.array as Float32Array
    const patches = aPatch.array as Float32Array
    let w = 0
    let minY = Infinity
    let maxY = -Infinity
    take.forEach((k, c) => {
      if (!k) return
      const cell = tile.cells[c]!
      offsets.set(cell.offsets.subarray(0, k * 4), w * 4)
      params.set(cell.params.subarray(0, k * 4), w * 4)
      patches.set(cell.patches.subarray(0, k * 3), w * 3)
      for (let i = 0; i < k; i++) {
        const y = cell.offsets[i * 4 + 1]
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      w += k
    })

    for (const attr of [aOffset, aParams, aPatch]) {
      attr.clearUpdateRanges()
      attr.addUpdateRange(0, written * attr.itemSize)
      attr.needsUpdate = true
    }
    geometry.instanceCount = written

    tile.built = counts
    tile.segments = segments
    tile.minY = minY
    tile.maxY = maxY
    this.applyTileSettings(tile)
  }

  private createCell(tile: Tile, c: number, cs: number): CellCache {
    const s = this.settings
    const n = this.cellsPerSide
    const a = c % n
    const b = Math.floor(c / n)
    // Each cell has its own random streams keyed by global cell coords. Blades are drawn in a fixed
    // order with a fixed number of draws, so fewer blades is always an exact prefix of more blades:
    // LOD changes only add/remove blades, never reshuffle them.
    const cellSeed = hash2(tile.ix * n + a, tile.iz * n + b)
    const clumpRand = mulberry32(cellSeed ^ 0x9e3779b9)
    const clumps = Math.max(1, Math.ceil((cs * cs) / (s.clumpSize * s.clumpSize)))
    const cell: CellCache = {
      rand: mulberry32(cellSeed),
      clumpX: new Float32Array(clumps),
      clumpZ: new Float32Array(clumps),
      clumpH: new Float32Array(clumps),
      candidates: 0,
      count: 0,
      offsets: new Float32Array(0),
      params: new Float32Array(0),
      patches: new Float32Array(0),
    }
    for (let k = 0; k < clumps; k++) {
      cell.clumpX[k] = a * cs + clumpRand() * cs
      cell.clumpZ[k] = b * cs + clumpRand() * cs
      cell.clumpH[k] = clumpRand()
    }
    return cell
  }

  /** Continues a cell's blade stream until `upTo` candidates have been drawn. */
  private generate(tile: Tile, cell: CellCache, c: number, cs: number, full: number, upTo: number) {
    const s = this.settings
    const n = this.cellsPerSide
    const cx = (c % n) * cs
    const cz = Math.floor(c / n) * cs
    const ox = tile.ix * s.tileSize
    const oz = tile.iz * s.tileSize
    const clumping = s.type === 'billboards' ? 0 : s.clumping // a billboard already is a tuft
    const checkSlope = Number.isFinite(s.maxSlope)
    const { rand, clumpX, clumpZ, clumpH } = cell
    const clumps = clumpX.length

    const grow = upTo - cell.candidates
    if (cell.offsets.length < (cell.count + grow) * 4) {
      const cap = Math.max(cell.count + grow, cell.count * 2)
      const resize = (arr: Float32Array, stride: number) => {
        const next = new Float32Array(cap * stride)
        next.set(arr.subarray(0, cell.count * stride))
        return next
      }
      cell.offsets = resize(cell.offsets, 4)
      cell.params = resize(cell.params, 4)
      cell.patches = resize(cell.patches, 3)
    }
    const { offsets, params, patches } = cell

    for (let i = cell.candidates; i < upTo; i++) {
      let lx = cx + rand() * cs
      let lz = cz + rand() * cs
      let yaw = rand() * Math.PI * 2
      let hr = rand()
      const ws = 1 + (rand() * 2 - 1) * s.widthVariation
      const seed = rand()
      const k = Math.floor(rand() * clumps)
      const angle = rand() * Math.PI * 2
      const radius = Math.sqrt(rand()) * s.clumpSize * 0.5
      // Tufts: blades gather around clump centres, face outwards (so they droop outwards) and share
      // a clump-level height.
      if (rand() < clumping) {
        lx = clumpX[k] + Math.sin(angle) * radius
        lz = clumpZ[k] + Math.cos(angle) * radius
        yaw = angle + (yaw / Math.PI - 1) * 0.5
        hr = clumpH[k] * 0.65 + hr * 0.35
      }
      const wx = ox + lx
      const wz = oz + lz
      const y = this.sampleHeight(wx, wz)
      if (y !== y) continue
      if (checkSlope && slopeAt(this.sampleHeight, wx, wz) > s.maxSlope) continue
      const o = cell.count * 4
      offsets[o] = lx
      offsets[o + 1] = y
      offsets[o + 2] = lz
      offsets[o + 3] = yaw
      params[o] = 1 + (hr * 2 - 1) * s.heightVariation
      params[o + 1] = ws
      params[o + 2] = (i + 0.5) / full
      params[o + 3] = seed
      const p = cell.count * 3
      patches[p] = valueNoise(wx * 0.05, wz * 0.05) * 0.7 // light/dark patches
      patches[p + 1] = valueNoise(wx * 0.018 + 31.7, wz * 0.018 - 12.3) * 0.7 // dry patches
      // Flow field: a slowly meandering lean direction, so the field looks brushed into swirls
      // rather than combed in one direction.
      patches[p + 2] = valueNoise(wx * 0.07 - 5.1, wz * 0.07 + 9.4) + valueNoise(wx * 0.19 + 2.3, wz * 0.19 - 7.7) * 0.4
      cell.count++
    }
    cell.candidates = upTo
  }

  private applyTileSettings(tile: Tile) {
    const s = this.settings
    const { mesh } = tile
    const ts = s.tileSize
    mesh.material = this.material!
    mesh.receiveShadow = s.receiveShadow
    mesh.visible = mesh.geometry.instanceCount > 0
    if (!mesh.visible) return
    // Instanced geometry can't compute its own bounds; frustum culling needs a manual sphere.
    const reach = s.bladeHeight * (1 + s.heightVariation) * 2 + s.clumpSize // map can double height; tufts spill over edges
    mesh.geometry.boundingSphere = new Sphere(
      new Vector3(ts / 2, (tile.minY + tile.maxY) / 2, ts / 2),
      Math.hypot(ts / Math.SQRT2, (tile.maxY - tile.minY) / 2) + reach,
    )
  }

  private baseGeometry(segments: number, billboard: boolean) {
    const key = `${billboard}|${segments}`
    let g = this.baseGeometries.get(key)
    if (!g) {
      g = billboard ? createBillboardGeometry(segments) : createBladeGeometry(segments)
      this.baseGeometries.set(key, g)
    }
    return g
  }

  /**
   * TSL nodes reading the grass map at a world XZ position. Use them in your terrain material to show
   * dirt where grass was erased; they follow map edits and `grassMap` swaps live.
   *
   * @example
   * ```ts
   * const { coverage } = grass.mapNode(positionWorld.xz)
   * terrainMaterial.colorNode = mix(dirtColor, grassyGround, coverage)
   * ```
   */
  mapNode(worldXZ: Node<'vec2'>): GrassMapSample {
    return sampleGrassMap(this.uniforms, worldXZ)
  }

  private sunSearched = false
  private autoSun: DirectionalLight | null = null
  private updateSun() {
    let sun = this.settings.sun
    if (!sun && !this.sunSearched && this.object.parent) {
      this.sunSearched = true
      this.autoSun = findSun(this.object)
    }
    writeSun(this.uniforms, sun ?? this.autoSun)
  }

  private updateInteractors() {
    writeInteractors(this.uniforms, this.settings.interactors)
  }

  private clearTiles() {
    for (const tile of this.tiles.values()) this.removeTile(tile)
    this.tiles.clear()
  }

  private removeTile(tile: Tile) {
    tile.mesh.removeFromParent()
    this.retire(tile.mesh.geometry)
  }

  /**
   * Replaced tile geometries are freed a while later rather than immediately: WebGPU builds render
   * pipelines asynchronously, and one still in flight may read the old geometry. Freeing it at once
   * (which detaches the shared blade attributes) made that pipeline fail and the tile blink out.
   */
  private retired: { geometry: InstancedBufferGeometry; frame: number }[] = []
  private retire(geometry: InstancedBufferGeometry) {
    this.retired.push({ geometry, frame: this.frame })
  }
  private flushRetired(all = false) {
    while (this.retired.length && (all || this.frame - this.retired[0].frame > RETIRE_AFTER_FRAMES)) {
      disposeInstanced(this.retired.shift()!.geometry)
    }
  }
}

const _v = new Vector3()
const _t = new Vector3()

/** The interactor's object, or `null` while a React ref is unmounted. */
export function interactorObject(it: Interactor | undefined): Object3D | null {
  return (it && ('isObject3D' in it.object ? it.object : it.object.current)) ?? null
}

/** Copies interactor positions and radii into the shader slots (shared by grass and corn). */
export function writeInteractors(u: Pick<GrassUniforms, 'interactors' | 'interactorCount'>, list: Interactor[]) {
  const slots = u.interactors.array as unknown as { set: (x: number, y: number, z: number, w: number) => void }[]
  u.interactorCount.value = Math.min(list.length, MAX_INTERACTORS)
  for (let i = 0; i < MAX_INTERACTORS; i++) {
    const it = list[i]
    const obj = interactorObject(it)
    if (!obj) {
      slots[i].set(0, 0, 0, 0)
      continue
    }
    obj.getWorldPosition(_v)
    slots[i].set(_v.x, _v.y, _v.z, it.radius)
  }
}

/** The first DirectionalLight in the scene `object` belongs to. */
export function findSun(object: Object3D): DirectionalLight | null {
  let root: Object3D = object
  while (root.parent) root = root.parent
  let found: DirectionalLight | null = null
  root.traverse((o) => {
    if (!found && (o as DirectionalLight).isDirectionalLight) found = o as DirectionalLight
  })
  return found
}

/** Points the translucency uniforms at `sun` (no-op without one). */
export function writeSun(u: Pick<GrassUniforms, 'sunDirection' | 'sunColor'>, sun: DirectionalLight | null) {
  if (!sun) return
  sun.updateWorldMatrix(true, false)
  sun.target.updateWorldMatrix(true, false)
  u.sunDirection.value.setFromMatrixPosition(sun.matrixWorld).sub(_t.setFromMatrixPosition(sun.target.matrixWorld)).normalize()
  u.sunColor.value.copy(sun.color).multiplyScalar(sun.intensity)
}
/** Frames to wait before freeing a replaced tile geometry (see `Grass.retire`). */
const RETIRE_AFTER_FRAMES = 60
/** Cells are built with this many times the blades they currently need. */
const HEADROOM = 1.3

/** Rebuild when a cell needs more than it holds, holds far more than it needs, or detail changed.
 *  Headroom on the way up and slack on the way down stop tiles rebuilding as the camera wanders. */
function needsRebuild(tile: Tile, needs: Int32Array, segments: number) {
  if (tile.segments !== segments || tile.built.length !== needs.length) return true
  for (let c = 0; c < needs.length; c++) {
    const built = tile.built[c]
    const need = needs[c]
    if (need > built || built > need * 2.5 + 8) return true
  }
  return false
}

/**
 * The base blade shape: a tapered, folded strip with x in [-0.5, 0.5] and y in [0, 1]. Each of the
 * `segments` rows has three vertices (left edge, midrib, right edge) so the shader can fold the
 * blade along its midrib; a single vertex forms the tip. Exposed for custom instancing setups;
 * Grass creates these for you.
 */
export function createBladeGeometry(segments: number): BufferGeometry {
  const pos: number[] = []
  const uv: number[] = []
  const index: number[] = []
  for (let r = 0; r < segments; r++) {
    const y = r / segments
    // Pinched at the base, widest around a quarter of the way up, tapering to a sharp tip.
    const half = 0.5 * Math.pow(1 - y, 0.75) * (0.72 + 0.28 * Math.min(1, y / 0.25))
    pos.push(-half, y, 0, 0, y, 0, half, y, 0)
    uv.push(0, y, 0.5, y, 1, y)
    if (r > 0) {
      const a = (r - 1) * 3
      index.push(a, a + 1, a + 3, a + 1, a + 4, a + 3) // left half
      index.push(a + 1, a + 2, a + 4, a + 2, a + 5, a + 4) // right half
    }
  }
  const b = (segments - 1) * 3
  const tip = segments * 3
  pos.push(0, 1, 0)
  uv.push(0.5, 1)
  index.push(b, b + 1, tip, b + 1, b + 2, tip)
  return indexedGeometry(pos, uv, index)
}

/** The base billboard shape: a unit quad strip with `segments` rows so it bends smoothly in the wind. */
export function createBillboardGeometry(segments: number): BufferGeometry {
  const pos: number[] = []
  const uv: number[] = []
  const index: number[] = []
  for (let r = 0; r <= segments; r++) {
    const y = r / segments
    pos.push(-0.5, y, 0, 0.5, y, 0)
    uv.push(0, y, 1, y)
    if (r > 0) {
      const a = (r - 1) * 2
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  return indexedGeometry(pos, uv, index)
}

function indexedGeometry(pos: number[], uv: number[], index: number[]) {
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  g.setIndex(index)
  return g
}

/** Disposes only the per-tile instance buffers. The renderer frees every attribute on a geometry's
 *  dispose, so the shared blade index/position/uv must be detached first. */
function disposeInstanced(geometry: InstancedBufferGeometry) {
  geometry.setIndex(null)
  geometry.deleteAttribute('position')
  geometry.deleteAttribute('uv')
  geometry.dispose()
}
