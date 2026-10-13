import { Group, type Camera, type Object3D } from 'three/webgpu'
import type { LocalFrame, World } from 'threejs-biomes'
import { City, type CityStats } from './city.ts'
import { DEFAULT_CITY, mergeOptions, type CityInput } from './options.ts'
import { planCities, type CitySite } from './placement.ts'
import { generatePopulation, type PopulationData, type PopulationInput } from './population-model.ts'
import { generateNetworks } from './population-network.ts'

/** Settings of a {@link Settlements} group. All plain data. */
export interface SettlementsOptions {
  /** Where people live: the population model's settings (its `center` and `radius` are the area to populate). */
  population: PopulationInput
  /** Settings shared by every settlement (centre, size, radius and seed come from the population; `sizes` maps it onto cities). */
  city: CityInput
  /** Most settlements to build, largest first. */
  maxSettlements: number
}

/** Input of {@link Settlements.create}: settings plus the objects it needs. */
export interface SettlementsCreateOptions extends Partial<SettlementsOptions> {
  /** The world. */
  world: World
  /** Frame to lay settlements out in (`world.frame` by default). */
  frame?: LocalFrame
  /** Camera for level of detail. */
  camera?: Camera
  /** If given, the group is added to it and updates itself via `scene.onBeforeRender`. */
  scene?: Object3D
}

const DEFAULTS: SettlementsOptions = { population: {}, city: {}, maxSettlements: 24 }

/**
 * Every settlement of a population: the population model ({@link generatePopulation}) decides where people
 * live and how many, {@link planCities} maps its settlements onto size classes (hamlets to cities), and each
 * gets one {@link City}.
 */
export class Settlements {
  /** Root of all settlements. */
  readonly object = new Group()
  /** The cities, largest first. */
  cities: City[] = []
  /** Their sites, matching `cities`. */
  sites: CitySite[] = []
  /** The population they were planned from. */
  data!: PopulationData
  /** Resolved settings. */
  options: SettlementsOptions = DEFAULTS
  private readonly world: World
  private readonly frame: LocalFrame
  private camera: Camera | null
  private siteKey = ''
  private unhook = () => {}

  /** Plans the population and creates its cities. */
  static async create(options: SettlementsCreateOptions): Promise<Settlements> {
    return new Settlements(options)
  }

  /** Prefer {@link Settlements.create}. */
  constructor({ world, frame, camera, scene, ...input }: SettlementsCreateOptions) {
    this.world = world
    this.frame = frame ?? world.frame
    this.camera = camera ?? null
    this.object.name = 'Settlements'
    this.reset(input)
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

  /** Replaces all settings. New population settings or size classes re-plan everything; other city settings apply to each city. */
  reset(input: Partial<SettlementsOptions> = {}): this {
    const o = (this.options = { ...DEFAULTS, ...input })
    const key = JSON.stringify([o.population, o.city.sizes, o.maxSettlements])
    if (key !== this.siteKey) {
      this.siteKey = key
      for (const c of this.cities) c.dispose()
      this.data = generatePopulation(this.world, o.population, this.frame)
      const sizes = mergeOptions(DEFAULT_CITY.sizes, o.city.sizes)
      this.sites = planCities(this.data, sizes).slice(0, o.maxSettlements)
      // Farmsteads join the road network with a driveway: route it only when there are farms to build.
      if (this.sites.some((s) => s.size === 'farmstead')) this.sites = planCities(this.data, sizes, generateNetworks(this.data)).slice(0, o.maxSettlements)
      this.cities = this.sites.map((s) => {
        const c = new City({ world: this.world, frame: this.frame, camera: this.camera ?? undefined, ...this.cityInput(s) })
        this.object.add(c.object)
        return c
      })
    } else {
      this.cities.forEach((c, i) => c.reset(this.cityInput(this.sites[i])))
    }
    return this
  }

  /** Merges settings into the current ones. */
  set(input: Partial<SettlementsOptions>): this {
    return this.reset({ ...this.options, ...input, population: mergeOptions(this.options.population, input.population), city: mergeOptions(this.options.city, input.city) })
  }

  /** Updates every city (progressive generation and LOD). */
  update(): void {
    for (const c of this.cities) {
      c.camera = this.camera
      c.update()
    }
  }

  /** Sets the LOD camera of every city. */
  setCamera(camera: Camera | null): void {
    this.camera = camera
  }

  /** Totals over all cities. */
  get stats(): CityStats {
    const t: CityStats = { ready: true, roadKm: 0, roads: 0, junctions: 0, bridges: 0, blocks: 0, lots: 0, buildings: 0, population: 0, modifiers: 0, generationMs: 0, detailed: 0 }
    for (const c of this.cities) {
      const s = c.stats
      t.ready &&= s.ready
      for (const k of ['roadKm', 'roads', 'junctions', 'bridges', 'blocks', 'lots', 'buildings', 'population', 'modifiers', 'generationMs', 'detailed'] as const) t[k] += s[k]
    }
    return t
  }

  /** Removes every city and its terrain edits. */
  dispose(): void {
    this.unhook()
    for (const c of this.cities) c.dispose()
    this.cities = []
    this.object.removeFromParent()
  }

  private cityInput(s: CitySite): CityInput {
    return mergeOptions(this.options.city, { center: [s.x, s.z], size: s.size, radius: s.radius, seed: s.seed, farm: s.road ? { road: s.road.points, roadType: s.road.type } : undefined })
  }
}
