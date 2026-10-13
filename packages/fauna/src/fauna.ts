import { Group, type Camera, type Object3D } from 'three/webgpu'
import type { World } from 'threejs-biomes'
import { BirdFlocks, type BirdFlocksInput } from './birds.ts'
import { Clock, hookScene, prepareRenderer, type FaunaRenderer, type MaterialStates, type Predator } from './common.ts'
import { FishSchools, type FishSchoolsInput } from './fish.ts'
import type { FaunaLayer, FaunaLayerOptions, FaunaLayerSettings } from './layer.ts'

/** Creates a fauna layer from shared options plus that kind's own settings. */
export type FaunaKindFactory = (options: FaunaLayerOptions & Record<string, unknown>) => FaunaLayer<unknown, FaunaLayerSettings>

/**
 * The registry of animal kinds {@link Fauna} manages, by name. Add a kind (e.g. land herds built on
 * `FaunaLayer`) by adding a factory here; its settings are then read from `Fauna`'s input under that name.
 */
export const FAUNA_KINDS: Record<string, FaunaKindFactory> = {
  fish: (o) => new FishSchools(o) as unknown as FaunaLayer<unknown, FaunaLayerSettings>,
  birds: (o) => new BirdFlocks(o) as unknown as FaunaLayer<unknown, FaunaLayerSettings>,
}

/** Settings of {@link Fauna}: shared ones, then one entry per kind (its settings, or `false` to turn it off). */
export interface FaunaInput {
  /** Seed for every kind. */
  seed?: number | string
  /** Floating origin for every kind. */
  origin?: [number, number, number]
  /** Material states for every kind. */
  states?: Partial<MaterialStates>
  /** Objects every kind flees from (not JSON). */
  predators?: Predator[]
  /** Fish schools, or `false` for none. */
  fish?: FishSchoolsInput | false
  /** Bird flocks, or `false` for none. */
  birds?: BirdFlocksInput | false
  /** Settings of kinds added to {@link FAUNA_KINDS}. */
  [kind: string]: unknown
}

/** Options for {@link Fauna.create}. */
export interface FaunaOptions extends FaunaInput {
  /** Camera everything streams around. */
  camera: Camera
  /** The world that decides where animals live. */
  world: World
  /** If given, fauna is added to it and updates whenever it renders. */
  scene?: Object3D
  /** A WebGPURenderer; initialised if needed. */
  renderer?: FaunaRenderer
}

const SHARED = ['seed', 'origin', 'states', 'predators'] as const

/**
 * All the animals of a world in one object: every kind in {@link FAUNA_KINDS} (fish schools and bird
 * flocks built in), sharing a seed, floating origin, material states and predators.
 *
 * @example
 * ```ts
 * const fauna = await Fauna.create({ camera, scene, renderer, world, seed: 7, birds: { density: 8 } })
 * fauna.set({ fish: false })          // no fish
 * fauna.layers.birds?.stats.animals   // live counters per kind
 * ```
 */
export class Fauna {
  /** Root of every kind's object. */
  readonly object = new Group()
  /** The active layers, by kind name. */
  readonly layers: Record<string, FaunaLayer<unknown, FaunaLayerSettings> | undefined> = {}
  /** Camera everything streams around. */
  camera: Camera
  /** The world. */
  world: World

  private input: FaunaInput = {}
  private clock = new Clock()
  private unhook = () => {}

  /** Creates every enabled kind and spawns the nearest groups. */
  static async create(options: FaunaOptions): Promise<Fauna> {
    await prepareRenderer(options.renderer, 'Fauna')
    const f = new Fauna(options)
    f.update(0)
    return f
  }

  /** Prefer {@link Fauna.create}. */
  constructor({ camera, world, scene, renderer: _renderer, ...input }: FaunaOptions) {
    this.camera = camera
    this.world = world
    this.object.name = 'Fauna'
    this.reset(input)
    if (scene) {
      scene.add(this.object)
      this.unhook = hookScene(scene, () => this.update())
    }
  }

  /** Changes settings, merging into earlier ones. A kind set to `false` is removed; set it to `{}` to bring it back. */
  set(input: FaunaInput): this {
    for (const [k, v] of Object.entries(input)) if (v !== undefined) this.input[k] = v
    return this.apply(false, input)
  }

  /** Replaces all settings (every kind back to its defaults, all enabled unless set to `false`). */
  reset(input: FaunaInput = {}): this {
    this.input = { ...input }
    return this.apply(true, input)
  }

  private apply(reset: boolean, changed: FaunaInput): this {
    const shared: Record<string, unknown> = {}
    for (const k of SHARED) if (this.input[k] !== undefined) shared[k] = this.input[k]
    const sharedChanged = SHARED.some((k) => changed[k] !== undefined)
    for (const [kind, factory] of Object.entries(FAUNA_KINDS)) {
      const own = this.input[kind]
      let layer = this.layers[kind]
      if (own === false) {
        layer?.dispose()
        this.layers[kind] = undefined
        continue
      }
      const settings = { ...shared, ...(own as object | undefined) }
      if (!layer) {
        layer = this.layers[kind] = factory({ camera: this.camera, world: this.world, ...settings })
        this.object.add(layer.object)
      } else if (reset) layer.reset(settings)
      else if (sharedChanged || changed[kind] !== undefined) layer.set({ ...shared, ...(changed[kind] as object | undefined) })
    }
    return this
  }

  /** Updates every kind. Called automatically when a `scene` was given (and by `<Fauna>`). */
  update(delta: number = this.clock.tick()): void {
    for (const layer of Object.values(this.layers)) {
      if (!layer) continue
      layer.camera = this.camera
      layer.world = this.world
      layer.update(delta)
    }
  }

  /** Removes everything and frees GPU resources. */
  dispose(): void {
    this.unhook()
    for (const layer of Object.values(this.layers)) layer?.dispose()
    this.object.removeFromParent()
  }
}
