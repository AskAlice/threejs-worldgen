// Shared pieces of the vehicle generators: paints, seeded helpers, the model wrapper and wheels.
import { FINISH, MeshBuilder, paint, type MeshData, type Paint, type Vec3 } from './mesh.ts'
import type { ModelPart, VehicleDomain, VehicleModel, VehicleParams, VehicleType } from './models.ts'

/** A seeded random source, 0…1. */
export type Rand = () => number

// Shared paints.
export const TYRE = paint('#1a1a1c', 0, 0, FINISH.rubber)
export const RIM = paint('#a9aeb4')
export const TRIM = paint('#2b2c30')
export const DARK = paint('#141518')
export const GLASS = paint('#1f2c36', 0, 0.05, FINISH.glass)
export const LIT = paint('#2c3b46', 0, 0.4, FINISH.glass)
export const HEAD = paint('#b4bbc1', 0, 1, FINISH.glass)
export const TAIL = paint('#b0141c', 0, 0.8, FINISH.glass)
export const BODY = paint('#ffffff', 1)
export const WHITE = paint('#eceef0')
export const GREY = paint('#9aa1a8')
export const CHROME = paint('#d9dcdf', 0, 0, FINISH.chrome)
export const BRUSHED = paint('#b4b7b9', 0, 0, FINISH.brushed)
export const PLASTIC = paint('#1c1d20', 0, 0, FINISH.rubber)

export const pick = <T>(rand: Rand, list: readonly T[]): T => list[Math.floor(rand() * list.length) % list.length]
export const jitter = (rand: Rand, amount: number) => 1 + (rand() * 2 - 1) * amount
export const num = (p: VehicleParams, k: string) => Number(p[k])
export const str = (p: VehicleParams, k: string) => String(p[k])
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Wraps parts into a {@link VehicleModel}, with the bounding size measured from the mounted parts. */
export function model(type: VehicleType, style: string, domain: VehicleDomain, parts: ModelPart[], extra: Partial<VehicleModel> = {}): VehicleModel {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (const part of parts) for (const m of part.mounts) for (let k = 0; k < 3; k++) {
    b[k] = Math.min(b[k], part.mesh.bounds[k] + m.position[k])
    b[k + 3] = Math.max(b[k + 3], part.mesh.bounds[k + 3] + m.position[k])
  }
  return {
    type, style, domain, parts, size: [b[3] - b[0], b[4] - b[1], b[5] - b[2]],
    wheelBase: 0, exhausts: [], vents: [], hosts: [], stages: 0, palette: ['#ffffff'], wake: 0, bank: 0, trim: 0, ...extra,
  }
}

/** The static body part. */
export const body = (mesh: MeshData): ModelPart => ({ name: 'body', mesh, mounts: [{ position: [0, 0, 0] }] })

/** A road wheel along x: tyre, hub and a spoke bar so the spin reads. */
export function roadWheel(r: number, w: number, bike = false): MeshData {
  const m = new MeshBuilder()
  if (bike) {
    m.tube('x', [0, 0, 0], r, r - w * 0.9, w, TYRE, 18)
    m.cylinder('x', [0, 0, 0], r * 0.08, w * 2, RIM, 6)
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI
      m.beam([0, Math.sin(a) * (r - w), Math.cos(a) * (r - w)], [0, -Math.sin(a) * (r - w), -Math.cos(a) * (r - w)], 0.012, RIM)
    }
  } else {
    m.cylinder('x', [0, 0, 0], r, w, TYRE, 12, r, TYRE)
    m.cylinder('x', [0, 0, 0], r * 0.62, w * 1.04, RIM, 10)
    m.box([0, 0, 0], [w * 1.1, r * 0.95, r * 0.18], DARK)
  }
  return m.build()
}

/** Wheel looks: how the face of the rim is made. */
export type RimStyle = 'spokes' | 'split' | 'mesh' | 'aero' | 'steel' | 'artillery' | 'dish'

/** Options of {@link smoothWheel}. */
export interface WheelLook {
  /** Rim face. */
  rim: RimStyle
  /** Spokes (spokes, split, artillery, mesh). */
  spokes: number
  /** Rim radius / tyre radius (low-profile tyres ≈ 0.75, balloon tyres ≈ 0.55). */
  ratio: number
  /** Rim paint. */
  color: Paint
  /** Inner barrel and hub paint. */
  hub?: Paint
}

/**
 * A smooth road wheel along x (outer face towards +x; mount mirrored for the left side): a lathed tyre
 * with rounded shoulders and sidewall bulge, a dished rim and a spoke pattern so the spin reads.
 */
export function smoothWheel(r: number, w: number, look: WheelLook): MeshData {
  const m = new MeshBuilder()
  wheelInto(m, r, w, look)
  return m.build()
}

/** Twin tyres on one hub (truck drive and trailer axles): outer face towards +x, `gap` metres apart. */
export function dualWheel(r: number, w: number, look: WheelLook, gap = 0.04): MeshData {
  const m = new MeshBuilder()
  m.group([(w + gap) / 2, 0, 0], [0, 0, 0], () => wheelInto(m, r, w, look))
  m.group([-(w + gap) / 2, 0, 0], [0, Math.PI, 0], () => wheelInto(m, r, w, { ...look, rim: 'steel' }))
  return m.build()
}

/** Adds a {@link smoothWheel} to `m`. */
export function wheelInto(m: MeshBuilder, r: number, w: number, look: WheelLook): void {
  const rr = r * look.ratio, h = w / 2
  // Tyre: tread, rounded shoulders, bulging sidewalls down to the bead at the rim.
  const prof: [number, number][] = []
  const shoulder = Math.min(w * 0.22, (r - rr) * 0.45)
  for (let k = 0; k <= 4; k++) { const a = (k / 4) * Math.PI / 2; prof.push([r - shoulder + Math.cos(a) * shoulder, -h + shoulder - Math.sin(a) * shoulder]) }
  prof.reverse()
  const tyre: [number, number][] = [[rr * 0.98, -h * 0.82], [rr + (r - rr) * 0.35, -h * 1.02], ...prof.slice(1)]
  const top = tyre.map(([a, b]) => [a, -b] as [number, number]).reverse()
  m.lathe('x', [0, 0, 0], [...tyre, ...top], TYRE, 32)
  const hub = look.hub ?? DARK
  // Rim barrel (dark inside) and the face, set into the outer side.
  m.lathe('x', [0, 0, 0], [[rr * 0.98, h * 0.82], [rr * 0.98, -h * 0.7], [rr * 0.2, -h * 0.6]], hub, 28)
  const face = h * 0.62
  const c = look.color
  m.lathe('x', [0, 0, 0], [[rr * 0.985, h * 0.86], [rr * 0.9, h * 0.8], [rr * 0.86, face]], c, 28)
  const spoke = (a: number, wIn: number, wOut: number, depth: number, s: Paint) => {
    const u: Vec3 = [0, Math.cos(a), Math.sin(a)], v: Vec3 = [0, -Math.sin(a), Math.cos(a)]
    m.fin([[rr * 0.2, -wIn], [rr * 0.88, -wOut], [rr * 0.88, wOut], [rr * 0.2, wIn]], [face - depth / 2, 0, 0], u, v, depth, s)
  }
  if (look.rim === 'aero') {
    m.lathe('x', [0, 0, 0], [[rr * 0.88, face], [rr * 0.6, face + h * 0.08], [rr * 0.2, face + h * 0.1], [0.001, face + h * 0.1]], c, 28)
    for (let k = 0; k < 5; k++) spoke((k / 5) * Math.PI * 2, rr * 0.03, rr * 0.05, 0.012, DARK)
  } else if (look.rim === 'steel' || look.rim === 'dish') {
    m.lathe('x', [0, 0, 0], [[rr * 0.88, face], [rr * 0.7, face - h * 0.15], [rr * 0.45, face - h * 0.1], [rr * 0.3, face + h * 0.05], [0.001, face + h * 0.08]], c, 24)
    for (let k = 0; k < (look.rim === 'steel' ? 6 : 4); k++) {
      const a = (k / 6) * Math.PI * 2
      m.cylinder('x', [face - h * 0.1, Math.cos(a) * rr * 0.56, Math.sin(a) * rr * 0.56], rr * 0.07, 0.02, DARK, 8)
    }
  } else if (look.rim === 'artillery') {
    m.cylinder('x', [face - 0.02, 0, 0], rr * 0.22, 0.12, hub, 12)
    for (let k = 0; k < look.spokes; k++) {
      const a = (k / look.spokes) * Math.PI * 2
      m.beam([face - 0.05, Math.cos(a) * rr * 0.18, Math.sin(a) * rr * 0.18], [face - 0.05, Math.cos(a) * rr * 0.9, Math.sin(a) * rr * 0.9], 0.035, c)
    }
  } else {
    m.lathe('x', [0, 0, 0], [[rr * 0.24, face - h * 0.05], [rr * 0.2, face + h * 0.05], [0.001, face + h * 0.06]], look.rim === 'mesh' ? c : hub, 16)
    const n = look.spokes
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2
      if (look.rim === 'split') for (const d of [-0.09, 0.09]) spoke(a + d, rr * 0.05, rr * 0.035, h * 0.3, c)
      else if (look.rim === 'mesh') { spoke(a, rr * 0.025, rr * 0.02, h * 0.25, c); spoke(a + Math.PI / n, rr * 0.02, rr * 0.03, h * 0.15, c) }
      else spoke(a, rr * 0.09, rr * 0.07, h * 0.3, c)
    }
  }
}

/** Monotone cubic interpolation through `(x, y)` keys (sorted by x): smooth body lines with no overshoot. */
export function curve(keys: [number, number][]): (x: number) => number {
  const n = keys.length
  const xs = keys.map((k) => k[0]), ys = keys.map((k) => k[1])
  const d: number[] = [], m: number[] = new Array(n).fill(0)
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-9, xs[i + 1] - xs[i]))
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (3 * (xs[i + 1] - xs[i - 1])) / ((2 * xs[i + 1] - xs[i] - xs[i - 1]) / d[i - 1] + (xs[i + 1] + xs[i] - 2 * xs[i - 1]) / d[i])
  if (n > 1) { m[0] = d[0]; m[n - 1] = d[n - 2] }
  return (x: number) => {
    if (n === 1 || x <= xs[0]) return ys[0]
    if (x >= xs[n - 1]) return ys[n - 1]
    let i = 0
    while (x > xs[i + 1]) i++
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h
    const t2 = t * t, t3 = t2 * t
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1]
  }
}
