// Six car lookalikes with generic names: proportions and silhouettes of well-known cars, no badges,
// logos or names. Smooth lofted bodies (see body.ts), seeded colours and trims, distinct wheels and
// lamps, and tailpipe vents for the exhaust smoke (none on the electric saloon).
import { FINISH, MeshBuilder, paint, type MeshData, type Paint, type Vec3 } from './mesh.ts'
import { BODY, CHROME, DARK, GLASS, HEAD, PLASTIC, TAIL, TRIM, TYRE, body, model, pick, smoothWheel, type Rand, type WheelLook } from './kit.ts'
import { faceY, loftBody, mirrors, onEnd, onSide, type Body } from './body.ts'
import type { ExhaustVent, ModelPart, PartMount, VehicleModel, VehicleParams } from './models.ts'

/** The lookalike car styles. */
export const LOOKALIKE_STYLES = ['compact', 'retroWagon', 'vintage', 'electricSaloon', 'roadster', 'muscle'] as const
/** A lookalike car style. */
export type LookalikeStyle = (typeof LOOKALIKE_STYLES)[number]

/** Overall size of a reference car, metres (width without mirrors). */
export interface CarDimensions {
  length: number
  width: number
  height: number
  wheelBase: number
}

/**
 * The real cars' published dimensions each lookalike matches (within a few per cent): a current
 * compact sedan, a 2000s retro wagon, a 1910s touring car (top up), a large electric liftback, a
 * front-engined convertible grand tourer (windscreen frame for height) and a full-size muscle sedan.
 */
export const CAR_REFERENCES: Record<LookalikeStyle, CarDimensions> = {
  compact: { length: 4.674, width: 1.801, height: 1.415, wheelBase: 2.736 },
  retroWagon: { length: 4.288, width: 1.705, height: 1.601, wheelBase: 2.616 },
  vintage: { length: 3.416, width: 1.651, height: 1.93, wheelBase: 2.54 },
  electricSaloon: { length: 5.021, width: 1.963, height: 1.431, wheelBase: 2.96 },
  roadster: { length: 4.586, width: 1.938, height: 1.318, wheelBase: 2.67 },
  muscle: { length: 5.04, width: 1.905, height: 1.479, wheelBase: 3.052 },
}

const PALETTES: Record<LookalikeStyle, string[]> = {
  compact: ['#e9ecee', '#1b1b1d', '#7f8a92', '#b9c0c6', '#25384d', '#a8121c', '#2a6fb0', '#3b4048'],
  retroWagon: ['#5a1320', '#1b1b1d', '#c9ccce', '#2a3f66', '#8f1d1d', '#e4dfcf', '#3e5a3a', '#6d6f73'],
  vintage: ['#121212', '#121212', '#121212', '#1d2b22', '#2e1515', '#1a2233'],
  electricSaloon: ['#f2f3f4', '#111214', '#8c939a', '#1e3f7a', '#9e1b22', '#c3c8cc'],
  roadster: ['#b3121c', '#c41a1a', '#f1c40f', '#111214', '#e9ecee', '#2a3a55', '#7d8187'],
  muscle: ['#1b1b1d', '#c41a1a', '#e9ecee', '#5d6168', '#f2a900', '#1f5a2d', '#2a4c9a', '#6c2a8c'],
}

/** Wheels: a smooth tyre plus rim mounted at the four corners (left side mirrored, spin reversed). */
function wheels(r: number, w: number, look: WheelLook, x: number, axles: [front: number, rear: number], track: [number, number] = [x, x]): ModelPart {
  const mounts: PartMount[] = []
  for (const side of [-1, 1]) for (const [k, z] of axles.entries()) {
    mounts.push({
      position: [side * track[k], r, z], rotation: side < 0 ? [0, Math.PI, 0] : undefined,
      spin: { axis: 0, rate: side / r, by: 'distance' }, steer: k === 0 ? 1 : undefined,
    })
  }
  return { name: 'wheel', mesh: smoothWheel(r, w, look), mounts }
}

const tailpipe = (x: number, y: number, z: number, radius = 0.035): ExhaustVent => ({ position: [x, y, z], direction: [0, -0.15, -1], kind: 'tailpipe', radius })

/** Lamps in a mirrored pair on the front or rear. */
function lampPair(m: MeshBuilder, b: Body, x: number, y: number, dir: 1 | -1, size: Vec3, s: Paint, sink = 0.72, e = 5): void {
  for (const side of [-1, 1]) onEnd(m, b, side * x, y, dir, size, s, sink, e)
}

/** Generates one lookalike car. `k` scales everything (the `size` parameter). */
export function lookalikeCar(style: LookalikeStyle, p: VehicleParams, rand: Rand): VehicleModel {
  const k = Number(p.size ?? 1)
  const ref = CAR_REFERENCES[style]
  const m = new MeshBuilder()
  let built: { parts: ModelPart[]; vents: ExhaustVent[]; wheelBase: number }
  if (style === 'vintage') built = vintage(m, rand)
  else built = BUILDERS[style](m, rand, ref)
  const parts = [body(scaleMesh(m.build(), k)), ...built.parts.map((pt) => ({ ...pt, mesh: scaleMesh(pt.mesh, k), mounts: pt.mounts.map((mt) => ({ ...mt, position: mt.position.map((v) => v * k) as Vec3, spin: mt.spin && { ...mt.spin, rate: mt.spin.rate / k } })) }))]
  const vents = built.vents.map((v) => ({ ...v, position: v.position.map((c) => c * k) as Vec3, radius: v.radius * k }))
  return model('car', style, 'land', parts, { wheelBase: built.wheelBase * k, palette: PALETTES[style], vents, bank: -0.04 })
}

function scaleMesh(d: MeshData, k: number): MeshData {
  if (k === 1) return d
  const position = d.position.map((v) => v * k)
  return { ...d, position, bounds: d.bounds.map((v) => v * k) as MeshData['bounds'] }
}

type Builder = (m: MeshBuilder, rand: Rand, ref: CarDimensions) => { parts: ModelPart[]; vents: ExhaustVent[]; wheelBase: number }

// Axle positions from the reference's front overhang.
const axlesOf = (ref: CarDimensions, front: number): [number, number] => [ref.length / 2 - front, ref.length / 2 - front - ref.wheelBase]

const BUILDERS: Record<Exclude<LookalikeStyle, 'vintage'>, Builder> = {
  /** Compact sedan: low, wedge-shaped, long sloping rear glass into a short boot, slim swept lamps. */
  compact(m, rand, ref) {
    const { length: L, width: W, height: H } = ref
    const r = 0.323, ax = axlesOf(ref, 0.94)
    const trimBlack = rand() < 0.5
    const b = loftBody(m, {
      L, W, H, r, axles: ax,
      belt: [[0, 0.84], [0.025, 0.93], [0.08, 0.99], [0.16, 1.0], [0.4, 0.97], [0.7, 0.9], [0.84, 0.83], [0.95, 0.76], [1, 0.7]],
      bottom: [[0, 0.4], [0.05, 0.26], [0.14, 0.17], [0.86, 0.17], [0.95, 0.21], [1, 0.3]],
      plan: [[0, 0.82], [0.04, 0.95], [0.13, 1], [0.86, 1], [0.95, 0.93], [1, 0.78]],
      split: 0.55, eTop: 4.6, eBot: 5, fillet: [0.14, 0.16],
      roof: [[0.13, 1.0], [0.19, 1.15], [0.27, 1.32], [0.35, 1.405], [0.44, H], [0.5, 1.37], [0.6, 1.14], [0.7, 0.9]],
      roofSpan: [0.3, 0.5], pillars: [0.47], cPillar: 0.25, topW: 0.7,
      pillarPaint: TRIM, roofPaint: trimBlack && rand() < 0.4 ? paint('#151618', 0, 0, FINISH.plain) : BODY,
    })
    // Front: slim swept headlights, a wide dark lower grille, a slim upper grille.
    lampPair(m, b, 0.6, faceY(b, 1, 0.8), 1, [0.36, 0.07, 0.12], HEAD)
    onEnd(m, b, 0, faceY(b, 1, 0.25), 1, [1.1, 0.2, 0.1], PLASTIC, 0.6)
    onEnd(m, b, 0, faceY(b, 1, 0.66), 1, [0.7, 0.06, 0.08], PLASTIC, 0.6)
    // Rear: lamps wrapping round the corners onto the boot, a thin bar between them.
    lampPair(m, b, 0.62, faceY(b, -1, 0.8), -1, [0.42, 0.09, 0.1], TAIL)
    onEnd(m, b, 0, faceY(b, -1, 0.86), -1, [0.9, 0.025, 0.06], TAIL, 0.6)
    onEnd(m, b, 0, faceY(b, -1, 0.12), -1, [1.3, 0.1, 0.08], PLASTIC, 0.6)
    mirrors(m, b, b.z(0.68), 1.0, trimBlack ? PLASTIC : BODY)
    for (const side of [-1, 1]) for (const z of [0.05, -0.85]) onSide(m, b, z, 0.86, side, [0.03, 0.025, 0.16], trimBlack ? PLASTIC : BODY)
    const rim = pick(rand, ['#2e3034', '#b4b8bd', '#1c1d20'])
    return {
      parts: [wheels(r, 0.235, { rim: 'split', spokes: 5, ratio: 0.71, color: paint(rim, 0, 0, FINISH.plain) }, W / 2 - 0.14, ax)],
      vents: [tailpipe(0.45, 0.28, -L / 2 + 0.12)], wheelBase: ax[0] - ax[1],
    }
  },

  /** Retro wagon: tall upright glasshouse, separate bulging front wings, an upright chrome grille. */
  retroWagon(m, rand, ref) {
    const { length: L, width: W, height: H } = ref
    const r = 0.316, ax = axlesOf(ref, 0.83)
    const b = loftBody(m, {
      L, W, H, r, axles: ax,
      belt: [[0, 0.86], [0.03, 0.97], [0.1, 1.01], [0.5, 1.0], [0.68, 0.98], [0.82, 0.95], [0.94, 0.89], [1, 0.76]],
      bottom: [[0, 0.42], [0.05, 0.26], [0.14, 0.2], [0.86, 0.2], [0.95, 0.26], [1, 0.4]],
      plan: [[0, 0.86], [0.04, 0.96], [0.12, 1], [0.6, 1], [0.72, 0.86], [0.86, 0.76], [1, 0.62]],
      split: 0.4, eTop: 2.8, eBot: 4, fillet: [0.2, 0.22], tuck: [0.05, 0.2],
      roof: [[0.035, 0.98], [0.06, 1.3], [0.1, 1.5], [0.17, 1.585], [0.4, H], [0.52, 1.58], [0.6, 1.36], [0.69, 0.98]],
      roofSpan: [0.11, 0.53], pillars: [0.34], cPillar: 0.13, topW: 0.84, eGlass: 3,
      pillarPaint: BODY,
    })
    // Front wings: smooth pods over the front wheels sweeping back into the doors; rear haunches.
    for (const side of [-1, 1]) {
      wing(m, side * (W / 2 - 0.2), ax[0], r, 0.2, 0.92, -1.05, 0.62)
      wing(m, side * (W / 2 - 0.19), ax[1], r, 0.2, 0.9, -0.45, 0.45)
    }
    // Upright chrome grille between the wings, round-cornered lamps set into the wing fronts.
    onEnd(m, b, 0, faceY(b, 1, 0.55), 1, [0.6, 0.42, 0.08], PLASTIC, 0.5, 4)
    for (let i = 0; i < 4; i++) onEnd(m, b, 0, faceY(b, 1, 0.38 + i * 0.12), 1, [0.6, 0.025, 0.1], CHROME, 0.45, 6)
    onEnd(m, b, 0, faceY(b, 1, 0.55), 1, [0.64, 0.46, 0.06], CHROME, 0.62, 4)
    for (const side of [-1, 1]) m.rounded([side * (W / 2 - 0.2), 0.74, ax[0] + 0.66], [0.28, 0.2, 0.12], HEAD, 3, 14, 6)
    onEnd(m, b, 0, faceY(b, 1, 0.1), 1, [1.4, 0.16, 0.1], BODY, 0.6, 4)
    // Rear: upright lamps at the corners, a bumper.
    lampPair(m, b, 0.62, faceY(b, -1, 0.68), -1, [0.18, 0.3, 0.1], TAIL)
    onEnd(m, b, 0, faceY(b, -1, 0.1), -1, [1.45, 0.16, 0.1], BODY, 0.6, 4)
    mirrors(m, b, b.z(0.67), 1.06, BODY)
    for (const side of [-1, 1]) for (const z of [0.25, -0.55]) onSide(m, b, z, 0.9, side, [0.03, 0.03, 0.16], CHROME)
    return {
      parts: [wheels(r, 0.205, { rim: 'spokes', spokes: 5, ratio: 0.64, color: CHROME }, W / 2 - 0.16, ax)],
      vents: [tailpipe(-0.5, 0.3, -L / 2 + 0.1, 0.03)], wheelBase: ax[0] - ax[1],
    }
  },

  /** Electric liftback: no grille, smooth low nose, glass roof, flush handles, aero wheel covers. */
  electricSaloon(m, rand, ref) {
    const { length: L, width: W, height: H } = ref
    const r = 0.351, ax = axlesOf(ref, 0.95)
    const b = loftBody(m, {
      L, W, H, r, axles: ax,
      belt: [[0, 0.8], [0.025, 0.92], [0.08, 0.97], [0.2, 0.985], [0.45, 0.95], [0.66, 0.9], [0.8, 0.8], [0.93, 0.7], [1, 0.58]],
      bottom: [[0, 0.38], [0.05, 0.24], [0.13, 0.16], [0.87, 0.16], [0.95, 0.2], [1, 0.3]],
      plan: [[0, 0.84], [0.05, 0.96], [0.15, 1], [0.85, 1], [0.95, 0.93], [1, 0.74]],
      split: 0.5, eTop: 2.9, eBot: 4.5, fillet: [0.2, 0.26],
      roof: [[0.09, 0.97], [0.15, 1.1], [0.25, 1.3], [0.35, 1.415], [0.45, H], [0.53, 1.39], [0.6, 1.18], [0.66, 0.9]],
      roofSpan: [0.32, 0.53], pillars: [0.46], cPillar: 0.21, topW: 0.7,
      pillarPaint: TRIM, roofPaint: GLASS,
    })
    // A smooth nose with no grille, only a slim dark intake low down; slim lamps.
    lampPair(m, b, 0.62, faceY(b, 1, 0.78), 1, [0.3, 0.06, 0.1], HEAD)
    onEnd(m, b, 0, faceY(b, 1, 0.2), 1, [0.9, 0.06, 0.08], PLASTIC, 0.62)
    lampPair(m, b, 0.6, faceY(b, -1, 0.82), -1, [0.4, 0.07, 0.1], TAIL)
    onEnd(m, b, 0, faceY(b, -1, 0.96), -1, [1.0, 0.02, 0.05], PLASTIC, 0.55) // lip spoiler shut line
    mirrors(m, b, b.z(0.64), 0.98, BODY, [0.2, 0.11, 0.1])
    for (const side of [-1, 1]) for (const z of [0.15, -0.75]) onSide(m, b, z, 0.84, side, [0.012, 0.02, 0.2], CHROME, 0.75)
    const cover = pick(rand, ['#6b7076', '#2b2d31', '#8c9196'])
    return {
      parts: [wheels(r, 0.245, { rim: 'aero', spokes: 5, ratio: 0.69, color: paint(cover) }, W / 2 - 0.15, ax)],
      vents: [], wheelBase: ax[0] - ax[1],
    }
  },

  /** Convertible grand tourer: long bonnet, cockpit set back, open top, haunches, twin round tail lamps. */
  roadster(m, rand, ref) {
    const { length: L, width: W } = ref
    const r = 0.343, ax = axlesOf(ref, 0.96)
    const leather = pick(rand, [paint('#2a1f1a'), paint('#7a4a2a'), paint('#b8a080'), paint('#1a1a1c'), paint('#6b1414')])
    const b = loftBody(m, {
      L, W, H: 1.28, r, axles: ax,
      belt: [[0, 0.84], [0.03, 0.94], [0.12, 0.98], [0.3, 0.97], [0.45, 0.92], [0.6, 0.89], [0.75, 0.84], [0.9, 0.74], [0.97, 0.63], [1, 0.54]],
      bottom: [[0, 0.34], [0.05, 0.2], [0.14, 0.14], [0.86, 0.14], [0.95, 0.16], [1, 0.25]],
      plan: [[0, 0.84], [0.05, 0.95], [0.16, 1], [0.84, 1], [0.94, 0.9], [1, 0.7]],
      split: 0.5, eTop: 2.6, eBot: 4.5, fillet: [0.18, 0.26],
      cockpit: [0.37, 0.59], interior: leather,
    })
    // Front wings and rear haunches rising above the bonnet and deck.
    for (const side of [-1, 1]) {
      wing(m, side * (W / 2 - 0.25), ax[0], r, 0.26, 0.86, -0.9, 0.8, 2.4)
      wing(m, side * (W / 2 - 0.25), ax[1], r, 0.27, 0.95, -0.75, 0.75, 2.4)
    }
    // Windscreen: a raked, curved pane in a dark frame.
    windscreen(m, b.z(0.595), 0.9, 1.28, 0.42, W * 0.42)
    // Cockpit: two seats, a dash, a wheel and the tonneau humps behind the seats.
    for (const side of [-1, 1]) {
      const x = side * 0.38
      m.rounded([x, 0.78, b.z(0.43)], [0.5, 0.3, 0.55], leather, 3)
      m.rounded([x, 1.03, b.z(0.4)], [0.48, 0.55, 0.16], leather, 3, 14, 6)
      m.rounded([x, 1.15, b.z(0.33)], [0.36, 0.2, 0.5], BODY, 2.6) // humps
    }
    m.rounded([0, 0.86, b.z(0.575)], [W * 0.78, 0.12, 0.3], DARK, 3)
    m.lathe('z', [0.38, 0.95, b.z(0.535)], [[0.17, -0.02], [0.17, 0.02], [0.14, 0.02], [0.14, -0.02]], DARK, 20)
    // Swept slim headlamps, a wide low intake, twin round tail lamps a side, quad tailpipes.
    lampPair(m, b, 0.6, faceY(b, 1, 0.76), 1, [0.36, 0.08, 0.12], HEAD)
    onEnd(m, b, 0, faceY(b, 1, 0.25), 1, [1.05, 0.16, 0.1], PLASTIC, 0.6, 4)
    for (const x of [0.48, 0.72]) lampPair(m, b, x, faceY(b, -1, 0.72), -1, [0.13, 0.13, 0.08], TAIL, 0.5, 2.2)
    onEnd(m, b, 0, faceY(b, -1, 0.12), -1, [1.2, 0.12, 0.1], PLASTIC, 0.6)
    mirrors(m, b, b.z(0.6), 0.96, BODY, [0.22, 0.1, 0.12])
    const vents: ExhaustVent[] = []
    for (const x of [-0.62, -0.5, 0.5, 0.62]) {
      m.lathe('z', [x, 0.3, -L / 2 + 0.06], [[0.045, -0.06], [0.045, 0.06], [0.035, 0.06], [0.035, -0.02]], CHROME, 14)
      vents.push(tailpipe(x, 0.3, -L / 2 - 0.01, 0.04))
    }
    return {
      parts: [wheels(r, 0.255, { rim: 'split', spokes: 5, ratio: 0.77, color: paint(pick(rand, ['#b9bdc2', '#2a2b2e', '#8a8f95'])) }, W / 2 - 0.16, ax)],
      vents, wheelBase: ax[0] - ax[1],
    }
  },

  /** Muscle sedan: long, wide and flat-topped, a full-width grille, a thick C pillar, a full-width tail lamp. */
  muscle(m, rand, ref) {
    const { length: L, width: W, height: H } = ref
    const r = 0.364, ax = axlesOf(ref, 0.95)
    const b = loftBody(m, {
      L, W, H, r, axles: ax,
      belt: [[0, 0.92], [0.03, 1.0], [0.1, 1.035], [0.25, 1.035], [0.5, 1.0], [0.66, 0.98], [0.85, 0.96], [0.96, 0.93], [1, 0.84]],
      bottom: [[0, 0.42], [0.05, 0.25], [0.13, 0.18], [0.87, 0.18], [0.95, 0.22], [1, 0.34]],
      plan: [[0, 0.9], [0.04, 0.98], [0.14, 1], [0.86, 1], [0.96, 0.97], [1, 0.88]],
      split: 0.48, eTop: 4.6, eBot: 6, fillet: [0.12, 0.13], tuck: [0.04, 0.1],
      roof: [[0.17, 1.03], [0.22, 1.18], [0.29, 1.37], [0.37, 1.46], [0.48, H], [0.55, 1.44], [0.61, 1.22], [0.66, 0.98]],
      roofSpan: [0.33, 0.555], pillars: [0.47], cPillar: 0.31, topW: 0.74, eGlass: 3.2,
      pillarPaint: TRIM,
    })
    // A full-width black grille with slim lamps at its ends and a split bar; a bonnet bulge.
    onEnd(m, b, 0, faceY(b, 1, 0.62), 1, [1.62, 0.26, 0.08], PLASTIC, 0.6, 7)
    onEnd(m, b, 0, faceY(b, 1, 0.62), 1, [0.06, 0.24, 0.1], BODY, 0.55, 7)
    lampPair(m, b, 0.66, faceY(b, 1, 0.66), 1, [0.3, 0.07, 0.1], HEAD, 0.45)
    onEnd(m, b, 0, faceY(b, 1, 0.15), 1, [1.3, 0.12, 0.1], PLASTIC, 0.6)
    m.rounded([0, b.top(b.z(0.82)) - 0.03, b.z(0.82)], [0.7, 0.1, 1.1], BODY, 3)
    // Full-width tail lamp ring, a ducktail lip, twin tailpipes.
    onEnd(m, b, 0, faceY(b, -1, 0.78), -1, [1.72, 0.09, 0.08], TAIL, 0.55, 8)
    onEnd(m, b, 0, faceY(b, -1, 0.98), -1, [1.5, 0.03, 0.06], BODY, 0.5)
    onEnd(m, b, 0, faceY(b, -1, 0.12), -1, [1.3, 0.14, 0.1], PLASTIC, 0.6)
    mirrors(m, b, b.z(0.66), 1.08, BODY)
    for (const side of [-1, 1]) for (const z of [0.1, -0.95]) onSide(m, b, z, 0.92, side, [0.03, 0.03, 0.17], BODY)
    const vents: ExhaustVent[] = []
    for (const x of [-0.6, 0.6]) {
      m.lathe('z', [x, 0.3, -L / 2 + 0.08], [[0.055, -0.08], [0.055, 0.08], [0.045, 0.08], [0.045, -0.02]], CHROME, 14)
      vents.push(tailpipe(x, 0.3, -L / 2 + 0.01, 0.05))
    }
    return {
      parts: [wheels(r, 0.245, { rim: 'split', spokes: 5, ratio: 0.7, color: paint(pick(rand, ['#2a2b2e', '#5a5e63', '#b4b8bd'])) }, W / 2 - 0.15, ax)],
      vents, wheelBase: ax[0] - ax[1],
    }
  },
}

/** A smooth wing (fender) pod over a wheel: sweeps from `back` to `front` metres around the axle. */
function wing(m: MeshBuilder, x: number, zc: number, r: number, hw: number, top: number, back: number, front: number, e = 2.8): void {
  const R = r * 1.14 + 0.03
  const rows: Vec3[][] = []
  const n = 24
  for (let i = 0; i <= n; i++) {
    const t = i / n, z = zc + back + (front - back) * t
    const env = Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 0.5 // rounded ends, longer tail
    const d = Math.abs(z - zc)
    const cut = d < R ? r + Math.sqrt(R * R - d * d) : r * 0.9
    const tp = cut + (top - cut) * 0.5 + (top - (cut + (top - cut) * 0.5)) * env
    const lo = Math.min(tp - 0.01, cut)
    const w = Math.max(0.01, hw * env)
    const ring: Vec3[] = []
    for (let j = 0; j < 20; j++) {
      const a = (j / 20) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a)
      const p = 2 / e
      ring.push([x + w * Math.sign(c) * Math.abs(c) ** p, lo + (tp - lo) * (0.5 + 0.5 * Math.sign(s) * Math.abs(s) ** p), z])
    }
    rows.push(ring)
  }
  m.surface(rows, (i, j) => (Math.sin(((j + 0.5) / 20) * Math.PI * 2) < -0.5 ? PLASTIC : BODY))
}

/** A curved windscreen pane between `y0` (base, at z0) and `y1`, raked back by `rake` metres. */
function windscreen(m: MeshBuilder, z0: number, y0: number, y1: number, rake: number, hw: number): void {
  const rows: Vec3[][] = []
  const n = 10
  for (let i = 0; i <= n; i++) {
    const t = i / n, y = y0 + (y1 - y0) * t, z = z0 - rake * t, w = hw * (1 - 0.12 * t)
    const ring: Vec3[] = []
    for (let j = 0; j < 24; j++) {
      const a = (j / 24) * Math.PI * 2
      const xn = Math.cos(a), thick = Math.sin(a) * 0.012
      ring.push([w * xn, y, z + thick - 0.1 * xn * xn]) // edges curve back
    }
    rows.push(ring)
  }
  m.surface(rows, (i, j) => {
    const xn = Math.abs(Math.cos(((j + 0.5) / 24) * Math.PI * 2))
    return i >= n - 1 || xn > 0.93 ? DARK : GLASS
  }, true, [DARK, DARK])
}

// ---------------------------------------------------------------- vintage

/**
 * A 1910s touring car: ladder frame, upright radiator and flat-sided bonnet, an open tub with two bench
 * seats under a folding fabric top, separate wings over tall wooden-spoked wheels, running boards and
 * bucket lamps.
 */
function vintage(m: MeshBuilder, rand: Rand): { parts: ModelPart[]; vents: ExhaustVent[]; wheelBase: number } {
  const ref = CAR_REFERENCES.vintage
  const L = ref.length, W = ref.width
  const r = 0.381, ax: [number, number] = [L / 2 - 0.36, L / 2 - 0.36 - ref.wheelBase]
  const brass = rand() < 0.35
  const shell = brass ? paint('#b8893a', 0, 0, FINISH.chrome) : BODY
  const leather = pick(rand, [paint('#1a1714'), paint('#3a2418'), paint('#2a2a2a')])
  const fabric = pick(rand, [paint('#141414', 0, 0, FINISH.rubber), paint('#5b5040', 0, 0, FINISH.rubber)])
  const nickel = paint('#c9c2b0', 0, 0, FINISH.chrome)
  // Ladder frame and axles.
  for (const s of [-1, 1]) m.box([s * 0.42, 0.55, -0.05], [0.07, 0.14, L - 0.3], DARK)
  m.box([0, 0.5, ax[0]], [1.3, 0.08, 0.08], DARK)
  m.box([0, 0.48, ax[1]], [1.3, 0.1, 0.1], DARK)
  m.lathe('z', [0, 0.48, ax[1] + 0.9], [[0.001, -0.9], [0.12, -0.7], [0.08, 0.2], [0.05, 0.9], [0.001, 0.9]], DARK, 12)
  // Radiator, bonnet, scuttle.
  const zR = ax[0] + 0.06
  m.rounded([0, 1.0, zR], [0.56, 0.66, 0.14], shell, 7)
  m.box([0, 1.0, zR + 0.06], [0.44, 0.52, 0.04], paint('#16171a'))
  m.rounded([0, 1.37, zR], [0.12, 0.08, 0.1], nickel, 3)
  const hoodL = 0.86
  m.rounded([0, 1.0, zR - 0.07 - hoodL / 2], [0.58, 0.54, hoodL], BODY, 6, 16, 8)
  for (const s of [-1, 1]) for (let i = 0; i < 6; i++) m.box([s * 0.29, 0.9, zR - 0.25 - i * 0.1], [0.012, 0.18, 0.025], PLASTIC)
  const zCowl = zR - 0.07 - hoodL
  m.rounded([0, 1.02, zCowl - 0.12], [1.0, 0.62, 0.3], BODY, 5)
  // Tub: front and rear seats in one body, open sides above the doors.
  const tubF = zCowl - 0.2, tubB = ax[1] - 0.3, tubW = 1.26
  m.rounded([0, 0.92, (tubF + tubB) / 2], [tubW, 0.6, tubF - tubB], BODY, 7, 20, 10)
  m.rounded([0, 1.15, (tubF + tubB) / 2 + 0.05], [tubW - 0.12, 0.16, tubF - tubB - 0.2], DARK, 8) // inside
  for (const zs of [tubF - 0.55, tubB + 0.4]) {
    m.rounded([0, 1.18, zs], [tubW - 0.18, 0.18, 0.5], leather, 4)
    m.rounded([0, 1.42, zs - 0.26], [tubW - 0.2, 0.5, 0.14], leather, 4)
  }
  m.rounded([0, 1.12, tubB - 0.02], [tubW, 0.66, 0.2], BODY, 6) // rounded rear
  // Upright windscreen in a brass or black frame; steering wheel.
  const zW = zCowl - 0.2
  m.box([0, 1.55, zW], [1.0, 0.55, 0.012], GLASS)
  for (const s of [-1, 1]) m.box([s * 0.51, 1.5, zW], [0.03, 0.7, 0.03], brass ? shell : PLASTIC)
  m.box([0, 1.83, zW], [1.05, 0.03, 0.03], brass ? shell : PLASTIC)
  m.lathe('y', [-0.3, 1.42, zW - 0.32], [[0.2, -0.015], [0.2, 0.015], [0.17, 0.015], [0.17, -0.015]], DARK, 18)
  m.beam([-0.3, 1.42, zW - 0.32], [-0.3, 0.95, zW + 0.05], 0.035, DARK)
  // Folding top: fabric canopy on bows from the screen to behind the rear seat.
  const topF = zW - 0.05, topB = tubB - 0.1, topY = ref.height
  const rows: Vec3[][] = []
  for (let i = 0; i <= 12; i++) {
    const t = i / 12, z = topF + (topB - topF) * t
    const sag = 0.02 * Math.sin(t * Math.PI * 6) ** 2
    const y = topY - sag - 0.12 * Math.max(0, t - 0.75) / 0.25 * (t > 0.75 ? 1 : 0)
    const w = 0.62
    const ring: Vec3[] = []
    for (let j = 0; j < 20; j++) {
      const a = (j / 20) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a)
      ring.push([w * Math.sign(c) * Math.abs(c) ** 0.4, y - 0.11 + 0.11 * Math.sign(s) * Math.abs(s) ** 0.4, z])
    }
    rows.push(ring)
  }
  m.surface(rows, () => fabric, true, [fabric, fabric])
  for (const s of [-1, 1]) {
    m.beam([s * 0.6, topY - 0.15, topB + 0.2], [s * 0.6, 1.2, tubB + 0.1], 0.03, PLASTIC)
    m.beam([s * 0.6, topY - 0.12, topF - 0.6], [s * 0.6, 1.2, tubB + 0.25], 0.025, PLASTIC)
  }
  // Wings and running boards: thin curved sheets over the wheels joined by flat boards.
  for (const s of [-1, 1]) {
    const x = s * (W / 2 - 0.165)
    fender(m, x, ax[0], r, 0.155, -0.95, 0.3)
    fender(m, x, ax[1], r, 0.155, -0.45, 0.4)
    m.box([x, 0.46, (ax[0] + ax[1]) / 2 + 0.05], [0.26, 0.03, ax[0] - ax[1] - 1.05], PLASTIC)
    m.box([x * 0.9, 0.5, (ax[0] + ax[1]) / 2 + 0.05], [0.04, 0.1, ax[0] - ax[1] - 1.05], DARK)
    // Bucket headlamps on stalks either side of the radiator; side lamps at the scuttle.
    const hx = s * 0.42
    m.beam([hx, 0.55, zR + 0.04], [hx, 1.08, zR + 0.04], 0.035, DARK)
    m.lathe('z', [hx, 1.14, zR + 0.06], [[0.001, -0.12], [0.1, -0.1], [0.12, 0.04], [0.12, 0.08], [0.001, 0.08]], (k) => (k >= 3 ? HEAD : shell === BODY ? nickel : shell), 18)
    m.lathe('z', [s * 0.53, 1.18, zCowl - 0.1], [[0.001, -0.08], [0.06, -0.06], [0.065, 0.05], [0.001, 0.05]], (k) => (k >= 2 ? HEAD : nickel), 12)
  }
  m.rounded([0.35, 0.95, tubB - 0.1], [0.08, 0.1, 0.06], TAIL, 3)
  const wood = pick(rand, [paint('#8a6238'), paint('#a77b4c'), paint('#2a1a12')])
  const look: WheelLook = { rim: 'artillery', spokes: 12, ratio: 0.8, color: wood, hub: paint('#16171a') }
  const parts = [wheels(r, 0.09, look, W / 2 - 0.2, ax, [W / 2 - 0.24, W / 2 - 0.2])]
  return { parts, vents: [{ position: [-0.32, 0.42, -L / 2 + 0.25], direction: [0, -0.1, -1], kind: 'tailpipe', radius: 0.03 }], wheelBase: ref.wheelBase }
}

/** A thin vintage wing over a wheel, flowing down to the running board at `back`. */
function fender(m: MeshBuilder, x: number, zc: number, r: number, hw: number, back: number, front: number): void {
  const R = r + 0.09
  const rows: Vec3[][] = []
  const n = 22
  for (let i = 0; i <= n; i++) {
    const t = i / n, a = Math.PI * (0.05 + 0.95 * t) // around the wheel from the front to the top and back
    let y = r + Math.sin(a) * R, z = zc + Math.cos(a) * R * (front / 0.42)
    if (Math.cos(a) < 0) {
      // Behind the wheel the wing flattens into the running board.
      const k = -Math.cos(a)
      z = zc - k * Math.abs(back)
      y = r + Math.sin(a) * R * (1 - k * 0.35) + (0.46 - r) * k * k
    }
    const ring: Vec3[] = []
    for (let j = 0; j < 12; j++) {
      const b = (j / 12) * Math.PI * 2
      ring.push([x + Math.cos(b) * hw, y + Math.sin(b) * 0.012 - 0.05 * Math.cos(b) ** 2, z])
    }
    rows.push(ring)
  }
  m.surface(rows, (i, j) => (Math.sin(((j + 0.5) / 12) * Math.PI * 2) < 0 ? DARK : BODY), true, [BODY, BODY])
}
