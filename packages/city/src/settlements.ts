import { Group, type Camera, type Object3D } from 'three/webgpu'
import type { LocalFrame, World } from 'threejs-biomes'
import { City, type CityStats } from './city.ts'
import { mergeOptions, type CityInput } from './options.ts'
import { findSettlements, type PlacementInput, type Region, type Settlement } from './placement.ts'

/** Settings of a {@link Settlements} group. All plain data. */
export interface SettlementsOptions {
  /** Area to populate (frame-local metres). */
  region: Region
  /** Placement rules. */
  placement: PlacementInput
  /** Settings shared by every settlement (centre, size, radius and seed come from placement). */
  city: CityInput
  /** Most settlements to build, best sites first. */
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

const DEFAULTS: SettlementsOptions = { region: { minX: -10000, minZ: -10000, maxX: 10000, maxZ: 10000 }, placement: {}, city: {}, maxSettlements: 24 }

/**
 * Every settlement in a region: sites from {@link findSettlements}, one {@link City} each, sized by
 * how good the site is (hamlets to cities).
 */
export class Settlements {
  /** Root of all settlements. */
  readonly object = new Group()
  /** The cities, best site first. */
  cities: City[] = []
  /** The chosen sites, matching `cities`. */
  sites: Settlement[] = []
  /** Resolved settings. */
  options: SettlementsOptions = DEFAULTS
  private readonly world: World
  private readonly frame: LocalFrame
  private camera: Camera | null
  private siteKey = ''
  private unhook = () => {}

  /** Finds sites and creates their cities. */
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

  /** Replaces all settings. New region or placement rules re-site everything; city settings apply to each city. */
  reset(input: Partial<SettlementsOptions> = {}): this {
    const o = (this.options = { ...DEFAULTS, ...input })
    const key = JSON.stringify([o.region, o.placement, o.maxSettlements])
    if (key !== this.siteKey) {
      this.siteKey = key
      for (const c of this.cities) c.dispose()
      this.sites = findSettlements(this.world, this.frame, o.region, o.placement).sort((a, b) => b.score - a.score).slice(0, o.maxSettlements)
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
    return this.reset({ ...this.options, ...input, city: mergeOptions(this.options.city, input.city) })
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

  private cityInput(s: Settlement): CityInput {
    return mergeOptions(this.options.city, { center: [s.x, s.z], size: s.size, radius: s.radius, seed: s.seed })
  }
}
