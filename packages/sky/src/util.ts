/**
 * Small shared helpers: seeded randomness, plain-data merging and 3D vector/matrix maths on number
 * arrays (float64, so true positions millions of kilometres away stay exact). No three.js here, so
 * everything that uses it runs in workers and under `node --test`.
 */

/** A 3D vector as a plain array. */
export type Vec3 = [number, number, number]

/** A 3×3 matrix as 9 numbers in column-major order (the same layout as three's `Matrix3.elements`). */
export type Mat3 = [number, number, number, number, number, number, number, number, number]

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

/** 32-bit hash of up to three integers. */
export function hash3(a: number, b: number, c = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/** Recursive partial: nested objects become partial too, arrays are replaced whole. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object | null ? DeepPartial<NonNullable<T[K]>> | Extract<T[K], null> : T[K]
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype

/** Deep-merges plain-data `input` into `target` (mutating it): objects merge, arrays and values replace, `undefined` is skipped. */
export function merge<T>(target: T, input: unknown): T {
  if (!isPlain(input)) return target
  const t = target as Record<string, unknown>
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue
    t[k] = isPlain(v) && isPlain(t[k]) ? merge(t[k], v) : isPlain(v) ? merge({}, v) : v
  }
  return target
}

/** Clamps `x` to [lo, hi]. */
export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)
/** Hermite smoothstep from `a` to `b` (a > b reverses it). */
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
/** Degrees → radians. */
export const DEG = Math.PI / 180

/** Dot product. */
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
/** Length. */
export const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
/** Cross product into `out`. */
export function cross(a: Vec3, b: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0]
  out[0] = x; out[1] = y; out[2] = z
  return out
}
/** `a - b` into `out`. */
export function sub(a: Vec3, b: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2]
  return out
}
/** Unit vector into `out` (zero stays zero). */
export function normalize(a: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const l = length(a) || 1
  out[0] = a[0] / l; out[1] = a[1] / l; out[2] = a[2] / l
  return out
}

/** Identity matrix. */
export const identity = (): Mat3 => [1, 0, 0, 0, 1, 0, 0, 0, 1]
/** Rotation about +X by `a` radians. */
export const rotationX = (a: number): Mat3 => {
  const c = Math.cos(a), s = Math.sin(a)
  return [1, 0, 0, 0, c, s, 0, -s, c]
}
/** Rotation about +Y by `a` radians (turns +Z towards +X). */
export const rotationY = (a: number): Mat3 => {
  const c = Math.cos(a), s = Math.sin(a)
  return [c, 0, -s, 0, 1, 0, s, 0, c]
}
/** Matrix whose columns are `x`, `y`, `z`. */
export const fromColumns = (x: Vec3, y: Vec3, z: Vec3): Mat3 => [x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]]
/** `a · b`. */
export function mulMat(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9) as Mat3
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2]
  return o
}
/** Transpose (the inverse of a rotation). */
export const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
/** `m · v` into `out`. */
export function mulVec(m: Mat3, v: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const x = m[0] * v[0] + m[3] * v[1] + m[6] * v[2]
  const y = m[1] * v[0] + m[4] * v[1] + m[7] * v[2]
  const z = m[2] * v[0] + m[5] * v[1] + m[8] * v[2]
  out[0] = x; out[1] = y; out[2] = z
  return out
}
/** `mᵀ · v` into `out` (inverse rotation). */
export function mulVecT(m: Mat3, v: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const x = m[0] * v[0] + m[1] * v[1] + m[2] * v[2]
  const y = m[3] * v[0] + m[4] * v[1] + m[5] * v[2]
  const z = m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
  out[0] = x; out[1] = y; out[2] = z
  return out
}

/**
 * Approximate linear-light RGB of a black body at `kelvin` (1000–40000 K), normalised so the
 * brightest channel is 1. Tanner Helland's fit, converted from sRGB to linear.
 */
export function kelvinToRgb(kelvin: number): Vec3 {
  const t = clamp(kelvin, 1000, 40000) / 100
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592)
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492)
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307
  const lin = (c: number) => Math.pow(clamp(c, 0, 255) / 255, 2.2)
  const out: Vec3 = [lin(r), lin(g), lin(b)]
  const m = Math.max(...out)
  return [out[0] / m, out[1] / m, out[2] / m]
}

/** Parses `#rgb` / `#rrggbb` into linear RGB 0..1. */
export function hexToLinear(hex: string): Vec3 {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h, 16)
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)]
}
