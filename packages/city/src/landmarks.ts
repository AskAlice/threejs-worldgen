import { hash4, mulberry32 } from 'threejs-biomes'
import { pick, type Architecture } from './architecture.ts'
import { entranceFacing, streetRect, type Building, type BuildingPart, type BuildingStyle } from './buildings.ts'
import type { Lot } from './lots.ts'
import type { PlannedLot } from './plan.ts'
import { boxCorners, pointInPolygon, polygonArea, polygonCentroid, type OrientedBox, type Vec2 } from './polygon.ts'

/** Civic buildings that make a place recognisable from above. */
export type Landmark = 'church' | 'townHall' | 'waterTower'

/** Every landmark, in the order they are placed (the first gets the lot nearest the centre). */
export const LANDMARKS: readonly Landmark[] = ['church', 'townHall', 'waterTower']

/** A church: a gabled nave with a tower and spire at the street end. Sizes in metres. */
export interface ChurchOptions {
  /** Nave width range. */
  width: [number, number]
  /** Nave length range. */
  length: [number, number]
  /** Nave wall height range. */
  wallHeight: [number, number]
  /** Nave roof pitch (rise / run). */
  pitch: number
  /** Tower width range. */
  towerWidth: [number, number]
  /** Tower wall height range. */
  towerHeight: [number, number]
  /** Spire height as a multiple of the tower width (0 = a flat-topped tower). */
  spire: number
  /** Setback from the street. */
  setback: number
}

/** A town hall: a hip-roofed civic block, often with a clock tower. Sizes in metres. */
export interface TownHallOptions {
  /** Width range along the street. */
  width: [number, number]
  /** Depth range. */
  depth: [number, number]
  /** Floor range. */
  floors: [number, number]
  /** Roof pitch (rise / run). */
  pitch: number
  /** Chance (0..1) of a clock tower on the roof. */
  clockTower: number
  /** Clock tower rise above the ridge. */
  towerHeight: number
  /** Setback from the street. */
  setback: number
}

/** A water tower: a tank on a column, near the edge of town. Sizes in metres. */
export interface WaterTowerOptions {
  /** Height range of the tank's underside. */
  height: [number, number]
  /** Column radius. */
  columnRadius: number
  /** Tank radius range. */
  tankRadius: [number, number]
  /** Tank height range. */
  tankHeight: [number, number]
  /** Distance range from the centre, as a fraction of the radius. */
  reach: [number, number]
}

/** Landmark shapes (how many each size class gets is `SizeClass.landmarks`). */
export interface LandmarkOptions {
  /** Churches. */
  church: ChurchOptions
  /** Town halls. */
  townHall: TownHallOptions
  /** Water towers. */
  waterTower: WaterTowerOptions
}

/** Default landmark shapes. */
export const DEFAULT_LANDMARKS: LandmarkOptions = {
  church: { width: [10, 14], length: [22, 32], wallHeight: [8, 11], pitch: 0.95, towerWidth: [4.5, 6.5], towerHeight: [18, 28], spire: 2, setback: 4 },
  townHall: { width: [18, 26], depth: [14, 20], floors: [2, 3], pitch: 0.45, clockTower: 0.6, towerHeight: 6, setback: 5 },
  waterTower: { height: [20, 28], columnRadius: 1.4, tankRadius: [4, 5.5], tankHeight: [6, 9], reach: [0.35, 0.7] },
}

/** What a landmark needs besides its lot: the regional architecture and storey heights. */
export interface LandmarkContext {
  /** Regional building tradition (materials, roofs). */
  architecture: Architecture
  /** Storey height per building style, metres. */
  floorHeight: Record<BuildingStyle, number>
}

/**
 * Picks lots for a settlement's landmarks and plans them: churches and town halls on the street-facing lots nearest
 * the centre (where the nave or hall fits), water towers on a lot near a seeded point `reach` out. Pure: the same
 * lots, counts and seed give the same landmarks.
 * @param counts How many of each (a fraction is the chance of one more).
 * @returns Landmark buildings by lot id (`id` −1: the caller numbers them).
 */
export function planLandmarks(lots: PlannedLot[], counts: Record<Landmark, number>, o: LandmarkOptions, ctx: LandmarkContext, center: Vec2, radius: number, seed: number): Map<number, Building> {
  const rand = mulberry32(hash4(seed, 71, 7, 3))
  const out = new Map<number, Building>()
  for (const kind of LANDMARKS) {
    const n = Math.floor(counts[kind]) + (rand() < counts[kind] % 1 ? 1 : 0)
    for (let i = 0; i < n; i++) {
      let [tx, tz] = center
      if (kind === 'waterTower') {
        const a = rand() * Math.PI * 2, d = radius * (o.waterTower.reach[0] + rand() * (o.waterTower.reach[1] - o.waterTower.reach[0]))
        tx += Math.cos(a) * d; tz += Math.sin(a) * d
      }
      const candidates = lots
        .filter((l) => l.front >= 0 && !out.has(l.id) && l.district !== 'park' && (kind === 'waterTower' || l.district !== 'farmland'))
        .map((l) => ({ l, d: Math.hypot(l.center[0] - tx, l.center[1] - tz) }))
        .sort((p, q) => p.d - q.d || p.l.id - q.l.id)
        .slice(0, 80)
      for (const { l } of candidates) {
        const lr = mulberry32(hash4(seed, l.id, 73, LANDMARKS.indexOf(kind)))
        const b = kind === 'church' ? church(l, o.church, ctx, lr) : kind === 'townHall' ? townHall(l, o.townHall, ctx, lr) : waterTower(l, o.waterTower, lr)
        if (b) { out.set(l.id, b); break }
      }
    }
  }
  return out
}

const span = (r: [number, number], rand: () => number) => r[0] + rand() * (r[1] - r[0])

function frontLength(lot: Lot): number {
  const p = lot.polygon, a = p[lot.front], b = p[(lot.front + 1) % p.length]
  return Math.hypot(b[0] - a[0], b[1] - a[1])
}

function building(lot: PlannedLot, use: Landmark, style: BuildingStyle, parts: BuildingPart[], a: Pick<Building, 'material' | 'roofMaterial' | 'floors' | 'floorHeight'>, seed: number): Building {
  const foot = parts[0].tiers[0].polygon
  let height = 0
  for (const p of parts) height = Math.max(height, p.tiers[p.tiers.length - 1].top)
  return {
    id: -1, lot: lot.id, district: lot.district, style, parts, ...a, height, base: 0, bottom: 0, stilts: 0, center: polygonCentroid(foot), area: polygonArea(foot),
    seed, population: 0, details: [], balconies: [], shops: false, entrance: entranceFacing(foot, lot), use,
  }
}

function church(lot: PlannedLot, c: ChurchOptions, ctx: LandmarkContext, rand: () => number): Building | null {
  const front = frontLength(lot)
  const w = Math.min(span(c.width, rand), front - 2)
  if (w < c.width[0] * 0.8) return null
  const tw = Math.min(span(c.towerWidth, rand), w * 0.7)
  const along = (front - w) / 2
  const len = span(c.length, rand)
  // The nave runs back from the street (gable end to the street); the tower stands across its front gable.
  const nave = streetRect(lot, along, w, len, c.setback + tw * 0.6)
  const tower = streetRect(lot, along + (w - tw) / 2, tw, tw, c.setback)
  if (!nave || !tower || nave.halfLength * 2 < c.length[0] * 0.7 || Math.min(tower.halfLength, tower.halfWidth) * 2 < tw * 0.8) return null
  const flat = pick(ctx.architecture.houseRoofs, rand()) === 'flat'
  const wall = span(c.wallHeight, rand), top = Math.max(wall + nave.halfWidth * c.pitch + 3, span(c.towerHeight, rand))
  return building(lot, 'church', 'house', [
    { tiers: [{ polygon: boxCorners(nave), top: wall }], rect: nave, roof: flat ? 'flat' : 'gable', roofHeight: flat ? 0 : nave.halfWidth * c.pitch, blank: true },
    { tiers: [{ polygon: boxCorners(tower), top }], rect: tower, roof: flat || c.spire <= 0 ? 'flat' : 'hip', roofHeight: flat ? 0 : tw * c.spire, blank: true },
  ], { material: pick(ctx.architecture.houseMaterials, rand()), roofMaterial: pick(ctx.architecture.roofMaterials, rand()), floors: 1, floorHeight: wall }, rand())
}

function townHall(lot: PlannedLot, t: TownHallOptions, ctx: LandmarkContext, rand: () => number): Building | null {
  const front = frontLength(lot)
  const w = Math.min(span(t.width, rand), front - 2)
  if (w < t.width[0] * 0.7) return null
  const r = streetRect(lot, (front - w) / 2, w, span(t.depth, rand), t.setback)
  if (!r || r.halfWidth * 2 < t.depth[0] * 0.7) return null
  const fh = ctx.floorHeight.block
  const floors = Math.round(span(t.floors, rand))
  const top = floors * fh
  const flat = pick(ctx.architecture.houseRoofs, rand()) === 'flat'
  const rise = flat ? 0 : r.halfWidth * t.pitch
  const parts: BuildingPart[] = [{ tiers: [{ polygon: boxCorners(r), top }], rect: r, roof: flat ? 'flat' : 'hip', roofHeight: rise }]
  if (rand() < t.clockTower) {
    const s = r.halfWidth * 0.32
    const tower: OrientedBox = { center: r.center, axis: r.axis, halfLength: s, halfWidth: s }
    parts.push({ tiers: [{ polygon: boxCorners(tower), top: top + rise + t.towerHeight }], rect: tower, roof: flat ? 'flat' : 'hip', roofHeight: flat ? 0 : s * 1.6, blank: true })
  }
  return building(lot, 'townHall', 'block', parts, { material: pick(ctx.architecture.blockMaterials, rand()), roofMaterial: pick(ctx.architecture.roofMaterials, rand()), floors, floorHeight: fh }, rand())
}

function waterTower(lot: PlannedLot, o: WaterTowerOptions, rand: () => number): Building | null {
  const h = span(o.height, rand), R = span(o.tankRadius, rand), th = span(o.tankHeight, rand)
  const [cx, cz] = lot.center
  const ring = (r: number, n: number): Vec2[] => Array.from({ length: n }, (_, i) => [cx + Math.cos((i / n) * Math.PI * 2) * r, cz + Math.sin((i / n) * Math.PI * 2) * r])
  if (!ring(R + 1.5, 16).every(([x, z]) => pointInPolygon(x, z, lot.polygon))) return null
  return building(lot, 'waterTower', 'shed', [
    { tiers: [{ polygon: ring(o.columnRadius, 12), top: h }, { polygon: ring(R, 16), top: h + th }], rect: null, roof: 'cone', roofHeight: R * 0.3, blank: true },
  ], { material: 'metal', roofMaterial: 'metal', floors: 1, floorHeight: h }, rand())
}
