/**
 * Seeded, deterministic noise: integer hashing, a seeded PRNG, 3D gradient noise with analytic
 * derivatives, and the fractal sums the world is built from (fBm, ridged multifractal, eroded fBm,
 * domain warping, cellular). Everything is 3D so the same code drives flat worlds (sampled on a plane)
 * and planets (sampled on a sphere). Pure JS in float64, so the same seed gives the same numbers on
 * every machine, in workers and in tests, at any scale from millimetres to planets.
 */

/** 32-bit integer hash of four integers. Uniform enough for gradients and placement. */
export function hash4(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1) ^ Math.imul(d | 0, 0x85ebca77)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/** Hash of four integers mapped to [0, 1). */
export function hash01(a: number, b: number, c: number, d: number): number {
  return hash4(a, b, c, d) / 4294967296
}

/** Turns any string or number into a 32-bit seed, so `seed: 'meadow'` works as well as `seed: 42`. */
export function seedOf(seed: number | string): number {
  if (typeof seed === 'number') return seed | 0
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return h | 0
}

/** Mulberry32: a small, fast, seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Value and gradient of a 3D noise sample. */
export interface NoiseSample {
  /** Noise value, roughly in [-1, 1]. */
  value: number
  /** ∂value/∂x. */
  dx: number
  /** ∂value/∂y. */
  dy: number
  /** ∂value/∂z. */
  dz: number
}

// Perlin's improved-noise gradient set: the 12 cube edge directions, padded to 16.
const G = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1], [1, 1, 0], [-1, 1, 0], [0, -1, 1], [0, -1, -1],
]
const GX = new Float64Array(G.map((g) => g[0]))
const GY = new Float64Array(G.map((g) => g[1]))
const GZ = new Float64Array(G.map((g) => g[2]))
const NORM = 0.95

function lerpGrad(ux: number, uy: number, uz: number, ga: number, gb: number, gc: number, gd: number, ge: number, gf: number, gg: number, gh: number): number {
  return ga + ux * (gb - ga) + uy * (gc - ga) + uz * (ge - ga) + ux * uy * (ga - gb - gc + gd) + uy * uz * (ga - gc - ge + gg) +
    uz * ux * (ga - gb - ge + gf) + ux * uy * uz * (-ga + gb + gc - gd + ge - gf - gg + gh)
}

/**
 * 3D gradient noise with quintic fade and analytic derivatives (after Iñigo Quilez). Writes into
 * `out` and returns it, so hot loops allocate nothing.
 */
export function gradientNoise(seed: number, x: number, y: number, z: number, out: NoiseSample = { value: 0, dx: 0, dy: 0, dz: 0 }): NoiseSample {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
  const wx = x - ix, wy = y - iy, wz = z - iz
  const ux = wx * wx * wx * (wx * (wx * 6 - 15) + 10)
  const uy = wy * wy * wy * (wy * (wy * 6 - 15) + 10)
  const uz = wz * wz * wz * (wz * (wz * 6 - 15) + 10)
  const dux = 30 * wx * wx * (wx * (wx - 2) + 1)
  const duy = 30 * wy * wy * (wy * (wy - 2) + 1)
  const duz = 30 * wz * wz * (wz * (wz - 2) + 1)

  const a = hash4(ix, iy, iz, seed) & 15, b = hash4(ix + 1, iy, iz, seed) & 15
  const c = hash4(ix, iy + 1, iz, seed) & 15, d = hash4(ix + 1, iy + 1, iz, seed) & 15
  const e = hash4(ix, iy, iz + 1, seed) & 15, f = hash4(ix + 1, iy, iz + 1, seed) & 15
  const g = hash4(ix, iy + 1, iz + 1, seed) & 15, h = hash4(ix + 1, iy + 1, iz + 1, seed) & 15

  const va = GX[a] * wx + GY[a] * wy + GZ[a] * wz
  const vb = GX[b] * (wx - 1) + GY[b] * wy + GZ[b] * wz
  const vc = GX[c] * wx + GY[c] * (wy - 1) + GZ[c] * wz
  const vd = GX[d] * (wx - 1) + GY[d] * (wy - 1) + GZ[d] * wz
  const ve = GX[e] * wx + GY[e] * wy + GZ[e] * (wz - 1)
  const vf = GX[f] * (wx - 1) + GY[f] * wy + GZ[f] * (wz - 1)
  const vg = GX[g] * wx + GY[g] * (wy - 1) + GZ[g] * (wz - 1)
  const vh = GX[h] * (wx - 1) + GY[h] * (wy - 1) + GZ[h] * (wz - 1)

  const k1 = vb - va, k2 = vc - va, k3 = ve - va
  const k4 = va - vb - vc + vd, k5 = va - vc - ve + vg, k6 = va - vb - ve + vf
  const k7 = -va + vb + vc - vd + ve - vf - vg + vh

  out.value = (va + ux * k1 + uy * k2 + uz * k3 + ux * uy * k4 + uy * uz * k5 + uz * ux * k6 + ux * uy * uz * k7) * NORM

  out.dx = (lerpGrad(ux, uy, uz, GX[a], GX[b], GX[c], GX[d], GX[e], GX[f], GX[g], GX[h]) + dux * (k1 + uy * k4 + uz * k6 + uy * uz * k7)) * NORM
  out.dy = (lerpGrad(ux, uy, uz, GY[a], GY[b], GY[c], GY[d], GY[e], GY[f], GY[g], GY[h]) + duy * (k2 + uz * k5 + ux * k4 + uz * ux * k7)) * NORM
  out.dz = (lerpGrad(ux, uy, uz, GZ[a], GZ[b], GZ[c], GZ[d], GZ[e], GZ[f], GZ[g], GZ[h]) + duz * (k3 + ux * k6 + uy * k5 + ux * uy * k7)) * NORM
  return out
}

/**
 * 3D gradient noise value only (no derivatives): the fast path used by fBm, ridged noise and warping.
 * Same field as {@link gradientNoise}.
 */
export function noise3(seed: number, x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
  const wx = x - ix, wy = y - iy, wz = z - iz
  const ux = wx * wx * wx * (wx * (wx * 6 - 15) + 10)
  const uy = wy * wy * wy * (wy * (wy * 6 - 15) + 10)
  const uz = wz * wz * wz * (wz * (wz * 6 - 15) + 10)
  let g = hash4(ix, iy, iz, seed) & 15
  const va = GX[g] * wx + GY[g] * wy + GZ[g] * wz
  g = hash4(ix + 1, iy, iz, seed) & 15
  const vb = GX[g] * (wx - 1) + GY[g] * wy + GZ[g] * wz
  g = hash4(ix, iy + 1, iz, seed) & 15
  const vc = GX[g] * wx + GY[g] * (wy - 1) + GZ[g] * wz
  g = hash4(ix + 1, iy + 1, iz, seed) & 15
  const vd = GX[g] * (wx - 1) + GY[g] * (wy - 1) + GZ[g] * wz
  g = hash4(ix, iy, iz + 1, seed) & 15
  const ve = GX[g] * wx + GY[g] * wy + GZ[g] * (wz - 1)
  g = hash4(ix + 1, iy, iz + 1, seed) & 15
  const vf = GX[g] * (wx - 1) + GY[g] * wy + GZ[g] * (wz - 1)
  g = hash4(ix, iy + 1, iz + 1, seed) & 15
  const vg = GX[g] * wx + GY[g] * (wy - 1) + GZ[g] * (wz - 1)
  g = hash4(ix + 1, iy + 1, iz + 1, seed) & 15
  const vh = GX[g] * (wx - 1) + GY[g] * (wy - 1) + GZ[g] * (wz - 1)
  const x00 = va + ux * (vb - va), x10 = vc + ux * (vd - vc), x01 = ve + ux * (vf - ve), x11 = vg + ux * (vh - vg)
  const y0 = x00 + uy * (x10 - x00), y1 = x01 + uy * (x11 - x01)
  return (y0 + uz * (y1 - y0)) * NORM
}

/** Settings of a fractal noise sum. */
export interface FractalOptions {
  /** Base frequency in cycles per metre (1 / feature size). */
  frequency: number
  /** Number of octaves. */
  octaves: number
  /** Frequency multiplier per octave. */
  lacunarity: number
  /** Amplitude multiplier per octave. */
  gain: number
}

const scratch: NoiseSample = { value: 0, dx: 0, dy: 0, dz: 0 }

/**
 * Number of octaves worth evaluating when nothing smaller than `minWavelength` metres can be seen
 * (e.g. a terrain patch's vertex spacing ×2). Skipping invisible octaves keeps far LODs cheap and
 * free of aliasing; `minWavelength = 0` keeps them all.
 */
export function visibleOctaves(o: FractalOptions, minWavelength: number): number {
  if (!(minWavelength > 0)) return o.octaves
  const n = Math.floor(Math.log(1 / (o.frequency * minWavelength)) / Math.log(o.lacunarity)) + 1
  return Math.max(0, Math.min(o.octaves, n))
}

/** Fractal Brownian motion: a sum of gradient-noise octaves, normalised to roughly [-1, 1]. */
export function fbm(seed: number, x: number, y: number, z: number, o: FractalOptions, minWavelength = 0): number {
  const octaves = visibleOctaves(o, minWavelength)
  let sum = 0, amp = 1, norm = 0, f = o.frequency
  for (let i = 0; i < o.octaves; i++) {
    if (i < octaves) sum += amp * noise3(seed + i * 1013, x * f, y * f, z * f)
    norm += amp
    amp *= o.gain
    f *= o.lacunarity
  }
  return sum / norm
}

/**
 * Ridged multifractal (Musgrave): `(1 − |noise|)^sharpness` per octave, each octave weighted by the
 * previous one so ridges stay sharp and valleys smooth. Returns [0, 1].
 */
export function ridged(seed: number, x: number, y: number, z: number, o: FractalOptions, sharpness = 2, minWavelength = 0): number {
  const octaves = visibleOctaves(o, minWavelength)
  let sum = 0, amp = 1, norm = 0, weight = 1, f = o.frequency
  for (let i = 0; i < o.octaves; i++) {
    if (i < octaves) {
      let n = 1 - Math.abs(noise3(seed + i * 2027, x * f, y * f, z * f))
      n = Math.pow(Math.max(n, 0), sharpness) * weight
      weight = Math.min(1, Math.max(0, n * 1.5))
      sum += n * amp
    }
    norm += amp
    amp *= o.gain
    f *= o.lacunarity
  }
  return sum / norm
}

/**
 * "Eroded" fBm (Iñigo Quilez): each octave is damped by the slope accumulated so far, giving smooth
 * valley floors and sharp gullies without simulating erosion. Returns roughly [-1, 1].
 * @param erosion 0 = plain fBm, larger = stronger slope damping.
 */
export function erodedFbm(seed: number, x: number, y: number, z: number, o: FractalOptions, erosion = 1, minWavelength = 0): number {
  const octaves = visibleOctaves(o, minWavelength)
  let sum = 0, amp = 1, norm = 0, dx = 0, dy = 0, dz = 0, f = o.frequency
  for (let i = 0; i < o.octaves; i++) {
    if (i < octaves) {
      const n = gradientNoise(seed + i * 3001, x * f, y * f, z * f, scratch)
      dx += n.dx; dy += n.dy; dz += n.dz
      sum += (amp * n.value) / (1 + erosion * (dx * dx + dy * dy + dz * dz))
    }
    norm += amp
    amp *= o.gain
    f *= o.lacunarity
  }
  return sum / norm
}

/** A mutable 3D point. */
export type Vec3 = [x: number, y: number, z: number]

/**
 * Domain warp: offsets a point by three fBm fields so features lose their grid alignment. Writes the
 * warped point into `out` and returns it.
 */
export function warp(seed: number, x: number, y: number, z: number, frequency: number, amount: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const o = { frequency, octaves: 2, lacunarity: 2, gain: 0.5 }
  out[0] = x + amount * fbm(seed + 17, x, y, z, o)
  out[1] = y + amount * fbm(seed + 31, x + 5.2, y + 1.3, z + 7.1, o)
  out[2] = z + amount * fbm(seed + 47, x - 3.7, y + 9.2, z - 2.8, o)
  return out
}

/** Result of a cellular (Worley) query. */
export interface CellSample {
  /** Distance to the nearest feature point, in cells. */
  distance: number
  /** Feature point of the nearest cell, in cell units. */
  point: Vec3
  /** A stable random number in [0, 1) for the nearest cell. */
  random: number
}

/** 3D cellular noise: nearest of one jittered feature point per cell. Coordinates are in cell units. */
export function cellular(seed: number, x: number, y: number, z: number, jitter = 1, out: CellSample = { distance: 0, point: [0, 0, 0], random: 0 }): CellSample {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
  out.distance = Infinity
  for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = ix + i, cy = iy + j, cz = iz + k
    const px = cx + 0.5 + (hash01(cx, cy, cz, seed) - 0.5) * jitter
    const py = cy + 0.5 + (hash01(cx, cy, cz, seed + 1) - 0.5) * jitter
    const pz = cz + 0.5 + (hash01(cx, cy, cz, seed + 2) - 0.5) * jitter
    const d = Math.hypot(px - x, py - y, pz - z)
    if (d < out.distance) {
      out.distance = d
      out.point[0] = px; out.point[1] = py; out.point[2] = pz
      out.random = hash01(cx, cy, cz, seed + 3)
    }
  }
  return out
}

/** Hermite smoothstep from `a` to `b` (works with `a > b` for a falling edge). */
export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Clamps `x` to [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

/** Piecewise-linear curve through `[x, y]` points sorted by x; flat beyond the ends. */
export function curve(points: readonly (readonly [number, number])[], x: number): number {
  if (x <= points[0][0]) return points[0][1]
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]
    if (x <= x1) {
      const [x0, y0] = points[i - 1]
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
    }
  }
  return points[points.length - 1][1]
}
