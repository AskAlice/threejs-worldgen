import { BufferGeometry, Float32BufferAttribute, Group, Mesh, type Camera, type MeshBasicNodeMaterial, type Object3D, type PerspectiveCamera } from 'three/webgpu'
import type { LocalFrame } from 'threejs-biomes'
import { Clock, hookScene, mergeInput, placeInFrame, prepareRenderer, type WaterRenderer } from './common.ts'
import type { HydrologyResult } from './hydrology.ts'
import { DEFAULT_APPEARANCE, applyAppearance, applyWaves, createWaterMaterial, createWaterUniforms, setWavePhases, updateSun, type WaterAppearance, type WaterUniforms } from './material.ts'
import type { RiverFlowOptions } from './rivers.ts'
import { MAX_WAVES, createWaves, type Wave, type WaveOptions } from './waves.ts'

/** Every setting of {@link Lakes}. All optional on input; see {@link LakesInput}. */
export interface LakesSettings extends WaterAppearance, Omit<RiverFlowOptions, 'minStrength'> {
  /** World position that is (0, 0, 0) in render space (floating origin). */
  origin: [x: number, y: number, z: number]
  /** Wind ripples on the lakes (small Gerstner waves). */
  waves: WaveOptions
  /** 0 … 1 foam on the sharpest crests. */
  whitecaps: number
  /** Cells each lake surface extends past its shore, so it tucks under the banks. */
  expand: number
  /** Also draw the hydrology rivers (as ribbons along their polylines, at their water surface). */
  rivers: boolean
  /** Seconds per flow-map cycle on the rivers. */
  flowPeriod: number
  /** Flow speed (m/s) where river rapids start foaming. */
  rapids: number
}

/** Partial settings accepted by {@link Lakes.create}, {@link Lakes.set} and `<Lakes>`. `waves` merges field by field. */
export type LakesInput = Partial<Omit<LakesSettings, 'waves'>> & {
  /** Wave settings to change. */
  waves?: Partial<WaveOptions>
}

/** Options for {@link Lakes.create}. */
export interface LakesOptions extends LakesInput {
  /** Lakes and rivers to draw, from `analyzeHydrology` / `computeHydrology`. */
  hydrology: HydrologyResult
  /** Frame the hydrology was sampled in (e.g. `world.frame`); omit for a flat world in world coordinates. */
  frame?: LocalFrame | null
  /** Camera, for the per-pixel detail fade (its field of view). Optional. */
  camera?: Camera | null
  /** If given, lakes are added to it and update whenever it renders. */
  scene?: Object3D
  /** A WebGPURenderer; initialised if needed. */
  renderer?: WaterRenderer
}

/** Default lakes: calm, slightly green fresh water with light wind ripples. */
export const DEFAULT_LAKES: LakesSettings = {
  ...DEFAULT_APPEARANCE,
  shallowColor: '#a3d2c4',
  deepColor: '#123a3f',
  visibility: 4,
  foamWidth: 0.2,
  detail: 0.3,
  detailScale: 0.8,
  origin: [0, 0, 0],
  waves: { count: 6, seed: 7, amplitude: 0.03, wavelength: [0.3, 3], direction: [1, 0.35], spread: 0.7, choppiness: 0.4, speed: 1 },
  whitecaps: 0,
  expand: 1,
  rivers: true,
  flowPeriod: 2,
  rapids: 2.5,
  flowSpeed: 1,
  minFlowSpeed: 0.15,
  maxFlowSpeed: 4,
}

/**
 * Draws the lakes (and optionally rivers) of a bounded-map hydrology result: each lake is a flat
 * water surface at its spill level using the ocean's wave shading, extended under its shore; rivers
 * are ribbons along their polylines with flow-mapped water moving downstream. Carve the rivers into
 * the world first (`riverModifiers`), or their surfaces sit on the unchanged ground.
 *
 * @example
 * ```ts
 * const hydrology = computeHydrology(world.height, { x: -2000, z: -2000, width: 4000, depth: 4000, cellSize: 8 }, { seaLevel: 0 })
 * for (const m of riverModifiers(hydrology, world.frame)) world.addModifier(m)
 * const lakes = await Lakes.create({ hydrology, frame: world.frame, scene, camera })
 * ```
 */
export class Lakes {
  /** Root object: lake and river meshes in the hydrology's frame. */
  readonly object = new Group()
  /** Uniforms of the lake (wave) material. */
  readonly uniforms: WaterUniforms = createWaterUniforms()
  /** Uniforms of the river (flow) material. */
  readonly riverUniforms: WaterUniforms = createWaterUniforms()
  /** The hydrology being drawn. Swap it with {@link Lakes.setHydrology}. */
  hydrology: HydrologyResult
  /** Frame the hydrology lives in, or `null` for world coordinates on a flat world. */
  frame: LocalFrame | null
  /** Camera for the detail fade, if any. */
  camera: Camera | null
  /** Resolved settings. */
  settings!: LakesSettings
  /** Seconds of wave and flow time. */
  time = 0

  private input: LakesInput = {}
  private waves: Wave[] = []
  private waveKey = ''
  private meshKey = ''
  private environment: unknown = undefined
  private lakeMesh: Mesh<BufferGeometry, MeshBasicNodeMaterial> | null = null
  private riverMesh: Mesh<BufferGeometry, MeshBasicNodeMaterial> | null = null
  private lakeMaterial: MeshBasicNodeMaterial | null = null
  private riverMaterial: MeshBasicNodeMaterial | null = null
  private phases = new Float64Array(MAX_WAVES)
  private clock = new Clock()
  private sunCache = { light: null, searched: false } as Parameters<typeof updateSun>[3]
  private unhook = () => {}

  /** Creates the lake and river meshes. */
  static async create(options: LakesOptions): Promise<Lakes> {
    await prepareRenderer(options.renderer, 'Lakes')
    const lakes = new Lakes(options)
    lakes.update(0)
    return lakes
  }

  /** Prefer {@link Lakes.create}. */
  constructor({ hydrology, frame = null, camera = null, scene, renderer: _renderer, ...input }: LakesOptions) {
    this.hydrology = hydrology
    this.frame = frame
    this.camera = camera
    this.object.name = 'Lakes'
    this.object.matrixAutoUpdate = false
    this.set(input)
    if (scene) {
      scene.add(this.object)
      this.unhook = hookScene(scene, () => this.update())
    }
  }

  /** Changes settings, merging into earlier ones. `expand`, `rivers` and flow speeds rebuild the meshes. */
  set(input: LakesInput): this {
    mergeInput(this.input, input)
    const s = mergeInput(structuredClone(DEFAULT_LAKES), this.input) as LakesSettings
    this.settings = s
    for (const u of [this.uniforms, this.riverUniforms]) {
      applyAppearance(u, s)
      u.flowPeriod.value = Math.max(0.1, s.flowPeriod)
      u.rapids.value = s.rapids
    }
    this.uniforms.whitecaps.value = s.whitecaps
    this.uniforms.gridMinSpacing.value = this.hydrology.grid.cellSize
    const waveKey = JSON.stringify(s.waves)
    if (waveKey !== this.waveKey) {
      this.waveKey = waveKey
      this.waves = createWaves(s.waves)
      applyWaves(this.uniforms, this.waves, s.waves.direction[0], s.waves.direction[1])
      applyWaves(this.riverUniforms, [], s.waves.direction[0], s.waves.direction[1])
    }
    if (s.environment !== this.environment) {
      this.environment = s.environment
      this.lakeMaterial?.dispose()
      this.riverMaterial?.dispose()
      this.lakeMaterial = createWaterMaterial(this.uniforms, 'waves', s.environment)
      this.riverMaterial = createWaterMaterial(this.riverUniforms, 'flow', s.environment)
      if (this.lakeMesh) this.lakeMesh.material = this.lakeMaterial
      if (this.riverMesh) this.riverMesh.material = this.riverMaterial
    }
    const meshKey = JSON.stringify([s.expand, s.rivers, s.flowSpeed, s.minFlowSpeed, s.maxFlowSpeed])
    if (meshKey !== this.meshKey) {
      this.meshKey = meshKey
      this.rebuild()
    }
    return this
  }

  /** Replaces all settings: anything not in `input` goes back to the defaults. */
  reset(input: LakesInput = {}): this {
    this.input = {}
    return this.set(input)
  }

  /** Moves the floating origin. Same as `set({ origin })`. */
  setOrigin(origin: readonly number[]): this {
    return this.set({ origin: [origin[0], origin[1], origin[2]] })
  }

  /** Draws a different hydrology result (e.g. after re-running the analysis), optionally in another frame. */
  setHydrology(hydrology: HydrologyResult, frame: LocalFrame | null = this.frame): void {
    this.hydrology = hydrology
    this.frame = frame
    this.uniforms.gridMinSpacing.value = hydrology.grid.cellSize
    this.rebuild()
  }

  /** Advances waves and flow, places the meshes and reads the sun. Called automatically with a `scene` (and by `<Lakes>`). */
  update(delta: number = this.clock.tick()): void {
    const s = this.settings
    this.time += delta
    const { x0, z0 } = this.hydrology.grid
    for (const u of [this.uniforms, this.riverUniforms]) {
      u.time.value = this.time
      const cam = this.camera as PerspectiveCamera | null
      u.tanHalfFov.value = cam?.isPerspectiveCamera ? Math.tan((cam.fov * Math.PI) / 360) / (cam.zoom || 1) : 0.4
      updateSun(u, s.sun, this.object, this.sunCache)
    }
    // Lake geometry is relative to the grid origin; phases carry the rest in float64.
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i]
      const a = w.k * (w.dirX * x0 + w.dirZ * z0) - w.omega * this.time
      this.phases[i] = a - Math.PI * 2 * Math.round(a / (Math.PI * 2))
    }
    setWavePhases(this.uniforms, this.phases)
    if (this.frame) placeInFrame(this.object, this.frame, s.origin)
    else {
      this.object.position.set(-s.origin[0], -s.origin[1], -s.origin[2])
      this.object.quaternion.identity()
      this.object.updateMatrix()
    }
  }

  private rebuild() {
    for (const m of [this.lakeMesh, this.riverMesh]) if (m) { m.removeFromParent(); m.geometry.dispose() }
    this.lakeMesh = this.riverMesh = null
    const { x0, z0 } = this.hydrology.grid
    const lakes = buildLakeGeometry(this.hydrology, this.settings.expand)
    if (lakes) {
      this.lakeMesh = new Mesh(lakes, this.lakeMaterial!)
      this.lakeMesh.name = 'Lakes'
    }
    const rivers = this.settings.rivers ? buildRiverGeometry(this.hydrology, this.settings) : null
    if (rivers) {
      this.riverMesh = new Mesh(rivers, this.riverMaterial!)
      this.riverMesh.name = 'Hydrology rivers'
    }
    for (const m of [this.lakeMesh, this.riverMesh]) {
      if (!m) continue
      m.position.set(x0, 0, z0)
      m.updateMatrix()
      m.matrixAutoUpdate = false
      m.frustumCulled = false // waves move vertices in the shader
      this.object.add(m)
    }
  }

  /** Removes the meshes from the scene and frees their GPU resources. */
  dispose(): void {
    this.unhook()
    for (const m of [this.lakeMesh, this.riverMesh]) m?.geometry.dispose()
    this.lakeMaterial?.dispose()
    this.riverMaterial?.dispose()
    this.object.removeFromParent()
  }
}

/** One mesh for all lakes: a quad per lake cell (shore dilated by `expand` cells), at the lake level, relative to the grid origin. */
function buildLakeGeometry(h: HydrologyResult, expand: number): BufferGeometry | null {
  const { cols, rows, cellSize: cs } = h.grid
  const pos: number[] = []
  const index: number[] = []
  const e = Math.max(0, Math.floor(expand))
  for (const lake of h.lakes) {
    const [c0, r0, bw, bh] = lake.bounds
    // Dilated mask over the box grown by `e`.
    const w = bw + 2 * e, hgt = bh + 2 * e
    const mask = new Uint8Array(w * hgt)
    for (let r = 0; r < bh; r++) for (let c = 0; c < bw; c++) mask[(r + e) * w + c + e] = lake.mask[r * bw + c]
    for (let k = 0; k < e; k++) {
      const prev = mask.slice()
      for (let r = 0; r < hgt; r++) for (let c = 0; c < w; c++) {
        if (prev[r * w + c]) continue
        for (let dr = -1; dr <= 1 && !mask[r * w + c]; dr++) for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc
          if (rr >= 0 && cc >= 0 && rr < hgt && cc < w && prev[rr * w + cc]) { mask[r * w + c] = 1; break }
        }
      }
    }
    // Shared corner vertices.
    const corner = new Int32Array((w + 1) * (hgt + 1)).fill(-1)
    const vertex = (c: number, r: number) => {
      const k = r * (w + 1) + c
      if (corner[k] < 0) {
        corner[k] = pos.length / 3
        pos.push((c0 - e + c - 0.5) * cs, lake.level, (r0 - e + r - 0.5) * cs)
      }
      return corner[k]
    }
    for (let r = 0; r < hgt; r++) for (let c = 0; c < w; c++) {
      const gc = c0 - e + c, gr = r0 - e + r
      if (!mask[r * w + c] || gc < 0 || gr < 0 || gc >= cols || gr >= rows) continue
      const a = vertex(c, r), b = vertex(c + 1, r), d = vertex(c, r + 1), f = vertex(c + 1, r + 1)
      index.push(a, d, b, b, d, f)
    }
  }
  if (!index.length) return null
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setIndex(index)
  return g
}

/** One mesh for all rivers: a ribbon per polyline at its water surface, wide enough to reach under the carved banks. */
function buildRiverGeometry(h: HydrologyResult, o: LakesSettings): BufferGeometry | null {
  const { x0, z0, cellSize: cs } = h.grid
  const pos: number[] = [], flow: number[] = [], local: number[] = [], index: number[] = []
  for (const river of h.rivers) {
    const p = river.points
    const base = pos.length / 3
    for (let i = 0; i < p.length; i++) {
      const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)]
      let tx = b[0] - a[0], tz = b[1] - a[1]
      const len = Math.hypot(tx, tz) || 1
      tx /= len; tz /= len
      const halfChannel = river.width[i] / 2
      const half = halfChannel + Math.max(cs, halfChannel * h.options.bankFalloff) * 0.8
      // Speed from the surface slope along the river.
      const drop = river.surface[Math.max(0, i - 1)] - river.surface[Math.min(p.length - 1, i + 1)]
      const slope = Math.max(0, drop) / len
      const speed = Math.min(o.maxFlowSpeed, Math.max(o.minFlowSpeed, o.flowSpeed * Math.sqrt(slope / 0.01)))
      for (const side of [-1, 1]) {
        const x = p[i][0] - tz * half * side, z = p[i][1] + tx * half * side
        pos.push(x - x0, river.surface[i], z - z0)
        flow.push(tx * speed, tz * speed)
        local.push(x, z)
      }
      if (i > 0) {
        const k = base + (i - 1) * 2 // left, right of the previous point
        index.push(k, k + 1, k + 2, k + 1, k + 3, k + 2)
      }
    }
  }
  if (!index.length) return null
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('aFlow', new Float32BufferAttribute(flow, 2))
  g.setAttribute('aLocal', new Float32BufferAttribute(local, 2))
  g.setIndex(index)
  return g
}
