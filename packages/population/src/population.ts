import type { LocalFrame, World } from 'threejs-biomes'
import { DEFAULT_POPULATION, generatePopulation, resolvePopulationOptions, type PopulationData, type PopulationInput, type PopulationOptions } from './model.ts'
import { generateNetworks, type Network } from './network.ts'

/**
 * A live population over a world: settings in, {@link PopulationData} and a {@link Network} out,
 * regenerated (synchronously, deterministically) whenever the settings or the world change.
 *
 * @example
 * ```ts
 * const population = new Population(world, { seed: 'valley', totalPopulation: 800_000 })
 * population.data.settlements[0]     // the largest place: { class: 'city', position: [x, z], … }
 * population.network.edges           // roads, rail and power lines as [x, z] polylines
 * population.set({ zipf: 1.2 })      // live update; listeners (e.g. the overlay) rebuild
 * ```
 */
export class Population {
  /** The world people live on. */
  readonly world: World
  /** Resolved settings. Change them with {@link Population.set} / {@link Population.reset}. */
  options: PopulationOptions
  /** Cells, settlements and land use. */
  data!: PopulationData
  /** Roads, railways and power lines. */
  network!: Network
  /** Bumped on every regeneration. */
  version = 0

  private readonly frame?: LocalFrame
  private readonly listeners = new Set<(population: Population) => void>()
  private unsubscribe: (() => void) | null = null

  /**
   * Generates the population of `world` from `input` (anything missing comes from the defaults).
   * @param frame Local frame to work in (overrides `options.location`).
   */
  constructor(world: World, input: PopulationInput = {}, frame?: LocalFrame) {
    this.world = world
    this.frame = frame
    this.options = resolvePopulationOptions(input)
    this.generate()
    this.follow()
  }

  /** Merges `input` into the current settings (nested objects merge; arrays replace) and regenerates. */
  set(input: PopulationInput): this {
    this.options = resolvePopulationOptions(input, this.options)
    return this.changed()
  }

  /** Replaces all settings: anything not in `input` goes back to {@link DEFAULT_POPULATION}. */
  reset(input: PopulationInput = {}): this {
    const next = resolvePopulationOptions(input, DEFAULT_POPULATION)
    if (JSON.stringify(next) === JSON.stringify(this.options)) return this
    this.options = next
    return this.changed()
  }

  /** Calls `listener` after every regeneration. Returns an unsubscribe function. */
  onChange(listener: (population: Population) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Regenerates whenever the world changes (on from construction). Returns a function that stops it;
   * calling `follow` again resumes.
   */
  follow(): () => void {
    this.unsubscribe ??= this.world.onChange(() => this.changed())
    return () => { this.unsubscribe?.(); this.unsubscribe = null }
  }

  /** Stops following the world and drops all listeners. */
  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.listeners.clear()
  }

  private generate() {
    this.data = generatePopulation(this.world, this.options, this.frame)
    this.network = generateNetworks(this.data)
  }

  private changed(): this {
    this.generate()
    this.version++
    for (const l of this.listeners) l(this)
    return this
  }
}
