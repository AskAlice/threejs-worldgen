/**
 * Where animal groups spawn: deterministic per tile (seed + tile coordinates), species picked by how
 * well each fits the world there, and each group gets a small sampled environment (its usable band:
 * water for fish, air above the ground for birds) so it never leaves plausible places. Pure: no
 * three.js, so it runs in tests and workers.
 */
import { createSample, hash4, mulberry32, type WorldSample } from 'threejs-biomes'
import { GridEnvironment, type Band } from './boids.ts'

/** Anything that samples a world at local (x, z): a `World`'s `frame`, or `world.frameAt(...)`. */
export interface FaunaSampler {
  /** Samples local (x, z); `elevation` and `waterLevel` are local y. */
  sample(x: number, z: number, out?: WorldSample, minWavelength?: number): WorldSample
}

/** What a kind of animal (fish, birds, …) tells placement about its species. */
export interface Habitat<S> {
  /** Weighted suitability (0 = never here) of a species at a world sample. */
  suitability(species: S, sample: WorldSample): number
  /** The raw usable band for a species at a sample (e.g. riverbed … water surface); `false` = unusable. */
  band(species: S, sample: WorldSample, out: Band): boolean
  /** The thinnest band a species can use (its margins plus its body). */
  minThickness(species: S): number
  /** Group size range [min, max]. */
  groupSize(species: S): [number, number]
  /** How far (metres) a group roams from home; also the half-size of its environment grid. */
  roam(species: S): number
}

/** Placement settings shared by every kind of animal. */
export interface SpawnOptions {
  /** World seed. */
  seed: number
  /** Separates kinds that share a seed (fish vs birds). */
  salt: number
  /** Edge length of a tile, metres. */
  tileSize: number
  /** Group candidates per km²; candidates in unsuitable places are dropped. */
  density: number
  /** Samples per side of each group's environment grid. */
  gridResolution: number
  /** Skip world detail smaller than this (metres) when sampling (faster, slightly less exact). */
  minWavelength: number
}

/** One spawned group. */
export interface GroupSpawn {
  /** Species id. */
  species: string
  /** Seed for the group's simulation. */
  seed: number
  /** Members. */
  count: number
  /** Home position (local x, y, z). */
  home: [number, number, number]
  /** Where the group may go. */
  environment: GridEnvironment
}

/**
 * Spawns the groups of one tile. A generator so callers can spread the world sampling over frames
 * (`yield` after every few samples); the result is the same however it is driven. Use
 * {@link spawnTileNow} to run it to completion.
 */
export function* spawnTile<S>(ix: number, iz: number, species: Readonly<Record<string, S>>, habitat: Habitat<S>, sampler: FaunaSampler, o: SpawnOptions): Generator<void, GroupSpawn[]> {
  const rand = mulberry32(hash4(o.seed, ix, iz, o.salt))
  const area = (o.tileSize * o.tileSize) / 1e6
  const expected = o.density * area
  const n = Math.floor(expected) + (rand() < expected % 1 ? 1 : 0)
  const ids = Object.keys(species).sort()
  const weights = new Float64Array(ids.length)
  const sample = createSample(8)
  const band: Band = { floor: 0, top: 0 }
  const out: GroupSpawn[] = []
  for (let k = 0; k < n; k++) {
    // Fixed draws per candidate, so rejecting one never shifts the next.
    const x = (ix + rand()) * o.tileSize, z = (iz + rand()) * o.tileSize
    const pick = rand(), sizeRand = rand(), seed = hash4(o.seed, ix, iz, k * 7919 + o.salt)
    sampler.sample(x, z, sample, o.minWavelength)
    let total = 0
    ids.forEach((id, i) => (total += weights[i] = Math.max(0, habitat.suitability(species[id], sample))))
    if (total <= 0) continue
    let r = pick * Math.max(total, 1), chosen = -1
    for (let i = 0; i < ids.length; i++) if ((r -= weights[i]) < 0) { chosen = i; break }
    if (chosen < 0) continue
    const sp = species[ids[chosen]]
    yield

    // Sample the usable band around home on a small grid.
    const res = Math.max(3, Math.floor(o.gridResolution))
    const R = Math.max(1, habitat.roam(sp))
    const cell = (2 * R) / (res - 1)
    const floors = new Float64Array(res * res), tops = new Float64Array(res * res)
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        sampler.sample(x - R + i * cell, z - R + j * cell, sample, o.minWavelength)
        const ok = habitat.band(sp, sample, band)
        floors[j * res + i] = ok ? band.floor : NaN
        tops[j * res + i] = ok ? band.top : NaN
      }
      yield
    }
    const env = new GridEnvironment(x - R, z - R, cell, res, floors, tops, habitat.minThickness(sp))
    // Home: the centre cell if usable, else the usable cell nearest to it.
    let hx = NaN, hz = NaN, best = Infinity
    for (let j = 0; j < res - 1; j++) {
      for (let i = 0; i < res - 1; i++) {
        const cx = x - R + (i + 0.5) * cell, cz = z - R + (j + 0.5) * cell
        if (!env.band(cx, cz, band)) continue
        const d = Math.hypot(cx - x, cz - z)
        if (d < best) { best = d; hx = cx; hz = cz }
      }
    }
    if (!(best < R)) continue
    env.band(hx, hz, band)
    const [lo, hi] = habitat.groupSize(sp)
    out.push({
      species: ids[chosen],
      seed,
      count: Math.max(1, Math.round(lo + (hi - lo) * sizeRand)),
      home: [hx, (band.floor + band.top) * 0.5, hz],
      environment: env,
    })
  }
  return out
}

/** Runs {@link spawnTile} to completion. */
export function spawnTileNow<S>(ix: number, iz: number, species: Readonly<Record<string, S>>, habitat: Habitat<S>, sampler: FaunaSampler, o: SpawnOptions): GroupSpawn[] {
  const g = spawnTile(ix, iz, species, habitat, sampler, o)
  for (;;) {
    const step = g.next()
    if (step.done) return step.value
  }
}
