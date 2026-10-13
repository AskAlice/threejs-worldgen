// Farm tractors: big lugged rear tyres and smaller front ones, a cab or an open roll-over frame, an
// exhaust stack ahead of the cab, seeded colour families with matching rims (no liveries), and optional
// implements: a mounted plough or seeder, or a towed tipping trailer that articulates like a truck
// trailer. Plus wheel footprints as plain data for grass and crop interaction, and field-row routes.
import { Object3D } from 'three/webgpu'
import { FINISH, MeshBuilder, paint, type MeshData, type Paint, type Vec3 } from './mesh.ts'
import { BODY, BRUSHED, DARK, GLASS, HEAD, PLASTIC, TAIL, TRIM, TYRE, body, model, num, pick, str, wheelInto, type Rand } from './kit.ts'
import { faceY, loftBody, onEnd } from './body.ts'
import type { ExhaustVent, ModelPart, PartMount, VehicleModel, VehicleParams } from './models.ts'
import type { FleetSim, RouteSpec } from './sim.ts'
import type { Fleet } from './fleet.ts'

/** Colour families: body paints and the rim colour that goes with them. */
export const TRACTOR_FAMILIES: Record<string, { body: string[]; rim: string }> = {
  green: { body: ['#2f6b2a', '#367c2b', '#2a5f25'], rim: '#e8c21c' },
  red: { body: ['#b3261e', '#a11d17', '#c0301f'], rim: '#9aa0a6' },
  blue: { body: ['#1f4f9a', '#2a5db0', '#1c4688'], rim: '#c9ccd0' },
  orange: { body: ['#e36c0a', '#d9601a', '#ef7d1a'], rim: '#2b2c30' },
}

/** Tractor implements. */
export const TRACTOR_IMPLEMENTS = ['none', 'plough', 'seeder', 'trailer'] as const

/** Sizes of the default (mid-size, about 150 hp) tractor, metres. */
export const TRACTOR_SIZE = { rearRadius: 0.98, frontRadius: 0.775, rearWidth: 0.71, frontWidth: 0.6, wheelBase: 2.8, track: 1.95 }

/** An agricultural tyre along x: a lathed carcass with chevron lugs across the tread, and a dished rim. */
function lugWheel(r: number, w: number, rim: Paint, lugs: number): MeshData {
  const m = new MeshBuilder()
  wheelInto(m, r - 0.04, w, { rim: 'dish', spokes: 8, ratio: 0.5, color: rim, hub: rim })
  const h = w / 2
  for (let k = 0; k < lugs; k++) {
    const a = (k / lugs) * Math.PI * 2
    for (const side of [-1, 1]) {
      // A lug runs from the centre line out to the shoulder, swept back in a chevron.
      const a1 = a + 0.16
      const p0: Vec3 = [side * 0.04, Math.cos(a) * (r - 0.02), Math.sin(a) * (r - 0.02)]
      const p1: Vec3 = [side * h * 0.96, Math.cos(a1) * (r - 0.03), Math.sin(a1) * (r - 0.03)]
      m.beam(p0, p1, 0.07, TYRE)
    }
  }
  return m.build()
}

/** A curved mudguard over a wheel at (x, zc), radius R around the axle at height yc, from angle a0 to a1 (0 = front). */
function mudguard(m: MeshBuilder, x: number, zc: number, yc: number, R: number, width: number, a0: number, a1: number, s: Paint): void {
  const rows: Vec3[][] = []
  const n = 18
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n
    const ring: Vec3[] = []
    for (let j = 0; j < 12; j++) {
      const b = (j / 12) * Math.PI * 2
      const rr = R + Math.sin(b) * 0.015, dx = Math.cos(b) * width / 2
      ring.push([x + dx, yc + Math.sin(a) * (rr - 0.04 * Math.cos(b) ** 2), zc + Math.cos(a) * (rr - 0.04 * Math.cos(b) ** 2)])
    }
    rows.push(ring)
  }
  m.surface(rows, () => s, true, [s, s])
}

/** One tractor, or (with `piece: 'trailer'`) the farm trailer it tows. */
export function tractor(p: VehicleParams, rand: Rand): VehicleModel {
  if (str(p, 'piece') === 'trailer') return farmTrailer(p, rand)
  const k = num(p, 'size')
  const S = TRACTOR_SIZE
  let family = str(p, 'family')
  if (!(family in TRACTOR_FAMILIES)) family = pick(rand, Object.keys(TRACTOR_FAMILIES))
  const fam = TRACTOR_FAMILIES[family]
  const rimPaint = paint(fam.rim)
  const rops = str(p, 'cab') === 'rops'
  const implement = str(p, 'implement')
  const m = new MeshBuilder()
  const rR = S.rearRadius, rF = S.frontRadius
  const zr = -1.2, zf = zr + S.wheelBase
  const W = 2.55
  // Engine and bonnet: a narrow loft from the cab to the grille, over the front axle.
  const hoodL = 2.5, hoodC = zf + 1.0 - hoodL / 2
  m.group([0, 0, hoodC], [0, 0, 0], () => {
    const b = loftBody(m, {
      L: hoodL, W: 0.98, H: 2.0, r: rF, axles: [],
      belt: [[0, 2.0], [0.4, 1.98], [0.85, 1.88], [1, 1.78]],
      bottom: [[0, 1.0], [0.6, 1.02], [1, 1.05]],
      plan: [[0, 1], [0.8, 0.97], [1, 0.9]],
      split: 0.5, eTop: 3.4, eBot: 6, tuck: [0.12, 0.04], fillet: [0.02, 0.1],
    })
    onEnd(m, b, 0, faceY(b, 1, 0.48), 1, [0.78, 0.62, 0.08], PLASTIC, 0.55, 8)
    for (let i = 0; i < 6; i++) onEnd(m, b, 0, faceY(b, 1, 0.24 + i * 0.09), 1, [0.72, 0.02, 0.1], TRIM, 0.45, 6)
    for (const s of [-1, 1]) onEnd(m, b, s * 0.3, faceY(b, 1, 0.85), 1, [0.22, 0.09, 0.08], HEAD, 0.5, 6)
    // Side louvres.
    for (const s of [-1, 1]) for (let i = 0; i < 5; i++) m.box([s * 0.49, 1.6, hoodL / 2 - 0.45 - i * 0.09], [0.01, 0.28, 0.035], PLASTIC)
  })
  // Chassis, front axle with weights, belly.
  m.box([0, 0.95, (zr + zf) / 2 + 0.4], [0.75, 0.55, S.wheelBase + 0.2], DARK)
  m.box([0, rF, zf], [S.track - 0.3, 0.16, 0.2], DARK)
  for (let i = 0; i < 8; i++) m.rounded([0, 0.95 + (i % 2) * 0.02, zf + 1.05 + i * 0.07], [0.9, 0.42, 0.065], paint('#3b3d40'), 8, 12, 4)
  // Front mudguards on short arms over the front wheels.
  for (const s of [-1, 1]) mudguard(m, s * S.track / 2, zf, rF, rF + 0.1, S.frontWidth + 0.08, 0.35, 1.9, BODY)
  // Rear mudguards: big arcs over the rear wheels, joined to the cab platform.
  for (const s of [-1, 1]) mudguard(m, s * S.track / 2, zr, rR, rR + 0.12, S.rearWidth + 0.12, 0.3, 2.6, BODY)
  const deck = 1.45
  m.box([0, deck - 0.05, zr + 0.2], [S.track - S.rearWidth - 0.1, 0.1, 1.8], DARK)
  // Cab: four posts, a crowned roof, glass all round; or an open frame over a seat.
  const c0 = zr - 0.55, c1 = zr + 1.25, roof = 3.0
  if (!rops) {
    for (const x of [-0.72, 0.72]) for (const z of [c0, c1]) m.beam([x, deck, z], [x * 0.98, roof - 0.08, z], 0.07, DARK)
    for (const x of [-0.71, 0.71]) m.box([x, (deck + roof) / 2, (c0 + c1) / 2], [0.015, roof - deck - 0.2, c1 - c0 - 0.06], GLASS)
    m.box([0, (deck + 0.3 + roof) / 2, c1], [1.38, roof - deck - 0.4, 0.015], GLASS)
    m.box([0, (deck + 0.5 + roof) / 2, c0], [1.38, roof - deck - 0.6, 0.015], GLASS)
    m.rounded([0, roof + 0.04, (c0 + c1) / 2], [1.62, 0.16, c1 - c0 + 0.3], rand() < 0.4 ? paint('#e9ecee') : BODY, 4, 18, 6)
    for (const s of [-1, 1]) for (const z of [c0 - 0.12, c1 + 0.12]) m.rounded([s * 0.5, roof, z], [0.18, 0.08, 0.06], HEAD, 4)
    m.rounded([0, roof + 0.13, (c0 + c1) / 2], [0.12, 0.08, 0.12], paint('#ffb43a', 0, 0.8, FINISH.glass), 3)
    for (const s of [-1, 1]) {
      m.beam([s * 0.75, roof - 0.35, c1 - 0.05], [s * 1.05, roof - 0.4, c1 + 0.2], 0.03, TRIM)
      m.rounded([s * 1.08, roof - 0.45, c1 + 0.22], [0.05, 0.3, 0.2], TRIM, 4)
    }
  } else {
    m.beam([-0.7, deck, c0], [-0.7, roof - 0.2, c0], 0.09, DARK)
    m.beam([0.7, deck, c0], [0.7, roof - 0.2, c0], 0.09, DARK)
    m.beam([-0.7, roof - 0.2, c0], [0.7, roof - 0.2, c0], 0.09, DARK)
    m.rounded([0, deck + 0.5, zr + 0.1], [0.55, 0.22, 0.5], PLASTIC, 4)
    m.rounded([0, deck + 0.85, zr - 0.15], [0.52, 0.55, 0.14], PLASTIC, 4)
  }
  // Steering wheel and dash.
  m.box([0, deck + 0.6, c1 - 0.2], [0.6, 0.5, 0.25], PLASTIC)
  m.lathe('z', [0, deck + 1.0, c1 - 0.42], [[0.19, -0.015], [0.19, 0.015], [0.16, 0.015], [0.16, -0.015]], DARK, 18)
  // Exhaust stack at the front right corner of the cab, with a muffler.
  const sx = 0.42, sz = c1 + 0.12
  m.lathe('y', [sx, (1.9 + roof + 0.25) / 2, sz], [[0.05, -(roof + 0.25 - 1.9) / 2], [0.05, (roof + 0.25 - 1.9) / 2], [0.045, (roof + 0.25 - 1.9) / 2 + 0.01]], DARK, 12)
  m.lathe('y', [sx, 2.25, sz], [[0.04, -0.3], [0.1, -0.24], [0.1, 0.24], [0.04, 0.3]], BRUSHED, 16)
  const vents: ExhaustVent[] = [{ position: [sx, roof + 0.26, sz], direction: [0, 1, 0], kind: 'stack', radius: 0.05 }]
  // Fuel tank and steps; three-point linkage and drawbar at the rear.
  m.lathe('z', [-0.55, 0.85, zr + 1.45], [[0.001, -0.35], [0.24, -0.33], [0.26, -0.25], [0.26, 0.25], [0.24, 0.33], [0.001, 0.35]], BODY, 20)
  for (let i = 0; i < 3; i++) m.box([0.85, 0.6 + i * 0.3, zr + 1.0], [0.3, 0.04, 0.22], DARK)
  for (const s of [-1, 1]) m.beam([s * 0.3, 0.7, zr - 0.5], [s * 0.42, 0.55, zr - 1.3], 0.07, DARK)
  m.beam([0, 1.25, zr - 0.6], [0, 1.0, zr - 1.25], 0.06, DARK)
  m.box([0, 0.55, zr - 0.95], [0.12, 0.08, 0.8], DARK)
  for (const s of [-1, 1]) m.rounded([s * 0.35, 1.25, zr - 0.62], [0.12, 0.08, 0.04], TAIL, 4)
  // Mounted implements ride on the linkage, part of the tractor.
  if (implement === 'plough') plough(m, zr - 1.3, rand)
  else if (implement === 'seeder') seeder(m, zr - 1.3, rimPaint)
  const parts: ModelPart[] = [body(scaleMesh(m.build(), k))]
  const wheelPart = (name: string, r: number, w: number, z: number, steer: boolean): ModelPart => ({
    name, mesh: scaleMesh(lugWheel(r, w, rimPaint, Math.round(26 * r)), k),
    mounts: [-1, 1].map((s): PartMount => ({
      position: [s * S.track / 2 * k, r * k, z * k], rotation: s < 0 ? [0, Math.PI, 0] : undefined,
      spin: { axis: 0, rate: s / (r * k), by: 'distance' }, steer: steer ? 1 : undefined,
    })),
  })
  parts.push(wheelPart('wheel', rR, S.rearWidth, zr, false), wheelPart('frontWheel', rF, S.frontWidth, zf, true))
  return model('tractor', `${family}-${rops ? 'rops' : 'cab'}${implement !== 'none' ? `-${implement}` : ''}`, 'land', parts, {
    wheelBase: S.wheelBase * k, vents: vents.map((v) => ({ ...v, position: v.position.map((c) => c * k) as Vec3 })), bank: -0.02,
    palette: fam.body, hitch: implement === 'trailer' ? { coupling: (zr - 1.3) * k } : undefined,
  })
}

function scaleMesh(d: MeshData, k: number): MeshData {
  return k === 1 ? d : { ...d, position: d.position.map((v) => v * k), bounds: d.bounds.map((v) => v * k) as MeshData['bounds'] }
}

/** A three-furrow mouldboard plough behind the linkage at z. */
function plough(m: MeshBuilder, z: number, rand: Rand): void {
  const steel = paint(pick(rand, ['#b3261e', '#1f4f9a', '#3b3d40']))
  m.beam([-0.2, 0.75, z], [0.9, 0.7, z - 2.6], 0.14, steel)
  m.box([0, 0.9, z + 0.1], [0.9, 0.5, 0.15], steel)
  for (let i = 0; i < 3; i++) {
    const t = (i + 0.5) / 3, x = -0.2 + 1.1 * t, zz = z - 2.6 * t
    m.beam([x, 0.72, zz], [x - 0.05, 0.25, zz - 0.15], 0.08, steel)
    m.fin([[0, 0], [0.55, 0.05], [0.5, 0.42], [0.05, 0.38]], [x - 0.3, 0.05, zz - 0.25], [0.8, 0, -0.6], [0, 1, 0], 0.03, BRUSHED)
  }
}

/** A seed drill: a wide bar with a hopper and disc coulters, behind the linkage at z. */
function seeder(m: MeshBuilder, z: number, s: Paint): void {
  m.box([0, 0.6, z - 0.2], [3.0, 0.12, 0.14], DARK)
  m.rounded([0, 1.15, z - 0.55], [2.8, 0.8, 0.9], s, 6)
  m.box([0, 1.58, z - 0.55], [2.75, 0.04, 0.85], PLASTIC)
  for (let i = 0; i < 16; i++) {
    const x = -1.35 + (i * 2.7) / 15
    m.beam([x, 0.6, z - 0.2], [x, 0.25, z - 0.6], 0.04, DARK)
    m.cylinder('x', [x, 0.2, z - 0.62], 0.2, 0.02, BRUSHED, 12)
  }
}

/** A single-axle tipping farm trailer on a drawbar (kingpin = the drawbar eye). */
function farmTrailer(p: VehicleParams, rand: Rand): VehicleModel {
  const m = new MeshBuilder()
  const L = 5.2, r = 0.58, axle = -0.4
  const tub = pick(rand, [paint('#2f6b2a'), paint('#b3261e'), paint('#3b5e8c'), paint('#6d6f73')])
  m.box([0, 1.25, 0], [2.2, 0.12, L], DARK)
  for (const s of [-1, 1]) m.box([s * 1.1, 1.75, 0], [0.06, 0.9, L], tub)
  m.box([0, 1.75, L / 2], [2.25, 0.9, 0.06], tub)
  m.box([0, 1.75, -L / 2], [2.25, 0.9, 0.06], tub)
  m.box([0, 1.32, 0], [2.14, 0.04, L - 0.1], paint('#5a4632'))
  // Drawbar to the eye, ahead of the body.
  m.beam([-0.5, 1.15, L / 2], [0, 0.65, L / 2 + 1.6], 0.1, DARK)
  m.beam([0.5, 1.15, L / 2], [0, 0.65, L / 2 + 1.6], 0.1, DARK)
  m.box([0, 0.9, L / 2 - 0.3], [0.1, 0.6, 0.1], DARK) // jack leg
  for (const s of [-1, 1]) m.rounded([s * 0.95, 1.1, -L / 2 - 0.02], [0.16, 0.08, 0.04], TAIL, 4)
  const load = str(p, 'load')
  if (load === 'hay' || load === 'mixed') for (let i = 0; i < 3; i++) m.rounded([0, 1.65, -L / 2 + 0.9 + i * 1.7], [1.9, 0.62, 1.4], paint('#c9a85a'), 6)
  else if (load === 'gravel') m.rounded([0, 1.4, 0], [2.0, 0.7, L * 0.85], paint('#8d8a84'), 2.2, 18, 8)
  const wheel = (s: number): PartMount => ({ position: [s * 1.25, r, axle], rotation: s < 0 ? [0, Math.PI, 0] : undefined, spin: { axis: 0, rate: s / r, by: 'distance' } })
  const wm = new MeshBuilder()
  wheelInto(wm, r, 0.42, { rim: 'steel', spokes: 6, ratio: 0.55, color: paint('#c9ccd0') })
  return model('tractor', 'trailer', 'land', [body(m.build()), { name: 'wheel', mesh: wm.build(), mounts: [wheel(-1), wheel(1)] }], {
    wheelBase: L / 2 + 1.6 - axle, palette: ['#ffffff'], hitch: { kingpin: L / 2 + 1.6, axle },
  })
}

// ---------------------------------------------------------------- footprints and field routes

/**
 * Where a vehicle's tyres touch the ground: one entry per wheel, fleet-local position at ground
 * level, an influence `radius` (half the tyre's width plus a margin) and a `strength` (heavier
 * vehicles press harder; 1 for a tractor's rear wheels). Plain data, ready for grass or crop
 * interaction (threejs-grass bends blades within `radius` of an interactor's position).
 */
export interface WheelFootprint {
  /** Contact point, fleet-local metres (y on the ground). */
  position: [x: number, y: number, z: number]
  /** Influence radius, metres. */
  radius: number
  /** How hard it presses, 0…1. */
  strength: number
}

/** Wheel parts the footprints come from. */
const WHEEL_PARTS = new Set(['wheel', 'frontWheel', 'dual'])

/**
 * The wheel footprints of vehicle `v` of a fleet simulation this frame (see {@link WheelFootprint}),
 * written into `out` (grown as needed) and returned.
 */
export function wheelFootprints(sim: FleetSim, v: number, out: WheelFootprint[] = []): WheelFootprint[] {
  const model = sim.models[sim.model[v]]
  const p = sim.pose, o = v * 8
  const yaw = p[o + 3], c = Math.cos(yaw), s = Math.sin(yaw)
  const heavy = model.type === 'tractor' || model.type === 'truck' ? 1 : 0.6
  let n = 0
  let maxR = 0
  for (const part of model.parts) if (WHEEL_PARTS.has(part.name)) maxR = Math.max(maxR, part.mesh.bounds[4])
  for (const part of model.parts) {
    if (!WHEEL_PARTS.has(part.name)) continue
    const b = part.mesh.bounds, width = b[3] - b[0], r = b[4]
    for (const mt of part.mounts) {
      const [x, , z] = mt.position
      const f = (out[n] ??= { position: [0, 0, 0], radius: 0, strength: 0 })
      f.position[0] = p[o] + c * x + s * z
      f.position[1] = p[o + 1]
      f.position[2] = p[o + 2] - s * x + c * z
      f.radius = (width / 2) * 1.15
      f.strength = heavy * Math.min(1, r / Math.max(1e-6, maxR))
      n++
    }
  }
  out.length = n
  return out
}

/** An interactor in the shape threejs-grass expects (`object` whose world position is read every frame, `radius`), plus a `strength`. */
export interface FootprintInteractor {
  object: Object3D
  radius: number
  strength: number
}

/**
 * Grass interactors that follow the wheels of a fleet's vehicles: one `Object3D` per tyre, parented to
 * the fleet so world positions are right wherever the fleet is. Pass `interactors` to
 * threejs-grass (`grass.set({ interactors })`) and call `update()` after `fleet.update()`.
 *
 * @example
 * ```ts
 * const prints = new WheelInteractors(fleet, { types: ['tractor'] })
 * grass.set({ interactors: prints.interactors })
 * // every frame
 * fleet.update(dt); prints.update()
 * ```
 */
export class WheelInteractors {
  /** The interactors (up to `max`). */
  readonly interactors: FootprintInteractor[] = []
  private readonly fleet: Fleet
  private readonly types: Set<string>
  private readonly max: number
  private prints: WheelFootprint[] = []

  constructor(fleet: Fleet, { types = ['tractor'], max = 16 }: { types?: string[]; max?: number } = {}) {
    this.fleet = fleet
    this.types = new Set(types)
    this.max = max
    this.update()
  }

  /** Moves the interactors onto this frame's wheel footprints. */
  update(): this {
    const sim = this.fleet.sim
    let n = 0
    for (let v = 0; v < sim.count && n < this.max; v++) {
      if (!this.types.has(sim.models[sim.model[v]].type)) continue
      wheelFootprints(sim, v, this.prints)
      for (const f of this.prints) {
        if (n >= this.max) break
        let it = this.interactors[n]
        if (!it) {
          it = this.interactors[n] = { object: new Object3D(), radius: 0, strength: 0 }
          it.object.name = 'wheel-footprint'
          this.fleet.object.add(it.object)
        }
        it.object.position.set(f.position[0], f.position[1], f.position[2])
        it.radius = f.radius
        it.strength = f.strength
        n++
      }
    }
    for (const it of this.interactors.splice(n)) it.object.removeFromParent()
    return this
  }

  /** Removes the interactor objects. */
  dispose(): void {
    for (const it of this.interactors.splice(0)) it.object.removeFromParent()
  }
}

/**
 * A closed route working a field in rows (boustrophedon): `rows` passes `spacing` metres apart and
 * `length` long, turned round at the headlands, then back along the headland to the start. Centred at
 * `center` (x, y, z), rows along `heading` (radians, 0 = +z).
 */
export function fieldRoute(center: [number, number, number], rows: number, spacing: number, length: number, heading = 0): RouteSpec {
  const pts: [number, number, number][] = []
  const n = Math.max(2, Math.round(rows))
  const width = (n - 1) * spacing
  const turn = Math.max(spacing / 2, 4)
  const local: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const x = -width / 2 + i * spacing, dir = i % 2 ? -1 : 1
    local.push([x, -dir * length / 2], [x, dir * length / 2])
    if (i < n - 1) for (let k = 1; k < 6; k++) {
      const a = (k / 6) * Math.PI
      local.push([x + spacing / 2 - Math.cos(a) * spacing / 2, dir * (length / 2 + Math.sin(a) * turn)])
    }
  }
  // Back along the outside headland to the first row.
  const last = local[local.length - 1]
  const back = (n % 2 ? 1 : -1) * (length / 2 + turn * 2)
  local.push([last[0] + turn, last[1] + Math.sign(back) * turn], [width / 2 + turn, back], [-width / 2 - turn, back], [-width / 2 - turn, -back * 0.98])
  const c = Math.cos(heading), s = Math.sin(heading)
  for (const [x, z] of local) pts.push([center[0] + c * x + s * z, center[1], center[2] - s * x + c * z])
  return { kind: 'path', points: pts, closed: true, smooth: 4 }
}
