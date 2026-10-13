// Pure CPU side of emission: how many particles to spawn this frame, where in the ring they go, and the
// weighted source table the GPU picks spawn points from. No three.js here, so it is unit-tested in Node.

/** One frame's spawn batch (see {@link EmitterClock.step}). */
export interface SpawnBatch {
  /** Serial number of the first new particle (seeds its random numbers). */
  first: number
  /** Ring slot of the first new particle. */
  slot: number
  /** How many to spawn. */
  count: number
}

/**
 * Deterministic spawn scheduling for a fixed-capacity ring buffer: fractional particles carry over
 * between frames, so the same sequence of `dt` always spawns the same particles with the same serial
 * numbers (and therefore the same random numbers), whatever the frame rate splits look like.
 */
export class EmitterClock {
  /** Pool size. */
  readonly capacity: number
  /** Particles spawned since the last reset; the serial of the next one. */
  spawned = 0
  /** Ring slot of the next particle. */
  head = 0
  private carry = 0

  /** Creates a clock for a pool of `capacity` particles. */
  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity))
  }

  /** Spawns `rate × dt` particles (plus the carried fraction), at most `maxPerFrame`. */
  step(rate: number, dt: number, maxPerFrame = Infinity): SpawnBatch {
    const want = this.carry + Math.max(0, rate) * Math.max(0, dt)
    const count = Math.min(Math.floor(want), Math.max(0, Math.floor(maxPerFrame)), this.capacity)
    this.carry = count < Math.floor(want) ? 0 : want - count // capped frames drop the backlog instead of bursting later
    const batch = { first: this.spawned, slot: this.head, count }
    this.spawned = (this.spawned + count) >>> 0
    this.head = (this.head + count) % this.capacity
    return batch
  }

  /** Back to an empty pool. */
  reset(): this {
    this.spawned = this.head = this.carry = 0
    return this
  }
}

/**
 * Particles per second for a pool: `rate × weight`, throttled so particles living `meanLife` seconds
 * never need more than `capacity` slots (the ring would otherwise recycle live particles early).
 */
export function spawnRate(rate: number, weight: number, capacity: number, meanLife: number): number {
  return Math.max(0, Math.min(rate * weight, capacity / Math.max(1e-3, meanLife)))
}

/** Floats per source: position xyz, weight, then four free values (`data`, e.g. size scale, lift, tint, heat). */
export const SOURCE_STRIDE = 8

/**
 * A weighted list of spawn points that the CPU refreshes cheaply. `positions` is `count × 4` floats
 * (x, y, z, weight), `data` is `count × 4` free floats per source, `cdf` the running sum of weights
 * that the GPU binary-searches with a random number.
 */
export interface SourceTable {
  /** Sources in use. */
  count: number
  /** Sum of weights. */
  total: number
  /** x, y, z, weight per source. */
  positions: Float32Array
  /** Four free floats per source (read by the shading and forces as `source.data`). */
  data: Float32Array
  /** Inclusive prefix sum of weights per source. */
  cdf: Float32Array
}

/** An empty table for up to `max` sources. */
export function createSourceTable(max: number): SourceTable {
  const n = Math.max(1, Math.floor(max))
  return { count: 0, total: 0, positions: new Float32Array(n * 4), data: new Float32Array(n * 4), cdf: new Float32Array(n) }
}

/** Most sources a table holds. */
export function sourceCapacity(table: SourceTable): number {
  return table.cdf.length
}

/**
 * Fills `table` from `sources` (`SOURCE_STRIDE` floats each: x, y, z, weight, d0…d3). Sources with
 * weight ≤ 0 are skipped. If there are more than the table holds, the heaviest are kept (ties keep
 * the earlier one), so the selection is deterministic.
 */
export function fillSourceTable(table: SourceTable, sources: ArrayLike<number>, count = Math.floor(sources.length / SOURCE_STRIDE)): SourceTable {
  const max = sourceCapacity(table)
  let order: number[] = []
  for (let i = 0; i < count; i++) if (sources[i * SOURCE_STRIDE + 3] > 0) order.push(i)
  if (order.length > max) {
    order.sort((a, b) => sources[b * SOURCE_STRIDE + 3] - sources[a * SOURCE_STRIDE + 3] || a - b)
    order = order.slice(0, max).sort((a, b) => a - b)
  }
  let total = 0
  for (let k = 0; k < order.length; k++) {
    const s = order[k] * SOURCE_STRIDE
    for (let c = 0; c < 4; c++) {
      table.positions[k * 4 + c] = sources[s + c]
      table.data[k * 4 + c] = sources[s + 4 + c]
    }
    total += sources[s + 3]
    table.cdf[k] = total
  }
  table.count = order.length
  table.total = total
  return table
}

/** The source a uniform random `u` in [0, 1) picks: the first whose prefix sum exceeds `u × total` (what the GPU does). */
export function pickSource(table: SourceTable, u: number): number {
  if (table.count === 0) return -1
  const target = u * table.total
  let lo = 0, hi = table.count - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (table.cdf[mid] <= target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The GPU's per-particle random number `k` (0…15) for particle `serial`: PCG hash, as in the shaders. */
export function particleRandom(serial: number, k: number, seed: number): number {
  return pcg((Math.imul(serial >>> 0, 16) + k + seed) >>> 0)
}

/** PCG hash of a 32-bit unsigned integer to [0, 1) (same as three's TSL `hash`). */
export function pcg(v: number): number {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0
  return (((word >>> 22) ^ word) >>> 0) / 2 ** 32
}
