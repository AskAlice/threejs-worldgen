import {
  Group, Vector3,
  type Camera, type DirectionalLight, type MeshPhysicalNodeMaterial, type Node, type Object3D,
} from 'three/webgpu'
import { createGrassMaterial, createGrassUniforms, sampleGrassMap, type GrassMapSample, type GrassUniforms } from './material.ts'
import { createHeightSampler, type HeightFn, type Terrain } from 'threejs-heightfield'
import type { GrassMap } from './grass-map.ts'
import {
  layoutKey as computeLayoutKey, materialKey as computeMaterialKey, resolveSettings, writeSettings,
  type GrassInput, type GrassSettings, type ObjectRef, type WindOptions,
} from './grass-settings.ts'
import { TileGeometryStore } from './grass-geometry.ts'
import { TileStream } from './grass-tiles.ts'
import { Retirement } from './retirement.ts'
import { findSun, resolveTerrain, subscribeScene, writeInteractors, writeSun } from './grass-scene.ts'

export { createBillboardGeometry, createBladeGeometry } from './grass-geometry.ts'
export { findSun, resolveObject, writeInteractors, writeSun } from './grass-scene.ts'
export type { GrassInput, GrassLOD, GrassSettings, Interactor, ObjectRef, WindOptions } from './grass-settings.ts'

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
  /**
   * Mesh/group (or a ref to one) to grow on, a `(x, z) => y` function, or omit for flat ground.
   * A ref that is `null` at construction grows on flat ground and is adopted on the first update after it
   * mounts (and dropped again if it unmounts) — the same rule in the vanilla and React entry points.
   */
  terrain?: Terrain | ObjectRef<Object3D>
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
  /** The terrain as given (object, ref or function); a ref is re-resolved on every update. */
  private terrain: Terrain | ObjectRef<Object3D> | undefined
  private resolvedTerrain: Terrain | undefined
  private material: MeshPhysicalNodeMaterial | null = null
  private readonly retirement = new Retirement()
  private readonly geometry = new TileGeometryStore({
    settings: () => this.settings,
    material: () => this.material,
  }, this.retirement)
  private readonly stream = new TileStream({
    object: this.object,
    settings: () => this.settings,
    billboard: () => this.billboard,
    height: () => this.sampleHeight,
    densityAt: (dist) => this.densityAt(dist),
    material: () => this.material,
    geometry: this.geometry,
    retirement: this.retirement,
  })
  private layoutKey = ''
  private layoutTileSize = 0
  private layoutType = ''
  /** `settings.type` resolved once per apply; decides geometry, density, clumping and material. */
  private billboard = false
  private materialKey = ''
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
    this.terrain = terrain
    this.resolvedTerrain = resolveTerrain(terrain)
    this.sampleHeight = createHeightSampler(this.resolvedTerrain)
    this.object.name = 'Grass'
    this.set(input)
    if (scene) {
      scene.add(this.object)
      this.unhook = subscribeScene(scene, () => this.update())
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
      else Object.assign(this.input, { [k]: v })
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
    const s = resolveSettings(this.input)
    this.settings = s
    this.billboard = s.type === 'billboards'
    writeSettings(this.uniforms, s)

    const layoutKey = computeLayoutKey(s)
    if (layoutKey !== this.layoutKey) {
      const tileSizeChanged = this.layoutTileSize !== s.tileSize
      const typeChanged = this.layoutType !== s.type
      this.layoutKey = layoutKey
      this.layoutTileSize = s.tileSize
      this.layoutType = s.type
      if (tileSizeChanged) {
        // The new grid does not line up with the old one: keep the old tiles on screen until the
        // new grid covers their area, then retire them through the delayed-free path.
        if (typeChanged) this.stream.clear()
        else this.stream.retireForResize()
      } else {
        // Keep showing the old blades until each tile is rebuilt, instead of the field blinking out.
        this.stream.resetCells()
      }
    }

    // LOD distances/densities are uniform-driven, so they must not rebuild the material.
    const materialKey = computeMaterialKey(s)
    if (materialKey !== this.materialKey) {
      this.materialKey = materialKey
      if (this.material) {
        const material = this.material
        this.retirement.retire(() => material.dispose())
      }
      this.material = createGrassMaterial(this.uniforms, s.type)
    }
    this.stream.applySettings()
    return this
  }

  /** Swaps the terrain (mesh/group, ref to one, or height function) and regenerates all tiles. */
  setTerrain(terrain?: Terrain | ObjectRef<Object3D>): void {
    this.terrain = terrain
    this.adoptTerrain(resolveTerrain(terrain))
  }

  /**
   * Applies a resolved terrain. A ref that is `null` at construction resolves to flat ground and is picked up
   * here once it mounts (and dropped again if it unmounts); see {@link Grass.update}.
   */
  private adoptTerrain(terrain: Terrain | undefined): void {
    this.resolvedTerrain = terrain
    this.sampleHeight = createHeightSampler(terrain)
    this.stream.clear()
  }

  /**
   * Re-centres the tiles on the camera, streams tiles in/out and refreshes interactors and the sun.
   * Called automatically when a `scene` was given (and by the `<Grass>` component); otherwise call it once per frame.
   * @param budget Milliseconds allowed for tile (re)builds this frame. Defaults to `settings.buildBudget`.
   */
  update(budget: number = this.settings.buildBudget): void {
    const s = this.settings
    // A terrain ref's object mounts (or unmounts) without a render, so the frame loop is where it is adopted.
    // Both entry points share this rule: the React wrapper hands refs straight through.
    const terrain = resolveTerrain(this.terrain)
    if (terrain !== this.resolvedTerrain) this.adoptTerrain(terrain)
    this.retirement.beginFrame()
    const cam = this.camera.getWorldPosition(_cam)
    const { tiles, instances } = this.stream.update(cam, budget, s.castShadow, s.shadowDistance)

    this.uniforms.viewPosition.value.copy(cam)
    let sun = s.sun
    if (!sun && !this.sunSearched && this.object.parent) {
      this.sunSearched = true
      this.autoSun = findSun(this.object)
    }
    writeSun(this.uniforms, sun ?? this.autoSun)
    writeInteractors(this.uniforms, s.interactors)
    this.stats.tiles = tiles
    this.stats.instances = instances
  }

  /** Removes the grass from the scene and frees its GPU resources. */
  dispose(): void {
    this.unhook()
    this.stream.clear()
    if (this.material) {
      const material = this.material
      this.retirement.retire(() => material.dispose())
      this.material = null
    }
    this.geometry.dispose()
    this.object.removeFromParent()
    // No more update() calls will flush the retire list, so free it on a timer instead of at once:
    // in-flight pipelines may still reference these buffers.
    this.retirement.schedule()
  }

  /** Fraction (0..1) of full blade density at a distance from the camera — the CPU mirror of the shader's LOD curve. */
  densityAt(dist: number): number {
    const l = this.settings.lods
    const seg = (a: number, b: number) => Math.min(1, Math.max(0, (dist - a) / Math.max(b - a, 1e-3)))
    const mix = (a: number, b: number, t: number) => a + (b - a) * t
    return mix(mix(mix(l[0].density, l[1].density, seg(l[0].distance, l[1].distance)), l[2].density, seg(l[1].distance, l[2].distance)), l[3].density, seg(l[2].distance, l[3].distance))
  }

  /** The coverage/height map grass is painted through, or `null`. Shorthand for `settings.grassMap`. */
  get grassMap(): GrassMap | null {
    return this.settings.grassMap
  }

  /** Radius (metres) around the camera that has grass. Shorthand for `settings.maxDistance`. */
  get maxDistance(): number {
    return this.settings.maxDistance
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
}

const _cam = new Vector3()
