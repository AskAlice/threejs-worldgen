import { hash } from './random.ts'

/**
 * Candidate grid cells per `spacing`. One jittered candidate lives in each global cell of size `spacing / CELLS`;
 * more cells mean more candidates and denser packing, at a higher cost.
 */
const CELLS = 2

/** Elimination rounds. Each round adds packing density and widens the margin a tile has to look at. */
const ROUNDS = 3

/**
 * Seamless, deterministic Poisson-disk (blue-noise) points inside the square tile
 * `[x0, x0 + size) × [z0, z0 + size)`.
 *
 * Every point is at least `spacing` from every other point, including points of neighbouring tiles, and a tile's
 * points never depend on which other tiles were generated or in which order:
 *
 * 1. A global grid of cells (size `spacing / 2`) each holds one candidate, jittered and given a random priority by
 *    hashing the cell's integer coordinates with `seed`.
 * 2. In each of a few rounds, a candidate survives if no other live candidate within `spacing` has a higher priority
 *    (a Matérn type-II hard-core process); survivors are accepted and remove their neighbours. Repeating the round
 *    on the leftovers fills most gaps, approaching random sequential packing.
 * 3. Whether a candidate is accepted after `k` rounds depends only on candidates within `(2k + 1) · spacing`, so the
 *    tile evaluates that margin around itself and keeps only its own points. Tiles therefore stitch exactly.
 *
 * @returns Interleaved `[x, z, random]` triples; `random` is a stable per-point number in [0, 1).
 */
export function poissonDisk(x0: number, z0: number, size: number, spacing: number, seed: number): Float32Array {
  if (!(spacing > 0) || !(size > 0)) return new Float32Array(0)
  const r2 = spacing * spacing
  const cell = spacing / CELLS
  const margin = (2 * ROUNDS + 1) * spacing
  const gx0 = Math.floor((x0 - margin) / cell)
  const gz0 = Math.floor((z0 - margin) / cell)
  const nx = Math.floor((x0 + size + margin) / cell) - gx0 + 1
  const nz = Math.floor((z0 + size + margin) / cell) - gz0 + 1
  const n = nx * nz
  const px = new Float64Array(n)
  const pz = new Float64Array(n)
  const pri = new Float64Array(n)
  const rnd = new Float32Array(n)
  // 0 = live, 1 = accepted, 2 = removed
  const state = new Uint8Array(n)

  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      const h = hash(gx0 + i, gz0 + j, seed)
      px[k] = (gx0 + i + h / 4294967296) * cell
      pz[k] = (gz0 + j + hash(h, 1) / 4294967296) * cell
      pri[k] = hash(h, 2) / 4294967296
      rnd[k] = hash(h, 3) / 4294967296
    }
  }

  const reach = Math.ceil(spacing / cell)
  const winners: number[] = []
  for (let round = 0; round < ROUNDS; round++) {
    winners.length = 0
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i
        if (state[k] !== 0) continue
        let wins = true
        search: for (let b = Math.max(0, j - reach); b <= Math.min(nz - 1, j + reach); b++) {
          for (let a = Math.max(0, i - reach); a <= Math.min(nx - 1, i + reach); a++) {
            const m = b * nx + a
            if (m === k || state[m] !== 0) continue
            // Ties (vanishingly rare) are broken by global cell order, so the result stays deterministic.
            if (pri[m] < pri[k] || (pri[m] === pri[k] && m < k)) continue
            const dx = px[m] - px[k]
            const dz = pz[m] - pz[k]
            if (dx * dx + dz * dz < r2) {
              wins = false
              break search
            }
          }
        }
        if (wins) winners.push(k)
      }
    }
    for (const k of winners) state[k] = 1
    for (const k of winners) {
      const i = k % nx
      const j = (k - i) / nx
      for (let b = Math.max(0, j - reach); b <= Math.min(nz - 1, j + reach); b++) {
        for (let a = Math.max(0, i - reach); a <= Math.min(nx - 1, i + reach); a++) {
          const m = b * nx + a
          if (state[m] !== 0) continue
          const dx = px[m] - px[k]
          const dz = pz[m] - pz[k]
          if (dx * dx + dz * dz < r2) state[m] = 2
        }
      }
    }
  }

  const out: number[] = []
  for (let k = 0; k < n; k++) {
    if (state[k] !== 1) continue
    const x = px[k]
    const z = pz[k]
    if (x >= x0 && x < x0 + size && z >= z0 && z < z0 + size) out.push(x, z, rnd[k])
  }
  return new Float32Array(out)
}
