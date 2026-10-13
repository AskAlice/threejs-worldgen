import { BufferGeometry, Float32BufferAttribute, Group, Mesh, Vector3, type Camera, type MeshBasicNodeMaterial, type Object3D } from 'three/webgpu'
import { createSample, type LocalFrame, type World, type WorldSample } from 'threejs-biomes'
import { Clock, hookScene, mergeInput, placeInFrame, prepareRenderer, worldToFrame, type WaterRenderer } from './common.ts'
import { createWaterSample, type WaterSample } from './hydrology.ts'
import { DEFAULT_APPEARANCE, applyAppearance, createWaterMaterial, createWaterUniforms, updateSun, type WaterAppearance, type WaterUniforms } from './material.ts'

/** How river water moves; shared by {@link Rivers} and {@link waterAt}. */
export interface RiverFlowOptions {
  /** River channel strength (the world's `river`, 0 … 1) where water starts. */
  minStrength: number
  /** Surface speed (m/s) at a 1% slope; speed grows with √slope. */
  flowSpeed: number
  /** Slowest flow, m/s (flat stretches still drift). */
  minFlowSpeed: number
  /** Fastest flow, m/s. */
  maxFlowSpeed: number
}

/** Every setting of {@link Rivers}. All optional on input. */
export interface RiversSettings extends WaterAppearance, RiverFlowOptions {
  /** World position that is (0, 0, 0) in render space (floating origin). */
  origin: [x: number, y: number, z: number]
  /** Edge length of a streaming tile, metres. */
  tileSize: number
  /** Grid cells per tile side. Cell size = tileSize / resolution. */
  resolution: number
  /** Radius around the camera that has river meshes, metres. Nothing is built while the camera is higher than this. */
  maxDistance: number
  /** Milliseconds per frame spent building tiles, nearest first. */
  buildBudget: number
  /** Cells the water surface extends past the wet area, so it tucks under the banks. */
  expand: number
  /** Raises (or lowers) the water surface, metres. */
  surfaceOffset: number
  /** Seconds per flow-map cycle. Longer = less visible reset, more stretching. */
  flowPeriod: number
  /** Flow speed (m/s) where rapids start foaming. */
  rapids: number
  /** Planets: distance (metres) from the tile frame's centre at which a new frame is centred on the camera. */
  reframeDistance: number
}

/** Partial settings accepted by {@link Rivers.create}, {@link Rivers.set} and `<Rivers>`. */
export type RiversInput = Partial<RiversSettings>

/** Options for {@link Rivers.create}. */
export interface RiversOptions extends RiversInput {
  /** Camera the tiles stream around. */
  camera: Camera
  /** World whose rivers to draw (its `waterLevel` and `river` fields). Tiles rebuild when it changes. */
  world: World
  /** If given, rivers are added to it and update whenever it renders. */
  scene?: Object3D
  /** A WebGPURenderer; initialised if needed. */
  renderer?: WaterRenderer
}

/** Live counters of {@link Rivers}. */
export interface RiversStats {
  /** Tiles in range (with or without water). */
  tiles: number
  /** Tiles with a river mesh. */
  meshes: number
  /** Triangles across all river meshes. */
  triangles: number
  /** Tiles waiting to be (re)built. */
  pending: number
}

/** Default rivers: greenish, fairly clear water. */
export const DEFAULT_RIVERS: RiversSettings = {
  ...DEFAULT_APPEARANCE,
  shallowColor: '#a9cdb0',
  deepColor: '#1f3d33',
  visibility: 2.5,
  refraction: 0.03,
  foamWidth: 0.25,
  detail: 0.45,
  detailScale: 0.9,
  origin: [0, 0, 0],
  tileSize: 128,
  resolution: 48,
  maxDistance: 1000,
  buildBudget: 4,
  expand: 2,
  surfaceOffset: 0,
  flowPeriod: 2,
  rapids: 2.5,
  reframeDistance: 20_000,
  minStrength: 0.02,
  flowSpeed: 1,
  minFlowSpeed: 0.15,
  maxFlowSpeed: 4,
}

interface Tile {
  ix: number
  iz: number
  /** Key of the settings/world/frame the current mesh was built for. */
  built: string
  mesh: Mesh<BufferGeometry, MeshBasicNodeMaterial> | null
  seen: number
  dist: number
}

/**
 * River water surfaces for a world's noise rivers, streamed in camera-centred tiles.
 *
 * Each tile samples the world on a grid; wherever there is river water it builds a surface at the
 * river's level, extended a little so it tucks under the banks. The flow direction comes from the
 * slope of the river surface (with the across-channel part removed), and drives flow-mapped ripples
 * and foam that move downstream. Tiles build within a per-frame time budget, nearest first; most
 * tiles are rejected after a 3×3 probe, and only cells near water are sampled at full resolution. On planets, tiles live in a local frame that is
 * re-centred on the camera every `reframeDistance`.
 *
 * @example
 * ```ts
 * const rivers = await Rivers.create({ camera, scene, renderer, world, maxDistance: 2000 })
 * ```
 */
export class Rivers {
  /** Root of all river tiles (placed in the current frame). */
  readonly object = new Group()
  /** Shader uniforms (for advanced tweaks). */
  readonly uniforms: WaterUniforms = createWaterUniforms()
  /** Live counters, refreshed by {@link Rivers.update}. */
  readonly stats: RiversStats = { tiles: 0, meshes: 0, triangles: 0, pending: 0 }
  /** Camera the tiles follow. */
  camera: Camera
  /** The world. */
  world: World
  /** Resolved settings. Change them with {@link Rivers.set} / {@link Rivers.reset}. */
  settings!: RiversSettings
  /** Seconds of flow time. */
  time = 0
  /** The frame tiles are built in (the world itself on flat worlds). */
  frame: LocalFrame

  private input: RiversInput = {}
  private material: MeshBasicNodeMaterial | null = null
  private environment: unknown = undefined
  private layoutKey = ''
  private frameId = 0
  private frameVersion = -1
  private sphere = false
  private latLon: [number, number] | null = null
  private tiles = new Map<string, Tile>()
  private job: { tile: Tile; key: string; steps: Generator<void, BufferGeometry | null> } | null = null
  private retired: { geometry: BufferGeometry; frame: number }[] = []
  private frameCount = 0
  private clock = new Clock()
  private sunCache = { light: null, searched: false } as Parameters<typeof updateSun>[3]
  private unhook = () => {}

  /** Creates rivers and builds the tiles nearest the camera so the first frame has water. */
  static async create(options: RiversOptions): Promise<Rivers> {
    await prepareRenderer(options.renderer, 'Rivers')
    const rivers = new Rivers(options)
    rivers.update(0, 250)
    return rivers
  }

  /** Prefer {@link Rivers.create}. */
  constructor({ camera, world, scene, renderer: _renderer, ...input }: RiversOptions) {
    this.camera = camera
    this.world = world
    this.frame = world.frame
    this.object.name = 'Rivers'
    this.object.matrixAutoUpdate = false
    this.set(input)
    if (scene) {
      scene.add(this.object)
      this.unhook = hookScene(scene, () => this.update())
    }
  }

  /** Changes settings, merging into earlier ones. Look settings apply instantly; layout and flow settings rebuild tiles (old ones stay until replaced). */
  set(input: RiversInput): this {
    mergeInput(this.input, input)
    const s = mergeInput(structuredClone(DEFAULT_RIVERS), this.input) as RiversSettings
    this.settings = s
    applyAppearance(this.uniforms, s)
    this.uniforms.flowPeriod.value = Math.max(0.1, s.flowPeriod)
    this.uniforms.rapids.value = s.rapids
    this.layoutKey = JSON.stringify([s.tileSize, s.resolution, s.expand, s.surfaceOffset, s.minStrength, s.flowSpeed, s.minFlowSpeed, s.maxFlowSpeed])
    if (s.environment !== this.environment) {
      this.environment = s.environment
      this.material?.dispose()
      this.material = createWaterMaterial(this.uniforms, 'flow', s.environment)
      for (const t of this.tiles.values()) if (t.mesh) t.mesh.material = this.material
    }
    return this
  }

  /** Replaces all settings: anything not in `input` goes back to the defaults. */
  reset(input: RiversInput = {}): this {
    this.input = {}
    return this.set(input)
  }

  /** Moves the floating origin. Same as `set({ origin })`. */
  setOrigin(origin: readonly number[]): this {
    return this.set({ origin: [origin[0], origin[1], origin[2]] })
  }

  /**
   * Streams tiles around the camera, builds within the time budget and advances the flow. Called
   * automatically when a `scene` was given (and by `<Rivers>`); otherwise call it once per frame.
   * @param delta Seconds since the last frame; measured if omitted.
   * @param budget Milliseconds for tile building this frame. Defaults to `settings.buildBudget`.
   */
  update(delta: number = this.clock.tick(), budget: number = this.settings.buildBudget): void {
    const s = this.settings
    const frameNo = ++this.frameCount
    this.time += delta
    this.uniforms.time.value = this.time
    const [ox, oy, oz] = s.origin
    const cam = this.camera.getWorldPosition(_v)
    const px = cam.x + ox, py = cam.y + oy, pz = cam.z + oz

    // Frame: the world itself on flat worlds; a camera-centred tangent frame on planets.
    const sphere = this.world.options.surface === 'sphere'
    if (sphere !== this.sphere) {
      this.sphere = sphere
      this.setFrame(this.world.frame)
      this.latLon = null
    }
    if (!sphere) this.frame = this.world.frame // replaced on every world change; same axes
    else if (!this.latLon || Math.hypot(...pick(worldToFrame(this.frame, px, py, pz, _l))) > s.reframeDistance) {
      const len = Math.hypot(px, py, pz) || 1
      this.latLon = [(Math.asin(py / len) * 180) / Math.PI, (Math.atan2(px, pz) * 180) / Math.PI]
      this.setFrame(this.world.frameAt(...this.latLon))
    } else if (this.frameVersion !== this.world.version) {
      this.frame = this.world.frameAt(...this.latLon) // e.g. a new radius; tiles rebuild in place
    }
    this.frameVersion = this.world.version
    placeInFrame(this.object, this.frame, s.origin)
    const [cx, cy, cz] = worldToFrame(this.frame, px, py, pz, _l)

    // Tiles in range.
    const ts = s.tileSize
    const key = `${this.layoutKey}|${this.world.version}|${this.frameId}`
    const pending: Tile[] = []
    if (Math.abs(cy) < s.maxDistance) {
      const r = Math.ceil(s.maxDistance / ts)
      const ci = Math.floor(cx / ts), cj = Math.floor(cz / ts)
      for (let i = ci - r; i <= ci + r; i++) {
        for (let j = cj - r; j <= cj + r; j++) {
          const dx = Math.max(i * ts - cx, 0, cx - (i + 1) * ts)
          const dz = Math.max(j * ts - cz, 0, cz - (j + 1) * ts)
          const dist = Math.hypot(dx, dz)
          if (dist >= s.maxDistance) continue
          const id = `${i},${j}`
          let tile = this.tiles.get(id)
          if (!tile) this.tiles.set(id, (tile = { ix: i, iz: j, built: '', mesh: null, seen: 0, dist: 0 }))
          tile.seen = frameNo
          tile.dist = dist
          if (tile.built !== key) pending.push(tile)
        }
      }
    }
    for (const [id, tile] of this.tiles) {
      if (tile.seen === frameNo) continue
      this.removeMesh(tile)
      this.tiles.delete(id)
      if (this.job?.tile === tile) this.job = null
    }
    while (this.retired.length && frameNo - this.retired[0].frame > 60) this.retired.shift()!.geometry.dispose()

    // Build nearest first, resuming the tile in progress, until the budget is spent.
    pending.sort((a, b) => a.dist - b.dist)
    const start = performance.now()
    let next = 0
    while (performance.now() - start < budget) {
      if (!this.job || this.job.key !== key) {
        let tile = pending[next++]
        while (tile && tile.built === key) tile = pending[next++]
        if (!tile) break
        this.job = { tile, key, steps: this.buildTile(tile) }
      }
      const step = this.job.steps.next()
      if (step.done) {
        this.finish(this.job.tile, step.value)
        this.job.tile.built = key
        this.job = null
      }
    }

    updateSun(this.uniforms, s.sun, this.object, this.sunCache)
    let meshes = 0, triangles = 0
    for (const t of this.tiles.values()) if (t.mesh) { meshes++; triangles += (t.mesh.geometry.index?.count ?? 0) / 3 }
    this.stats.tiles = this.tiles.size
    this.stats.meshes = meshes
    this.stats.triangles = triangles
    this.stats.pending = pending.filter((t) => t.built !== key).length
  }

  private setFrame(frame: LocalFrame) {
    this.frame = frame
    this.frameId++
    for (const t of this.tiles.values()) this.removeMesh(t)
    this.tiles.clear()
    this.job = null
  }

  /**
   * Builds one tile's water mesh, yielding often so the budget is respected. World samples are
   * costly, so it refines in passes: a 3×3 valley probe (river valleys are far wider than its
   * spacing), a coarse grid every 4 cells, then full resolution only in coarse cells next to water.
   */
  private *buildTile(tile: Tile): Generator<void, BufferGeometry | null> {
    const s = this.settings
    const frame = this.frame
    const ts = s.tileSize
    const res = Math.max(2, Math.floor(s.resolution))
    const cs = ts / res
    const x0 = tile.ix * ts, z0 = tile.iz * ts
    const sample = this.scratch

    let valley = false
    for (let k = 0; k < 9 && !valley; k++) {
      const v = frame.sample(x0 + ((k % 3) / 2) * ts, z0 + (Math.floor(k / 3) / 2) * ts, sample, ts / 4)
      valley = v.valley > 0 || v.river > 0
    }
    if (!valley) return null
    yield

    const n = res + 1
    const level = new Float32Array(n * n).fill(NaN)
    const strength = new Float32Array(n * n)
    const done = new Uint8Array(n * n)
    let wet = 0
    const visit = (a: number, b: number) => {
      const i = b * n + a
      if (done[i]) return !Number.isNaN(level[i]) || strength[i] > 0
      done[i] = 1
      const v = frame.sample(x0 + a * cs, z0 + b * cs, sample, cs * 2)
      strength[i] = v.river
      if (v.river >= s.minStrength && !Number.isNaN(v.waterLevel)) {
        level[i] = v.waterLevel + s.surfaceOffset
        wet++
      }
      return v.river > 0
    }

    const step = 4
    const m = Math.ceil(res / step) + 1 // coarse nodes per side
    const node = (k: number) => Math.min(res, k * step)
    const coarse = new Uint8Array(m * m)
    for (let b = 0; b < m; b++) {
      for (let a = 0; a < m; a++) coarse[b * m + a] = visit(node(a), node(b)) ? 1 : 0
      yield
    }
    for (let cb = 0; cb < m - 1; cb++) {
      for (let ca = 0; ca < m - 1; ca++) {
        let near = false
        for (let db = -1; db <= 2 && !near; db++) for (let da = -1; da <= 2; da++) {
          const a = ca + da, b = cb + db
          if (a >= 0 && b >= 0 && a < m && b < m && coarse[b * m + a]) { near = true; break }
        }
        if (!near) continue
        for (let b = node(cb); b <= node(cb + 1); b++) for (let a = node(ca); a <= node(ca + 1); a++) visit(a, b)
      }
      yield
    }
    if (!wet) return null
    dilate(level, n, s.expand)
    return buildSurface(level, strength, n, cs, x0, z0, s)
  }

  private finish(tile: Tile, geometry: BufferGeometry | null) {
    this.removeMesh(tile)
    if (!geometry) return
    const mesh = new Mesh(geometry, this.material!)
    mesh.name = `River tile ${tile.ix},${tile.iz}`
    mesh.position.set(tile.ix * this.settings.tileSize, geometry.userData.y as number, tile.iz * this.settings.tileSize)
    mesh.updateMatrix()
    mesh.matrixAutoUpdate = false
    this.object.add(mesh)
    tile.mesh = mesh
  }

  /** Detaches a tile's mesh; its geometry is freed a while later (WebGPU may still be building a pipeline that reads it). */
  private removeMesh(tile: Tile) {
    if (!tile.mesh) return
    tile.mesh.removeFromParent()
    this.retired.push({ geometry: tile.mesh.geometry, frame: this.frameCount })
    tile.mesh = null
  }

  private scratch: WorldSample = createSample(8)

  /** Removes the rivers from the scene and frees their GPU resources. */
  dispose(): void {
    this.unhook()
    for (const t of this.tiles.values()) if (t.mesh) t.mesh.geometry.dispose()
    this.tiles.clear()
    for (const r of this.retired) r.geometry.dispose()
    this.retired = []
    this.material?.dispose()
    this.object.removeFromParent()
  }
}

/** Grows the wet area by `steps` cells; new cells take the mean level of their wet neighbours. */
function dilate(level: Float32Array, n: number, steps: number) {
  for (let k = 0; k < steps; k++) {
    const prev = level.slice()
    for (let b = 0; b < n; b++) {
      for (let a = 0; a < n; a++) {
        const i = b * n + a
        if (!Number.isNaN(prev[i])) continue
        let sum = 0, count = 0
        for (let db = -1; db <= 1; db++) {
          for (let da = -1; da <= 1; da++) {
            const aa = a + da, bb = b + db
            if (aa < 0 || bb < 0 || aa >= n || bb >= n) continue
            const v = prev[bb * n + aa]
            if (!Number.isNaN(v)) { sum += v; count++ }
          }
        }
        if (count) level[i] = sum / count
      }
    }
  }
}

/** Triangulates every grid cell whose four corners have water, with per-vertex flow. */
function buildSurface(level: Float32Array, strength: Float32Array, n: number, cs: number, x0: number, z0: number, flow: RiverFlowOptions): BufferGeometry | null {
  const index = new Int32Array(n * n).fill(-1)
  let y = 0, count = 0
  for (let i = 0; i < level.length; i++) if (!Number.isNaN(level[i])) { y += level[i]; count++ }
  y /= count || 1
  const pos: number[] = [], flows: number[] = [], local: number[] = []
  const at = (a: number, b: number) => {
    const i = b * n + a
    if (index[i] >= 0) return index[i]
    const l = level[i]
    // Central differences where both neighbours are wet, one-sided otherwise.
    const g = (da: number, db: number, f: Float32Array) => {
      const a1 = a + da, b1 = b + db, a0 = a - da, b0 = b - db
      const ok1 = a1 < n && b1 < n && !Number.isNaN(f[b1 * n + a1])
      const ok0 = a0 >= 0 && b0 >= 0 && !Number.isNaN(f[b0 * n + a0])
      const span = (Number(ok1) + Number(ok0)) * cs
      return span ? ((ok1 ? f[b1 * n + a1] : f[i]) - (ok0 ? f[b0 * n + a0] : f[i])) / span : 0
    }
    const [fx, fz] = riverFlow(g(1, 0, level), g(0, 1, level), g(1, 0, strength), g(0, 1, strength), strength[i], flow)
    index[i] = pos.length / 3
    pos.push(a * cs, l - y, b * cs)
    flows.push(fx, fz)
    local.push(x0 + a * cs, z0 + b * cs)
    return index[i]
  }
  const tris: number[] = []
  for (let b = 0; b < n - 1; b++) {
    for (let a = 0; a < n - 1; a++) {
      const i = b * n + a
      if (Number.isNaN(level[i]) || Number.isNaN(level[i + 1]) || Number.isNaN(level[i + n]) || Number.isNaN(level[i + n + 1])) continue
      const p00 = at(a, b), p10 = at(a + 1, b), p01 = at(a, b + 1), p11 = at(a + 1, b + 1)
      tris.push(p00, p01, p10, p10, p01, p11)
    }
  }
  if (!tris.length) return null
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3))
  geometry.setAttribute('aFlow', new Float32BufferAttribute(flows, 2))
  geometry.setAttribute('aLocal', new Float32BufferAttribute(local, 2))
  geometry.setIndex(tris)
  geometry.computeBoundingSphere()
  geometry.userData.y = y
  return geometry
}

/**
 * Surface velocity (m/s, x and z) of a river from the gradients of its water level and of the
 * channel strength: downhill along the level, with the across-channel part removed (water runs
 * along the channel), at `flowSpeed·√(slope / 1%)`, faster mid-channel.
 */
export function riverFlow(levelDx: number, levelDz: number, riverDx: number, riverDz: number, strength: number, o: RiverFlowOptions): [number, number] {
  let fx = -levelDx, fz = -levelDz
  const g = Math.hypot(riverDx, riverDz)
  if (g > 1e-9) {
    const nx = riverDx / g, nz = riverDz / g
    const d = fx * nx + fz * nz
    fx -= d * nx; fz -= d * nz
  }
  const slope = Math.hypot(fx, fz)
  if (slope < 1e-9) return [0, 0]
  const speed = Math.min(o.maxFlowSpeed, Math.max(o.minFlowSpeed, o.flowSpeed * Math.sqrt(slope / 0.01))) * (0.6 + 0.4 * Math.min(1, strength))
  return [(fx / slope) * speed, (fz / slope) * speed]
}

/** Anything that samples a world at local (x, z): a `World` (its main frame) or a `LocalFrame`. */
export interface WaterSource {
  /** Samples the world at local (x, z). */
  sample(x: number, z: number, out?: WorldSample): WorldSample
}

const _s = createSample(8)
const _n = createSample(8)
/**
 * Water at local (x, z) of a world or frame: sea or river level, depth and (for rivers) surface flow
 * velocity — for gameplay, buoyancy and particles. Waves are not included (see `Ocean.waterAt`).
 */
export function waterAt(source: WaterSource, x: number, z: number, out: WaterSample = createWaterSample(), flow: Partial<RiverFlowOptions> = {}): WaterSample {
  const o = { ...DEFAULT_RIVERS, ...flow }
  const s = source.sample(x, z, _s)
  out.flowX = 0; out.flowZ = 0
  if (Number.isNaN(s.waterLevel)) {
    out.kind = 'none'; out.level = NaN; out.depth = 0
    return out
  }
  const level = s.waterLevel, river = s.river
  out.level = level
  out.depth = Math.max(0, level - s.elevation)
  if (river < o.minStrength) {
    out.kind = 'sea'
    return out
  }
  out.kind = 'river'
  const e = 1
  const probe = (px: number, pz: number) => {
    const n = source.sample(px, pz, _n)
    return [Number.isNaN(n.waterLevel) ? level : n.waterLevel, n.river]
  }
  const [lx1, rx1] = probe(x + e, z), [lx0, rx0] = probe(x - e, z)
  const [lz1, rz1] = probe(x, z + e), [lz0, rz0] = probe(x, z - e)
  const [fx, fz] = riverFlow((lx1 - lx0) / (2 * e), (lz1 - lz0) / (2 * e), (rx1 - rx0) / (2 * e), (rz1 - rz0) / (2 * e), river, o)
  out.flowX = fx; out.flowZ = fz
  return out
}

const _v = new Vector3()
const _l: [number, number, number] = [0, 0, 0]
const pick = (p: [number, number, number]): [number, number] => [p[0], p[2]]
