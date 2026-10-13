// Smooth lofted car bodies: a lower body (bonnet, flanks, boot, bumpers with wheel arches cut out of
// it) and a glasshouse (windscreen, side and rear glass with roof and pillars painted onto it), both
// lofted through superellipse cross-sections along the length and smooth-shaded, plus helpers that put
// lamps, grilles and trim onto the surface. Shared by the car lookalikes, pickups and truck cabs.
import { type MeshBuilder, type Paint, type Vec3 } from './mesh.ts'
import { BODY, DARK, GLASS, PLASTIC, curve } from './kit.ts'

/** A lofted body, in metres; profile keys are `[u, value]` with u = 0 at the rear bumper, 1 at the front. */
export interface BodyProfile {
  /** Length, width (no mirrors), height. */
  L: number
  W: number
  H: number
  /** Wheel centres along z (vehicle space) and tyre radius: arches are cut around them. */
  axles: number[]
  r: number
  /** Arch radius / tyre radius. */
  arch?: number
  /** Top line of the lower body (bonnet, waist, boot), metres. */
  belt: [number, number][]
  /** Bottom line (bumpers, sills), metres. */
  bottom: [number, number][]
  /** Half width / (W / 2). */
  plan: [number, number][]
  /** Where the flanks are widest, 0 (bottom) … 1 (top). Default 0.45. */
  split?: number
  /** Superellipse exponents of the lower body above and below its widest line (2 round … 8 boxy). */
  eTop?: number
  eBot?: number
  /** Taper of the flanks towards the top and the bottom (0 = none). */
  tuck?: [top: number, bottom: number]
  /** Corner radii of the rear and front ends, metres. */
  fillet?: [rear: number, front: number]
  /** Glasshouse top line from the rear glass base to the windscreen base; omit for none. */
  roof?: [number, number][]
  /** Glasshouse half width at its base / lower-body half width. Default 0.92. */
  glassW?: number
  /** Glasshouse half width at the roof / at its base (tumblehome). Default 0.74. */
  topW?: number
  /** Glasshouse squareness. Default 2.6. */
  eGlass?: number
  /** u range of the painted roof panel (outside it the top is windscreen or rear glass). */
  roofSpan?: [number, number]
  /** u of B pillars (and further door pillars). */
  pillars?: number[]
  /** Side glass ends at this u (behind it, the C pillar is painted). */
  cPillar?: number
  /** Side glass starts at this u (in front of it, a painted A pillar root, e.g. a fixed quarter panel). */
  aPillar?: number
  /** Paints. */
  paint?: Paint
  roofPaint?: Paint
  pillarPaint?: Paint
  /** u range of an open cockpit: the top of the lower body there is interior. */
  cockpit?: [number, number]
  interior?: Paint
}

/** A built body: the profile functions, for placing details on it. */
export interface Body {
  /** z of a u. */
  z(u: number): number
  /** Lower-body cross-section at z. */
  section(z: number): { w: number; top: number; low: number; mid: number; cut: number }
  /** Half width of the lower body at z and height y (−1 outside it). */
  half(z: number, y: number): number
  /** Lower body top at z. */
  top(z: number): number
  /** Roof line at z (lower-body top outside the glasshouse). */
  roof(z: number): number
  /**
   * The body surface at (x, y) seen from the front (`dir` 1) or rear (−1): its z and the outward
   * normal's yaw. Null if (x, y) misses the body.
   */
  end(x: number, y: number, dir: 1 | -1): { z: number; yaw: number } | null
}

const RING = 32

/** Points of a body cross-section ring at z (see {@link BodyProfile}). */
function ring(z: number, w: number, top: number, low: number, mid: number, cut: number, eT: number, eB: number, tT: number, tB: number): Vec3[] {
  const half = (y: number) => {
    const up = y >= mid
    const yn = Math.min(1, up ? (y - mid) / Math.max(1e-6, top - mid) : (mid - y) / Math.max(1e-6, mid - low))
    const e = up ? eT : eB
    return w * (1 - yn ** e) ** (1 / e) * (1 - (up ? tT : tB) * yn * yn)
  }
  const pts: Vec3[] = []
  for (let j = 0; j < RING; j++) {
    const a = (j / RING) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a)
    const up = s >= 0, e = up ? eT : eB, p = 2 / e
    const yn = Math.sign(s) * Math.abs(s) ** p
    let y = mid + yn * (up ? top - mid : mid - low)
    let x = w * Math.sign(c) * Math.abs(c) ** p * (1 - (up ? tT : tB) * yn * yn)
    if (y < cut) {
      y = cut
      x = Math.sign(x) * Math.min(Math.abs(x), half(cut))
    }
    pts.push([x, y, z])
  }
  return pts
}

/** Sorted, de-duplicated stations along z. */
function stations(z0: number, z1: number, step: number, extra: number[]): number[] {
  const out: number[] = []
  for (let z = z0; z < z1; z += step) out.push(z)
  out.push(z1, ...extra.filter((z) => z > z0 && z < z1))
  out.sort((a, b) => a - b)
  return out.filter((z, i) => i === 0 || z - out[i - 1] > 0.004)
}

/** Lofts a {@link BodyProfile} into `m` and returns its profile functions. */
export function loftBody(m: MeshBuilder, P: BodyProfile): Body {
  const { L, W, r } = P
  const belt = curve(P.belt), bottom = curve(P.bottom), plan = curve(P.plan)
  const roofLine = P.roof ? curve(P.roof) : null
  const eT = P.eTop ?? 3.2, eB = P.eBot ?? 6, [tT, tB] = P.tuck ?? [0.06, 0.12], split = P.split ?? 0.45
  const [fr, ff] = P.fillet ?? [0.15, 0.15]
  const R = r * (P.arch ?? 1.14) + 0.02
  const uOf = (z: number) => z / L + 0.5
  const zOf = (u: number) => (u - 0.5) * L
  const shrink = (z: number) => {
    const df = L / 2 - z, dr = z + L / 2
    let k = 0
    if (df < ff) { const t = 1 - df / ff; k = Math.max(k, ff * (1 - Math.sqrt(Math.max(0, 1 - t * t)))) }
    if (dr < fr) { const t = 1 - dr / fr; k = Math.max(k, fr * (1 - Math.sqrt(Math.max(0, 1 - t * t)))) }
    return k
  }
  const archAt = (z: number) => {
    let y = -Infinity
    for (const zc of P.axles) {
      const d = Math.abs(z - zc)
      if (d < R) y = Math.max(y, r + Math.sqrt(R * R - d * d))
    }
    return y
  }
  const section = (z: number) => {
    const u = uOf(z), k = shrink(z)
    const w = Math.max(0.05, (W / 2) * plan(u) - k)
    const top = belt(u) - k * 0.3
    const sill = Math.min(top - 0.05, bottom(u) + k * 0.45)
    // The widest line stays above the arches, and over an arch the flank rolls under to the arch line
    // (the ring is squashed, not clipped), so the grid never shears and the arch lip shades cleanly.
    const mid = Math.min(top - 0.04, Math.max(sill + (top - sill) * split, P.axles.length ? r + R + 0.03 : -Infinity))
    const arch = archAt(z)
    const low = Math.min(mid - 0.02, Math.max(sill, arch))
    return { w, top, low, mid, cut: arch > sill ? low : -Infinity }
  }
  const half = (z: number, y: number) => {
    const s = section(z)
    if (y > s.top || y < Math.max(s.low, s.cut)) return -1
    const up = y >= s.mid
    const yn = Math.min(1, up ? (y - s.mid) / Math.max(1e-6, s.top - s.mid) : (s.mid - y) / Math.max(1e-6, s.mid - s.low))
    const e = up ? eT : eB
    return s.w * (1 - yn ** e) ** (1 / e) * (1 - (up ? tT : tB) * yn * yn)
  }

  // Lower body: dense stations at the rounded ends, the arch edges and the pillars.
  const extra: number[] = []
  for (let k = 0; k <= 8; k++) {
    const a = (k / 8) * Math.PI / 2
    extra.push(L / 2 - ff + ff * Math.sin(a), -L / 2 + fr - fr * Math.sin(a))
  }
  // Arches: dense round the curve, and a clean step at each edge.
  for (const zc of P.axles) {
    for (let k = -12; k <= 12; k++) extra.push(zc + R * Math.sin((k / 12) * Math.PI / 2))
    for (const d of [-R - 0.002, -R + 0.002, R - 0.002, R + 0.002]) extra.push(zc + d)
  }
  const zs = stations(-L / 2, L / 2, 0.07, extra)
  const secs = zs.map(section)
  const rows = zs.map((z, i) => { const s = secs[i]; return ring(z, s.w, s.top, s.low, s.mid, -Infinity, eT, eB, tT, tB) })
  const paintBody = P.paint ?? BODY
  const cockpit = P.cockpit
  m.surface(rows, (i, j) => {
    const a = rows[i][j], b = rows[i + 1][(j + 1) % RING]
    const z = (a[2] + b[2]) / 2, x = Math.abs(a[0] + b[0]) / 2
    const sMid = Math.sin(((j + 0.5) / RING) * Math.PI * 2)
    const sec = section(z)
    if (sMid < -0.45 && (secs[i].cut > -Infinity || secs[i + 1].cut > -Infinity)) return PLASTIC // arch liner
    if (sMid < -0.85) return DARK // underbody
    if (cockpit && sMid > 0.3 && x < sec.w * 0.84) {
      const u = uOf(z)
      if (u > cockpit[0] && u < cockpit[1]) return P.interior ?? DARK
    }
    return paintBody
  }, true, [paintBody, paintBody])
  // Wheel wells: the inner walls behind the arches, kept under the bonnet and boot lid.
  for (const zc of P.axles) {
    const top = Math.min(r + R, Math.min(section(zc - R).top, section(zc + R).top, section(zc).top) - 0.08)
    m.box([0, (r * 0.4 + top) / 2, zc], [W * 0.62, top - r * 0.4, R * 2], PLASTIC)
  }

  // Glasshouse.
  if (P.roof && roofLine) {
    const u0 = P.roof[0][0], u3 = P.roof[P.roof.length - 1][0]
    const span = P.roofSpan ?? [u0, u3]
    const gx: number[] = [...span, ...(P.pillars ?? []).flatMap((u) => [u - 0.012, u + 0.012])]
    if (P.cPillar !== undefined) gx.push(P.cPillar)
    if (P.aPillar !== undefined) gx.push(P.aPillar)
    for (const [u] of P.roof) gx.push(u)
    const gz = stations(zOf(u0), zOf(u3), 0.045, gx.map(zOf))
    const glassW = P.glassW ?? 0.92, topW = P.topW ?? 0.74, eG = P.eGlass ?? 2.6
    const grows = gz.map((z) => {
      const u = uOf(z), s = section(z), w = (W / 2) * plan(u) * glassW
      // Sit the base below the shoulders under the glass's own edge, so no edge shows above the bonnet.
      const xn = Math.min(0.999, w / Math.max(1e-6, s.w))
      const shoulder = s.mid + (s.top - s.mid) * (1 - xn ** eT) ** (1 / eT)
      const base = Math.min(belt(u) - 0.07, shoulder - 0.03)
      return ring(z, w, Math.max(base + 0.002, roofLine(u)), base, base, -Infinity, eG, 8, 1 - topW, 0)
    })
    const roofPaint = P.roofPaint ?? paintBody, pillar = P.pillarPaint ?? paintBody
    m.surface(grows, (i, j) => {
      const u = uOf((grows[i][0][2] + grows[i + 1][0][2]) / 2)
      const s = Math.sin(((j + 0.5) / RING) * Math.PI * 2)
      if (s < 0) return DARK
      const inRoof = u > span[0] && u < span[1]
      if (s >= 0.7) return inRoof ? roofPaint : GLASS
      if (s >= 0.55) return inRoof || u < span[0] || P.cPillar !== undefined && u < P.cPillar ? roofPaint : pillar
      if (P.cPillar !== undefined && u < P.cPillar) return roofPaint
      if (P.aPillar !== undefined && u > P.aPillar) return roofPaint
      if ((P.pillars ?? []).some((p) => Math.abs(u - p) < 0.012)) return pillar
      return GLASS
    }, true, [DARK, DARK])
  }

  const roofAt = (z: number) => {
    const u = uOf(z)
    if (!P.roof || !roofLine || u < P.roof[0][0] || u > P.roof[P.roof.length - 1][0]) return belt(u)
    return Math.max(belt(u), roofLine(u))
  }
  const end = (x: number, y: number, dir: 1 | -1) => {
    let found = NaN
    for (let k = 0; k <= 400; k++) {
      const z = dir * (L / 2 - (k / 400) * L * 0.4)
      if (half(z, y) >= Math.abs(x)) { found = z; break }
    }
    if (found !== found) return null
    const d = 0.03
    const za = endZ(Math.abs(x) - d), zb = endZ(Math.abs(x) + d)
    const slope = za !== null && zb !== null ? (zb - za) / (2 * d) : 0
    // Outward normal in (x, z): front (−f′·sx, 1), rear (f′·sx, −1) with f′ the slope of z over |x|.
    const sx = Math.sign(x) || 1
    const yaw = dir > 0 ? Math.atan2(-slope * sx, 1) : Math.atan2(slope * sx, -1)
    return { z: found, yaw }
    function endZ(ax: number): number | null {
      for (let k = 0; k <= 400; k++) {
        const z = dir * (L / 2 - (k / 400) * L * 0.4)
        if (half(z, y) >= Math.max(0, ax)) return z
      }
      return null
    }
  }
  return { z: zOf, section, half, top: (z) => belt(uOf(z)), roof: roofAt, end }
}

/** Height at fraction `f` (0 bottom … 1 top) of the body's front (`dir` 1) or rear (−1) face, `depth` metres in from the end. */
export function faceY(b: Body, dir: 1 | -1, f: number, depth = 0.12): number {
  const s = b.section(dir * (b.z(1) - depth))
  const lo = Math.max(s.low, s.cut)
  return lo + (s.top - lo) * f
}

/**
 * A lamp, grille or badge-free panel on the body's front (`dir` 1) or rear (−1) at (x, y): a smooth
 * rounded box `size` (width, height, depth) facing out of the surface, sunk to `sink` of its depth.
 */
export function onEnd(m: MeshBuilder, b: Body, x: number, y: number, dir: 1 | -1, size: Vec3, s: Paint, sink = 0.55, e = 5): boolean {
  // Above the nose or tail the search would land on the bonnet or boot lid: step down onto the end face.
  let at = b.end(x, y, dir)
  for (let k = 0; k < 20 && at && Math.abs(at.z - b.z(dir > 0 ? 1 : 0)) > 0.45; k++) at = b.end(x, (y -= 0.02), dir)
  if (!at) return false
  const nx = Math.sin(at.yaw), nz = Math.cos(at.yaw)
  const d = size[2] * (0.5 - sink)
  m.group([x + nx * d, y, at.z + nz * d], [0, at.yaw, 0], () => m.rounded([0, 0, 0], size, s, e, 14, 6))
  return true
}

/** A panel on the flank at (z, y) on side `side` (±1): door handles, side markers, trim strips. */
export function onSide(m: MeshBuilder, b: Body, z: number, y: number, side: number, size: Vec3, s: Paint, sink = 0.6, e = 5): void {
  const x = b.half(z, y)
  if (x <= 0) return
  const d = 0.04
  const slope = (b.half(z + d, y) - b.half(z - d, y)) / (2 * d)
  // size = (depth out of the flank, height, length); turned to follow the flank's plan curve.
  m.group([side * (x + size[0] * (0.5 - sink)), y, z], [0, Math.atan2(slope * side, 1), 0], () => m.rounded([0, 0, 0], size, s, e, 12, 6))
}

/** Side mirrors at the windscreen base. */
export function mirrors(m: MeshBuilder, b: Body, z: number, y: number, s: Paint, size: Vec3 = [0.2, 0.13, 0.1]): void {
  for (const side of [-1, 1]) {
    const x = Math.max(0.3, b.half(z, b.top(z) - 0.06))
    m.rounded([side * (x + size[0] * 0.45), y, z], size, s, 3.5, 14, 6)
    m.box([side * (x + 0.02), y - 0.04, z + 0.01], [0.06, 0.04, 0.05], s)
    m.box([side * (x + size[0] * 0.45), y, z - size[2] * 0.42], [size[0] * 0.8, size[1] * 0.75, 0.01], GLASS)
  }
}
