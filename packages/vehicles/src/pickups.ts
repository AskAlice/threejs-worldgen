// Pickups with generic names, in three body families: a full-size pickup (regular, extended or crew cab,
// short or long bed, lift, hitch and bed loads), a car-based ute (coupé utility with a covered tray, or a
// cab-chassis with a flat tray) and an angular, flat-panelled brushed stainless pickup (electric).
import { FINISH, MeshBuilder, paint, type Paint, type Vec3 } from './mesh.ts'
import { BODY, BRUSHED, CHROME, DARK, GLASS, HEAD, PLASTIC, TAIL, TRIM, body, model, num, pick, smoothWheel, str, type Rand, type WheelLook } from './kit.ts'
import { faceY, loftBody, mirrors, onEnd, onSide, type Body } from './body.ts'
import type { ExhaustVent, ModelPart, PartMount, VehicleModel, VehicleParams } from './models.ts'
import type { CarDimensions } from './cars.ts'

/** The pickup body families. */
export const PICKUP_STYLES = ['fullSize', 'ute', 'angular'] as const
/** A pickup body family. */
export type PickupStyle = (typeof PICKUP_STYLES)[number]

/** Full-size pickup sizes by cab and bed (published figures of the best-selling full-size pickup). */
export const FULL_SIZE_DIMENSIONS: Record<string, CarDimensions> = {
  'regular/short': { length: 5.311, width: 2.029, height: 1.961, wheelBase: 3.119 },
  'regular/long': { length: 5.779, width: 2.029, height: 1.961, wheelBase: 3.584 },
  'extended/short': { length: 5.885, width: 2.029, height: 1.961, wheelBase: 3.693 },
  'extended/long': { length: 6.358, width: 2.029, height: 1.961, wheelBase: 4.158 },
  'crew/short': { length: 5.885, width: 2.029, height: 1.961, wheelBase: 3.693 },
  'crew/long': { length: 6.19, width: 2.029, height: 1.961, wheelBase: 3.993 },
}

/** Inner bed lengths, metres (5.5, 6.5 and 8 ft), by cab and bed. */
const BED: Record<string, number> = {
  'regular/short': 1.981, 'regular/long': 2.438, 'extended/short': 1.981, 'extended/long': 2.438, 'crew/short': 1.676, 'crew/long': 1.981,
}

/** Reference sizes of the ute bodies and the angular pickup. */
export const PICKUP_REFERENCES: Record<'coupe' | 'tray' | 'angular', CarDimensions> = {
  coupe: { length: 5.04, width: 1.899, height: 1.47, wheelBase: 3.009 },
  tray: { length: 5.33, width: 1.8, height: 1.795, wheelBase: 3.085 },
  angular: { length: 5.683, width: 2.032, height: 1.741, wheelBase: 3.635 },
}

/** Reference dimensions of a pickup with these parameters. */
export function pickupReference(p: VehicleParams): CarDimensions {
  const style = str(p, 'style')
  if (style === 'ute') return PICKUP_REFERENCES[str(p, 'ute') === 'tray' ? 'tray' : 'coupe']
  if (style === 'angular') return PICKUP_REFERENCES.angular
  return FULL_SIZE_DIMENSIONS[`${str(p, 'cab')}/${str(p, 'bed')}`] ?? FULL_SIZE_DIMENSIONS['crew/short']
}

const PALETTE = ['#e9ecee', '#1b1b1d', '#7f8a92', '#a8121c', '#25384d', '#b9c0c6', '#5a4632', '#2b4a2f', '#c6b79c', '#1f4f8f']
const UTE_PALETTE = ['#e9ecee', '#1b1b1d', '#c41a1a', '#f2a900', '#2a6fb0', '#7f8a92', '#3e5a3a']

function wheels(r: number, w: number, look: WheelLook, x: number, axles: number[], y = r): ModelPart {
  const mounts: PartMount[] = []
  for (const side of [-1, 1]) axles.forEach((z, k) => mounts.push({
    position: [side * x, y, z], rotation: side < 0 ? [0, Math.PI, 0] : undefined,
    spin: { axis: 0, rate: side / r, by: 'distance' }, steer: k === 0 ? 1 : undefined,
  }))
  return { name: 'wheel', mesh: smoothWheel(r, w, look), mounts }
}

/** Generates one pickup. */
export function pickup(p: VehicleParams, rand: Rand): VehicleModel {
  let style = str(p, 'style')
  if (!(PICKUP_STYLES as readonly string[]).includes(style)) style = pick(rand, ['fullSize', 'fullSize', 'fullSize', 'ute', 'angular'])
  const m = new MeshBuilder()
  const built = style === 'ute' ? ute(m, p, rand) : style === 'angular' ? angular(m, p) : fullSize(m, p, rand)
  const k = num(p, 'size')
  const parts = [body(m.build()), ...built.parts]
  const out = model('pickup', built.style, 'land', parts, {
    wheelBase: built.wheelBase, vents: built.vents, bank: -0.05,
    palette: style === 'angular' ? (p.painted ? PALETTE : ['#ffffff']) : style === 'ute' ? UTE_PALETTE : PALETTE,
  })
  return k === 1 ? out : scaleModel(out, k)
}

function scaleModel(md: VehicleModel, k: number): VehicleModel {
  const parts = md.parts.map((pt) => ({
    ...pt,
    mesh: { ...pt.mesh, position: pt.mesh.position.map((v) => v * k), bounds: pt.mesh.bounds.map((v) => v * k) as typeof pt.mesh.bounds },
    mounts: pt.mounts.map((mt) => ({ ...mt, position: mt.position.map((v) => v * k) as Vec3, spin: mt.spin && { ...mt.spin, rate: mt.spin.rate / k } })),
  }))
  return { ...md, parts, size: md.size.map((v) => v * k) as Vec3, wheelBase: md.wheelBase * k, vents: md.vents.map((v) => ({ ...v, position: v.position.map((c) => c * k) as Vec3, radius: v.radius * k })) }
}

type Built = { style: string; parts: ModelPart[]; vents: ExhaustVent[]; wheelBase: number }

// ---------------------------------------------------------------- full size

/** A load in a bed or on a tray between x ±hw, z0…z1, from the floor at y. */
function bedLoad(m: MeshBuilder, kind: string, rand: Rand, hw: number, y: number, z0: number, z1: number): void {
  if (kind === 'crates') {
    const n = 2 + Math.floor(rand() * 3)
    for (let i = 0; i < n; i++) {
      const s = 0.45 + rand() * 0.2, x = (rand() * 2 - 1) * (hw - s / 2), z = z0 + s / 2 + rand() * (z1 - z0 - s)
      m.rounded([x, y + s / 2, z], [s, s, s], paint(pick(rand, ['#8a6a44', '#a07a4c', '#6e5636'])), 10, 12, 6)
    }
  } else if (kind === 'hay') {
    for (let i = 0; i < 2; i++) for (const x of [-hw / 2, hw / 2]) m.rounded([x, y + 0.2 + i * 0.4, (z0 + z1) / 2], [hw * 0.95, 0.38, Math.min(0.9, z1 - z0 - 0.1)], paint('#c9a85a'), 6, 12, 6)
  } else if (kind === 'gravel') {
    m.rounded([0, y, (z0 + z1) / 2], [hw * 1.9, 0.55, (z1 - z0) * 0.9], paint('#8d8a84'), 2.2, 18, 8)
  }
}

function fullSize(m: MeshBuilder, p: VehicleParams, rand: Rand): Built {
  let cab = str(p, 'cab'), bed = str(p, 'bed')
  if (!['regular', 'extended', 'crew'].includes(cab)) cab = 'crew'
  if (!['short', 'long'].includes(bed)) bed = 'short'
  const ref = FULL_SIZE_DIMENSIONS[`${cab}/${bed}`]
  const lift = Math.max(0, Math.min(0.3, num(p, 'lift')))
  const L = ref.length, W = ref.width, H = ref.height + lift
  const r = 0.412 + lift * 0.25 // 275/60 R20, bigger tyres on lifted trucks
  const front = L / 2 - 0.97, rear = front - ref.wheelBase
  const bedIn = BED[`${cab}/${bed}`], bedOut = bedIn + 0.14
  const bedRear = -L / 2 + 0.13, bedFront = bedRear + bedOut, cabBack = bedFront + 0.06
  const cabL = L / 2 - cabBack, cabC = (L / 2 + cabBack) / 2
  const ride = 0.26 + lift
  const chrome = rand() < 0.45
  const grille = chrome ? CHROME : rand() < 0.5 ? PLASTIC : BODY
  const lu = (z: number) => (z - cabBack) / cabL // u within the cab body
  const ws = lu(L / 2 - 1.58)
  const roofFront = lu(L / 2 - 2.18)
  let b!: Body
  m.group([0, 0, cabC], [0, 0, 0], () => {
    b = loftBody(m, {
      L: cabL, W, H, r, axles: [front - cabC], arch: 1.16,
      belt: [[0, 1.24 + lift], [0.04, 1.27 + lift], [ws, 1.27 + lift], [0.92, 1.24 + lift], [1, 1.16 + lift]],
      bottom: [[0, ride + 0.02], [0.8, ride], [0.95, ride + 0.12], [1, ride + 0.26]],
      plan: [[0, 0.97], [0.1, 1], [0.9, 1], [1, 0.95]],
      split: 0.55, eTop: 6, eBot: 7, fillet: [0.05, 0.1], tuck: [0.03, 0.06],
      roof: [[0.02, 1.25 + lift], [0.04, H - 0.02], [roofFront, H], [ws, 1.27 + lift]],
      roofSpan: [0.04, roofFront], pillars: cab === 'regular' ? [] : cab === 'extended' ? [lu(cabBack + 0.65)] : [lu(cabBack + 1.0)],
      cPillar: cab === 'regular' ? undefined : 0.07, topW: 0.86, eGlass: 5, pillarPaint: TRIM,
    })
    // Tall blunt face: a big grille, lamps either side, a bumper.
    onEnd(m, b, 0, faceY(b, 1, 0.66), 1, [1.3, 0.48, 0.1], grille, 0.55, 8)
    for (let i = 0; i < 3; i++) onEnd(m, b, 0, faceY(b, 1, 0.5 + i * 0.16), 1, [1.2, 0.03, 0.12], chrome ? PLASTIC : grille === BODY ? PLASTIC : CHROME, 0.5, 8)
    for (const side of [-1, 1]) onEnd(m, b, side * 0.78, faceY(b, 1, 0.68), 1, [0.34, 0.24, 0.12], HEAD, 0.5, 6)
    onEnd(m, b, 0, faceY(b, 1, 0.18), 1, [W * 0.98, 0.24, 0.16], chrome ? CHROME : PLASTIC, 0.5, 8)
    mirrors(m, b, b.z(ws) - 0.1, 1.42 + lift, PLASTIC, [0.24, 0.28, 0.12])
    for (const side of [-1, 1]) onSide(m, b, b.z(ws) - 0.5, 1.12 + lift, side, [0.035, 0.035, 0.18], chrome ? CHROME : PLASTIC)
    if (cab !== 'regular') for (const side of [-1, 1]) onSide(m, b, b.z(0.12), 1.12 + lift, side, [0.035, 0.035, 0.18], chrome ? CHROME : PLASTIC)
    // Steps under the doors on lifted trucks.
    if (lift > 0.05) for (const side of [-1, 1]) m.box([side * (W / 2 - 0.05), ride - 0.06, -cabL * 0.05], [0.16, 0.05, cabL * 0.5], PLASTIC)
  })
  // Bed: lower sides with the rear arch, a liner floor, thin side walls, a headboard and the tailgate.
  const bedTop = 1.3 + lift, floor = 0.92 + lift
  const bedC = (bedFront + bedRear) / 2
  m.group([0, 0, bedC], [0, 0, 0], () => {
    const bb = loftBody(m, {
      L: bedOut, W, H: floor, r, axles: [rear - bedC], arch: 1.16,
      belt: [[0, floor], [1, floor]], bottom: [[0, ride + 0.08], [1, ride + 0.02]], plan: [[0, 0.99], [1, 0.99]],
      split: 0.6, eTop: 8, eBot: 8, fillet: [0.04, 0.02], interior: PLASTIC, cockpit: [-1, 2],
    })
    for (const side of [-1, 1]) m.rounded([side * (W / 2 - 0.05), (floor + bedTop) / 2 - 0.02, 0], [0.09, bedTop - floor + 0.06, bedOut], BODY, 8, 12, 8)
    m.rounded([0, (floor + bedTop) / 2, bedOut / 2 - 0.05], [W - 0.06, bedTop - floor, 0.09], BODY, 8, 12, 6)
    m.rounded([0, (floor + bedTop) / 2 - 0.02, -bedOut / 2 + 0.04], [W - 0.04, bedTop - floor + 0.06, 0.08], BODY, 8, 12, 6)
    for (const side of [-1, 1]) m.rounded([side * (W / 2 - 0.05), bedTop - 0.2, -bedOut / 2 + 0.02], [0.1, 0.32, 0.1], TAIL, 6)
    onEnd(m, bb, 0, faceY(bb, -1, 0.15), -1, [W * 0.96, 0.2, 0.14], chrome ? CHROME : PLASTIC, 0.4, 8)
    bedLoad(m, str(p, 'load'), rand, W / 2 - 0.16, floor, -bedOut / 2 + 0.12, bedOut / 2 - 0.12)
    if (p.hitch) {
      m.box([0, ride + 0.12, -bedOut / 2 - 0.12], [0.07, 0.07, 0.3], DARK)
      m.lathe('y', [0, ride + 0.2, -bedOut / 2 - 0.24], [[0.001, -0.05], [0.025, -0.04], [0.025, 0.02], [0.03, 0.05], [0.001, 0.08]], CHROME, 12)
    }
  })
  // Chassis between cab and bed, visible below.
  for (const side of [-1, 1]) m.box([side * 0.5, ride + 0.05, (front + rear) / 2], [0.08, 0.2, ref.wheelBase + 0.6], DARK)
  const rim = pick(rand, [CHROME, paint('#2a2b2e'), paint('#9aa0a6')])
  const parts = [wheels(r, 0.275, { rim: rim === CHROME ? 'spokes' : 'split', spokes: 6, ratio: 0.62, color: rim }, W / 2 - 0.17, [front, rear])]
  const vents: ExhaustVent[] = [{ position: [0.62, ride + 0.05, -L / 2 + 0.2], direction: [0, -0.1, -1], kind: 'tailpipe', radius: 0.045 }]
  return { style: 'fullSize', parts, vents, wheelBase: ref.wheelBase }
}

// ---------------------------------------------------------------- ute

function ute(m: MeshBuilder, p: VehicleParams, rand: Rand): Built {
  const tray = str(p, 'ute') === 'tray'
  const ref = PICKUP_REFERENCES[tray ? 'tray' : 'coupe']
  const { length: L, width: W, height: H, wheelBase: WB } = ref
  const vents: ExhaustVent[] = []
  if (!tray) {
    const r = 0.335, front = L / 2 - 0.92, rear = front - WB
    const b = loftBody(m, {
      L, W, H, r, axles: [front, rear],
      belt: [[0, 0.92], [0.03, 1.0], [0.1, 1.02], [0.4, 1.02], [0.44, 1.0], [0.66, 0.95], [0.84, 0.84], [0.95, 0.76], [1, 0.68]],
      bottom: [[0, 0.42], [0.05, 0.27], [0.14, 0.18], [0.86, 0.18], [0.95, 0.22], [1, 0.32]],
      plan: [[0, 0.95], [0.05, 0.99], [0.15, 1], [0.86, 1], [0.95, 0.93], [1, 0.8]],
      split: 0.5, eTop: 4, eBot: 5, fillet: [0.08, 0.16],
      roof: [[0.405, 1.02], [0.43, 1.36], [0.46, H], [0.55, H - 0.01], [0.6, 1.3], [0.665, 0.95]],
      roofSpan: [0.44, 0.56], pillars: [], topW: 0.76, pillarPaint: TRIM,
      cockpit: [0.03, 0.4], interior: paint('#16171a', 0, 0, FINISH.rubber), // the tray's soft tonneau cover
    })
    lampPair(m, b, 0.62, faceY(b, 1, 0.78), 1, [0.34, 0.08, 0.12], HEAD)
    onEnd(m, b, 0, faceY(b, 1, 0.45), 1, [0.9, 0.18, 0.1], PLASTIC, 0.6)
    lampPair(m, b, 0.7, faceY(b, -1, 0.75), -1, [0.24, 0.16, 0.1], TAIL)
    onEnd(m, b, 0, faceY(b, -1, 0.14), -1, [1.4, 0.14, 0.1], PLASTIC, 0.6)
    mirrors(m, b, b.z(0.64), 1.05, BODY)
    m.box([0, 1.03, b.z(0.4) + 0.01], [W * 0.92, 0.12, 0.05], PLASTIC) // tray headboard rail
    vents.push({ position: [0.5, 0.3, -L / 2 + 0.1], direction: [0, -0.1, -1], kind: 'tailpipe', radius: 0.04 })
    const parts = [wheels(r, 0.245, { rim: 'split', spokes: 5, ratio: 0.68, color: paint(pick(rand, ['#2a2b2e', '#b4b8bd'])) }, W / 2 - 0.15, [front, rear])]
    return { style: 'ute', parts, vents, wheelBase: WB }
  }
  // Cab-chassis with a flat tray: a short cab body, a ladder frame and an alloy deck with drop sides.
  const r = 0.38, front = L / 2 - 0.92, rear = front - WB
  const cabL = 2.55, cabC = L / 2 - cabL / 2, ride = 0.3
  m.group([0, 0, cabC], [0, 0, 0], () => {
    const b = loftBody(m, {
      L: cabL, W: W * 0.98, H, r, axles: [front - cabC],
      belt: [[0, 1.12], [0.4, 1.12], [0.58, 1.08], [0.8, 0.98], [1, 0.86]],
      bottom: [[0, ride + 0.05], [0.8, ride + 0.02], [0.95, ride + 0.1], [1, ride + 0.2]],
      plan: [[0, 0.96], [0.1, 1], [0.88, 1], [1, 0.9]],
      split: 0.5, eTop: 4.5, eBot: 6, fillet: [0.05, 0.14],
      roof: [[0.02, 1.13], [0.04, H - 0.02], [0.3, H], [0.42, H - 0.04], [0.58, 1.08]],
      roofSpan: [0.04, 0.34], pillars: [], topW: 0.82, eGlass: 3.5, pillarPaint: TRIM,
    })
    lampPair(m, b, 0.62, faceY(b, 1, 0.8), 1, [0.32, 0.12, 0.12], HEAD)
    onEnd(m, b, 0, faceY(b, 1, 0.55), 1, [0.9, 0.24, 0.1], PLASTIC, 0.6)
    onEnd(m, b, 0, faceY(b, 1, 0.15), 1, [W * 0.96, 0.22, 0.14], PLASTIC, 0.5, 8)
    mirrors(m, b, b.z(0.56), 1.2, PLASTIC)
  })
  const deckY = 1.0, alloy = paint('#c3c6c8', 0, 0, FINISH.brushed)
  const trayL = L - cabL - 0.08, trayC = -L / 2 + trayL / 2
  for (const side of [-1, 1]) m.box([side * 0.45, ride + 0.25, (front + rear) / 2 - 0.4], [0.08, 0.2, WB + 1.6], DARK)
  m.box([0, deckY - 0.08, trayC], [W, 0.1, trayL], DARK)
  m.box([0, deckY, trayC], [W, 0.06, trayL], alloy)
  for (const side of [-1, 1]) m.box([side * (W / 2 - 0.02), deckY + 0.17, trayC], [0.04, 0.3, trayL], alloy)
  m.box([0, deckY + 0.17, -L / 2 + 0.02], [W, 0.3, 0.04], alloy)
  m.box([0, deckY + 0.36, trayC + trayL / 2 - 0.03], [W * 0.95, 0.68, 0.05], alloy) // headboard
  for (const side of [-1, 1]) m.rounded([side * (W / 2 - 0.15), deckY - 0.12, -L / 2 + 0.06], [0.22, 0.1, 0.08], TAIL, 4)
  // Rear mudguards over the wheels under the deck.
  for (const side of [-1, 1]) m.rounded([side * (W / 2 - 0.2), deckY - 0.14, rear], [0.36, 0.06, 0.95], PLASTIC, 6)
  bedLoad(m, str(p, 'load'), rand, W / 2 - 0.1, deckY + 0.03, trayC - trayL / 2 + 0.1, trayC + trayL / 2 - 0.1)
  vents.push({ position: [0.55, ride + 0.05, rear - 0.6], direction: [0.2, -0.3, -1], kind: 'tailpipe', radius: 0.04 })
  const parts = [wheels(r, 0.235, { rim: 'steel', spokes: 6, ratio: 0.6, color: paint(pick(rand, ['#c9cdd1', '#2a2b2e'])) }, W / 2 - 0.16, [front, rear])]
  return { style: 'ute-tray', parts, vents, wheelBase: WB }
}

/** Lamps in a mirrored pair on the front or rear. */
function lampPair(m: MeshBuilder, b: Body, x: number, y: number, dir: 1 | -1, size: Vec3, s: Paint): void {
  for (const side of [-1, 1]) onEnd(m, b, side * x, y, dir, size, s)
}

// ---------------------------------------------------------------- angular

/**
 * Flat panels between polygonal cross-sections (`pts` per station, the same count each, closed
 * rings): every quad is one flat face, so the body stays crisply faceted.
 */
function facets(m: MeshBuilder, stations: { z: number; pts: [number, number][] }[], paintOf: (i: number, j: number, mid: Vec3) => Paint): void {
  const n = stations[0].pts.length
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i], b = stations[i + 1]
    const inside: Vec3 = [0, (a.pts.reduce((s, q) => s + q[1], 0) + b.pts.reduce((s, q) => s + q[1], 0)) / (2 * n), (a.z + b.z) / 2]
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n
      const quad: Vec3[] = [[a.pts[j][0], a.pts[j][1], a.z], [a.pts[k][0], a.pts[k][1], a.z], [b.pts[k][0], b.pts[k][1], b.z], [b.pts[j][0], b.pts[j][1], b.z]]
      const mid: Vec3 = [(quad[0][0] + quad[2][0]) / 2, (quad[0][1] + quad[2][1]) / 2, (quad[0][2] + quad[2][2]) / 2]
      const s = paintOf(i, j, mid)
      // Split into triangles so twisted quads stay flat-faced.
      m.face([quad[0], quad[1], quad[2]], s, inside)
      m.face([quad[0], quad[2], quad[3]], s, inside)
    }
  }
  for (const [st, dz] of [[stations[0], 1], [stations[stations.length - 1], -1]] as const) {
    m.face(st.pts.map(([x, y]) => [x, y, st.z] as Vec3), paintOf(-1, -1, [0, 0, st.z]), [0, st.pts.reduce((s, q) => s + q[1], 0) / n, st.z + dz])
  }
}

function angular(m: MeshBuilder, p: VehicleParams): Built {
  const ref = PICKUP_REFERENCES.angular
  const { length: L, width: W, height: H, wheelBase: WB } = ref
  const r = 0.44, front = L / 2 - 1.02, rear = front - WB
  const skin = p.painted ? BODY : BRUSHED
  const hw = W / 2
  const apex = L / 2 - 2.35 // roof peak
  const nose = 1.12, tail = 1.36, belt = 0.98, sill = 0.42
  // Side profile: the roof line runs straight from the nose to the apex and down to the tailgate.
  const topAt = (z: number) => (z > apex ? nose + (H - nose) * (L / 2 - z) / (L / 2 - apex) : tail + (H - tail) * (z + L / 2) / (apex + L / 2))
  const archAt = (z: number) => {
    let y = 0
    for (const zc of [front, rear]) {
      const d = Math.abs(z - zc), R = r * 1.25
      if (d < R) y = Math.max(y, d < R * 0.55 ? r + R * 0.78 : r + R * 0.78 - (d - R * 0.55) / (R * 0.45) * (r + R * 0.78 - sill))
    }
    return y
  }
  const zs = new Set<number>([-L / 2, -L / 2 + 0.06, L / 2 - 0.08, L / 2, apex])
  for (const zc of [front, rear]) for (const f of [-1, -0.55, -0.3, 0, 0.3, 0.55, 1]) zs.add(zc + f * r * 1.25)
  for (let z = -L / 2; z < L / 2; z += 0.25) zs.add(z)
  const order = [...zs].sort((a, b) => a - b)
  // Cross-section: sill, flank, belt crease, then the upper body leaning in to the roof.
  const stations = order.map((z) => {
    const end = z < -L / 2 + 0.03 || z > L / 2 - 0.03
    const top = topAt(z), cut = archAt(z)
    const lo = Math.max(sill, cut)
    const w = end ? hw - 0.04 : hw
    const shoulder = Math.min(top - 0.02, belt + 0.12)
    const roofW = w * 0.62
    const pts: [number, number][] = [
      [w - 0.12, Math.min(lo, shoulder - 0.05)], [w, Math.min(Math.max(lo, 0.62), shoulder - 0.04)], [w, shoulder], [roofW, top],
      [-roofW, top], [-w, shoulder], [-w, Math.min(Math.max(lo, 0.62), shoulder - 0.04)], [-w + 0.12, Math.min(lo, shoulder - 0.05)],
    ]
    return { z, pts }
  })
  const glassZ: [number, number] = [L / 2 - 1.85, -L / 2 + 2.05]
  facets(m, stations, (i, j, mid) => {
    if (i < 0) return skin
    const z = mid[2]
    if (j === 7) return DARK // underside
    if (j === 3) return z > apex && z < glassZ[0] + 0.85 ? GLASS : skin // windscreen on the roof facet
    if ((j === 2 || j === 4) && z < glassZ[0] && z > glassZ[1] && mid[1] > shoulderY(mid) + 0.08) return GLASS // side windows
    if ((j === 0 || j === 6) && archAt(z) > sill + 0.05) return PLASTIC
    return skin
  })
  function shoulderY(mid: Vec3) { return Math.min(topAt(mid[2]) - 0.02, belt + 0.12) }
  // Light bars across the nose and the tailgate; dark lower valance; wheel-arch flares.
  m.box([0, nose - 0.04, L / 2 - 0.02], [W * 0.96, 0.03, 0.03], HEAD)
  m.box([0, tail - 0.06, -L / 2 + 0.01], [W * 0.96, 0.05, 0.03], TAIL)
  m.box([0, sill + 0.06, L / 2 - 0.06], [W * 0.9, 0.14, 0.04], PLASTIC)
  for (const zc of [front, rear]) for (const side of [-1, 1]) {
    m.fin([[-r * 1.3, 0], [-r * 0.65, r * 0.98], [r * 0.65, r * 0.98], [r * 1.3, 0]], [side * (hw + 0.012), r + 0.02, zc], [0, 0, 1], [0, 1, 0], 0.03, PLASTIC)
  }
  // Tonneau ridges and a hairline door seam.
  for (const side of [-1, 1]) m.box([side * (hw + 0.002), belt - 0.25, (glassZ[0] + glassZ[1]) / 2 + 0.3], [0.004, 0.45, 0.005], DARK)
  const parts = [wheels(r, 0.29, { rim: 'aero', spokes: 6, ratio: 0.64, color: paint('#2c2e31') }, hw - 0.16, [front, rear])]
  return { style: 'angular', parts, vents: [], wheelBase: WB }
}
