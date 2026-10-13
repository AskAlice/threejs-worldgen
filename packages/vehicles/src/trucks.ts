// Heavy goods vehicles: conventional (long-bonnet) and cab-over tractors, day or sleeper cabs, 2 to 4
// axles, chrome stacks or under-body exhaust; rigid box trucks; and trailers (box van, ISO containers
// on a skeletal chassis, flatbed with seeded loads, tanker) that couple into multi-trailer rigs. A rig is
// one fleet unit: the tractor follows the route and every trailer is dragged by its kingpin.
import { FINISH, MeshBuilder, paint, type Paint, type Vec3 } from './mesh.ts'
import { BODY, BRUSHED, CHROME, DARK, GLASS, HEAD, PLASTIC, TAIL, TRIM, body, dualWheel, model, num, pick, smoothWheel, str, type Rand, type WheelLook } from './kit.ts'
import { faceY, loftBody, onEnd, type Body } from './body.ts'
import type { ExhaustVent, ModelPart, PartMount, VehicleModel, VehicleParams } from './models.ts'

/** Trailer kinds. */
export const TRAILER_KINDS = ['box', 'container', 'flatbed', 'tanker'] as const
/** A trailer kind. */
export type TrailerKind = (typeof TRAILER_KINDS)[number]

/** Road-legal limits the generated rigs keep to, metres: the strictest common width and height, the longest single trailer and road train. */
export const TRUCK_LIMITS = { width: 2.6, height: 4.3, trailer: 16.2, rig: 53.5 }

/** ISO container sizes, metres. */
export const ISO = { length20: 6.058, length40: 12.192, width: 2.438, height: 2.591 }

const CAB_PALETTE = ['#b8282a', '#e9ecee', '#1b1b1d', '#1f4f8f', '#2b6b3a', '#e7b416', '#6d6f73', '#7a1f2b', '#cf5a12', '#3a3f6b']
const BOX_PALETTE = ['#f2f3f4', '#f2f3f4', '#e9ecee', '#c9ccd0', '#9a1c1c', '#1f4f8f', '#2b6b3a']
const CONTAINER_COLORS = ['#8c2a1e', '#a33a22', '#1d4f86', '#2d6a3e', '#c96b1c', '#6d7378', '#e3e1d9', '#7a2d5a', '#b8a12a', '#3b4552']

const R_STEER = 0.507 // 295/75 R22.5
const R_TRAILER = 0.48 // 11R22.5 low profile
const TW = 0.28

const steerLook: WheelLook = { rim: 'dish', spokes: 10, ratio: 0.56, color: paint('#d4d7da', 0, 0, FINISH.chrome) }
const driveLook: WheelLook = { rim: 'dish', spokes: 10, ratio: 0.56, color: paint('#c4c7ca', 0, 0, FINISH.chrome) }

/** Steer and dual axles of a vehicle as one wheel part each. */
function axleParts(steer: number[], duals: number[], track: number, rSteer = R_STEER, rDual = R_STEER): ModelPart[] {
  const parts: ModelPart[] = []
  const mount = (z: number, r: number, side: number, steerable: boolean): PartMount => ({
    position: [side * track, r, z], rotation: side < 0 ? [0, Math.PI, 0] : undefined,
    spin: { axis: 0, rate: side / r, by: 'distance' }, steer: steerable ? 1 : undefined,
  })
  if (steer.length) parts.push({ name: 'wheel', mesh: smoothWheel(rSteer, TW, steerLook), mounts: steer.flatMap((z) => [-1, 1].map((s) => mount(z, rSteer, s, true))) })
  // Duals: the outer tyre's face stays inside the 2.6 m legal width.
  const dualTrack = Math.min(track, TRUCK_LIMITS.width / 2 - 0.02 - TW * 1.07 - 0.02)
  if (duals.length) parts.push({ name: 'dual', mesh: dualWheel(rDual, TW, driveLook), mounts: duals.flatMap((z) => [-1, 1].map((s) => ({ ...mount(z, rDual, s, false), position: [s * dualTrack, rDual, z] as Vec3 }))) })
  return parts
}

/** Ladder frame rails from z0 to z1 at height y. */
function frame(m: MeshBuilder, z0: number, z1: number, y: number): void {
  for (const s of [-1, 1]) m.box([s * 0.43, y, (z0 + z1) / 2], [0.09, 0.28, z1 - z0], DARK)
  for (let z = z0 + 0.4; z < z1; z += 1.6) m.box([0, y, z], [0.8, 0.2, 0.08], DARK)
}

/** Mud flaps and lamps behind an axle group. */
function mudflaps(m: MeshBuilder, z: number, W: number): void {
  for (const s of [-1, 1]) m.box([s * (W / 2 - 0.3), 0.55, z], [0.6, 0.62, 0.02], PLASTIC)
}

/** A truck: a tractor, a rigid box truck, or (with `piece: 'trailer'`) one trailer of a rig. */
export function truck(p: VehicleParams, rand: Rand): VehicleModel {
  if (str(p, 'piece') === 'trailer') return trailer(p, rand)
  return tractor(p, rand)
}

// ---------------------------------------------------------------- tractor and rigid

function tractor(p: VehicleParams, rand: Rand): VehicleModel {
  const cabOver = str(p, 'cab') === 'cabOver'
  const sleeper = !!p.sleeper
  const rigid = str(p, 'body') === 'rigid'
  const axles = Math.max(2, Math.min(4, Math.round(num(p, 'axles'))))
  const stacks = !!p.stacks
  const W = 2.5, m = new MeshBuilder()
  const drives = rigid ? Math.min(axles - 1, 2) : axles - 1
  const spread = 1.32
  // Lengths from the front bumper: bonnet (conventional), cab, sleeper; wheelbase to the drive group centre.
  const front = cabOver ? 1.45 : 1.0
  const bbc = cabOver ? (sleeper ? 2.3 : 1.75) : sleeper ? 5.2 : 3.4
  const WB = rigid ? 5.6 : cabOver ? (drives > 1 ? 3.9 : 3.6) : sleeper ? 5.9 : 4.2
  const rear = rigid ? 2.4 : 1.0 + (drives - 1) * spread / 2
  const L = front + WB + rear
  const zf = L / 2 - front, zr = zf - WB
  const driveZ = Array.from({ length: drives }, (_, k) => zr + (k - (drives - 1) / 2) * spread)
  const steerZ = axles === 4 && rigid ? [zf, zf - 1.9] : [zf]
  const chrome = rand() < 0.6
  const tanks = chrome ? BRUSHED : paint('#9aa0a6', 0, 0, FINISH.brushed)
  const cabBack = L / 2 - bbc
  const roof = sleeper ? 3.95 : 3.05
  let b!: Body
  if (!cabOver) {
    // Long bonnet over the steer axle with integral wings, then the cab.
    const hoodL = 2.05, hoodC = L / 2 - hoodL / 2
    m.group([0, 0, hoodC], [0, 0, 0], () => {
      b = loftBody(m, {
        L: hoodL, W, H: 1.9, r: R_STEER, axles: [zf - hoodC], arch: 1.12,
        belt: [[0, 1.86], [0.5, 1.8], [0.9, 1.68], [1, 1.6]],
        bottom: [[0, 0.95], [0.6, 0.9], [0.9, 0.55], [1, 0.5]],
        plan: [[0, 1], [0.85, 0.99], [1, 0.94]],
        split: 0.62, eTop: 4.5, eBot: 7, tuck: [0.4, 0.05], fillet: [0.02, 0.08],
      })
      // Tall upright grille in a chrome surround, lamps in the wings, a bumper.
      onEnd(m, b, 0, faceY(b, 1, 0.62), 1, [0.98, 0.95, 0.1], chrome ? CHROME : PLASTIC, 0.5, 10)
      onEnd(m, b, 0, faceY(b, 1, 0.62), 1, [0.86, 0.84, 0.12], DARK, 0.42, 12)
      for (let i = -3; i <= 3; i++) onEnd(m, b, i * 0.115, faceY(b, 1, 0.62), 1, [0.025, 0.82, 0.13], chrome ? CHROME : TRIM, 0.38, 6)
      for (const s of [-1, 1]) onEnd(m, b, s * 0.92, faceY(b, 1, 0.36), 1, [0.36, 0.2, 0.12], HEAD, 0.55, 5)
    })
    m.box([0, 0.62, L / 2 + 0.02], [W, 0.34, 0.24], chrome ? CHROME : PLASTIC)
  }
  // Cab (and sleeper): a boxy loft with a near-upright split windscreen.
  const cabL = cabOver ? bbc : bbc - 2.05
  const cabC = cabBack + cabL / 2
  const cabFloor = cabOver ? 1.3 : 1.05, sill = cabOver ? 2.0 : 2.2
  m.group([0, 0, cabC], [0, 0, 0], () => {
    const u = (dz: number) => 1 - dz / cabL // u at dz metres behind the cab front
    const roofKeys: [number, number][] = sleeper && !cabOver
      ? [[0.01, sill + 0.01], [0.03, roof], [u(1.75), roof], [u(1.45), 3.12], [u(0.35), 3.05], [1, sill]]
      : [[0.01, sill + 0.01], [0.03, roof], [u(0.3), roof], [1, sill]]
    const cab = loftBody(m, {
      L: cabL, W, H: roof, r: R_STEER, axles: cabOver ? [zf - cabC] : [], arch: 1.12,
      belt: [[0, sill], [1, sill]], bottom: [[0, cabFloor], [1, cabOver ? 0.55 : cabFloor]],
      plan: [[0, 0.99], [1, 0.99]], split: 0.5, eTop: 9, eBot: 9, tuck: [0.02, 0.02], fillet: [0.06, 0.1],
      roof: roofKeys, roofSpan: [0.02, u(0.3)], pillars: [u(0.04) - 0.0001], cPillar: u(1.25), topW: 0.95, eGlass: 8, glassW: 0.97,
      pillarPaint: TRIM,
    })
    if (cabOver) {
      // Flat face: a grille panel under the screen, lamps in the bumper.
      onEnd(m, cab, 0, faceY(cab, 1, 0.55), 1, [1.7, 0.42, 0.06], PLASTIC, 0.6, 10)
      for (let i = 0; i < 4; i++) onEnd(m, cab, 0, faceY(cab, 1, 0.42 + i * 0.07), 1, [1.6, 0.02, 0.07], chrome ? CHROME : TRIM, 0.55, 8)
      onEnd(m, cab, 0, faceY(cab, 1, 0.12), 1, [W, 0.32, 0.16], PLASTIC, 0.5, 10)
      for (const s of [-1, 1]) onEnd(m, cab, s * 0.95, faceY(cab, 1, 0.14), 1, [0.36, 0.14, 0.1], HEAD, 0.4, 6)
    }
    // West-coast mirrors on arms, sun visor, steps.
    for (const s of [-1, 1]) {
      const zM = cabL / 2 - 0.15
      m.beam([s * W / 2, sill + 0.15, zM], [s * (W / 2 + 0.28), sill + 0.25, zM + 0.1], 0.04, TRIM)
      m.rounded([s * (W / 2 + 0.3), sill + 0.35, zM + 0.1], [0.12, 0.62, 0.22], TRIM, 5)
      m.box([s * (W / 2 - 0.12), cabFloor - 0.25, cabL / 2 - (cabOver ? 0.7 : 0.6)], [0.3, 0.05, 0.5], PLASTIC)
    }
    m.rounded([0, roof - 0.04, cabL / 2 + 0.05], [W * 0.96, 0.08, 0.32], BODY, 6)
    for (let i = 0; i < 5; i++) m.rounded([(i - 2) * 0.3, roof + 0.02, cabL / 2 - 0.1], [0.12, 0.06, 0.08], paint('#ffb43a', 0, 0.8, FINISH.glass), 3)
  })
  // Chassis: frame, fuel tanks, battery box, fifth wheel or box body, stacks, flaps, lamps.
  frame(m, -L / 2 + 0.1, L / 2 - (cabOver ? 0.5 : 0.4), 0.95)
  const tankZ = rigid ? zf - 2.1 : (zf + driveZ[0]) / 2 - 0.2
  m.lathe('z', [-0.9, 0.82, tankZ], [[0.001, -0.75], [0.3, -0.72], [0.33, -0.65], [0.33, 0.65], [0.3, 0.72], [0.001, 0.75]], tanks, 24)
  m.box([0.95, 0.82, tankZ], [0.5, 0.55, 0.9], PLASTIC)
  for (const s of [-1, 1]) m.box([s * (s < 0 ? 1.235 : 1.2), 0.82, tankZ], [0.01, 0.06, s < 0 ? 1.3 : 0.9], s < 0 ? tanks : PLASTIC)
  const vents: ExhaustVent[] = []
  if (stacks) {
    for (const s of [-1, 1]) {
      const sz = cabBack - 0.18
      m.lathe('y', [s * 1.08, 2.6, sz], [[0.11, -1.5], [0.11, 1.35], [0.1, 1.55], [0.08, 1.56]], chrome ? CHROME : DARK, 16)
      m.box([s * 1.08, 2.1, sz], [0.16, 0.9, 0.24], BRUSHED) // heat shield
      vents.push({ position: [s * 1.08, 4.17, sz], direction: [0, 1, 0], kind: 'stack', radius: 0.1 })
    }
  } else vents.push({ position: [1.05, 0.48, tankZ - 1.1], direction: [0.3, -0.35, -0.9], kind: 'stack', radius: 0.07 })
  if (rigid) {
    // Box body on the frame behind the cab.
    const boxL = L - bbc - 0.25, boxC = -L / 2 + boxL / 2
    m.rounded([0, 1.2 + 1.3, boxC], [2.55, 2.6, boxL], BODY, 14, 16, 10)
    for (const s of [-1, 1]) m.box([s * 1.28, 1.25, boxC], [0.03, 0.1, boxL], BRUSHED)
    m.box([0, 2.5, -L / 2 - 0.01], [2.4, 2.4, 0.02], paint('#d9dbdd'))
    for (const s of [-1, 1]) m.rounded([s * 0.95, 0.95, -L / 2 + 0.05], [0.3, 0.12, 0.08], TAIL, 4)
  } else {
    // Fifth wheel over the drive axles; deck plate; lamps on the frame end.
    m.rounded([0, 1.2, zr + 0.3], [1.0, 0.1, 1.0], DARK, 4)
    m.box([0, 1.12, zr + 1.5], [0.9, 0.04, 1.4], BRUSHED)
    for (const s of [-1, 1]) m.rounded([s * 0.55, 0.95, -L / 2 + 0.12], [0.22, 0.1, 0.06], TAIL, 4)
  }
  mudflaps(m, driveZ[driveZ.length - 1] - 0.65, W)
  const parts = [body(m.build()), ...axleParts(steerZ, driveZ, W / 2 - 0.2)]
  const style = rigid ? `rigid-${cabOver ? 'cabover' : 'conventional'}` : `${cabOver ? 'cabover' : 'conventional'}-${sleeper ? 'sleeper' : 'day'}`
  const color = str(p, 'cabColor')
  return model('truck', style, 'land', parts, {
    wheelBase: zf - (drives > 1 ? (driveZ[0] + driveZ[driveZ.length - 1]) / 2 : driveZ[0]), vents, bank: -0.02,
    palette: /^#[0-9a-f]{6}$/i.test(color) ? [color] : rigid ? BOX_PALETTE : CAB_PALETTE,
    hitch: rigid ? undefined : { coupling: zr + 0.3 },
  })
}

// ---------------------------------------------------------------- trailers

/** Trailer length by kind, single or in a multi-trailer rig, metres. */
export function trailerLength(kind: TrailerKind, multi: boolean): number {
  if (multi) return kind === 'flatbed' ? 12.5 : kind === 'tanker' ? 12.2 : 12.6
  return kind === 'box' ? 16.15 : kind === 'flatbed' ? 14.63 : kind === 'tanker' ? 13 : 12.6
}

/** The kind of a trailer with these parameters (`mixed` picks one from the seed). */
export function trailerKind(p: VehicleParams, rand: Rand): TrailerKind {
  const k = str(p, 'trailer')
  if ((TRAILER_KINDS as readonly string[]).includes(k)) return k as TrailerKind
  return pick(rand, ['box', 'box', 'container', 'container', 'flatbed', 'tanker'])
}

function trailer(p: VehicleParams, rand: Rand): VehicleModel {
  const slot = Math.round(num(p, 'slot') || 0)
  const count = Math.max(1, Math.min(3, Math.round(num(p, 'trailers'))))
  const lead = slot < count - 1
  const kind = trailerKind(p, rand)
  const L = trailerLength(kind, count > 1)
  const m = new MeshBuilder()
  const kingpin = L / 2 - 0.9
  // Lead trailers of a rig carry the next one's fifth wheel over their own axles (B-train).
  const axleC = lead ? -L / 2 + 1.35 : -L / 2 + 2.4
  const axleZ = [axleC + 0.66, axleC - 0.66]
  if (count > 1 && !lead && slot > 0) axleZ.push(axleC - 1.98)
  const deck = 1.25
  const bodyEnd = lead ? -L / 2 + 3.0 : -L / 2 // the lead's body stops short of the next trailer's nose
  const bodyL = L / 2 - bodyEnd, bodyC = (L / 2 + bodyEnd) / 2
  let palette = BOX_PALETTE
  // Underframe, landing legs, kingpin plate, side guards.
  for (const s of [-1, 1]) m.box([s * 0.5, deck - 0.22, 0], [0.12, 0.34, L - 0.1], DARK)
  for (const s of [-1, 1]) {
    m.box([s * 0.55, 0.6, kingpin - 2.4], [0.1, 1.0, 0.12], PLASTIC)
    m.box([s * 0.55, 0.12, kingpin - 2.4], [0.3, 0.06, 0.3], DARK)
  }
  m.box([0, deck - 0.06, kingpin], [1.2, 0.06, 1.2], DARK)
  if (kind === 'box') {
    m.rounded([0, deck + 1.43, bodyC], [2.6, 2.86, bodyL], BODY, 16, 16, 10)
    for (const y of [deck + 0.02, deck + 2.84]) for (const s of [-1, 1]) m.box([s * 1.285, y, bodyC], [0.03, 0.08, bodyL], BRUSHED)
    for (let z = bodyEnd + 1.2; z < L / 2 - 0.5; z += 1.2) for (const s of [-1, 1]) m.box([s * 1.292, deck + 1.43, z], [0.008, 2.7, 0.03], paint('#d6d8da'))
    if (!lead) {
      m.box([0, deck + 1.43, -L / 2 - 0.01], [2.5, 2.7, 0.02], paint('#d9dbdd'))
      m.box([0, deck + 1.43, -L / 2 - 0.02], [0.02, 2.7, 0.02], DARK)
      for (const s of [-1, 1]) for (const y of [0.6, 1.4, 2.2]) m.box([s * 0.62, deck + y, -L / 2 - 0.03], [0.04, 0.06, 0.02], BRUSHED)
    }
    for (const s of [-1, 1]) m.box([s * 1.0, deck - 0.75, bodyC + 1], [0.02, 0.6, bodyL * 0.45], PLASTIC) // side skirts
  } else if (kind === 'container') {
    palette = ['#3b3d40']
    // Skeletal chassis with twist locks, carrying one 40 ft or two 20 ft boxes.
    m.box([0, deck + 0.04, 0], [2.3, 0.08, 0.2], DARK)
    for (const z of [L / 2 - 0.3, -L / 2 + 0.3]) m.box([0, deck - 0.05, z], [2.44, 0.18, 0.18], DARK)
    const boxes = lead || rand() < 0.4 ? [ISO.length20] : rand() < 0.5 ? [ISO.length40] : [ISO.length20, ISO.length20]
    let z = L / 2 - 0.25
    for (const len of boxes) {
      if (z - len < bodyEnd - 0.01 && lead) break
      container(m, [0, deck + 0.05, z - len / 2], len, paint(pick(rand, CONTAINER_COLORS)), rand)
      z -= len + 0.08
    }
  } else if (kind === 'flatbed') {
    palette = ['#3b3d40']
    const wood = paint('#7a5a3a')
    m.box([0, deck + 0.05, bodyC], [2.55, 0.1, bodyL], wood)
    for (const s of [-1, 1]) m.box([s * 1.265, deck, bodyC], [0.06, 0.16, bodyL], DARK)
    m.box([0, deck + 0.6, L / 2 - 0.1], [2.5, 1.1, 0.08], DARK) // headboard
    flatLoad(m, str(p, 'load'), rand, deck + 0.1, bodyEnd + 0.4, L / 2 - 0.4)
  } else {
    palette = ['#ffffff']
    // Tank: smooth elliptical barrel with domed ends, catwalk, ladder.
    const finish = rand() < 0.65 ? paint('#c4c8cb', 0, 0, FINISH.brushed) : BODY
    if (finish === BODY) palette = ['#f2f3f4', '#e7b416', '#c9ccd0']
    const tl = bodyL - 0.2, tc = bodyC, cy = deck + 1.2
    const rows: Vec3[][] = []
    const n = 40
    for (let i = 0; i <= n; i++) {
      const t = i / n, a = (t * 2 - 1) * Math.PI / 2
      const z = tc + Math.sin(a) * tl / 2, k = Math.cos(a) ** 0.18
      const ring: Vec3[] = []
      for (let j = 0; j < 32; j++) {
        const b = (j / 32) * Math.PI * 2
        ring.push([Math.cos(b) * 1.22 * k, cy + Math.sin(b) * 1.08 * k, z])
      }
      rows.push(ring)
    }
    m.surface(rows, () => finish)
    m.box([0, cy + 1.1, tc], [0.5, 0.04, tl * 0.8], DARK)
    for (const s of [-1, 1]) m.box([s * 0.25, cy + 1.32, tc], [0.025, 0.025, tl * 0.8], BRUSHED)
    for (let z = tc - tl * 0.3; z <= tc + tl * 0.31; z += tl * 0.2) m.lathe('y', [0, cy + 1.12, z], [[0.001, -0.02], [0.28, -0.02], [0.28, 0.06], [0.001, 0.06]], DARK, 16)
    m.beam([0.9, deck + 0.1, -L / 2 + 0.25], [0.9, cy + 1.05, -L / 2 + 0.6], 0.05, BRUSHED)
  }
  if (lead) m.rounded([0, deck + 0.05, axleC], [1.0, 0.1, 1.0], DARK, 4)
  for (const s of [-1, 1]) m.rounded([s * 1.1, deck - 0.3, -L / 2 + 0.06], [0.28, 0.1, 0.06], TAIL, 4)
  mudflaps(m, axleZ[axleZ.length - 1] - 0.65, 2.5)
  const parts = [body(m.build()), ...axleParts([], axleZ, 2.5 / 2 - 0.2, R_TRAILER, R_TRAILER)]
  return model('truck', `trailer-${kind}`, 'land', parts, {
    wheelBase: kingpin - axleC, palette, bank: -0.01,
    hitch: { kingpin, axle: axleC, coupling: lead ? axleC : undefined },
  })
}

/** An ISO container with its base at `c` (y) centred at (x, z): corrugated sides, end doors with bars. */
function container(m: MeshBuilder, c: Vec3, len: number, s: Paint, rand: Rand): void {
  const { width: w, height: h } = ISO
  m.box([c[0], c[1] + h / 2, c[2]], [w - 0.04, h - 0.04, len - 0.04], s)
  const ribs = Math.round(len / 0.28)
  for (let i = 0; i < ribs; i++) {
    const z = c[2] - len / 2 + 0.12 + (i + 0.5) * ((len - 0.24) / ribs)
    for (const side of [-1, 1]) m.box([c[0] + side * (w / 2 - 0.02), c[1] + h / 2, z], [0.04, h - 0.2, 0.1], s)
  }
  const rail = paint('#2a2b2d')
  for (const y of [0.05, h - 0.05]) for (const side of [-1, 1]) m.box([c[0] + side * (w / 2 - 0.02), c[1] + y, c[2]], [0.06, 0.1, len], s)
  for (const z of [-1, 1]) for (const side of [-1, 1]) m.box([c[0] + side * (w / 2 - 0.04), c[1] + h / 2, c[2] + z * (len / 2 - 0.04)], [0.09, h, 0.09], rail)
  // Doors at the rear end: locking bars.
  for (let i = 0; i < 4; i++) m.box([c[0] + (i - 1.5) * 0.5, c[1] + h / 2, c[2] - len / 2 - 0.01], [0.035, h - 0.2, 0.03], BRUSHED)
  // A seeded livery band without names: a contrasting stripe on some boxes.
  if (rand() < 0.35) for (const side of [-1, 1]) m.box([c[0] + side * (w / 2 + 0.001), c[1] + h * 0.72, c[2]], [0.005, 0.32, len * 0.6], paint(pick(rand, ['#e9ecee', '#1b1b1d', '#e7b416'])))
}

/** A flatbed load between z0 and z1 on a deck at y. */
function flatLoad(m: MeshBuilder, load: string, rand: Rand, y: number, z0: number, z1: number): void {
  if (load === 'empty') return
  if (load === 'mixed' || !['lumber', 'pipes', 'machinery'].includes(load)) load = pick(rand, ['lumber', 'lumber', 'pipes', 'machinery', 'empty'])
  const strap = paint('#d4a017')
  if (load === 'lumber') {
    const wood = paint(pick(rand, ['#c9a46a', '#b8915a', '#d4b27a']))
    const n = Math.max(1, Math.floor((z1 - z0) / 4.9))
    for (let i = 0; i < n; i++) for (let k = 0; k < 2; k++) {
      const z = z0 + (i + 0.5) * ((z1 - z0) / n), yy = y + 0.1 + k * 0.62
      m.box([0, yy + 0.3, z], [2.3, 0.6, 4.7], wood)
      m.box([0, yy + 0.02, z], [2.3, 0.04, 4.7], PLASTIC)
      for (const dz of [-1.6, 0, 1.6]) m.box([0, yy + 0.3, z + dz], [2.34, 0.64, 0.05], strap)
    }
  } else if (load === 'pipes') {
    const pipe = paint(pick(rand, ['#5d646b', '#3a3f45', '#8a6a44']))
    const r = 0.18, len = Math.min(12, z1 - z0)
    for (let row = 0; row < 3; row++) for (let i = 0; i < 6 - row; i++) {
      const x = (i - (5 - row) / 2) * r * 2.05
      m.lathe('z', [x, y + r + row * r * 1.75, (z0 + z1) / 2], [[r * 0.8, -len / 2], [r, -len / 2], [r, len / 2], [r * 0.8, len / 2]], pipe, 16)
    }
    for (const dz of [-len / 3, len / 3]) m.box([0, y + 0.55, (z0 + z1) / 2 + dz], [2.35, 1.15, 0.05], strap)
  } else if (load === 'machinery') {
    // A tracked excavator, boom folded.
    const yellow = paint('#e0a51c'), zc = (z0 + z1) / 2
    for (const s of [-1, 1]) m.rounded([s * 0.9, y + 0.4, zc], [0.6, 0.8, 4.2], DARK, 6)
    m.box([0, y + 0.95, zc], [2.4, 0.3, 2.8], yellow)
    m.rounded([0.6, y + 1.75, zc + 0.7], [0.95, 1.3, 1.1], yellow, 8)
    m.box([0.6, y + 1.9, zc + 1.26], [0.85, 0.85, 0.02], GLASS)
    m.beam([-0.3, y + 1.4, zc + 0.6], [-0.3, y + 2.6, zc + 2.6], 0.36, yellow)
    m.beam([-0.3, y + 2.6, zc + 2.6], [-0.3, y + 0.6, zc + 3.4], 0.3, yellow)
    m.box([-0.3, y + 0.45, zc + 3.4], [0.9, 0.6, 0.6], DARK)
    for (const dz of [-1.6, 1.6]) m.beam([-1.25, y, zc + dz], [-0.9, y + 0.8, zc + dz], 0.03, strap)
  }
}
