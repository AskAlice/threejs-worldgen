import { mulberry32, seedOf } from 'threejs-biomes'
import { MeshBuilder, paint, type MeshData, type Paint, type Vec3 } from './mesh.ts'
import { LOOKALIKE_STYLES, lookalikeCar, type LookalikeStyle } from './cars.ts'
import { PICKUP_STYLES, pickup } from './pickups.ts'
import { TRAILER_KINDS, truck } from './trucks.ts'
import { BODY, DARK, GLASS, GREY, HEAD, LIT, RIM, TAIL, TRIM, TYRE, WHITE, body, jitter, model, num, pick, roadWheel, str, type Rand } from './kit.ts'

/** Every vehicle the package generates. */
export type VehicleType =
  | 'car' | 'pickup' | 'truck' | 'bicycle' | 'train'
  | 'fishing-boat' | 'cruise-liner' | 'speedboat' | 'hovercraft' | 'aircraft-carrier'
  | 'airplane' | 'fighter-jet' | 'rocket'

/** Where a vehicle moves. */
export type VehicleDomain = 'land' | 'rail' | 'sea' | 'air' | 'space'

/** One editable parameter of a vehicle, as JSON (same shape as `AssetParam` in threejs-worldgen). */
export type ParamDef =
  | { type: 'number'; default: number; min: number; max: number; step?: number }
  | { type: 'boolean'; default: boolean }
  | { type: 'choice'; default: string; options: string[] }
  | { type: 'color'; default: string }

/** Parameter values of one vehicle (missing ones use the defaults in {@link VEHICLE_KINDS}). */
export type VehicleParams = Record<string, number | string | boolean>

/** How a moving part is attached and animated. */
export interface PartMount {
  /** Pivot, vehicle space (metres; +z forward, +y up, ground or waterline at y = 0). */
  position: Vec3
  /** Rest rotation, Euler YXZ radians. */
  rotation?: Vec3
  /** Spin: about which local axis (0 x, 1 y, 2 z), how fast, and driven by distance travelled or time. */
  spin?: { axis: 0 | 1 | 2; rate: number; by: 'distance' | 'time' }
  /** Multiplier on the vehicle's steering angle (1 = steered wheel). */
  steer?: number
  /** Rocket stage this part belongs to (falls away at separation `stage`); −1 stays at the launch pad. */
  stage?: number
}

/** One kind of part of a model: one mesh, mounted once or many times (four wheels share one mesh). */
export interface ModelPart {
  /** Part name (`body`, `wheel`, `fan`, `stage0`, …). */
  name: string
  /** The geometry. */
  mesh: MeshData
  /** Where it is mounted. */
  mounts: PartMount[]
}

/** An engine exhaust: rocket plumes, afterburners. */
export interface Exhaust {
  /** Nozzle, vehicle space. */
  position: Vec3
  /** Unit direction the plume points. */
  direction: Vec3
  /** Plume radius at the nozzle. */
  radius: number
  /** Plume length at full throttle. */
  length: number
  /** Plume colour. */
  color: string
  /** Rocket stage that fires it (only while that stage is the active one). */
  stage?: number
}

/**
 * Where engine smoke leaves a vehicle (threejs-particles exhaust, see `VehicleExhaust`): car tailpipes,
 * truck and tractor stacks, locomotive chimneys. Electric vehicles have none.
 */
export interface ExhaustVent {
  /** Outlet, vehicle space. */
  position: Vec3
  /** Unit direction the gas leaves in, vehicle space. */
  direction: Vec3
  /** What comes out: faint `tailpipe` exhaust, diesel `stack` smoke, a `steam` locomotive's plume, a `diesel` locomotive's haze. */
  kind: 'tailpipe' | 'stack' | 'steam' | 'diesel'
  /** Outlet radius, metres. */
  radius: number
}

/** A parking spot on a host vehicle (jets on a carrier deck). */
export interface HostSpot {
  /** Position, host vehicle space. */
  position: Vec3
  /** Heading relative to the host, radians. */
  yaw: number
}

/** A generated vehicle: meshes per part plus what the motion needs to know. */
export interface VehicleModel {
  /** Vehicle type. */
  type: VehicleType
  /** Resolved style (`sedan`, `airliner`, `locomotive`, …). */
  style: string
  /** Where it moves. */
  domain: VehicleDomain
  /** Bounding size (x width, y height, z length), metres. */
  size: Vec3
  /** Parts. The first is the static body. */
  parts: ModelPart[]
  /** Distance between front and rear axles (steering), metres. */
  wheelBase: number
  /** Engine exhausts (rocket plumes, afterburners). */
  exhausts: Exhaust[]
  /** Engine smoke outlets (tailpipes, stacks, chimneys); empty for electric vehicles. */
  vents: ExhaustVent[]
  /** Parking spots for other vehicles (carriers). */
  hosts: HostSpot[]
  /** Rocket stages (0 for everything else). */
  stages: number
  /** Tint candidates for painted surfaces (`#rrggbb`). */
  palette: string[]
  /** Wake width factor (0 = no wake). */
  wake: number
  /** How far it banks into turns (1 = coordinated turn like an aircraft or bicycle; negative leans out). */
  bank: number
  /** Bow lift with speed (planing hulls). */
  trim: number
  /**
   * Articulation (trucks), vehicle-space z: where this vehicle's `kingpin` and the `axle` it pivots
   * on are (trailers), and the `coupling` the next trailer's kingpin sits on (fifth wheels).
   */
  hitch?: { kingpin?: number; axle?: number; coupling?: number }
}

// ---------------------------------------------------------------- land

const CAR_STYLES = {
  sedan: { L: 4.6, W: 1.8, H: 1.45, r: 0.32, ride: 0.28, cabin: 0.48, at: -0.04, hood: 0.55, taper: 0.8, rake: 0.3 },
  hatchback: { L: 3.9, W: 1.74, H: 1.5, r: 0.31, ride: 0.28, cabin: 0.55, at: -0.1, hood: 0.55, taper: 0.84, rake: 0.15 },
  suv: { L: 4.8, W: 1.95, H: 1.8, r: 0.38, ride: 0.42, cabin: 0.6, at: -0.1, hood: 0.55, taper: 0.88, rake: 0.1 },
  truck: { L: 5.5, W: 2.0, H: 1.9, r: 0.4, ride: 0.45, cabin: 0.3, at: 0.12, hood: 0.55, taper: 0.9, rake: 0.05 },
  van: { L: 5.2, W: 2.0, H: 2.3, r: 0.36, ride: 0.35, cabin: 0.8, at: -0.07, hood: 0.35, taper: 0.96, rake: 0.2 },
  bus: { L: 11.5, W: 2.55, H: 3.1, r: 0.5, ride: 0.35, cabin: 0.97, at: 0, hood: 0.3, taper: 0.99, rake: 0.05 },
} as const
const CAR_PALETTE = ['#b8282a', '#25384d', '#e9ecee', '#7f8a92', '#2a6fb0', '#168f78', '#e7b416', '#6c3c8c', '#cf5a12', '#1b1b1d', '#b9c0c6', '#2b8a4b']
const BUS_PALETTE = ['#e7b416', '#b8282a', '#2a6fb0', '#e9ecee', '#2b8a4b']

/** Styles `mixed` cars draw from (repeats weight them). */
const MIXED_CARS = ['sedan', 'sedan', 'sedan', 'hatchback', 'hatchback', 'suv', 'suv', 'truck', 'van', 'bus', 'compact', 'compact', 'retroWagon', 'electricSaloon', 'electricSaloon', 'muscle', 'roadster']

function car(p: VehicleParams, rand: Rand): VehicleModel {
  let style = str(p, 'style')
  if (!(style in CAR_STYLES) && !(LOOKALIKE_STYLES as readonly string[]).includes(style)) style = pick(rand, MIXED_CARS)
  if ((LOOKALIKE_STYLES as readonly string[]).includes(style)) return lookalikeCar(style as LookalikeStyle, p, rand)
  if (style === 'truck') return { ...pickup({ ...defaultParams('pickup'), style: 'fullSize', size: p.size }, rand), type: 'car', style: 'truck' }
  const st = CAR_STYLES[style as keyof typeof CAR_STYLES]
  const k = num(p, 'size') * jitter(rand, 0.05)
  const L = st.L * k * jitter(rand, 0.04), W = st.W * k, H = st.H * k * jitter(rand, 0.04), r = st.r * k, ride = st.ride * k
  const m = new MeshBuilder()
  const lowerTop = ride + (H - ride) * st.hood
  m.box([0, (ride + lowerTop) / 2, 0], [W, lowerTop - ride, L], BODY, [0.98, 0.96])
  m.box([0, ride + 0.12 * k, L / 2 - 0.05], [W * 0.98, 0.22 * k, 0.16], TRIM)
  m.box([0, ride + 0.12 * k, -L / 2 + 0.05], [W * 0.98, 0.22 * k, 0.16], TRIM)
  const cl = L * st.cabin, cz = L * st.at
  if (style === 'van' || style === 'bus') {
    const band = (H - lowerTop) * 0.62
    m.box([0, lowerTop + band / 2, cz], [W * 0.99, band, cl], style === 'bus' ? LIT : GLASS, [st.taper, 0.99], st.rake * 0.5)
    m.box([0, lowerTop + band + (H - lowerTop - band) / 2, cz + st.rake * 0.5], [W * 0.99 * st.taper, H - lowerTop - band, cl - st.rake], BODY, [0.97, 0.98])
    if (style === 'bus') m.box([0, H - 0.25 * k, L / 2 - 0.02], [W * 0.6, 0.22 * k, 0.06], paint('#ffb43a', 0, 0.9))
  } else {
    m.box([0, (lowerTop + H - 0.06) / 2, cz], [W * 0.92, H - 0.06 - lowerTop, cl], GLASS, [st.taper, 0.72], -st.rake * 0.2)
    m.box([0, H - 0.04, cz - st.rake * 0.1], [W * 0.92 * st.taper * 0.98, 0.08, cl * 0.7], BODY)
  }
  if (style === 'truck') {
    const bedL = L * 0.42, bz = -L / 2 + bedL / 2 + 0.1
    for (const s of [-1, 1]) m.box([s * (W / 2 - 0.05), lowerTop + 0.2 * k, bz], [0.1, 0.4 * k, bedL], BODY)
    m.box([0, lowerTop + 0.2 * k, -L / 2 + 0.12], [W, 0.4 * k, 0.1], BODY)
  }
  if ((style === 'suv' || style === 'hatchback') && rand() < 0.35) for (const s of [-1, 1]) m.box([s * W * 0.32, H + 0.05, cz], [0.06, 0.06, cl * 0.6], TRIM)
  if (style === 'sedan' && rand() < 0.2) m.box([0, lowerTop + 0.08, -L / 2 + 0.2], [W * 0.8, 0.06, 0.25], BODY)
  for (const s of [-1, 1]) {
    m.box([s * W * 0.33, lowerTop - 0.16 * k, L / 2], [W * 0.2, 0.12 * k, 0.06], HEAD)
    m.box([s * W * 0.36, lowerTop - 0.14 * k, -L / 2], [W * 0.16, 0.12 * k, 0.06], TAIL)
  }
  const over = style === 'bus' ? r * 4.2 : r * 2.1
  const zf = L / 2 - over, zr = -L / 2 + (style === 'bus' ? r * 6 : over)
  const ww = 0.22 * k * (style === 'bus' ? 1.3 : 1)
  const wheelX = W / 2 - ww * 0.45
  const spin = { axis: 0 as const, rate: 1 / r, by: 'distance' as const }
  const wheels: ModelPart = {
    name: 'wheel', mesh: roadWheel(r, ww),
    mounts: [-1, 1].flatMap((s) => [{ position: [s * wheelX, r, zf] as Vec3, spin, steer: 1 }, { position: [s * wheelX, r, zr] as Vec3, spin }]),
  }
  return model('car', style, 'land', [body(m.build()), wheels], { wheelBase: zf - zr, palette: style === 'bus' ? BUS_PALETTE : CAR_PALETTE, bank: -0.04 })
}

function bicycle(p: VehicleParams, rand: Rand): VehicleModel {
  let style = str(p, 'style')
  if (!['road', 'city', 'mountain'].includes(style)) style = pick(rand, ['road', 'city', 'city', 'mountain'])
  const r = style === 'mountain' ? 0.37 : 0.34, tw = style === 'mountain' ? 0.06 : style === 'road' ? 0.028 : 0.04
  const frame = paint(pick(rand, ['#1b1b1d', '#c8ccd0', '#2a6fb0', '#b8282a', '#2b8a4b', '#e7b416']))
  const m = new MeshBuilder()
  const R: Vec3 = [0, r, -0.5], F: Vec3 = [0, r, 0.52], B: Vec3 = [0, 0.28, -0.03], S: Vec3 = [0, 0.86, -0.17]
  const Ht: Vec3 = [0, style === 'city' ? 0.92 : 0.86, 0.36], Hb: Vec3 = [0, 0.7, 0.4]
  for (const [a, b] of [[B, S], [S, Ht], [B, Hb], [Hb, Ht]] as [Vec3, Vec3][]) m.beam(a, b, 0.035, frame)
  for (const s of [-1, 1]) {
    m.beam([s * 0.05, B[1], B[2]], [s * 0.06, R[1], R[2]], 0.02, frame)
    m.beam([s * 0.04, S[1] - 0.05, S[2]], [s * 0.06, R[1], R[2]], 0.02, frame)
    m.beam([s * 0.03, Hb[1], Hb[2]], [s * 0.05, F[1], F[2]], 0.025, frame)
  }
  const bar: Vec3 = [0, Ht[1] + (style === 'city' ? 0.12 : 0.06), Ht[2] - (style === 'city' ? 0.08 : -0.02)]
  m.beam(Ht, bar, 0.03, TRIM)
  m.beam([-0.22, bar[1], bar[2]], [0.22, bar[1], bar[2]], 0.025, TRIM)
  m.box([0, S[1] + 0.04, S[2] - 0.02], [0.12, 0.05, 0.26], DARK)
  m.cylinder('x', B, 0.09, 0.02, RIM, 10)
  if (style === 'city') {
    m.box([0, Ht[1] - 0.05, Ht[2] + 0.22], [0.3, 0.2, 0.24], paint('#8a6a3a'))
    for (const z of [R[2], F[2]]) m.box([0, r * 2 + 0.03, z], [tw * 2, 0.02, 0.5], frame)
  }
  m.box([0, 0.9, 0.42], [0.06, 0.05, 0.04], HEAD)
  m.box([0, 0.72, -0.55], [0.05, 0.04, 0.03], TAIL)
  if (p.rider) {
    const skin = paint(pick(rand, ['#f1c7a5', '#d9a17a', '#a8704a', '#6e4428'])), pants = paint(pick(rand, ['#1d2633', '#3b3b3b', '#2d4a6b', '#5c4632']))
    const hip: Vec3 = [0, 0.98, -0.14], lean = style === 'road' ? 0.55 : style === 'mountain' ? 0.4 : 0.2
    const shoulder: Vec3 = [0, hip[1] + 0.55 * Math.cos(lean), hip[2] + 0.55 * Math.sin(lean)]
    m.beam(hip, shoulder, 0.3, BODY)
    m.ellipsoid([0, shoulder[1] + 0.16, shoulder[2] + 0.04], [0.1, 0.12, 0.11], skin, 8, 5)
    m.ellipsoid([0, shoulder[1] + 0.2, shoulder[2] + 0.03], [0.12, 0.09, 0.14], paint(pick(rand, ['#e7b416', '#b8282a', '#1b1b1d', '#eceef0'])), 8, 3, true)
    for (const s of [-1, 1]) {
      m.beam([s * 0.17, shoulder[1] - 0.05, shoulder[2]], [s * 0.2, bar[1] + 0.02, bar[2]], 0.08, BODY)
      const knee: Vec3 = [s * 0.12, 0.72, 0.12 + s * 0.06], foot: Vec3 = [s * 0.11, 0.25 + s * 0.06, -0.03 + s * 0.08]
      m.beam([s * 0.1, hip[1], hip[2]], knee, 0.12, pants)
      m.beam(knee, foot, 0.09, pants)
    }
  }
  const spin = { axis: 0 as const, rate: 1 / r, by: 'distance' as const }
  const wheels: ModelPart = { name: 'wheel', mesh: roadWheel(r, tw, true), mounts: [{ position: F, spin, steer: 1 }, { position: R, spin }] }
  return model('bicycle', style, 'land', [body(m.build()), wheels], {
    wheelBase: F[2] - R[2], bank: 1, palette: ['#e74c3c', '#2e86de', '#f1c40f', '#27ae60', '#ff6fb5', '#ff8c1a', '#eceef0', '#1b1b1d'],
  })
}

// ---------------------------------------------------------------- rail

function railAxle(r: number): MeshData {
  const m = new MeshBuilder()
  for (const s of [-1, 1]) {
    m.cylinder('x', [s * 0.72, 0, 0], r, 0.13, DARK, 12)
    m.cylinder('x', [s * 0.79, 0, 0], r * 1.08, 0.025, TRIM, 12)
    m.box([s * 0.65, 0, 0], [0.03, r * 1.5, 0.12], RIM)
  }
  m.cylinder('x', [0, 0, 0], 0.08, 1.4, TRIM, 6)
  return m.build()
}

const TRAIN_PALETTES = {
  locomotive: ['#b8282a', '#e67e22', '#25384d', '#2b8a4b', '#2a6fb0', '#e7b416'],
  passenger: ['#25384d', '#6c3c8c', '#b8282a', '#1f6f4a', '#b9c0c6', '#2a6fb0'],
  freight: ['#7b3f2a', '#5d6d7e', '#a04000', '#1f618d', '#6e2c00', '#4a5a3a'],
}

function train(p: VehicleParams, rand: Rand): VehicleModel {
  const car = str(p, 'car') as 'locomotive' | 'passenger' | 'freight'
  const k = num(p, 'size')
  const W = 2.95 * k, r = 0.46
  const m = new MeshBuilder()
  let L: number, style: string = car
  const floor = 1.15
  if (car === 'locomotive') {
    L = 19 * k
    const H = 4.25 * k, nose = 3.2 * k
    m.box([0, (floor + H) / 2, -nose / 2], [W, H - floor, L - nose], BODY, [0.94, 1])
    m.box([0, (floor + H) / 2 - 0.1, L / 2 - nose / 2], [W, H - floor - 0.2, nose], BODY, [0.9, 0.7], -0.3)
    m.box([0, H - 0.75 * k, L / 2 - nose * 0.42], [W * 0.86, 0.75 * k, nose * 0.62], GLASS, [0.92, 0.6], -0.25)
    m.box([0, H + 0.15, -L * 0.2], [W * 0.6, 0.3, L * 0.35], TRIM)
    m.box([0, H + 0.12, L * 0.12], [W * 0.5, 0.24, 2.5], GREY)
    const stripe = paint(pick(rand, ['#f4d03f', '#eceef0', '#1b1b1d', '#e67e22']))
    for (const s of [-1, 1]) m.box([s * (W / 2 + 0.01), floor + 0.7, 0], [0.02, 0.35, L * 0.98], stripe)
    for (const s of [-1, 1]) m.box([s * 0.85, floor + 0.55, L / 2 + 0.02], [0.3, 0.2, 0.05], HEAD)
  } else if (car === 'passenger') {
    L = 22 * k
    const H = 4.0 * k
    m.loft([
      { z: -L / 2, w: W / 2, top: H, bottom: floor, round: 0.25 },
      { z: L / 2, w: W / 2, top: H, bottom: floor, round: 0.25 },
    ], BODY, 14)
    for (const s of [-1, 1]) {
      m.box([s * (W / 2 + 0.01), floor + 1.75 * k, 0], [0.04, 0.75 * k, L * 0.82], LIT)
      for (const z of [-L * 0.43, L * 0.43]) m.box([s * (W / 2 + 0.015), floor + 1.15 * k, z], [0.03, 1.9 * k, 0.9], GREY)
    }
    m.box([0, floor + 1.2, L / 2 + 0.15], [1.0, 2.2, 0.3], DARK)
    m.box([0, floor + 1.2, -L / 2 - 0.15], [1.0, 2.2, 0.3], DARK)
  } else {
    L = 17 * k
    let kind = str(p, 'freight')
    if (!['boxcar', 'tank', 'hopper', 'container'].includes(kind)) kind = pick(rand, ['boxcar', 'tank', 'hopper', 'container', 'container'])
    style = kind
    m.box([0, floor + 0.12, 0], [W * 0.95, 0.25, L], TRIM)
    if (kind === 'boxcar') {
      m.box([0, floor + 0.25 + 1.75 * k, 0], [W, 3.5 * k, L * 0.98], BODY, [0.98, 1])
      for (const s of [-1, 1]) m.box([s * (W / 2 + 0.01), floor + 1.9 * k, 0], [0.03, 3.0 * k, 2.8], TRIM)
    } else if (kind === 'tank') {
      m.cylinder('z', [0, floor + 1.7 * k, 0], 1.4 * k, L * 0.92, BODY, 14)
      m.box([0, floor + 3.15 * k, 0], [0.9, 0.2, 1.4], GREY)
    } else if (kind === 'hopper') {
      m.loft([
        { z: -L * 0.47, w: W / 2, top: floor + 3.6 * k, bottom: floor + 0.4, round: 0.05, keel: 0.7 },
        { z: L * 0.47, w: W / 2, top: floor + 3.6 * k, bottom: floor + 0.4, round: 0.05, keel: 0.7 },
      ], BODY, 12)
    } else {
      const n = rand() < 0.5 ? 1 : 2
      const cl = (L * 0.95) / n
      for (let i = 0; i < n; i++) {
        const c = paint(pick(rand, ['#b8282a', '#2a6fb0', '#2b8a4b', '#e67e22', '#5d6d7e', '#e7b416', '#eceef0', '#6c3c8c']))
        m.box([0, floor + 0.25 + 1.3 * k, -L * 0.475 + cl * (i + 0.5)], [W * 0.92, 2.6 * k, cl - 0.25], c)
      }
    }
  }
  for (const s of [-1, 1]) {
    const bz = s * (L / 2 - 3.2 * k)
    m.box([0, 0.6, bz], [W * 0.75, 0.5, 3.2], TRIM)
    m.box([0, floor - 0.2, s * (L / 2 + 0.2)], [0.35, 0.3, 0.5], TRIM)
  }
  const spin = { axis: 0 as const, rate: 1 / r, by: 'distance' as const }
  const mounts: PartMount[] = []
  for (const s of [-1, 1]) for (const a of [-1, 1]) mounts.push({ position: [0, r, s * (L / 2 - 3.2 * k) + a * 1.25], spin })
  return model('train', style, 'rail', [body(m.build()), { name: 'axle', mesh: railAxle(r), mounts }], {
    wheelBase: L - 6.4 * k, palette: TRAIN_PALETTES[car], bank: -0.02,
  })
}

// ---------------------------------------------------------------- sea

const ANTIFOUL = paint('#7e2a20')

function fishingBoat(p: VehicleParams, rand: Rand): VehicleModel {
  const L = num(p, 'length') * jitter(rand, 0.08), W = L * 0.34 * jitter(rand, 0.05)
  const deck = L * 0.1
  const m = new MeshBuilder()
  m.loft([
    { z: -L / 2, w: W * 0.4, top: deck, bottom: -L * 0.04, round: 0.3, keel: 0.4 },
    { z: -L / 4, w: W / 2, top: deck * 0.97, bottom: -L * 0.08, round: 0.35, keel: 0.5 },
    { z: L / 8, w: W * 0.48, top: deck * 1.05, bottom: -L * 0.08, round: 0.35, keel: 0.6 },
    { z: L * 0.38, w: W * 0.3, top: deck * 1.35, bottom: -L * 0.05, round: 0.4, keel: 0.8 },
    { z: L / 2, w: 0.04, top: deck * 1.6, bottom: deck * 0.2, round: 0.5, keel: 0.9 },
  ], BODY, 12, { y: 0.12, paint: ANTIFOUL })
  const hz = L * 0.08, hw = W * 0.55, hh = L * 0.17
  m.box([0, deck + hh / 2, hz], [hw, hh, L * 0.22], WHITE)
  m.box([0, deck + hh * 0.72, hz], [hw * 1.02, hh * 0.28, L * 0.225], LIT)
  m.box([0, deck + hh + 0.06, hz], [hw * 1.1, 0.12, L * 0.25], TRIM)
  m.cylinder('y', [hw * 0.3, deck + hh + 0.6, hz - L * 0.06], 0.12, 1.2, DARK, 6)
  const mz = hz + L * 0.17
  m.beam([0, deck, mz], [0, deck + L * 0.5, mz], 0.14, TRIM)
  m.box([0, deck + L * 0.5, mz], [0.15, 0.15, 0.15], paint('#fff7d6', 0, 1))
  m.beam([0, deck + L * 0.3, mz], [0, deck + 0.4, -L * 0.42], 0.1, TRIM)
  if (p.outriggers) for (const s of [-1, 1]) m.beam([0, deck + L * 0.3, mz], [s * W * 1.3, deck + L * 0.12, mz - L * 0.05], 0.08, TRIM)
  m.cylinder('x', [0, deck + 0.45, -L * 0.36], 0.4, W * 0.6, paint('#d9822b'), 10)
  for (const s of [-1, 1]) m.beam([s * W * 0.35, deck, -L * 0.47], [0, deck + L * 0.32, -L * 0.42], 0.1, GREY)
  return model('fishing-boat', p.outriggers ? 'trawler' : 'seiner', 'sea', [body(m.build())], {
    palette: ['#1f5f99', '#b03a2e', '#1e8449', '#117a65', '#f4f6f6', '#d4ac0d'], wake: 1, bank: 0.08, trim: 0.05,
  })
}

function cruiseLiner(p: VehicleParams, rand: Rand): VehicleModel {
  const L = num(p, 'length') * jitter(rand, 0.05), W = L * 0.13, decks = Math.round(num(p, 'decks')), funnels = Math.round(num(p, 'funnels'))
  const top = L * 0.06, draft = L * 0.035
  const m = new MeshBuilder()
  m.loft([
    { z: -L / 2, w: W * 0.45, top, bottom: -draft * 0.4, round: 0.5, keel: 0.2 },
    { z: -L * 0.3, w: W / 2, top, bottom: -draft, round: 0.3, keel: 0.15 },
    { z: L * 0.22, w: W / 2, top, bottom: -draft, round: 0.3, keel: 0.2 },
    { z: L * 0.42, w: W * 0.3, top: top * 1.05, bottom: -draft * 0.8, round: 0.4, keel: 0.5 },
    { z: L / 2, w: 0.2, top: top * 1.12, bottom: -draft * 0.2, round: 0.5, keel: 0.8 },
  ], BODY, 14, { y: -0.4, paint: ANTIFOUL })
  const dh = 2.8
  for (let d = 0; d < decks; d++) {
    const len = L * (0.74 - d * 0.04), y = top + d * dh + dh / 2, z = -L * 0.05 - d * L * 0.006, w = W * (0.94 - d * 0.015)
    m.box([0, y, z], [w, dh, len], WHITE)
    m.box([0, y + 0.2, z], [w + 0.15, 1.1, len * 0.97], LIT)
  }
  const deckTop = top + decks * dh
  m.box([0, deckTop - dh / 2 + 0.2, -L * 0.05 + L * (0.74 - (decks - 1) * 0.04) / 2 - 1.5], [W * 0.9, 1.2, 2.5], GLASS)
  m.box([0, deckTop + 0.15, -L * 0.15], [W * 0.3, 0.3, L * 0.08], paint('#4fc3e8'))
  for (let f = 0; f < funnels; f++) {
    const z = -L * 0.22 + f * L * 0.1
    m.box([0, deckTop + 5, z], [W * 0.22, 10, L * 0.07], BODY, [0.85, 0.75], -1.5)
    m.box([0, deckTop + 10.3, z - 1.5], [W * 0.19, 0.6, L * 0.054], DARK)
  }
  const boats = Math.floor(L / 22)
  for (const s of [-1, 1]) for (let b = 0; b < boats; b++) {
    m.ellipsoid([s * (W * 0.47 + 0.6), top + 2.2, -L * 0.3 + (b / Math.max(1, boats - 1)) * L * 0.55], [1.1, 0.9, 3.2], paint('#e8731a'), 6, 3)
  }
  for (const s of [-1, 1]) m.box([s * W * 0.2, top * 0.75, L * 0.47], [0.4, 0.4, 0.2], paint('#fff7d6', 0, 1))
  return model('cruise-liner', `${decks}-deck`, 'sea', [body(m.build())], { palette: ['#f4f6f7', '#1b2631', '#17202a', '#922b21', '#1f3a5f'], wake: 1.6, bank: 0.01 })
}

function speedboat(p: VehicleParams, rand: Rand): VehicleModel {
  const L = num(p, 'length') * jitter(rand, 0.08), W = L * 0.34
  const m = new MeshBuilder()
  const h = L * 0.13
  m.loft([
    { z: -L / 2, w: W * 0.46, top: h, bottom: -h * 0.4, round: 0.25, keel: 0.7 },
    { z: -L / 6, w: W / 2, top: h * 1.05, bottom: -h * 0.6, round: 0.3, keel: 0.85 },
    { z: L / 4, w: W * 0.42, top: h * 1.12, bottom: -h * 0.5, round: 0.35, keel: 0.9 },
    { z: L * 0.43, w: W * 0.18, top: h * 1.18, bottom: 0, round: 0.4, keel: 0.95 },
    { z: L / 2, w: 0.02, top: h * 1.1, bottom: h * 0.5, round: 0.5, keel: 0.95 },
  ], BODY, 12, { y: h * 0.25, paint: WHITE })
  m.box([0, h * 1.6, L * 0.08], [W * 0.72, h * 0.9, 0.12], GLASS, [0.85, 1], -0.25)
  for (const s of [-1, 1]) m.box([s * W * 0.2, h * 1.35, -L * 0.08], [W * 0.28, h * 0.5, L * 0.12], paint('#e9e1d0'))
  m.box([0, h * 1.25, -L * 0.33], [W * 0.75, h * 0.35, L * 0.12], paint('#e9e1d0'))
  if (p.cabin) m.box([0, h * 1.35, L * 0.27], [W * 0.6, h * 0.7, L * 0.22], WHITE, [0.8, 0.7], 0.15)
  m.box([0, h * 0.8, -L / 2 - 0.25], [0.45, h * 2.2, 0.5], DARK, [0.9, 0.8])
  m.box([0, h * 1.95, -L / 2 - 0.25], [0.5, 0.12, 0.6], WHITE)
  return model('speedboat', p.cabin ? 'cruiser' : 'runabout', 'sea', [body(m.build())], {
    palette: ['#c0392b', '#1a5276', '#f4d03f', '#17202a', '#e67e22', '#7d3c98'], wake: 1.3, bank: 0.35, trim: 0.5,
  })
}

/** A ducted fan or propeller disc spinning about z. */
function rotor(r: number, blades: number, width: number, s: Paint): MeshData {
  const m = new MeshBuilder()
  m.cylinder('z', [0, 0, 0], r * 0.16, width * 2, TRIM, 8)
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2
    const u: Vec3 = [Math.cos(a), Math.sin(a), 0], v: Vec3 = [-Math.sin(a) * 0.85, Math.cos(a) * 0.85, 0.5]
    m.fin([[r * 0.12, -width], [r * 0.95, -width * 0.6], [r * 0.95, width * 0.6], [r * 0.12, width]], [0, 0, 0], u, v, 0.03 + r * 0.02, s)
  }
  return m.build()
}

function hovercraft(p: VehicleParams, rand: Rand): VehicleModel {
  const L = num(p, 'length') * jitter(rand, 0.05), W = L * 0.45, fans = Math.round(num(p, 'fans'))
  const m = new MeshBuilder()
  const skirt = L * 0.075
  m.loft([
    { z: -L / 2, w: W * 0.32, top: skirt, bottom: 0, round: 1 },
    { z: -L * 0.43, w: W / 2, top: skirt, bottom: 0, round: 1 },
    { z: L * 0.38, w: W / 2, top: skirt, bottom: 0, round: 1 },
    { z: L / 2, w: W * 0.3, top: skirt, bottom: 0, round: 1 },
  ], paint('#25262a'), 12)
  m.box([0, skirt + 0.2, 0], [W * 0.95, 0.4, L * 0.92], BODY)
  const ch = L * 0.11
  m.box([0, skirt + 0.4 + ch / 2, L * 0.05], [W * 0.7, ch, L * 0.55], WHITE, [0.95, 0.94], 0)
  m.box([0, skirt + 0.4 + ch * 0.65, L * 0.05], [W * 0.71, ch * 0.32, L * 0.5], LIT)
  m.box([0, skirt + 0.4 + ch * 0.6, L * 0.33], [W * 0.5, ch * 0.5, 0.3], GLASS, [0.9, 1], -0.3)
  const r = L * 0.09
  const mounts: PartMount[] = []
  for (let f = 0; f < fans; f++) {
    const x = fans === 1 ? 0 : ((f / (fans - 1)) * 2 - 1) * W * 0.24, y = skirt + 0.4 + r * 1.05, z = -L * 0.38
    m.tube('z', [x, y, z], r * 1.08, r, r * 0.6, BODY, 14)
    m.fin([[0, -r * 0.4], [r * 1.6, -r * 0.4], [r * 1.6, -r * 0.1], [0, -r * 0.1]], [x, y - r * 0.8, z - r * 0.4], [0, 1, 0], [0, 0, 1], 0.08, TRIM)
    mounts.push({ position: [x, y, z], spin: { axis: 2, rate: 18, by: 'time' } })
  }
  return model('hovercraft', `${fans}-fan`, 'sea', [body(m.build()), { name: 'fan', mesh: rotor(r * 0.95, 5, r * 0.18, DARK), mounts }], {
    palette: ['#d35400', '#c0392b', '#1f618d', '#f4d03f', '#117a65'], wake: 0.9, bank: 0.15,
  })
}

function aircraftCarrier(p: VehicleParams, rand: Rand): VehicleModel {
  const L = num(p, 'length') * jitter(rand, 0.03), W = L * 0.13, spots = Math.round(num(p, 'spots'))
  const top = L * 0.06, draft = L * 0.037
  const m = new MeshBuilder()
  m.loft([
    { z: -L / 2, w: W * 0.45, top, bottom: -draft * 0.5, round: 0.2, keel: 0.1 },
    { z: -L * 0.35, w: W / 2, top, bottom: -draft, round: 0.2, keel: 0.1 },
    { z: L * 0.3, w: W * 0.47, top, bottom: -draft, round: 0.2, keel: 0.2 },
    { z: L * 0.45, w: W * 0.25, top, bottom: -draft * 0.7, round: 0.3, keel: 0.6 },
    { z: L / 2, w: 0.5, top: top * 1.02, bottom: top * 0.1, round: 0.4, keel: 0.8 },
  ], BODY, 12, { y: 0, paint: ANTIFOUL })
  const deckY = top + 1, deckW = W * 1.7
  const deck = paint('#3a3e44')
  m.box([W * 0.12, deckY, 0], [deckW, 2, L], deck, [1, 1])
  if (p.angledDeck) m.group([W * 0.45, deckY, -L * 0.12], [0, 0.16, 0], () => m.box([0, 0, 0], [W * 0.75, 1.98, L * 0.55], deck))
  const line = paint('#f2f2f2')
  m.box([W * 0.12, deckY + 1.02, L * 0.15], [0.5, 0.05, L * 0.6], line)
  if (p.angledDeck) m.group([W * 0.45, deckY + 1.02, -L * 0.12], [0, 0.16, 0], () => m.box([0, 0, 0], [0.5, 0.05, L * 0.5], paint('#e8c33a')))
  const ix = -W * 0.6, iz = L * 0.02
  m.box([ix, deckY + 1 + 6, iz], [8, 12, L * 0.09], BODY, [0.9, 0.85])
  m.box([ix, deckY + 1 + 10, iz], [8.2, 2, L * 0.07], LIT)
  m.beam([ix, deckY + 13, iz], [ix, deckY + 26, iz - 2], 0.6, GREY)
  m.box([ix, deckY + 22, iz - 2], [3, 1.2, 1.2], GREY)
  m.box([ix, deckY + 26, iz - 2], [0.4, 0.4, 0.4], paint('#ff4040', 0, 1))
  const hosts: HostSpot[] = []
  for (let i = 0; i < spots; i++) {
    const row = i % 2, col = Math.floor(i / 2)
    hosts.push({ position: [-W * 0.15 - row * W * 0.32, deckY + 1, L * 0.42 - col * L * 0.09], yaw: Math.PI * (0.75 + row * 0.1) })
  }
  return model('aircraft-carrier', p.angledDeck ? 'supercarrier' : 'straight-deck', 'sea', [body(m.build())], {
    hosts, palette: ['#6b7178', '#5d646b', '#73787d'], wake: 1.8, bank: 0.01,
  })
}

// ---------------------------------------------------------------- air

function fuselage(m: MeshBuilder, L: number, R: number, s: Paint, nose = 0.35, belly?: Paint, round = 1): void {
  m.loft([
    { z: -L / 2, w: R * 0.15, top: R * 0.95, bottom: R * 0.55, round },
    { z: -L / 2 + L * 0.18, w: R * 0.75, top: R * 0.95, bottom: -R * 0.35, round },
    { z: -L / 2 + L * 0.32, w: R, top: R, bottom: -R, round },
    { z: L / 2 - L * nose * 0.55, w: R, top: R, bottom: -R, round },
    { z: L / 2 - L * nose * 0.18, w: R * 0.7, top: R * 0.65, bottom: -R * 0.8, round },
    { z: L / 2, w: R * 0.05, top: -R * 0.15, bottom: -R * 0.35, round },
  ], s, 12, belly && { y: -R * 0.4, paint: belly })
}

/** Left (+x) and right wing outlines in the plane through `o`, with dihedral. */
function wings(m: MeshBuilder, o: Vec3, root: number, span: number, chord: number, sweep: number, taper: number, dihedral: number, thickness: number, s: Paint): void {
  for (const side of [1, -1]) {
    const u: Vec3 = [side * Math.cos(dihedral), Math.sin(dihedral), 0]
    m.fin([[root, chord / 2], [span, chord / 2 - sweep], [span, chord / 2 - sweep - chord * taper], [root, -chord / 2]], o, u, [0, 0, 1], thickness, s)
  }
}

function airplane(p: VehicleParams, rand: Rand): VehicleModel {
  let style = str(p, 'style')
  if (!['airliner', 'light'].includes(style)) style = rand() < 0.5 ? 'airliner' : 'light'
  const m = new MeshBuilder()
  const parts: ModelPart[] = []
  if (style === 'airliner') {
    const L = num(p, 'length') * jitter(rand, 0.06), R = L * 0.053, span = L * 0.95
    fuselage(m, L, R, WHITE, 0.2, BODY)
    for (const s of [-1, 1]) m.box([s * R * 0.985, R * 0.25, L * 0.05], [0.06, 0.28, L * 0.62], LIT)
    m.box([0, R * 0.42, L / 2 - L * 0.06], [R * 0.9, 0.35, R * 0.6], GLASS, [0.7, 0.6])
    const wy = -R * 0.45, wz = L * 0.04, chord = L * 0.2
    wings(m, [0, wy, wz], R * 0.8, span / 2, chord, chord * 0.75, 0.3, 0.09, 0.4, paint('#d6dbe0'))
    wings(m, [0, R * 0.4, -L / 2 + R * 1.6], R * 0.4, span * 0.17, L * 0.08, L * 0.05, 0.4, 0.12, 0.25, paint('#d6dbe0'))
    m.fin([[R * 0.7, -L / 2 + R * 4.2], [R * 0.7 + L * 0.17, -L / 2 + R * 1.7], [R * 0.7 + L * 0.17, -L / 2 + R * 0.5], [R * 0.7, -L / 2 + R * 0.2]], [0, 0, 0], [0, 1, 0], [0, 0, 1], 0.35, BODY)
    const engines = Math.round(num(p, 'engines')) >= 4 ? [0.3, 0.58] : [0.34]
    const er = R * 0.42, mounts: PartMount[] = []
    for (const side of [1, -1]) for (const t of engines) {
      const x = side * span / 2 * t, y = wy + Math.sin(0.09) * span / 2 * t - er * 1.25, z = wz + chord * 0.3 - chord * 0.75 * t * 0.5
      m.cylinder('z', [x, y, z], er, L * 0.12, BODY, 12, er * 0.75)
      m.beam([x, y + er * 0.6, z - L * 0.02], [x, y + er * 1.25, z - L * 0.03], er * 0.5, paint('#d6dbe0'))
      mounts.push({ position: [x, y, z + L * 0.061], spin: { axis: 2, rate: 30, by: 'time' } })
    }
    parts.push(body(m.build()), { name: 'fan', mesh: rotor(er * 0.92, 12, er * 0.25, DARK), mounts })
  } else {
    const L = num(p, 'length') * 0.22 * jitter(rand, 0.06), R = L * 0.075, span = L * 1.35
    fuselage(m, L, R, BODY, 0.45, undefined, 0.6)
    m.box([0, R * 0.75, L * 0.12], [R * 1.7, R * 0.6, L * 0.18], GLASS, [0.8, 0.7], -0.1)
    wings(m, [0, R * 1.05, L * 0.1], 0, span / 2, L * 0.17, 0, 1, 0.03, 0.18, WHITE)
    for (const s of [-1, 1]) m.beam([s * R * 0.9, -R * 0.4, L * 0.1], [s * span * 0.25, R * 1.0, L * 0.1], 0.06, GREY)
    wings(m, [0, R * 0.55, -L / 2 + L * 0.06], 0, span * 0.18, L * 0.1, 0, 1, 0, 0.1, WHITE)
    m.fin([[R * 0.5, -L / 2 + L * 0.18], [R * 0.5 + L * 0.16, -L / 2 + L * 0.06], [R * 0.5 + L * 0.16, -L / 2], [R * 0.5, -L / 2]], [0, 0, 0], [0, 1, 0], [0, 0, 1], 0.1, BODY)
    for (const s of [-1, 1]) {
      m.beam([s * R * 0.7, -R * 0.6, L * 0.08], [s * R * 2.2, -R * 2.4, L * 0.08], 0.08, GREY)
      m.cylinder('x', [s * R * 2.3, -R * 2.4, L * 0.08], R * 0.4, 0.15, TYRE, 8)
      m.box([s * span / 2, R * 1.05 + Math.sin(0.03) * span / 2, L * 0.1], [0.12, 0.1, 0.2], s > 0 ? paint('#ff3030', 0, 1) : paint('#30ff60', 0, 1))
    }
    m.cylinder('z', [0, 0, L / 2 + 0.1], R * 0.35, 0.3, RIM, 8, R * 0.1)
    const prop = new MeshBuilder()
    prop.fin([[-R * 2.6, -0.06], [R * 2.6, -0.06], [R * 2.6, 0.06], [-R * 2.6, 0.06]], [0, 0, 0], [1, 0, 0], [0, 1, 0], 0.04, DARK)
    parts.push(body(m.build()), { name: 'propeller', mesh: prop.build(), mounts: [{ position: [0, 0, L / 2 + 0.25], spin: { axis: 2, rate: 45, by: 'time' } }] })
  }
  return model('airplane', style, 'air', parts, {
    palette: style === 'airliner' ? ['#1f4e9c', '#c0392b', '#0e6655', '#d4ac0d', '#6c3483', '#17202a'] : ['#c0392b', '#1f4e9c', '#f1c40f', '#1e8449', '#eceef0'],
    bank: 1,
  })
}

function fighterJet(p: VehicleParams, rand: Rand): VehicleModel {
  let style = str(p, 'style')
  if (!['delta', 'twin-tail'].includes(style)) style = rand() < 0.5 ? 'delta' : 'twin-tail'
  const L = num(p, 'length') * jitter(rand, 0.05), R = L * 0.055
  const m = new MeshBuilder()
  m.loft([
    { z: -L / 2, w: R * 1.1, top: R * 0.6, bottom: -R * 0.6, round: 0.5 },
    { z: -L * 0.15, w: R * 1.4, top: R * 0.9, bottom: -R * 0.7, round: 0.5 },
    { z: L * 0.18, w: R, top: R * 0.85, bottom: -R * 0.6, round: 0.6 },
    { z: L * 0.38, w: R * 0.5, top: R * 0.4, bottom: -R * 0.35, round: 0.8 },
    { z: L / 2, w: 0.03, top: 0, bottom: -0.05, round: 1 },
  ], BODY, 12)
  m.ellipsoid([0, R * 0.7, L * 0.2], [R * 0.55, R * 0.7, L * 0.12], paint('#3b4a55', 0, 0.05), 10, 4, true)
  if (style === 'delta') {
    wings(m, [0, -R * 0.1, -L * 0.12], R * 0.8, L * 0.3, L * 0.55, L * 0.42, 0.12, -0.02, 0.18, BODY)
    m.fin([[R * 0.8, -L * 0.1], [R * 0.8 + L * 0.2, -L * 0.42], [R * 0.8 + L * 0.2, -L * 0.48], [R * 0.8, -L * 0.48]], [0, 0, 0], [0, 1, 0], [0, 0, 1], 0.15, BODY)
  } else {
    wings(m, [0, -R * 0.1, -L * 0.05], R * 0.9, L * 0.3, L * 0.32, L * 0.2, 0.3, -0.03, 0.16, BODY)
    wings(m, [0, -R * 0.1, -L * 0.43], R * 0.9, L * 0.2, L * 0.13, L * 0.06, 0.4, -0.05, 0.12, BODY)
    for (const s of [-1, 1]) {
      m.fin([[R * 0.5, -L * 0.18], [R * 0.5 + L * 0.17, -L * 0.36], [R * 0.5 + L * 0.17, -L * 0.44], [R * 0.5, -L * 0.42]], [s * R * 0.7, 0, 0], [s * Math.sin(0.3), Math.cos(0.3), 0], [0, 0, 1], 0.12, BODY)
    }
  }
  for (const s of [-1, 1]) m.box([s * R * 1.25, -R * 0.2, L * 0.08], [R * 0.6, R * 0.9, L * 0.12], DARK, [1, 0.8], -0.2)
  const exhausts: Exhaust[] = []
  for (const s of style === 'twin-tail' ? [-1, 1] : [0]) {
    m.cylinder('z', [s * R * 0.55, 0, -L / 2 - 0.3], R * 0.5, 0.8, DARK, 10, R * 0.55)
    exhausts.push({ position: [s * R * 0.55, 0, -L / 2 - 0.7], direction: [0, 0, -1], radius: R * 0.42, length: L * 0.25, color: '#ff8a2a' })
  }
  return model('fighter-jet', style, 'air', [body(m.build())], { exhausts, palette: ['#6e7781', '#5b6470', '#8a929a', '#4b5a3c', '#3d4a5a'], bank: 1.3 })
}

// ---------------------------------------------------------------- space

function rocket(p: VehicleParams, rand: Rand): VehicleModel {
  const H = num(p, 'height') * jitter(rand, 0.04), stages = Math.max(1, Math.min(3, Math.round(num(p, 'stages')))), r = H * 0.03
  const boosters = Math.round(num(p, 'boosters'))
  const shares = stages === 1 ? [0.85] : stages === 2 ? [0.6, 0.27] : [0.48, 0.24, 0.16]
  const fairing = H * (1 - shares.reduce((a, b) => a + b, 0))
  const parts: ModelPart[] = []
  const exhausts: Exhaust[] = []
  let y = 0
  for (let s = 0; s < stages; s++) {
    const h = H * shares[s], rr = r * (1 - s * 0.12)
    const m = new MeshBuilder()
    m.cylinder('y', [0, y + h / 2, 0], rr, h, s === 0 ? WHITE : paint('#f4f4f4'), 14)
    m.cylinder('y', [0, y + h * 0.82, 0], rr * 1.01, h * 0.05, BODY, 14)
    m.cylinder('y', [0, y + h - 0.4, 0], rr * 1.005, 0.8, DARK, 14)
    const bells = s === 0 ? 5 : 1
    for (let b = 0; b < bells; b++) {
      const a = (b / Math.max(1, bells - 1)) * Math.PI * 2, d = b === 0 || bells === 1 ? 0 : rr * 0.55
      m.cylinder('y', [Math.cos(a) * d, y - rr * 0.35, Math.sin(a) * d], rr * (bells === 1 ? 0.6 : 0.32), rr * 0.7, DARK, 10, rr * 0.12)
    }
    if (s === 0 && p.fins) for (let f = 0; f < 4; f++) {
      const a = (f / 4) * Math.PI * 2 + Math.PI / 4
      m.fin([[rr, 0], [rr * 2.2, 0], [rr * 2.2, h * 0.06], [rr, h * 0.16]], [0, y, 0], [Math.cos(a), 0, Math.sin(a)], [0, 1, 0], 0.15, BODY)
    }
    if (s === 0) for (let b = 0; b < boosters; b++) {
      const a = (b / boosters) * Math.PI * 2, bx = Math.cos(a) * rr * 1.55, bz = Math.sin(a) * rr * 1.55, bh = h * 0.7
      m.cylinder('y', [bx, bh / 2, bz], rr * 0.5, bh, WHITE, 10)
      m.cylinder('y', [bx, bh + rr * 0.6, bz], rr * 0.5, rr * 1.2, WHITE, 10, 0.05)
      m.cylinder('y', [bx, -rr * 0.3, bz], rr * 0.3, rr * 0.6, DARK, 8, rr * 0.12)
    }
    if (s === stages - 1) m.group([0, y + h, 0], [-Math.PI / 2, 0, 0], () => m.loft([
      { z: 0, w: rr * 1.05, top: rr * 1.05, bottom: -rr * 1.05, round: 1 },
      { z: fairing * 0.4, w: rr * 1.0, top: rr * 1.0, bottom: -rr * 1.0, round: 1 },
      { z: fairing * 0.8, w: rr * 0.55, top: rr * 0.55, bottom: -rr * 0.55, round: 1 },
      { z: fairing, w: 0.02, top: 0.02, bottom: -0.02, round: 1 },
    ], WHITE, 14))
    parts.push({ name: `stage${s}`, mesh: m.build(), mounts: [{ position: [0, 0, 0], stage: s }] })
    exhausts.push({ position: [0, y - rr * 0.7, 0], direction: [0, -1, 0], radius: rr * (s === 0 ? 1.3 + boosters * 0.25 : 0.6), length: H * (s === 0 ? 1.1 : 0.5), color: s === 0 ? '#ffb347' : '#9ec8ff', stage: s })
    y += h
  }
  if (p.pad) {
    const m = new MeshBuilder()
    const concrete = paint('#8d8a84'), steel = paint('#b8442a')
    m.box([0, -r * 1.2, 0], [r * 14, 1, r * 14], concrete)
    m.box([0, -r * 1.2 + 0.52, 0], [r * 4, 0.05, r * 4], DARK)
    const tx = r * 3.2, tw = r * 1.4, th = H * 1.05
    for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) m.beam([tx + dx * tw / 2, -r, dz * tw / 2], [tx + dx * tw / 2, th, dz * tw / 2], 0.35, steel)
    for (let k = 0; k < 10; k++) {
      const yy = (k / 10) * th
      m.beam([tx - tw / 2, yy, -tw / 2], [tx + tw / 2, yy + th / 10, -tw / 2], 0.18, steel)
      m.beam([tx - tw / 2, yy, tw / 2], [tx + tw / 2, yy + th / 10, tw / 2], 0.18, steel)
    }
    m.beam([tx - tw / 2, H * 0.7, 0], [r * 0.9, H * 0.7, 0], 0.5, steel)
    m.box([tx, th + 0.5, 0], [0.3, 0.3, 0.3], paint('#ff4040', 0, 1))
    parts.push({ name: 'pad', mesh: m.build(), mounts: [{ position: [0, 0, 0], stage: -1 }] })
  }
  return model('rocket', `${stages}-stage`, 'space', parts, { exhausts, stages, palette: ['#17202a', '#c0392b', '#1f4e9c', '#7f8c8d'] })
}

// ---------------------------------------------------------------- registry

/** A vehicle type: what it is, its parameters and its generator. */
export interface VehicleKind {
  /** Display name. */
  name: string
  /** Where it moves. */
  domain: VehicleDomain
  /** Search tags. */
  tags: string[]
  /** Parameters with defaults and ranges. */
  params: Record<string, ParamDef>
  /** Builds one model from resolved parameters and a seeded random source. */
  build: (params: VehicleParams, rand: Rand) => VehicleModel
}

const size = { type: 'number', default: 1, min: 0.6, max: 1.6, step: 0.01 } as const

/** Every vehicle type with its parameters (all JSON) and generator. */
export const VEHICLE_KINDS: Record<VehicleType, VehicleKind> = {
  car: {
    name: 'Car', domain: 'land', tags: ['car', 'sedan', 'hatchback', 'suv', 'truck', 'pickup', 'van', 'bus', 'compact', 'wagon', 'vintage', 'electric', 'roadster', 'convertible', 'muscle', 'traffic', 'road'],
    params: { style: { type: 'choice', default: 'mixed', options: ['mixed', 'sedan', 'hatchback', 'suv', 'truck', 'van', 'bus', ...LOOKALIKE_STYLES] }, size },
    build: car,
  },
  pickup: {
    name: 'Pickup', domain: 'land', tags: ['pickup', 'truck', 'ute', 'utility', 'stainless', 'farm', 'rural', 'traffic', 'road'],
    params: {
      style: { type: 'choice', default: 'mixed', options: ['mixed', ...PICKUP_STYLES] },
      cab: { type: 'choice', default: 'crew', options: ['regular', 'extended', 'crew'] },
      bed: { type: 'choice', default: 'short', options: ['short', 'long'] },
      lift: { type: 'number', default: 0, min: 0, max: 0.3, step: 0.01 },
      hitch: { type: 'boolean', default: false },
      load: { type: 'choice', default: 'none', options: ['none', 'crates', 'hay', 'gravel'] },
      ute: { type: 'choice', default: 'coupe', options: ['coupe', 'tray'] },
      painted: { type: 'boolean', default: false },
      size,
    },
    build: pickup,
  },
  truck: {
    name: 'Truck', domain: 'land', tags: ['truck', 'lorry', 'semi', 'tractor unit', 'trailer', 'container', 'flatbed', 'tanker', 'road train', 'freight', 'highway'],
    params: {
      cab: { type: 'choice', default: 'conventional', options: ['conventional', 'cabOver'] },
      sleeper: { type: 'boolean', default: true },
      axles: { type: 'number', default: 3, min: 2, max: 4, step: 1 },
      stacks: { type: 'boolean', default: true },
      cabColor: { type: 'color', default: '' },
      body: { type: 'choice', default: 'tractor', options: ['tractor', 'rigid'] },
      trailers: { type: 'number', default: 1, min: 1, max: 3, step: 1 },
      trailer: { type: 'choice', default: 'mixed', options: ['mixed', ...TRAILER_KINDS] },
      load: { type: 'choice', default: 'mixed', options: ['mixed', 'empty', 'lumber', 'pipes', 'machinery'] },
    },
    build: truck,
  },
  bicycle: {
    name: 'Bicycle', domain: 'land', tags: ['bike', 'bicycle', 'cyclist', 'road'],
    params: { style: { type: 'choice', default: 'mixed', options: ['mixed', 'road', 'city', 'mountain'] }, rider: { type: 'boolean', default: true } },
    build: bicycle,
  },
  train: {
    name: 'Train', domain: 'rail', tags: ['train', 'locomotive', 'wagon', 'railway', 'freight', 'passenger', 'rail'],
    params: {
      car: { type: 'choice', default: 'locomotive', options: ['locomotive', 'passenger', 'freight'] },
      freight: { type: 'choice', default: 'mixed', options: ['mixed', 'boxcar', 'tank', 'hopper', 'container'] },
      wagons: { type: 'number', default: 5, min: 0, max: 30, step: 1 },
      cargo: { type: 'choice', default: 'passenger', options: ['passenger', 'freight', 'mixed'] },
      size,
    },
    build: train,
  },
  'fishing-boat': {
    name: 'Fishing boat', domain: 'sea', tags: ['boat', 'fishing', 'trawler', 'harbour', 'ship', 'sea'],
    params: { length: { type: 'number', default: 13, min: 6, max: 40, step: 0.5 }, outriggers: { type: 'boolean', default: true } },
    build: fishingBoat,
  },
  'cruise-liner': {
    name: 'Cruise liner', domain: 'sea', tags: ['ship', 'cruise', 'liner', 'ocean liner', 'sea'],
    params: {
      length: { type: 'number', default: 200, min: 80, max: 360, step: 1 },
      decks: { type: 'number', default: 7, min: 2, max: 14, step: 1 },
      funnels: { type: 'number', default: 1, min: 0, max: 4, step: 1 },
    },
    build: cruiseLiner,
  },
  speedboat: {
    name: 'Speedboat', domain: 'sea', tags: ['boat', 'speedboat', 'motorboat', 'runabout', 'sea', 'lake'],
    params: { length: { type: 'number', default: 7, min: 4, max: 16, step: 0.1 }, cabin: { type: 'boolean', default: false } },
    build: speedboat,
  },
  hovercraft: {
    name: 'Hovercraft', domain: 'sea', tags: ['hovercraft', 'air cushion', 'ferry', 'shore', 'sea'],
    params: { length: { type: 'number', default: 20, min: 6, max: 60, step: 0.5 }, fans: { type: 'number', default: 2, min: 1, max: 4, step: 1 } },
    build: hovercraft,
  },
  'aircraft-carrier': {
    name: 'Aircraft carrier', domain: 'sea', tags: ['carrier', 'aircraft carrier', 'navy', 'warship', 'ship', 'sea'],
    params: {
      length: { type: 'number', default: 300, min: 150, max: 340, step: 1 },
      angledDeck: { type: 'boolean', default: true },
      spots: { type: 'number', default: 8, min: 0, max: 24, step: 1 },
    },
    build: aircraftCarrier,
  },
  airplane: {
    name: 'Airplane', domain: 'air', tags: ['plane', 'airplane', 'aeroplane', 'airliner', 'jet', 'light aircraft', 'cessna', 'air'],
    params: {
      style: { type: 'choice', default: 'airliner', options: ['mixed', 'airliner', 'light'] },
      length: { type: 'number', default: 38, min: 20, max: 75, step: 0.5 },
      engines: { type: 'number', default: 2, min: 2, max: 4, step: 2 },
    },
    build: airplane,
  },
  'fighter-jet': {
    name: 'Fighter jet', domain: 'air', tags: ['fighter', 'jet', 'military', 'air force', 'air'],
    params: { style: { type: 'choice', default: 'mixed', options: ['mixed', 'delta', 'twin-tail'] }, length: { type: 'number', default: 16, min: 10, max: 24, step: 0.1 } },
    build: fighterJet,
  },
  rocket: {
    name: 'Rocket', domain: 'space', tags: ['rocket', 'launch', 'space', 'booster', 'stage'],
    params: {
      height: { type: 'number', default: 60, min: 15, max: 120, step: 1 },
      stages: { type: 'number', default: 2, min: 1, max: 3, step: 1 },
      boosters: { type: 'number', default: 0, min: 0, max: 4, step: 2 },
      fins: { type: 'boolean', default: true },
      pad: { type: 'boolean', default: true },
    },
    build: rocket,
  },
}

/** Every vehicle type, in gallery order. */
export const VEHICLE_TYPES = Object.keys(VEHICLE_KINDS) as VehicleType[]

/** The default parameter values of a type. */
export function defaultParams(type: VehicleType): VehicleParams {
  return Object.fromEntries(Object.entries(VEHICLE_KINDS[type].params).map(([k, d]) => [k, d.default]))
}

/**
 * Generates one vehicle model. Deterministic: the same type, parameters and seed always give the same
 * meshes; different seeds give different proportions, styles and details.
 *
 * @example
 * ```ts
 * buildVehicle('car', { style: 'suv' }, 7).size     // [1.95, 1.8, 4.8]-ish metres
 * ```
 */
export function buildVehicle(type: VehicleType, params: VehicleParams = {}, seed: number | string = 1): VehicleModel {
  const kind = VEHICLE_KINDS[type]
  if (!kind) throw new Error(`Unknown vehicle type "${type}"`)
  return kind.build({ ...defaultParams(type), ...params }, mulberry32(seedOf(seed) ^ 0x5bd1e995))
}
