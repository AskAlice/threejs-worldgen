import { DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Sphere, type BufferGeometry, type Material, type Object3D } from 'three/webgpu'
import { mulberry32, seedOf } from 'threejs-biomes'
import { DEFAULT_BOIDS, type BoidParams } from './boids.ts'
import { Clock, DEFAULT_STATES, hookScene, mergeInput, prepareRenderer, toGeometry, type DeepPartial, type FaunaRenderer, type MaterialStates, type Predator } from './common.ts'
import { buildFishMesh, DEFAULT_FISH_DETAIL, type FishDetail, type FishMeshData } from './fish-geometry.ts'
import { applyFishSpecies, applyStates, createFishMaterial, createFishUniforms, type FishUniforms } from './fish-material.ts'
import { DEFAULT_WATER_RULES, FISH_SPECIES, fishClearance, fishHabitat, MAX_FISH_PITCH, type FishSpecies, type WaterRules } from './fish-species.ts'
import { DEFAULT_LAYER, FaunaLayer, type FaunaGroup, type FaunaLayerOptions, type FaunaLayerSettings } from './layer.ts'
import type { Habitat } from './placement.ts'

/** Every setting of {@link FishSchools}. */
export interface FishSchoolsSettings extends FaunaLayerSettings {
  /** Species that can spawn, by id (defaults to {@link FISH_SPECIES}). Set a species' `habitat.weight` to 0 to turn it off. */
  species: Record<string, FishSpecies>
  /** How river water is told from sea water. */
  water: WaterRules
  /** Extra clearance (metres) from the bed and the surface, on top of each fish's own size. */
  margin: number
  /** Mesh resolution. */
  detail: FishDetail
}

/** Partial settings for {@link FishSchools.create}, `set()` and `<FishSchools>`. New species must be complete. */
export type FishSchoolsInput = DeepPartial<Omit<FishSchoolsSettings, 'predators' | 'origin'>> & {
  /** Objects fish flee from (e.g. the camera, a diver, a shark). */
  predators?: Predator[]
  /** World position that is (0, 0, 0) in render space. */
  origin?: [number, number, number]
}

/** Options for {@link FishSchools.create}. */
export interface FishSchoolsOptions extends FishSchoolsInput, FaunaLayerOptions {}

/** Default {@link FishSchoolsSettings}. */
export const DEFAULT_FISH_SCHOOLS: FishSchoolsSettings = {
  ...DEFAULT_LAYER,
  species: structuredClone(FISH_SPECIES) as Record<string, FishSpecies>,
  water: { ...DEFAULT_WATER_RULES },
  margin: 0.15,
  detail: { ...DEFAULT_FISH_DETAIL },
}

/**
 * Fish schools streamed in tiles around the camera, wherever the world has water deep enough: species
 * chosen by water type (river vs sea), temperature and depth; each school a deterministic boids flock
 * that stays between the bed and the surface; swimming animated in the vertex shader.
 *
 * @example
 * ```ts
 * const fish = await FishSchools.create({ camera, scene, renderer, world, density: 200 })
 * fish.set({ species: { herring: { school: { size: [80, 160] } } } })
 * ```
 */
export class FishSchools extends FaunaLayer<FishSpecies, FishSchoolsSettings> {
  protected readonly salt = 0x5f15
  private readonly uniforms = new Map<string, FishUniforms>()
  private readonly meshes = new Map<string, FishMeshData>()

  /** Creates the schools and spawns the nearest tiles so the first frame has fish. */
  static async create(options: FishSchoolsOptions): Promise<FishSchools> {
    await prepareRenderer(options.renderer, 'FishSchools')
    const f = new FishSchools(options)
    f.update(0, 50)
    return f
  }

  /** Prefer {@link FishSchools.create}. */
  constructor({ camera, world, scene, renderer, ...input }: FishSchoolsOptions) {
    super({ camera, world, scene, renderer })
    this.object.name = 'FishSchools'
    this.set(input)
  }

  /** @inheritDoc */
  override set(input: FishSchoolsInput): this {
    return super.set(input)
  }

  /** @inheritDoc */
  override reset(input: FishSchoolsInput = {}): this {
    return super.reset(input)
  }

  protected defaults(): FishSchoolsSettings { return DEFAULT_FISH_SCHOOLS }
  protected species(): Readonly<Record<string, FishSpecies>> { return this.settings.species }
  protected habitat(): Habitat<FishSpecies> { return fishHabitat(this.settings.water, this.settings.margin) }
  protected placementOf(sp: FishSpecies): unknown {
    return [sp.habitat, sp.school, sp.length, sp.lengthVariation, sp.shape.depth, sp.shape.tail.height]
  }
  protected override layoutExtra(): unknown { return [this.settings.water, this.settings.margin] }
  protected maxPitch(): number { return MAX_FISH_PITCH }

  protected boidParams(sp: FishSpecies): BoidParams {
    const L = sp.length, spacing = sp.school.spacing * L, v = sp.school.speed * L
    return {
      ...DEFAULT_BOIDS,
      separationDistance: spacing, neighborRadius: spacing * 4, minDistance: spacing * 0.5,
      minSpeed: v * 0.3, maxSpeed: v * 2, maxAccel: v * 3,
      homeRadius: sp.school.roam, margin: fishClearance(sp, this.settings.margin),
    }
  }

  protected initMember(sp: FishSpecies, r: () => number, scale: Float32Array, look: Float32Array, i: number): void {
    const L = sp.length * (1 + (r() - 0.5) * 2 * sp.lengthVariation)
    const fat = 1 + (r() - 0.5) * 0.12
    scale.set([L * fat, L * fat, L], i * 3)
    look.set([(r() - 0.5) * 2 * sp.hueVariation, 1 + (r() - 0.5) * 0.24, r(), r()], i * 4)
  }

  protected animate(sp: FishSpecies, g: FaunaGroup, i: number, dt: number, speed: number, turnRate: number): number {
    const L = g.scale[i * 3 + 2]
    const bodyLengths = speed / L
    const m = g.motion
    m[i * 4] += Math.PI * 2 * Math.max(0.6, sp.swim.beat * bodyLengths) * dt
    m[i * 4 + 1] = Math.min(1.5, Math.max(0.4, 0.5 + (0.5 * bodyLengths) / Math.max(0.1, sp.school.speed)))
    m[i * 4 + 2] = Math.max(-0.25, Math.min(0.25, turnRate * 0.12))
    m[i * 4 + 3] += Math.PI * 2 * (1.5 + 2 * sp.swim.flutter) * dt
    return Math.max(-0.3, Math.min(0.3, -turnRate * 0.1))
  }

  protected geometryKey(sp: FishSpecies): string { return JSON.stringify([sp.shape, this.settings.detail]) }

  protected createGeometry(sp: FishSpecies): BufferGeometry { return toGeometry(this.meshData(sp)) }

  protected createMaterial(id: string): Material {
    const u = createFishUniforms()
    this.uniforms.set(id, u)
    return createFishMaterial(u)
  }

  protected applyLook(id: string, sp: FishSpecies): void {
    const u = this.uniforms.get(id)
    if (!u) return
    applyFishSpecies(u, sp, this.meshData(sp))
    applyStates(u, this.settings.states)
  }

  private meshData(sp: FishSpecies): FishMeshData {
    const key = this.geometryKey(sp)
    let data = this.meshes.get(key)
    if (!data) {
      if (this.meshes.size > 64) this.meshes.clear()
      this.meshes.set(key, (data = buildFishMesh(sp.shape, this.settings.detail)))
    }
    return data
  }
}

/** Every setting of a hero {@link Fish}. */
export interface FishSettings {
  /** Starting species (an id in {@link FISH_SPECIES}). */
  preset: string
  /** The species, resolved from `preset` plus your overrides. */
  species: FishSpecies
  /** Seed for this fish's size and colour variation. */
  seed: number | string
  /** Swimming speed in body lengths per second (drives the tail beat). */
  speed: number
  /** −1 … 1: how hard it is turning (bends the body). */
  turn: number
  /** Mesh resolution. */
  detail: FishDetail
  /** Material states. */
  states: MaterialStates
  /** Whether it casts shadows. */
  castShadow: boolean
  /** Whether it receives shadows. */
  receiveShadow: boolean
}

/** Partial settings for {@link Fish.create}, {@link Fish.set} and `<Fish>`. `species` overrides merge into the preset. */
export type FishInput = DeepPartial<Omit<FishSettings, 'preset'>> & {
  /** Starting species id. */
  preset?: string
}

/** Options for {@link Fish.create}. */
export interface FishOptions extends FishInput {
  /** If given, the fish is added to it and animates whenever it renders. */
  scene?: Object3D
  /** A WebGPURenderer; initialised if needed. */
  renderer?: FaunaRenderer
}

const FISH_DEFAULTS: Omit<FishSettings, 'species'> = { preset: 'trout', seed: 1, speed: 1, turn: 0, detail: { ...DEFAULT_FISH_DETAIL }, states: { ...DEFAULT_STATES }, castShadow: true, receiveShadow: true }

/**
 * One procedural fish (a hero asset or a gallery item): any {@link FishSpecies}, live-editable, swimming
 * in place. Move it by moving {@link Fish.object}; it faces +z and is `species.length` metres long.
 *
 * @example
 * ```ts
 * const fish = await Fish.create({ scene, renderer, preset: 'clownfish', seed: 3 })
 * fish.set({ species: { pattern: { stripes: { count: 4 } } }, speed: 2 })
 * ```
 */
export class Fish {
  /** Root object; position and rotate it. */
  readonly object = new Group()
  /** Shader uniforms. */
  readonly uniforms: FishUniforms = createFishUniforms()
  /** Resolved settings. */
  settings!: FishSettings
  /** Seconds of animation. */
  time = 0

  private input: FishInput = {}
  private readonly mesh: InstancedMesh
  private readonly material = createFishMaterial(this.uniforms)
  private geometryKey = ''
  private data: FishMeshData | null = null
  private phase = 0
  private finPhase = 0
  private clock = new Clock()
  private unhook = () => {}

  /** Creates a fish. */
  static async create(options: FishOptions = {}): Promise<Fish> {
    await prepareRenderer(options.renderer, 'Fish')
    return new Fish(options)
  }

  /** Prefer {@link Fish.create}. */
  constructor({ scene, renderer: _renderer, ...input }: FishOptions = {}) {
    this.object.name = 'Fish'
    this.mesh = new InstancedMesh(undefined as unknown as BufferGeometry, this.material, 1)
    this.object.add(this.mesh)
    this.set(input)
    if (scene) {
      scene.add(this.object)
      this.unhook = hookScene(scene, () => this.update())
    }
  }

  /** Changes settings, merging into earlier ones. Shape changes rebuild the mesh; everything else is instant. */
  set(input: FishInput): this {
    mergeInput(this.input, input)
    const base = mergeInput(structuredClone(FISH_DEFAULTS), { ...this.input, species: undefined }) as Omit<FishSettings, 'species'>
    const preset = FISH_SPECIES[base.preset] ?? FISH_SPECIES.trout
    const species = mergeInput(structuredClone(preset) as FishSpecies, this.input.species ?? {})
    const s: FishSettings = { ...base, species }
    this.settings = s
    const key = JSON.stringify([species.shape, s.detail])
    if (key !== this.geometryKey) {
      this.geometryKey = key
      this.data = buildFishMesh(species.shape, s.detail)
      const old = this.mesh.geometry as BufferGeometry | undefined
      const g = toGeometry(this.data)
      g.setAttribute('faunaMotion', new InstancedBufferAttribute(new Float32Array(4), 4).setUsage(DynamicDrawUsage))
      g.setAttribute('faunaLook', new InstancedBufferAttribute(new Float32Array(4), 4))
      this.mesh.geometry = g
      old?.dispose?.()
    }
    applyFishSpecies(this.uniforms, species, this.data!)
    applyStates(this.uniforms, s.states)
    const r = mulberry32(seedOf(s.seed))
    const L = species.length * (1 + (r() - 0.5) * 2 * species.lengthVariation)
    this.mesh.setMatrixAt(0, _m.makeScale(L, L, L))
    this.mesh.instanceMatrix.needsUpdate = true
    // Explicit bounds: the unit mesh's sphere scaled to this fish (with room for the swimming motion).
    const g = this.mesh.geometry.boundingSphere!
    ;(this.mesh.boundingSphere ??= new Sphere()).set(g.center, 1).center.multiplyScalar(L)
    this.mesh.boundingSphere.radius = g.radius * L
    const look = this.mesh.geometry.getAttribute('faunaLook') as InstancedBufferAttribute
    look.array[0] = (r() - 0.5) * 2 * species.hueVariation
    look.array[1] = 1 + (r() - 0.5) * 0.24
    look.array[2] = r()
    look.array[3] = r()
    look.needsUpdate = true
    this.mesh.castShadow = s.castShadow
    this.mesh.receiveShadow = s.receiveShadow
    return this
  }

  /** Replaces all settings: anything not in `input` goes back to the defaults. */
  reset(input: FishInput = {}): this {
    this.input = {}
    return this.set(input)
  }

  /** Advances the swimming. Called automatically when a `scene` was given (and by `<Fish>`). */
  update(delta: number = this.clock.tick()): void {
    const s = this.settings, sw = s.species.swim
    this.time += delta
    this.phase += Math.PI * 2 * Math.max(0.6, sw.beat * s.speed) * delta
    this.finPhase += Math.PI * 2 * (1.5 + 2 * sw.flutter) * delta
    const motion = this.mesh.geometry.getAttribute('faunaMotion') as InstancedBufferAttribute
    const m = motion.array as Float32Array // written in place, no per-frame allocation
    m[0] = this.phase
    m[1] = Math.min(1.5, Math.max(0.4, 0.5 + 0.5 * s.speed))
    m[2] = s.turn * 0.25
    m[3] = this.finPhase
    motion.needsUpdate = true
  }

  /** Removes the fish and frees its GPU resources. */
  dispose(): void {
    this.unhook()
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.mesh.dispose()
    this.object.removeFromParent()
  }
}

const _m = new Matrix4()
