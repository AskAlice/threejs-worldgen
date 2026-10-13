// 3×3 singular value decomposition for MPM plasticity, on the GPU (TSL) and the CPU (plain numbers). One generic
// implementation runs on either through a tiny arithmetic interface, so the TSL and TypeScript versions are the same
// straight-line maths by construction: cyclic Jacobi on AᵀA (fixed sweeps, no data-dependent branches), sorting, and
// a Givens QR of A·V (McAdams et al. 2011, "Computing the singular value decomposition of 3×3 matrices with minimal
// branching and elementary floating point operations"), which stays accurate for rank-deficient and reflected A.
import { abs, float, mat3, select, sqrt, vec3 } from 'three/tsl'
import type { Mat3 } from './mpm-materials.ts'

/**
 * The arithmetic {@link svd3Generic} and friends run on: plain numbers ({@link NUMBER_OPS}) or TSL float nodes
 * ({@link NODE_OPS}). `v` pins a value (a TSL `.toVar()`, so the generated shader stays linear; identity on numbers).
 */
export interface MPMOps<T> {
  add(a: T, b: T): T
  sub(a: T, b: T): T
  mul(a: T, b: T): T
  div(a: T, b: T): T
  sqrt(a: T): T
  /** `c < 0 ? a : b`, branch-free on the GPU. */
  neg(c: T, a: T, b: T): T
  /** `|c| < eps ? a : b`. */
  tiny(c: T, eps: number, a: T, b: T): T
  min(a: T, b: T): T
  max(a: T, b: T): T
  exp(a: T): T
  log(a: T): T
  num(x: number): T
  v(a: T): T
}

/** {@link MPMOps} on plain numbers (float64). */
export const NUMBER_OPS: MPMOps<number> = {
  add: (a, b) => a + b, sub: (a, b) => a - b, mul: (a, b) => a * b, div: (a, b) => a / b, sqrt: Math.sqrt,
  neg: (c, a, b) => (c < 0 ? a : b), tiny: (c, eps, a, b) => (Math.abs(c) < eps ? a : b),
  min: Math.min, max: Math.max, exp: Math.exp, log: Math.log, num: (x) => x, v: (a) => a,
}

const node = (a: any) => (typeof a === 'number' ? float(a) : a)
/** {@link MPMOps} on TSL float nodes. */
export const NODE_OPS: MPMOps<any> = {
  add: (a, b) => node(a).add(b), sub: (a, b) => node(a).sub(b), mul: (a, b) => node(a).mul(b), div: (a, b) => node(a).div(b),
  sqrt: (a) => sqrt(a), neg: (c, a, b) => select(node(c).lessThan(0), node(a), node(b)),
  tiny: (c, eps, a, b) => select(abs(c).lessThan(eps), node(a), node(b)),
  min: (a, b) => node(a).min(b), max: (a, b) => node(a).max(b), exp: (a) => node(a).exp(), log: (a) => node(a).log(), num: (x) => float(x), v: (a) => node(a).toVar(),
}

/** Jacobi sweeps over AᵀA (3 rotations each). Quadratic convergence: 4 reach float precision for any 3×3. */
export const SVD_SWEEPS = 4
const EPS = 1e-37 // the smallest normal float32 is 1.2e-38: AᵀA entries below this count as zero (full precision for |A| above ~1e-12)

/**
 * A = U·diag(S)·Vᵀ for a column-major 3×3 `a` (`a[col * 3 + row]`), on any {@link MPMOps}. U and V are rotations
 * (det +1), S is sorted by magnitude, S[0] ≥ S[1] ≥ |S[2]|, and S[2] < 0 when det A < 0. Branch-free and the same
 * operation sequence on every backend. Degenerate input is fine: the zero matrix gives U = V = I, S = 0.
 */
export function svd3Generic<T>(o: MPMOps<T>, a: T[]): { U: T[]; S: T[]; V: T[] } {
  const at = (m: T[], r: number, c: number) => m[c * 3 + r]
  // S = AᵀA, symmetric: s[i][j], kept as a full 3×3 of scalars for simple indexing.
  const s: T[][] = [0, 1, 2].map((i) => [0, 1, 2].map((j) => o.num(0)))
  for (let i = 0; i < 3; i++) for (let j = i; j < 3; j++) {
    let sum = o.mul(at(a, 0, i), at(a, 0, j))
    for (let k = 1; k < 3; k++) sum = o.add(sum, o.mul(at(a, k, i), at(a, k, j)))
    s[i][j] = s[j][i] = o.v(sum)
  }
  // V accumulates the rotations: v[row][col].
  const V: T[][] = [0, 1, 2].map((i) => [0, 1, 2].map((j) => o.num(i === j ? 1 : 0)))
  for (let sweep = 0; sweep < SVD_SWEEPS; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const r = 3 - p - q
      const apq = s[p][q]
      // t = tan of the rotation angle (Numerical Recipes `jacobi`), 0 when the entry is already zero.
      const theta = o.div(o.sub(s[q][q], s[p][p]), o.mul(o.num(2), o.tiny(apq, EPS, o.num(1), apq)))
      const t0 = o.div(o.num(1), o.add(o.max(theta, o.sub(o.num(0), theta)), o.sqrt(o.add(o.mul(theta, theta), o.num(1)))))
      const t = o.v(o.tiny(apq, EPS, o.num(0), o.neg(theta, o.sub(o.num(0), t0), t0)))
      const c = o.v(o.div(o.num(1), o.sqrt(o.add(o.mul(t, t), o.num(1)))))
      const sn = o.v(o.mul(t, c))
      const app = o.v(o.sub(s[p][p], o.mul(t, apq))), aqq = o.v(o.add(s[q][q], o.mul(t, apq)))
      const arp = o.v(o.sub(o.mul(c, s[r][p]), o.mul(sn, s[r][q]))), arq = o.v(o.add(o.mul(sn, s[r][p]), o.mul(c, s[r][q])))
      s[p][p] = app; s[q][q] = aqq; s[p][q] = s[q][p] = o.num(0)
      s[r][p] = s[p][r] = arp; s[r][q] = s[q][r] = arq
      for (let k = 0; k < 3; k++) {
        const vp = V[k][p], vq = V[k][q]
        V[k][p] = o.v(o.sub(o.mul(c, vp), o.mul(sn, vq)))
        V[k][q] = o.v(o.add(o.mul(sn, vp), o.mul(c, vq)))
      }
    }
  }
  // Sort the eigenvalues of AᵀA (σ²) descending, swapping V's columns (one negated, so det V stays +1).
  const d = [s[0][0], s[1][1], s[2][2]]
  for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
    const swap = o.v(o.sub(d[i], d[j])) // < 0: swap
    const di = d[i], dj = d[j]
    d[i] = o.v(o.neg(swap, dj, di)); d[j] = o.v(o.neg(swap, di, dj))
    for (let k = 0; k < 3; k++) {
      const vi = V[k][i], vj = V[k][j]
      V[k][i] = o.v(o.neg(swap, vj, vi))
      V[k][j] = o.v(o.neg(swap, o.sub(o.num(0), vi), vj))
    }
  }
  // B = A·V, then B = U·R by Givens rotations; R's diagonal holds the singular values (signed in the last one).
  const B: T[][] = [0, 1, 2].map((i) => [0, 1, 2].map((j) => {
    let sum = o.mul(at(a, i, 0), V[0][j])
    for (let k = 1; k < 3; k++) sum = o.add(sum, o.mul(at(a, i, k), V[k][j]))
    return o.v(sum)
  }))
  const U: T[][] = [0, 1, 2].map((i) => [0, 1, 2].map((j) => o.num(i === j ? 1 : 0)))
  for (const [p, q, col] of [[0, 1, 0], [0, 2, 0], [1, 2, 1]]) {
    const x = B[p][col], y = B[q][col]
    const rho = o.v(o.sqrt(o.add(o.mul(x, x), o.mul(y, y))))
    const safe = o.tiny(rho, EPS, o.num(1), rho)
    const c = o.v(o.tiny(rho, EPS, o.num(1), o.div(x, safe))), sn = o.v(o.tiny(rho, EPS, o.num(0), o.div(y, safe)))
    for (let k = 0; k < 3; k++) {
      const bp = B[p][k], bq = B[q][k]
      B[p][k] = o.v(o.add(o.mul(c, bp), o.mul(sn, bq)))
      B[q][k] = o.v(o.sub(o.mul(c, bq), o.mul(sn, bp)))
      const up = U[k][p], uq = U[k][q]
      U[k][p] = o.v(o.add(o.mul(c, up), o.mul(sn, uq)))
      U[k][q] = o.v(o.sub(o.mul(c, uq), o.mul(sn, up)))
    }
  }
  const flat = (m: T[][]) => [0, 1, 2].flatMap((c) => [m[0][c], m[1][c], m[2][c]])
  return { U: flat(U), S: [B[0][0], B[1][1], B[2][2]], V: flat(V) }
}

/** U·diag(s)·Vᵀ (column-major), on any {@link MPMOps}. */
export function usvGeneric<T>(o: MPMOps<T>, U: T[], s: T[], V: T[]): T[] {
  const out: T[] = []
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) {
    let sum = o.mul(o.mul(U[r], s[0]), V[c])
    for (let k = 1; k < 3; k++) sum = o.add(sum, o.mul(o.mul(U[k * 3 + r], s[k]), V[k * 3 + c]))
    out.push(o.v(sum))
  }
  return out
}

/** SVD of a column-major 3×3 on the CPU: A = U·diag(S)·Vᵀ (see {@link svd3Generic}). */
export function svd3(a: Mat3): { U: Mat3; S: [number, number, number]; V: Mat3 } {
  const r = svd3Generic(NUMBER_OPS, a)
  return { U: r.U, S: r.S as [number, number, number], V: r.V }
}

/** A TSL `mat3` node as 9 column-major float nodes. */
export function mat3Scalars(m: any): any[] {
  return [0, 1, 2].flatMap((c) => { const col = m.element(c); return [col.x, col.y, col.z] })
}

/** 9 column-major float nodes as a TSL `mat3`. */
export function scalarsMat3(s: any[]): any {
  return (mat3 as any)(vec3(s[0], s[1], s[2]), vec3(s[3], s[4], s[5]), vec3(s[6], s[7], s[8]))
}

/** SVD of a TSL `mat3` node (inline shader code): U and V as `mat3`, S as `vec3` (see {@link svd3Generic}). */
export function svd3Node(F: any): { U: any; S: any; V: any } {
  const r = svd3Generic(NODE_OPS, mat3Scalars(F))
  return { U: scalarsMat3(r.U), S: vec3(r.S[0], r.S[1], r.S[2]), V: scalarsMat3(r.V) }
}
