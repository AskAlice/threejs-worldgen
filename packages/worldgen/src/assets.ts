import type { Object3D } from 'three/webgpu'
import {
  createSample,
  hash01,
  isPlausible,
  mulberry32,
  seedOf,
  type AssetDef,
  type LocalFrame,
  type PlacementRule,
  type World,
  type WorldSample
} from 'threejs-biomes'

// Placement rules and plausibility live in threejs-biomes (every package depends on it, so props and
// vehicles can share them); re-exported here for existing consumers.
export { isPlausible, type AssetDef, type AssetParam, type PlacementRule } from 'threejs-biomes'

/** A search hit. */
export interface AssetMatch {
  /** The asset. */
  asset: AssetDef
  /** Relevance (higher is better). */
  score: number
}

/** Narrows a list or a search to some assets; every field is optional. */
export interface AssetFilter {
  /** Category, e.g. `tree` or `vehicle`. */
  category?: string
  /** Placement kind: what it stands on or in. */
  surface?: PlacementRule['surface']
  /** Providing package, e.g. `threejs-props`. */
  package?: string
  /** A biome it belongs to (assets with no biome affinity always pass). */
  biome?: string
}

/**
 * The shared catalogue every package registers its generators into. Powers the fuzzy-searchable
 * gallery, plausible random placement and spawning.
 */
export class AssetRegistry {
  private assets = new Map<string, AssetDef>()

  /** Adds (or replaces) assets. */
  register(...defs: AssetDef[]): this {
    for (const d of defs) this.assets.set(d.id, d)
    return this
  }

  /** The asset with this id. */
  get(id: string): AssetDef | undefined {
    return this.assets.get(id)
  }

  /** All assets matching `filter`. */
  list(filter: AssetFilter = {}): AssetDef[] {
    return [...this.assets.values()].filter((a) => matches(a, filter))
  }

  /**
   * Fuzzy search over names, ids, aliases, tags, categories, packages and biomes: typo-tolerant, every
   * query word must match something, best matches first. `filter` narrows the candidates first.
   */
  search(query: string, limit = 50, filter: AssetFilter = {}): AssetMatch[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const candidates = this.list(filter)
    if (!words.length)
      return candidates
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, limit)
        .map((asset) => ({ asset, score: 0 }))
    const hits: AssetMatch[] = []
    for (const asset of candidates) {
      const fields: [string, number][] = [
        [asset.name, 3],
        [asset.id, 2],
        [asset.category, 2],
        [asset.package, 1],
        ...asset.tags.map((t): [string, number] => [t, 2]),
        ...(asset.aliases ?? []).map((a): [string, number] => [a, 2]),
        ...(asset.placement.biomes ?? []).map((b): [string, number] => [b, 1])
      ]
      let total = 0
      let all = true
      for (const w of words) {
        let best = 0
        for (const [text, weight] of fields) best = Math.max(best, fuzzyScore(w, text) * weight)
        if (best <= 0) {
          all = false
          break
        }
        total += best
      }
      if (all) hits.push({ asset, score: total })
    }
    return hits.sort((a, b) => b.score - a.score || a.asset.name.localeCompare(b.asset.name)).slice(0, limit)
  }

  /** Builds one instance with defaults merged with `overrides`. */
  async create(id: string, overrides: Record<string, unknown> = {}, seed = 1): Promise<Object3D> {
    const a = this.assets.get(id)
    if (!a) throw new Error(`Unknown asset "${id}"`)
    return a.create({ ...defaults(a), ...overrides }, seed)
  }
}

function matches(a: AssetDef, filter: AssetFilter): boolean {
  return (
    (!filter.category || a.category === filter.category) &&
    (!filter.surface || a.placement.surface === filter.surface) &&
    (!filter.package || a.package === filter.package) &&
    (!filter.biome || !a.placement.biomes?.length || a.placement.biomes.includes(filter.biome))
  )
}

/** The default value of every parameter of an asset. */
export function defaults(asset: AssetDef): Record<string, unknown> {
  return Object.fromEntries(Object.entries(asset.params).map(([k, p]) => [k, p.default]))
}

/**
 * How well a query word matches a piece of text, 0 (no match) … ~1 (exact). Exact and prefix matches
 * score highest, then word-start subsequences, then plain subsequences, then near-misses within a
 * small edit distance (typos), so "redwod", "plm tree" or "skyscrapr" still find their assets.
 */
export function fuzzyScore(word: string, text: string): number {
  const t = text.toLowerCase()
  if (!word) return 0
  word = word.toLowerCase()
  if (t === word) return 1
  const words = t.split(/[^a-z0-9]+/).filter(Boolean)
  if (words.includes(word)) return 0.95
  if (words.some((w) => w.startsWith(word))) return 0.85
  if (t.includes(word)) return 0.7
  // Subsequence with bonuses for consecutive runs and word starts.
  let ti = 0,
    run = 0,
    score = 0
  for (let i = 0; i < word.length; i++) {
    const found = t.indexOf(word[i], ti)
    if (found < 0) {
      score = -1
      break
    }
    run = found === ti ? run + 1 : 0
    const start = found === 0 || /[^a-z0-9]/.test(t[found - 1])
    score += 1 + run * 0.5 + (start ? 0.5 : 0)
    ti = found + 1
  }
  if (score > 0) return Math.min(0.65, 0.25 + (score / (word.length * 2)) * 0.4)
  // Typos: small Damerau-Levenshtein distance against any word.
  if (word.length >= 3) {
    const allowed = word.length <= 4 ? 1 : 2
    let bestD = Infinity
    for (const w of words) bestD = Math.min(bestD, editDistance(word, w.slice(0, word.length + allowed)))
    if (bestD <= allowed) return 0.5 - bestD * 0.12
  }
  return 0
}

/** Optimal-string-alignment (Damerau-Levenshtein) distance. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  return d[a.length][b.length]
}

/** One planned instance from {@link planSpawns}. */
export interface SpawnPlan {
  /** Asset id. */
  id: string
  /** Local frame position. */
  x: number
  /** Local frame position. */
  y: number
  /** Local frame position. */
  z: number
  /** Yaw, radians. */
  yaw: number
  /** Per-instance seed (drives the asset's variety). */
  seed: number
}

/**
 * Plans `count` instances of plausible assets in a disc around (cx, cz): candidates are seeded (so the
 * same call always gives the same layout — random-looking, never random), each asset keeps only spots
 * that suit its placement rule, and assets that fit the local biome are favoured.
 */
export function planSpawns(
  registry: AssetRegistry,
  world: World,
  frame: LocalFrame,
  cx: number,
  cz: number,
  radius: number,
  count: number,
  seed: number | string = 1,
  filter: { category?: string; ids?: string[] } = {}
): SpawnPlan[] {
  const s = seedOf(seed) ^ seedOf(world.options.seed)
  const candidates = filter.ids
    ? filter.ids.map((i) => registry.get(i)).filter((a): a is AssetDef => !!a)
    : registry.list({ category: filter.category })
  if (!candidates.length) return []
  const rand = mulberry32(s)
  const out: SpawnPlan[] = []
  const sample = createSample()
  for (let attempt = 0; attempt < count * 30 && out.length < count; attempt++) {
    const r = radius * Math.sqrt(rand()),
      a = rand() * Math.PI * 2
    const x = cx + Math.cos(a) * r,
      z = cz + Math.sin(a) * r
    frame.sample(x, z, sample)
    const fits = candidates.filter((c) => isPlausible(world, frame, x, z, c.placement, 1, sample))
    if (!fits.length) continue
    const pick = fits[Math.floor(rand() * fits.length)]
    const y = surfaceY(pick.placement, sample, rand)
    out.push({
      id: pick.id,
      x,
      y,
      z,
      yaw: rand() * Math.PI * 2,
      seed: Math.floor(hash01(Math.floor(x * 10), Math.floor(z * 10), out.length, s) * 2 ** 31)
    })
  }
  return out
}

/** Where an asset with `rule` sits at a sampled spot: the ground, the water surface, a depth or an altitude. */
function surfaceY(rule: PlacementRule, sample: WorldSample, rand: () => number): number {
  const ground = sample.elevation
  switch (rule.surface) {
    case 'water':
      return sample.waterLevel
    case 'air':
      return ground + (rule.height ? rule.height[0] + rand() * (rule.height[1] - rule.height[0]) : 50)
    case 'underwater':
      return ground + (sample.waterLevel - ground) * (0.2 + 0.6 * rand())
    default:
      return ground
  }
}

/** One hand-placed asset: its serialisable plan and the built object. */
export interface PlacedAsset {
  /** Position, yaw and per-instance seed; store with `world.options.seed` to rebuild the placement. */
  plan: SpawnPlan
  /** The built instance, already positioned and rotated. */
  object: Object3D
}

/**
 * Places one asset at frame-local (x, z) for the gallery: `undefined` when the spot does not suit its
 * placement rule, otherwise the built, ground/water-snapped and seeded instance. The same asset, spot,
 * seed and world always give the same instance.
 */
export async function placeAsset(
  registry: AssetRegistry,
  id: string,
  world: World,
  frame: LocalFrame,
  x: number,
  z: number,
  seed: number | string = 1,
  overrides: Record<string, unknown> = {}
): Promise<PlacedAsset | undefined> {
  const asset = registry.get(id)
  const sample = createSample()
  frame.sample(x, z, sample)
  if (!asset || !isPlausible(world, frame, x, z, asset.placement, 1, sample)) return undefined
  const s = seedOf(seed) ^ seedOf(world.options.seed)
  const rand = mulberry32(s)
  const y = surfaceY(asset.placement, sample, rand)
  const yaw = rand() * Math.PI * 2
  const instance = Math.floor(hash01(Math.floor(x * 10), Math.floor(z * 10), 0, s) * 2 ** 31)
  const object = await registry.create(id, overrides, instance)
  object.position.set(x, y, z)
  object.rotation.y = yaw
  return { plan: { id, x, y, z, yaw, seed: instance }, object }
}
