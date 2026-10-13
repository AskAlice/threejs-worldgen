/** Gravity in the deep-water dispersion relation ω = √(g·k), m/s². */
export const GRAVITY = 9.81

/** Most waves a water surface sums (the size of the shader's uniform arrays). */
export const MAX_WAVES = 16

/** A parametric set of Gerstner waves: a wind sea built from a handful of numbers. */
export interface WaveOptions {
  /** Number of waves summed, 0 … 16. More = less regular, a little more GPU time. */
  count: number
  /** Seed for wavelength jitter and directions. */
  seed: number | string
  /** Amplitude of the longest wave, metres. Shorter waves scale down with their wavelength (constant steepness). */
  amplitude: number
  /** Shortest and longest wavelength, metres. */
  wavelength: [min: number, max: number]
  /** Wind direction as [x, z] in the surface's tangent plane (east, south). Normalised internally. */
  direction: [x: number, z: number]
  /** 0 … 1: how far wave directions fan out from the wind (1 = up to ±90°). */
  spread: number
  /** 0 … 1: horizontal displacement that sharpens crests and flattens troughs (1 = circular orbits, capped before crests fold). */
  choppiness: number
  /** Time multiplier (1 = real deep-water speed). */
  speed: number
}

/** One resolved Gerstner wave. */
export interface Wave {
  /** Unit propagation direction, x. */
  dirX: number
  /** Unit propagation direction, z. */
  dirZ: number
  /** Wavenumber 2π / wavelength, 1/m. */
  k: number
  /** Vertical amplitude, metres. */
  amplitude: number
  /** Horizontal displacement amplitude, metres. */
  chop: number
  /** Angular frequency, rad/s (already multiplied by `speed`). */
  omega: number
}

/** Builds the waves described by `options`: deterministic for a given seed. */
export function createWaves(options: WaveOptions): Wave[] {
  const n = Math.max(0, Math.min(MAX_WAVES, Math.floor(options.count)))
  const rand = random(options.seed)
  const lo = Math.max(1e-3, Math.min(options.wavelength[0], options.wavelength[1]))
  const hi = Math.max(lo, options.wavelength[0], options.wavelength[1])
  const wind = Math.atan2(options.direction[1], options.direction[0]) || 0
  const waves: Wave[] = []
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1)
    // Geometric spacing from long to short, jittered so the sum never repeats visibly.
    const lambda = Math.min(hi, Math.max(lo, hi * Math.pow(lo / hi, t) * (1 + (rand() - 0.5) * 0.3)))
    const angle = wind + (rand() * 2 - 1) * options.spread * Math.PI * 0.5
    const k = (2 * Math.PI) / lambda
    const amplitude = Math.max(0, options.amplitude) * (lambda / hi) * (0.7 + 0.6 * rand())
    waves.push({ dirX: Math.cos(angle), dirZ: Math.sin(angle), k, amplitude, chop: 0, omega: Math.sqrt(GRAVITY * k) * options.speed })
  }
  // Circular orbits (horizontal = vertical amplitude) at choppiness 1, scaled down if Σ k·chop would
  // pass 1: past that the Gerstner surface folds over itself at crests.
  const steep = waves.reduce((s, w) => s + w.k * w.amplitude, 0)
  const chop = Math.max(0, Math.min(1, options.choppiness)) * Math.min(1, 1 / (steep || 1))
  for (const w of waves) w.chop = w.amplitude * chop
  return waves
}

/** Sum of `chop × k` over the waves: the crest sharpness the whitecap foam is normalised by. */
export function crestSharpness(waves: readonly Wave[]): number {
  let s = 0
  for (const w of waves) s += w.chop * w.k
  return s
}

/** A point of a wave surface, from {@link sampleWaves}. */
export interface WaveSample {
  /** Surface height above the undisturbed level, metres. */
  height: number
  /** Unit surface normal, x. */
  nx: number
  /** Unit surface normal, y. */
  ny: number
  /** Unit surface normal, z. */
  nz: number
}

/**
 * Surface height and normal at a fixed (x, z), at time `time` (seconds). Gerstner waves move water
 * sideways, so the point that ends up above (x, z) is found by a few fixed-point iterations.
 * `phase` adds a per-wave phase (radians), as the ocean does to keep phases precise far from the origin.
 */
export function sampleWaves(waves: readonly Wave[], x: number, z: number, time: number, out: WaveSample = { height: 0, nx: 0, ny: 1, nz: 0 }, phase?: ArrayLike<number>): WaveSample {
  // Newton's method on p + D(p) = (x, z); the Jacobian stays invertible because Σ Q·k·A ≤ 1.
  let px = x, pz = z
  for (let iter = 0; iter < 6; iter++) {
    let fx = px - x, fz = pz - z
    let jxx = 1, jxz = 0, jzz = 1
    for (let i = 0; i < waves.length; i++) {
      const w = waves[i]
      const ph = w.k * (w.dirX * px + w.dirZ * pz) - w.omega * time + (phase?.[i] ?? 0)
      const c = Math.cos(ph), s = w.chop * w.k * Math.sin(ph)
      fx += w.chop * w.dirX * c
      fz += w.chop * w.dirZ * c
      jxx -= s * w.dirX * w.dirX
      jxz -= s * w.dirX * w.dirZ
      jzz -= s * w.dirZ * w.dirZ
    }
    const det = jxx * jzz - jxz * jxz
    if (Math.abs(det) < 1e-9) break
    px -= (jzz * fx - jxz * fz) / det
    pz -= (jxx * fz - jxz * fx) / det
  }
  let h = 0, nx = 0, ny = 1, nz = 0
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i]
    const ph = w.k * (w.dirX * px + w.dirZ * pz) - w.omega * time + (phase?.[i] ?? 0)
    const s = Math.sin(ph), c = Math.cos(ph)
    const ka = w.k * w.amplitude
    h += w.amplitude * s
    nx -= w.dirX * ka * c
    nz -= w.dirZ * ka * c
    ny -= w.chop * w.k * s
  }
  const len = Math.hypot(nx, ny, nz) || 1
  out.height = h
  out.nx = nx / len; out.ny = ny / len; out.nz = nz / len
  return out
}

/** Seeded PRNG (mulberry32 over an FNV-1a hash of the seed), kept local so this module has no dependencies. */
function random(seed: number | string): () => number {
  let a = 0x811c9dc5
  for (const ch of String(seed)) a = Math.imul(a ^ ch.charCodeAt(0), 16777619)
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
