import { pick, type Architecture, type RoofMaterial, type RoofShape, type WallMaterial } from './architecture.ts'
import type { District } from './districts.ts'
import type { Lot } from './lots.ts'
import { boxCorners, insetPolygon, orientedBox, pointInPolygon, polygonArea, polygonCentroid, type OrientedBox, type Vec2 } from './polygon.ts'

/** Building styles; each has its own proportions and window grid. */
export type BuildingStyle = 'tower' | 'block' | 'house' | 'shed'

/** Every building style, in a fixed order (the facade shader indexes its uniforms by it). */
export const BUILDING_STYLES: readonly BuildingStyle[] = ['tower', 'block', 'house', 'shed']

/** Kinds of small attached geometry. */
export type DetailKind = 'plant' | 'tank' | 'antenna' | 'chimney' | 'ac' | 'post'

/** A small box (or prism) on or against a building. Heights are metres above the building's base. */
export interface BuildingDetail {
  /** What it is (sets shape and colour). */
  kind: DetailKind
  /** Centre. */
  x: number
  /** Centre. */
  z: number
  /** Size along `angle`, metres. */
  width: number
  /** Size across `angle`, metres. */
  depth: number
  /** Bottom, metres above the base. */
  bottom: number
  /** Top, metres above the base. */
  top: number
  /** Orientation, radians from +x. */
  angle: number
}

/** A balcony slab with a railing, on an outer wall. */
export interface Balcony {
  /** Centre of the slab's wall edge. */
  x: number
  /** Centre of the slab's wall edge. */
  z: number
  /** Wall direction (radians from +x); the balcony sticks out to the right of it (outwards). */
  angle: number
  /** Width along the wall, metres. */
  width: number
  /** Depth out from the wall, metres. */
  depth: number
  /** Slab height above the base, metres. */
  y: number
}

/** One extruded storey range: an outline and its top height above the base. */
export interface BuildingTier {
  /** Outline, counter-clockwise. */
  polygon: Vec2[]
  /** Top of this tier, metres above the building's base. */
  top: number
}

/** One volume of a building: stacked tiers and the roof on the last one. */
export interface BuildingPart {
  /** Stacked tiers, widest first. */
  tiers: BuildingTier[]
  /** The rectangle pitched, skillion and saw-tooth roofs sit on (`null` = flat roof only). */
  rect: OrientedBox | null
  /** Roof shape. */
  roof: RoofShape
  /** Roof rise above the walls (ridge or peak), metres. */
  roofHeight: number
}

/** Door position on the street side, for mailboxes, paths and people. */
export interface Entrance {
  /** Position on the wall. */
  x: number
  /** Position on the wall. */
  z: number
  /** Outward unit normal (towards the street). */
  nx: number
  /** Outward unit normal (towards the street). */
  nz: number
}

/** A planned building (pure data; geometry is built from it). */
export interface Building {
  /** Index in the building list. */
  id: number
  /** Lot it stands on. */
  lot: number
  /** District it stands in. */
  district: District
  /** Style. */
  style: BuildingStyle
  /** Volumes (an L-shaped house has two). */
  parts: BuildingPart[]
  /** Wall material. */
  material: WallMaterial
  /** Pitched roof material (flat roofs are always concrete/membrane). */
  roofMaterial: RoofMaterial
  /** Storeys. */
  floors: number
  /** Storey height, metres. */
  floorHeight: number
  /** Highest wall top, metres above the base. */
  height: number
  /** Ground-floor level (local y), stilts included; set once the terrain is known. */
  base: number
  /** Bottom of the foundation or stilts (local y). */
  bottom: number
  /** Stilt height under the ground floor, metres (0 = on the ground). */
  stilts: number
  /** Footprint centroid. */
  center: Vec2
  /** Ground-floor area, m². */
  area: number
  /** Stable random number 0..1 (colour pick, window lights). */
  seed: number
  /** Estimated residents. */
  population: number
  /** Rooftop plant, tanks, antennas, chimneys, wall AC units, stilts. */
  details: BuildingDetail[]
  /** Balconies. */
  balconies: Balcony[]
  /** Shopfronts on the ground floor. */
  shops: boolean
  /** Main door. */
  entrance: Entrance
}

/** Building rules. */
export interface BuildingOptions {
  /** Storey height per style, metres. */
  floorHeight: Record<BuildingStyle, number>
  /** Buildings with at least this many floors become towers (with setbacks). */
  towerFloors: number
  /** Residential buildings with at most this many floors are houses. */
  houseFloors: number
  /** House width range along the street, metres. */
  houseWidth: [number, number]
  /** House depth range, metres. */
  houseDepth: [number, number]
  /** Gap kept between neighbouring buildings outside downtown, metres. */
  sideGap: number
  /** Share (0..1) of industrial sheds with saw-tooth roofs. */
  sawtoothRoofs: number
  /** Chance (0..1) that a pitched-roof house has a chimney. */
  chimneys: number
  /** Most rooftop plant boxes on a flat roof. */
  rooftop: number
  /** Chance (0..1) that a block or tower top floor is set back (a penthouse). */
  penthouses: number
  /** ± random variation of floor counts (fraction). */
  variation: number
  /** Floor area per resident, m² (for the population estimate). */
  areaPerPerson: number
}

/** Default building rules. */
export const DEFAULT_BUILDINGS: BuildingOptions = {
  floorHeight: { tower: 3.7, block: 3.2, house: 3, shed: 7 },
  towerFloors: 12,
  houseFloors: 2,
  houseWidth: [8, 13],
  houseDepth: [8, 12],
  sideGap: 2,
  sawtoothRoofs: 0.45,
  chimneys: 0.6,
  rooftop: 4,
  penthouses: 0.3,
  variation: 0.3,
  areaPerPerson: 45,
}

/** What {@link planBuilding} needs to know about the lot's surroundings. */
export interface BuildingSite {
  /** District of the lot. */
  district: District
  /** Density 0..1 at the lot (peaks downtown). */
  density: number
  /** Floor range of the district. */
  floors: [number, number]
  /** Highest floor count the settlement allows. */
  maxFloors: number
  /** Setback from the street, metres. */
  setback: number
  /** Chance that the lot is built on. */
  coverage: number
  /** Regional building tradition. */
  architecture: Architecture
}

const RESIDENTIAL_SHARE: Record<BuildingStyle, number> = { tower: 0.35, block: 0.75, house: 1, shed: 0 }

const fits = (r: OrientedBox, p: Vec2[]) => boxCorners(r).every(([x, z]) => pointInPolygon(x, z, p))

/** A rectangle-ish outline for a tower shaft: the inset footprint, its box, a chamfered box or a 12-gon. */
function shaftShape(foot: Vec2[], inset: number, kind: number): Vec2[] | null {
  const base = insetPolygon(foot, inset)
  if (!base) return null
  if (kind < 0.3) return base
  const b = orientedBox(base)
  let r: OrientedBox | null = null
  for (let s = 0.95; s > 0.5 && !r; s -= 0.08) {
    const c = { ...b, halfLength: b.halfLength * s, halfWidth: b.halfWidth * s }
    if (fits(c, base)) r = c
  }
  if (!r) return base
  const [cx, cz] = r.center, [ux, uz] = r.axis
  const at = (u: number, v: number): Vec2 => [cx + ux * u - uz * v, cz + uz * u + ux * v]
  if (kind < 0.6) return boxCorners(r)
  if (kind < 0.85) {
    // Chamfered corners.
    const c = Math.min(r.halfLength, r.halfWidth) * 0.3, L = r.halfLength, W = r.halfWidth
    return [at(-L + c, -W), at(L - c, -W), at(L, -W + c), at(L, W - c), at(L - c, W), at(-L + c, W), at(-L, W - c), at(-L, -W + c)]
  }
  // Round (an ellipse with 16 sides).
  const out: Vec2[] = []
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2
    out.push(at(Math.cos(a) * r.halfLength, Math.sin(a) * r.halfWidth))
  }
  return out
}

/** Rectangle `w` wide (along the street) and `d` deep, set back from the street edge a→b of `lot`. */
function streetRect(lot: Lot, along: number, w: number, d: number, setback: number): OrientedBox | null {
  const p = lot.polygon
  const a = p[lot.front], b = p[(lot.front + 1) % p.length]
  const fl = Math.hypot(b[0] - a[0], b[1] - a[1])
  const ux = (b[0] - a[0]) / fl, uz = (b[1] - a[1]) / fl
  const nx = -uz, nz = ux // inward
  for (let s = 1; s >= 0.5; s -= 0.1) {
    const dd = d * s, ww = w * (s < 0.75 ? s + 0.25 : 1)
    const cx = a[0] + ux * (along + w / 2) + nx * (setback + dd / 2)
    const cz = a[1] + uz * (along + w / 2) + nz * (setback + dd / 2)
    const r: OrientedBox = ww >= dd
      ? { center: [cx, cz], axis: [ux, uz], halfLength: ww / 2, halfWidth: dd / 2 }
      : { center: [cx, cz], axis: [nx, nz], halfLength: dd / 2, halfWidth: ww / 2 }
    if (fits(r, p)) return r
  }
  return null
}

/**
 * Decides what (if anything) stands on a lot: style, volumes, materials, roofs and details, matched
 * to the district and the regional architecture. Pure: same inputs and random sequence give the
 * same building, and the random sequence differs per lot, so no two buildings are clones.
 * @returns `null` for empty lots (parks, courtyards, lots without street access, coverage misses).
 */
export function planBuilding(lot: Lot, site: BuildingSite, o: BuildingOptions, rand: () => number, id: number): Building | null {
  const d = site.district
  const arch = site.architecture
  if (d === 'park' || lot.front < 0 || rand() >= site.coverage) return null

  let floors = Math.round((site.floors[0] + (site.floors[1] - site.floors[0]) * Math.pow(site.density, 1.6)) * (1 + (rand() * 2 - 1) * o.variation))
  floors = Math.max(1, Math.min(site.maxFloors, floors))
  let style: BuildingStyle
  if (d === 'industrial') style = 'shed'
  else if (d === 'farmland') style = rand() < 0.55 ? 'house' : 'shed'
  else if (floors >= o.towerFloors) style = 'tower'
  else if (floors <= o.houseFloors && d === 'residential') style = 'house'
  else style = 'block'
  if (style === 'shed') floors = Math.min(floors, 2)
  if (style === 'house') floors = Math.min(floors, Math.max(1, o.houseFloors))

  const fh = o.floorHeight[style]
  const seed = rand()
  const details: BuildingDetail[] = []
  const balconies: Balcony[] = []
  const parts: BuildingPart[] = []
  let material: WallMaterial
  const roofMaterial: RoofMaterial = pick(arch.roofMaterials, rand())
  let stilts = 0

  const p = lot.polygon
  const fa = p[lot.front], fb = p[(lot.front + 1) % p.length]
  const frontLen = Math.hypot(fb[0] - fa[0], fb[1] - fa[1])

  if (style === 'house' || style === 'shed') {
    let w: number, depth: number
    if (style === 'house') {
      material = pick(arch.houseMaterials, rand())
      w = Math.min(frontLen - o.sideGap * 2, o.houseWidth[0] + rand() * (o.houseWidth[1] - o.houseWidth[0]))
      depth = o.houseDepth[0] + rand() * (o.houseDepth[1] - o.houseDepth[0])
      stilts = arch.stilts > 0 ? arch.stilts * (0.8 + rand() * 0.4) : 0
    } else {
      material = d === 'farmland' ? (rand() < 0.6 ? 'wood' : 'metal') : rand() < 0.6 ? 'metal' : 'concrete'
      const box = orientedBox(p)
      w = Math.min(frontLen - o.sideGap * 2, box.halfLength * 2 * 0.85)
      depth = Math.max(10, Math.min(box.halfWidth * 2, box.halfLength * 2) * 0.8 - site.setback)
    }
    if (w < 5) return null
    const along = (frontLen - w) / 2 + (rand() - 0.5) * Math.max(0, frontLen - w - o.sideGap * 2) * 0.5
    const r = streetRect(lot, along, w, depth, site.setback)
    if (!r || r.halfWidth < 2.5) return null
    const top = floors * fh
    let roof: RoofShape, roofHeight: number
    if (style === 'house') {
      roof = pick(arch.houseRoofs, rand())
      const pitch = arch.pitch[0] + rand() * (arch.pitch[1] - arch.pitch[0])
      roofHeight = roof === 'flat' ? 0 : roof === 'skillion' ? r.halfWidth * 2 * pitch * 0.4 : r.halfWidth * pitch
    } else if (d === 'farmland' || rand() >= o.sawtoothRoofs) {
      roof = d === 'farmland' ? 'gable' : 'flat'
      roofHeight = roof === 'gable' ? r.halfWidth * 0.45 : 0
    } else {
      roof = 'sawtooth'
      roofHeight = Math.min(4, 1.5 + r.halfWidth * 0.08)
    }
    parts.push({ tiers: [{ polygon: boxCorners(r), top }], rect: r, roof, roofHeight })
    // A cross wing at one end, towards the back of the lot (an L-shaped plan).
    if (style === 'house' && rand() < arch.wings) {
      const side = rand() < 0.5 ? -1 : 1
      const ww = r.halfLength * (0.5 + rand() * 0.3)
      const wl = r.halfWidth * (1.6 + rand() * 0.8)
      const [ux, uz] = r.axis
      // Inward (away from the street) across the main rectangle's axis.
      const sx = (fa[0] + fb[0]) / 2 - r.center[0], sz = (fa[1] + fb[1]) / 2 - r.center[1]
      const back = -uz * sx + ux * sz > 0 ? -1 : 1
      const cx = r.center[0] + ux * side * (r.halfLength - ww) + -uz * back * (wl - r.halfWidth) * 0.9
      const cz = r.center[1] + uz * side * (r.halfLength - ww) + ux * back * (wl - r.halfWidth) * 0.9
      const wing: OrientedBox = { center: [cx, cz], axis: [-uz, ux], halfLength: wl, halfWidth: ww }
      if (fits(wing, p)) {
        const wRoof: RoofShape = roof === 'skillion' ? 'flat' : roof
        parts.push({ tiers: [{ polygon: boxCorners(wing), top: floors === 2 && rand() < 0.5 ? fh : top }], rect: wing, roof: wRoof, roofHeight: wRoof === 'flat' ? 0 : roof === 'flat' ? 0 : ww * (roofHeight / r.halfWidth) })
      }
    }
    if (style === 'house' && roof !== 'flat' && rand() < o.chimneys) {
      const t = (rand() - 0.5) * 1.2 * r.halfLength
      const s = rand() < 0.5 ? -0.45 : 0.45
      details.push({ kind: 'chimney', x: r.center[0] + r.axis[0] * t - r.axis[1] * s * r.halfWidth, z: r.center[1] + r.axis[1] * t + r.axis[0] * s * r.halfWidth, width: 0.7, depth: 0.7, bottom: top - 0.5, top: top + roofHeight + 0.9, angle: Math.atan2(r.axis[1], r.axis[0]) })
    }
    if (stilts > 0) {
      for (const part of parts) for (const [x, z] of part.tiers[0].polygon) {
        details.push({ kind: 'post', x, z, width: 0.3, depth: 0.3, bottom: -stilts - 1, top: 0, angle: 0 })
      }
    }
  } else {
    material = pick(style === 'tower' ? arch.towerMaterials : arch.blockMaterials, rand())
    const gap = d === 'downtown' ? 0 : o.sideGap
    const foot = insetPolygon(p, lot.street.map((s) => (s ? site.setback : gap)))
    if (!foot || polygonArea(foot) < 40) return null
    const top = floors * fh
    let tiers: BuildingTier[] = [{ polygon: foot, top }]
    if (style === 'tower') {
      // Podium, shaft and crown, with a per-tower shaft shape.
      const podium = Math.min(floors - 2, 2 + Math.floor(rand() * 4))
      const shaft = shaftShape(foot, 2.5 + rand() * 3, rand())
      if (shaft && polygonArea(shaft) > 120) {
        tiers = [{ polygon: foot, top: podium * fh }, { polygon: shaft, top }]
        const crown = rand() < 0.6 ? insetPolygon(shaft, 2 + rand() * 2) : null
        if (crown && polygonArea(crown) > 60) {
          const k = Math.max(podium + 1, Math.round(floors * (0.78 + rand() * 0.1)))
          tiers = [{ polygon: foot, top: podium * fh }, { polygon: shaft, top: k * fh }, { polygon: crown, top }]
        }
      }
    } else if (floors >= 3 && rand() < o.penthouses) {
      const pent = insetPolygon(foot, 2.5)
      if (pent && polygonArea(pent) > 50) tiers = [{ polygon: foot, top: (floors - 1) * fh }, { polygon: pent, top }]
    }
    parts.push({ tiers, rect: null, roof: 'flat', roofHeight: 0 })
    // Balconies on the longest walls of residential blocks.
    if (style === 'block' && d !== 'downtown' && rand() < arch.balconies) {
      const edges = foot.map((a, i) => ({ a, b: foot[(i + 1) % foot.length], l: Math.hypot(foot[(i + 1) % foot.length][0] - a[0], foot[(i + 1) % foot.length][1] - a[1]) })).sort((x, y) => y.l - x.l).slice(0, 2)
      const spacing = 3.4 + rand() * 1.6
      const bw = 2.2 + rand() * 1.2, bd = 1.1 + rand() * 0.5
      for (const e of edges) {
        if (e.l < 7) continue
        const ux = (e.b[0] - e.a[0]) / e.l, uz = (e.b[1] - e.a[1]) / e.l
        const n = Math.floor((e.l - 2) / spacing)
        const off = (e.l - n * spacing) / 2 + spacing / 2
        for (let f = 1; f < Math.min(tiers[0].top / fh, 14); f++) {
          for (let i = 0; i < n && balconies.length < 48; i++) {
            const t = off + i * spacing
            balconies.push({ x: e.a[0] + ux * t, z: e.a[1] + uz * t, angle: Math.atan2(uz, ux), width: bw, depth: bd, y: f * fh })
          }
        }
      }
    }
  }

  // Rooftop clutter on flat roofs.
  const top = parts[0].tiers[parts[0].tiers.length - 1]
  if (parts[0].roof === 'flat' && o.rooftop > 0) {
    const tb = orientedBox(top.polygon)
    const ang = Math.atan2(tb.axis[1], tb.axis[0])
    const n = Math.floor(rand() * (o.rooftop + 1)) + (style === 'tower' ? 1 : 0)
    for (let i = 0; i < n; i++) {
      const r = rand()
      const kind: DetailKind = style === 'house' ? 'plant' : r < 0.2 ? 'tank' : r < 0.32 && style === 'tower' ? 'antenna' : 'plant'
      const w = kind === 'antenna' ? 0.4 : kind === 'tank' ? 2.5 + rand() * 1.5 : 1.5 + rand() * Math.min(5, tb.halfLength * 0.6)
      const dd = kind === 'plant' ? 1.5 + rand() * Math.min(4, tb.halfWidth * 0.6) : w
      const h = kind === 'antenna' ? 6 + rand() * 14 : kind === 'tank' ? 2.5 + rand() * 2 : 1.2 + rand() * (style === 'tower' ? 4 : 2)
      const u = (rand() * 2 - 1) * Math.max(0, tb.halfLength - w), v = (rand() * 2 - 1) * Math.max(0, tb.halfWidth - dd)
      const x = tb.center[0] + tb.axis[0] * u - tb.axis[1] * v, z = tb.center[1] + tb.axis[1] * u + tb.axis[0] * v
      if (fits({ center: [x, z], axis: tb.axis, halfLength: w / 2, halfWidth: dd / 2 }, top.polygon)) {
        details.push({ kind, x, z, width: w, depth: dd, bottom: top.top, top: top.top + h, angle: ang })
      }
    }
  }

  // Wall air-conditioning units (more in hot regions).
  const nAc = Math.floor(rand() * (arch.airConditioners + 1) * (style === 'shed' ? 0.3 : 1))
  const wall = parts[0].tiers[0].polygon
  for (let i = 0; i < nAc; i++) {
    const k = Math.floor(rand() * wall.length)
    const a = wall[k], b = wall[(k + 1) % wall.length]
    const l = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (l < 3) continue
    const ux = (b[0] - a[0]) / l, uz = (b[1] - a[1]) / l
    const t = 1 + rand() * (l - 2)
    const f = Math.floor(rand() * Math.max(1, Math.round(parts[0].tiers[0].top / fh)))
    details.push({ kind: 'ac', x: a[0] + ux * t + uz * 0.3, z: a[1] + uz * t - ux * 0.3, width: 0.9, depth: 0.6, bottom: f * fh + 0.4, top: f * fh + 1.0, angle: Math.atan2(uz, ux) })
  }

  // Entrance: the middle of the wall closest to the street.
  const fm: Vec2 = [(fa[0] + fb[0]) / 2, (fa[1] + fb[1]) / 2]
  let entrance: Entrance = { x: wall[0][0], z: wall[0][1], nx: 0, nz: 1 }
  let bestD = Infinity
  for (let i = 0; i < wall.length; i++) {
    const a = wall[i], b = wall[(i + 1) % wall.length]
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2
    const dist = Math.hypot(mx - fm[0], mz - fm[1])
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    if (dist < bestD) { bestD = dist; entrance = { x: mx, z: mz, nx: (b[1] - a[1]) / l, nz: -(b[0] - a[0]) / l } }
  }

  let height = 0, floorArea = 0
  for (const part of parts) {
    let below = 0
    for (const t of part.tiers) {
      height = Math.max(height, t.top)
      const f = Math.max(0, Math.round(t.top / fh) - below)
      floorArea += polygonArea(t.polygon) * f
      below += f
    }
  }
  const foot = parts[0].tiers[0].polygon
  return {
    id, lot: lot.id, district: d, style, parts, material, roofMaterial, floors, floorHeight: fh, height,
    base: 0, bottom: 0, stilts, center: polygonCentroid(foot), area: polygonArea(foot), seed,
    population: (floorArea * RESIDENTIAL_SHARE[style] * (d === 'downtown' ? 0.6 : 1)) / o.areaPerPerson,
    details, balconies, shops: d === 'downtown' && style !== 'house' ? rand() < 0.8 : style === 'block' && rand() < 0.3, entrance,
  }
}
