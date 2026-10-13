import { test } from 'node:test'
import assert from 'node:assert/strict'
import { World } from 'threejs-biomes'
import { isPlausible } from '../../worldgen/src/assets.ts'
import { MeshBuilder, paint, type MeshData } from '../src/mesh.ts'
import { buildVehicle, VEHICLE_TYPES, VEHICLE_KINDS, type VehicleModel, type VehicleType } from '../src/models.ts'
import { CAR_REFERENCES, LOOKALIKE_STYLES, type CarDimensions } from '../src/cars.ts'
import { FULL_SIZE_DIMENSIONS, pickupReference } from '../src/pickups.ts'
import { TRAFFIC_POOLS, trafficGroups } from '../src/traffic.ts'
import { TRAILER_KINDS, TRUCK_LIMITS } from '../src/trucks.ts'
import { TRACTOR_IMPLEMENTS, fieldRoute, wheelFootprints } from '../src/tractor.ts'
import { DEFAULT_EXHAUST, VehicleExhaust, condensation, createExhaustBuffers, createExhaustState, exhaustSources, type ExhaustSettings } from '../src/exhaust.ts'
import { Fleet } from '../src/fleet.ts'
import { MOTION_STRIDE, SOURCE_STRIDE, spawnRate } from 'threejs-particles'
import { Path, RoadNavigator, circlePoints, type RoadNetwork } from '../src/paths.ts'
import { DEFAULT_FLEET, FleetSim, groupVehicleCount, rocketAt, type FleetGroup, type FleetSettings } from '../src/sim.ts'
import { planRoute, vehicleAssets, VEHICLE_PLACEMENT } from '../src/placement.ts'

const settings = (groups: FleetGroup[], extra: Partial<FleetSettings> = {}): FleetSettings => ({ ...structuredClone(DEFAULT_FLEET), groups, ...extra })

function checkMesh(m: MeshData, label: string) {
  const nv = m.position.length / 3
  assert.ok(nv > 0, `${label}: empty`)
  for (const v of m.position) assert.ok(Number.isFinite(v), `${label}: non-finite position`)
  for (let i = 0; i < nv; i++) assert.ok(Math.abs(Math.hypot(m.normal[i * 3], m.normal[i * 3 + 1], m.normal[i * 3 + 2]) - 1) < 1e-4, `${label}: normal not unit`)
  for (const i of m.index) assert.ok(i < nv, `${label}: index out of range`)
  assert.equal(m.color.length, nv * 3)
  assert.equal(m.style.length, nv * 3)
}

// Expected size ranges (x width, y height, z length) in metres, loose enough for seeded variety.
const SIZES: Record<VehicleType, [number, number][]> = {
  car: [[1.5, 2.8], [1.2, 3.4], [3.4, 12.5]],
  bicycle: [[0.3, 0.7], [1.0, 2.0], [1.4, 2.0]],
  train: [[2.8, 3.4], [3.8, 5], [16, 22]],
  pickup: [[1.7, 2.6], [1.4, 2.4], [4.8, 6.6]],
  truck: [[2.4, 3.4], [3, TRUCK_LIMITS.height], [5.5, 10]],
  tractor: [[2.3, 3.6], [2.6, 3.6], [4.2, 7.5]],
  'fishing-boat': [[3, 14], [5, 14], [10, 16]],
  'cruise-liner': [[20, 32], [35, 60], [180, 220]],
  speedboat: [[2, 3], [1.5, 3], [6.5, 8.5]],
  hovercraft: [[7, 11], [4, 7], [18, 22]],
  'aircraft-carrier': [[50, 80], [40, 70], [280, 320]],
  airplane: [[30, 40], [7, 12], [34, 42]],
  'fighter-jet': [[7, 12], [3, 6], [14, 19]],
  rocket: [[3, 30], [55, 75], [3, 30]],
}

test('every vehicle: valid geometry with sane bounds', () => {
  for (const type of VEHICLE_TYPES) for (const seed of [1, 2, 3]) {
    const m = buildVehicle(type, {}, seed)
    for (const part of m.parts) checkMesh(part.mesh, `${type}/${part.name}`)
    SIZES[type].forEach(([lo, hi], k) => assert.ok(m.size[k] >= lo && m.size[k] <= hi, `${type} seed ${seed}: size[${k}] = ${m.size[k].toFixed(2)} not in ${lo}…${hi}`))
    assert.ok(m.palette.every((c) => /^#[0-9a-f]{6}$/i.test(c)))
  }
  // Every style of car and train car.
  for (const style of ['sedan', 'hatchback', 'suv', 'truck', 'van', 'bus']) assert.equal(buildVehicle('car', { style }).style, style)
  for (const freight of ['boxcar', 'tank', 'hopper', 'container']) assert.equal(buildVehicle('train', { car: 'freight', freight }).style, freight)
  assert.equal(buildVehicle('train', { car: 'passenger' }).style, 'passenger')
  assert.equal(buildVehicle('airplane', { style: 'light' }).parts[1].name, 'propeller')
  assert.equal(buildVehicle('rocket', { stages: 3 }).stages, 3)
})

test('builder primitives face outwards', () => {
  const b = new MeshBuilder()
  const p = paint('#808080')
  b.box([0, 0, 0], [2, 1, 3], p, [0.7, 0.8], 0.2)
  b.cylinder('x', [0, 0, 0], 1, 2, p, 9, 0.5)
  b.cylinder('y', [0, 0, 0], 1, 2, p, 7)
  b.ellipsoid([0, 0, 0], [1, 2, 3], p, 8, 5)
  b.loft([{ z: -2, w: 1, top: 1, bottom: -1, round: 0.3, keel: 0.5 }, { z: 2, w: 0.6, top: 1.2, bottom: -0.5, round: 0.8 }], p, 10)
  const m = b.build()
  for (let i = 0; i < m.index.length; i += 3) {
    const [a, c, d] = [m.index[i], m.index[i + 1], m.index[i + 2]]
    const cx = (m.position[a * 3] + m.position[c * 3] + m.position[d * 3]) / 3
    const cy = (m.position[a * 3 + 1] + m.position[c * 3 + 1] + m.position[d * 3 + 1]) / 3
    const cz = (m.position[a * 3 + 2] + m.position[c * 3 + 2] + m.position[d * 3 + 2]) / 3
    // Every primitive is centred on the origin and convex, so outward means away from it (loft: from its axis).
    const dot = m.normal[a * 3] * cx + m.normal[a * 3 + 1] * cy + m.normal[a * 3 + 2] * cz
    assert.ok(dot > -1e-6, `face ${i / 3} points inwards`)
    // Winding agrees with the normal (front faces are counter-clockwise).
    const ux = m.position[c * 3] - m.position[a * 3], uy = m.position[c * 3 + 1] - m.position[a * 3 + 1], uz = m.position[c * 3 + 2] - m.position[a * 3 + 2]
    const vx = m.position[d * 3] - m.position[a * 3], vy = m.position[d * 3 + 1] - m.position[a * 3 + 1], vz = m.position[d * 3 + 2] - m.position[a * 3 + 2]
    const w = (uy * vz - uz * vy) * m.normal[a * 3] + (uz * vx - ux * vz) * m.normal[a * 3 + 1] + (ux * vy - uy * vx) * m.normal[a * 3 + 2]
    assert.ok(w >= -1e-9, `face ${i / 3} wound against its normal`)
  }
})

test('deterministic: same seed same meshes and motion, other seed differs', () => {
  for (const type of ['car', 'fishing-boat', 'fighter-jet'] as VehicleType[]) {
    assert.deepEqual(buildVehicle(type, {}, 5).parts[0].mesh.position, buildVehicle(type, {}, 5).parts[0].mesh.position)
    assert.notDeepEqual(buildVehicle(type, {}, 5).parts[0].mesh.position, buildVehicle(type, {}, 6).parts[0].mesh.position)
  }
  const groups: FleetGroup[] = [{ type: 'car', count: 12, route: { kind: 'circle', center: [0, 0, 0], radius: 50 } }]
  const run = (seed: number) => {
    const sim = new FleetSim(settings(groups, { seed }))
    for (let i = 0; i < 30; i++) sim.step(1 / 30)
    return [...sim.pose]
  }
  assert.deepEqual(run(3), run(3))
  assert.notDeepEqual(run(3), run(4))
})

test('paths: arc length, positions on the curve, ping-pong', () => {
  const circle = new Path(circlePoints([10, 2, -5], 40, 128), true, 1)
  assert.ok(Math.abs(circle.length - 2 * Math.PI * 40) / (2 * Math.PI * 40) < 0.002)
  for (let s = 0; s < 600; s += 37) {
    const p = circle.sample(s)
    assert.ok(Math.abs(Math.hypot(p.x - 10, p.z + 5) - 40) < 0.1)
    assert.equal(p.y, 2)
    assert.ok(Math.abs(Math.hypot(p.tx, p.ty, p.tz) - 1) < 1e-9)
    assert.ok(Math.abs(p.tx * (p.x - 10) + p.tz * (p.z + 5)) / 40 < 0.03, 'tangent along the circle')
  }
  const line = new Path([[0, 0, 0], [100, 0, 0]], false, 1)
  assert.equal(line.length, 100)
  assert.equal(line.sample(30).x, 30)
  const back = line.sample(130)
  assert.equal(back.x, 70)
  assert.equal(back.tx, -1)
  const spline = new Path([[0, 0, 0], [50, 0, 0], [50, 0, 50], [0, 0, 50]], true, 8)
  assert.ok(spline.length > 150 && spline.length < 250)
})

// A 4×4 street grid, 60 m blocks, plus a dead end.
function grid(): RoadNetwork {
  const nodes: { x: number; y: number; z: number; edges: number[] }[] = []
  const edges: { a: number; b: number; width: number }[] = []
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) nodes.push({ x: i * 60, y: NaN, z: j * 60, edges: [] })
  const link = (a: number, b: number) => {
    edges.push({ a, b, width: 8 })
    nodes[a].edges.push(edges.length - 1)
    nodes[b].edges.push(edges.length - 1)
  }
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    if (i < 3) link(j * 4 + i, j * 4 + i + 1)
    if (j < 3) link(j * 4 + i, (j + 1) * 4 + i)
  }
  nodes.push({ x: -50, y: NaN, z: 0, edges: [] })
  link(0, 16)
  return { nodes, edges }
}

function distToEdge(net: RoadNetwork, x: number, z: number): number {
  let best = Infinity
  for (const e of net.edges) {
    const a = net.nodes[e.a], b = net.nodes[e.b]
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2))
    best = Math.min(best, Math.hypot(x - a.x - dx * t, z - a.z - dz * t))
  }
  return best
}

test('road navigator: stays in lane on the graph, turns at junctions, deterministic', () => {
  const net = grid()
  const nav = new RoadNavigator(net, 20, 7)
  nav.height = () => 3
  for (let i = 0; i < 20; i++) assert.ok(nav.place(i))
  const seen = new Set<number>()
  let prev: number[] = []
  for (let step = 0; step < 600; step++) {
    const now: number[] = []
    for (let i = 0; i < 20; i++) {
      nav.advance(i, 0.5)
      const p = nav.pose(i)
      seen.add(nav.edge[i])
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z) && Number.isFinite(p.yaw))
      assert.equal(p.y, 3)
      // Lane centre (width/4 = 2 m off the centreline), corners cut by at most the corner radius.
      assert.ok(distToEdge(net, p.x, p.z) < 2 + 0.01 + nav.maxCorner * 0.3, `vehicle ${i} left the road`)
      now.push(p.x, p.z)
    }
    // Continuous motion: no teleports (except the lane swap of a dead-end U-turn).
    if (prev.length) for (let i = 0; i < 20; i++) assert.ok(Math.hypot(now[i * 2] - prev[i * 2], now[i * 2 + 1] - prev[i * 2 + 1]) < 4.5)
    prev = now
  }
  assert.ok(seen.size > 12, `only ${seen.size} edges visited`)
  // Right-hand traffic: heading +x with y up, the right-hand side is +z.
  const one = new RoadNavigator({ nodes: [{ x: 0, y: 0, z: 0, edges: [0] }, { x: 100, y: 0, z: 0, edges: [0] }], edges: [{ a: 0, b: 1, width: 8 }] }, 1, 1)
  one.edge[0] = 0; one.from[0] = 0; one.u[0] = 50; one.next[0] = 0
  assert.equal(one.pose(0).z, 2)
  one.leftHand = true
  assert.equal(one.pose(0).z, -2)
  // Same seed, same walk.
  const a = new RoadNavigator(net, 3, 9), b = new RoadNavigator(net, 3, 9)
  for (let i = 0; i < 3; i++) { a.place(i); b.place(i) }
  for (let s = 0; s < 200; s++) for (let i = 0; i < 3; i++) { a.advance(i, 1.3); b.advance(i, 1.3) }
  assert.deepEqual([...a.edge, ...a.u], [...b.edge, ...b.u])
})

test('fleet on roads: cars follow the graph', () => {
  const net = grid()
  const sim = new FleetSim(settings([{ type: 'car', count: 30, route: { kind: 'roads' } }]), net)
  for (let i = 0; i < 120; i++) sim.step(1 / 20)
  for (let v = 0; v < sim.count; v++) assert.ok(distToEdge(net, sim.pose[v * 8], sim.pose[v * 8 + 2]) < 4.5)
  assert.ok([...sim.travel].every((d) => d > 20))
})

test('trains: wagons follow the locomotive along the rails', () => {
  const rail = circlePoints([0, 0, 0], 300, 64)
  const g: FleetGroup = { type: 'train', count: 1, params: { wagons: 6, cargo: 'mixed' }, route: { kind: 'path', points: rail } }
  assert.equal(groupVehicleCount(g), 7)
  const sim = new FleetSim(settings([g]))
  for (let i = 0; i < 60; i++) sim.step(1 / 10)
  assert.equal(sim.count, 7)
  assert.equal(sim.models[sim.model[0]].style, 'locomotive')
  for (let v = 1; v < 7; v++) {
    const gap = Math.hypot(sim.pose[v * 8] - sim.pose[v * 8 - 8], sim.pose[v * 8 + 2] - sim.pose[v * 8 - 6])
    const expected = sim.models[sim.model[v]].size[2] / 2 + sim.models[sim.model[v - 1]].size[2] / 2 + 0.8
    assert.ok(Math.abs(gap - expected) < 1, `wagon ${v}: gap ${gap.toFixed(2)} vs ${expected.toFixed(2)}`)
    assert.ok(Math.abs(Math.hypot(sim.pose[v * 8], sim.pose[v * 8 + 2]) - 300) < 1, 'on the rails')
    assert.equal(sim.speed[v], sim.speed[0])
  }
})

test('rockets: gravity turn, stage separation, falling stages', () => {
  const f = { accel: 9, turn: 5000 }
  let prev = rocketAt(0, f)
  assert.equal(prev.altitude, 0)
  for (let t = 1; t < 120; t++) {
    const s = rocketAt(t, f)
    assert.ok(s.altitude > prev.altitude && s.downrange >= prev.downrange && s.tilt >= prev.tilt && s.tilt < Math.PI / 2)
    prev = s
  }
  const sim = new FleetSim(settings([{ type: 'rocket', count: 1, params: { stages: 3 }, route: { kind: 'pad', position: [0, 5, 0], period: 200, countdown: 10 } }], { rocket: { accel: 9, turn: 5000, separation: [30, 60], fallTime: 40 } }))
  sim.step(5)
  assert.ok(sim.flightTime[0] < 0 && sim.pose[1] === 5, 'on the pad during the countdown')
  sim.step(10) // t = 5 s
  assert.ok(sim.pose[1] > 5 && sim.activeStage(0) === 0)
  sim.step(30) // t = 35 s
  assert.equal(sim.activeStage(0), 1)
  const out = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, hidden: false }
  assert.equal(sim.stageState(0, 1, out), null)
  sim.step(25) // t = 60 s: stage 0 past the top of its arc
  const y1 = sim.stageState(0, 0, out)!.y
  sim.step(5) // t = 65 s: stage 1 gone too
  assert.equal(sim.activeStage(0), 2)
  const y2 = sim.stageState(0, 0, out)!.y
  assert.ok(y2 < y1, 'spent stage falls')
  assert.ok(sim.pose[1] > y2 + 5000, 'rocket climbs away from it')
  // Pad stays put.
  assert.deepEqual([...sim.anchor.subarray(0, 3)], [0, 5, 0])
})

test('boats bob on waves; planes bank; jets park on the carrier', () => {
  const sim = new FleetSim(settings([
    { type: 'aircraft-carrier', count: 1, route: { kind: 'circle', center: [0, 0, 0], radius: 2000 } },
    { type: 'fishing-boat', count: 2, route: { kind: 'circle', center: [0, 0, 0], radius: 300 } },
    { type: 'airplane', count: 1, route: { kind: 'circle', center: [0, 500, 0], radius: 1500 } },
    { type: 'fighter-jet', count: 4, route: { kind: 'host', group: 0 } },
  ], { waves: { count: 8, seed: 2, amplitude: 1.2, wavelength: [4, 60], direction: [1, 0.3], spread: 0.5, choppiness: 0.6, speed: 1 } }))
  const ys: number[] = []
  for (let i = 0; i < 80; i++) {
    sim.step(1 / 10)
    ys.push(sim.pose[1 * 8 + 1])
    const roll = sim.pose[1 * 8 + 5]
    assert.ok(Math.abs(roll) < 0.6, 'boat roll stays sane')
  }
  assert.ok(Math.max(...ys) - Math.min(...ys) > 0.2, 'boat heaves')
  // Counter-clockwise circle seen from above (+y) turns left: the plane banks into the turn.
  const plane = 3, roll = sim.pose[plane * 8 + 5]
  assert.ok(Math.abs(roll) > 0.02 && Math.abs(roll) < 1.2, `plane bank ${roll}`)
  const carrier = sim.models[sim.model[0]]
  const deck = sim.pose[1] + carrier.hosts[0].position[1]
  for (let v = 4; v < 8; v++) {
    const d = Math.hypot(sim.pose[v * 8] - sim.pose[0], sim.pose[v * 8 + 2] - sim.pose[2])
    assert.ok(d < carrier.size[2] / 2, 'jet on the carrier')
    assert.ok(Math.abs(sim.pose[v * 8 + 1] - deck) < 4, 'jet on the deck')
  }
})

test('weather exposure: rain wets, snow sheds at speed, fire burns and stops', () => {
  const sim = new FleetSim(settings([
    { type: 'car', count: 2, speed: [0, 0], route: { kind: 'static', position: [0, 0, 0] } },
    { type: 'car', count: 2, speed: [25, 25], route: { kind: 'circle', center: [0, 0, 0], radius: 200 } },
  ], { exposure: { ...DEFAULT_FLEET.exposure, rain: 1, snowfall: 1 } }))
  for (let i = 0; i < 100; i++) sim.step(0.5)
  const st = sim.states
  assert.ok(st.value(0, 'wetness') > 0.9, 'parked car soaked')
  assert.ok(st.value(0, 'snow') > 0.5, 'parked car snowy')
  assert.ok(st.value(2, 'snow') < 0.05, 'fast car sheds snow')
  // A wildfire under the moving cars.
  const env = { fire: { heatAt: () => 1 } }
  for (let i = 0; i < 60; i++) sim.step(0.5, env)
  assert.ok(sim.heat[2] > 0 && st.value(2, 'burn') > 0.3 && st.value(2, 'damage') > 0.3)
  assert.ok(sim.speed[2] < 1, 'burning car stopped')
})

test('placement: plausible routes for boats, planes, roads and pads', () => {
  const world = new World({ seed: 1 })
  const frame = world.frame
  const plausible = (x: number, z: number, rule: Parameters<typeof isPlausible>[4]) => isPlausible(world, frame, x, z, rule, 2)
  const boat = planRoute('speedboat', world, frame, { center: [-8250, -8300], radius: 300, seed: 3, points: 8, plausible })
  assert.ok(boat && boat.kind === 'path', 'found a loop on the water')
  if (boat?.kind === 'path') for (const [x, , z] of boat.points) assert.ok(isPlausible(world, frame, x, z, VEHICLE_PLACEMENT.speedboat, 2))
  const air = planRoute('airplane', world, frame, { center: [0, 0], radius: 2000, seed: 1, points: 8 })
  assert.ok(air && air.kind === 'path')
  if (air?.kind === 'path') for (const [x, y, z] of air.points) assert.ok(y - frame.height(x, z) >= 300)
  const car = planRoute('car', world, frame, { center: [0, 0], radius: 150, seed: 2, points: 8, attempts: 12 })
  if (car?.kind === 'path') for (const [x, y, z] of car.points) {
    assert.ok(isPlausible(world, frame, x, z, VEHICLE_PLACEMENT.car, 2))
    assert.ok(Math.abs(y - frame.height(x, z)) < 0.2)
  }
  // Every rule is a valid threejs-worldgen PlacementRule.
  for (const type of VEHICLE_TYPES) assert.equal(typeof isPlausible(world, frame, 0, 0, VEHICLE_PLACEMENT[type]), 'boolean')
})

test('assets: one AssetDef per type, defaults in range', () => {
  const defs = vehicleAssets()
  assert.equal(defs.length, VEHICLE_TYPES.length)
  assert.equal(new Set(defs.map((d) => d.id)).size, defs.length)
  for (const d of defs) {
    assert.equal(d.category, 'vehicle')
    assert.ok(d.id.startsWith('vehicles/') && d.tags.length > 2)
    for (const [k, p] of Object.entries(d.params)) {
      if (p.type === 'number') assert.ok(p.default >= p.min && p.default <= p.max, `${d.id}.${k}`)
      if (p.type === 'choice') assert.ok(p.options.includes(p.default), `${d.id}.${k}`)
    }
    assert.deepEqual(Object.keys(d.params), Object.keys(VEHICLE_KINDS[d.id.slice(9) as VehicleType].params))
  }
})

/**
 * Overall size of a model as published figures measure it: length and height of the whole vehicle,
 * body width without mirrors (widest body point below 60 % of the height, where mirrors never are) and
 * the wheelbase.
 */
function measure(m: VehicleModel): CarDimensions {
  const b = m.parts[0].mesh
  let w = 0
  for (let i = 0; i < b.position.length; i += 3) if (b.position[i + 1] < 0.6 * m.size[1]) w = Math.max(w, Math.abs(b.position[i]))
  return { length: m.size[2], width: 2 * w, height: m.size[1], wheelBase: m.wheelBase }
}

function within(label: string, got: CarDimensions, ref: CarDimensions, tol = 0.05) {
  for (const k of ['length', 'width', 'height', 'wheelBase'] as const) {
    assert.ok(Math.abs(got[k] / ref[k] - 1) <= tol, `${label} ${k}: ${got[k].toFixed(3)} vs ${ref[k]} (${((got[k] / ref[k] - 1) * 100).toFixed(1)} %)`)
  }
}

test('car lookalikes: within 5 % of the reference cars, distinct, deterministic, smooth', () => {
  const sizes = new Set<string>()
  for (const style of LOOKALIKE_STYLES) for (const seed of [1, 7]) {
    const m = buildVehicle('car', { style }, seed)
    assert.equal(m.style, style)
    for (const part of m.parts) checkMesh(part.mesh, `${style}/${part.name}`)
    within(style, measure(m), CAR_REFERENCES[style])
    sizes.add(m.size.map((v) => v.toFixed(2)).join())
    // Wheels: four, two of them steered, spinning with distance.
    const wheels = m.parts.find((p) => p.name === 'wheel')!
    assert.equal(wheels.mounts.length, 4)
    assert.equal(wheels.mounts.filter((t) => t.steer).length, 2)
    // Same seed, same car (geometry, colours and trims).
    const again = buildVehicle('car', { style }, seed)
    m.parts.forEach((p, i) => { assert.deepEqual(p.mesh.position, again.parts[i].mesh.position); assert.deepEqual(p.mesh.color, again.parts[i].mesh.color) })
    // Smooth bodywork: most body vertices share their position with others whose normals nearly agree.
    const b = m.parts[0].mesh, seen = new Map<string, number[]>()
    for (let i = 0; i < b.position.length / 3; i++) {
      const key = [0, 1, 2].map((k) => b.position[i * 3 + k].toFixed(4)).join()
      const list = seen.get(key) ?? []
      list.push(i)
      seen.set(key, list)
    }
    let shared = 0, smooth = 0
    for (const list of seen.values()) for (let a = 1; a < list.length; a++) {
      shared++
      const i = list[0], j = list[a]
      if (b.normal[i * 3] * b.normal[j * 3] + b.normal[i * 3 + 1] * b.normal[j * 3 + 1] + b.normal[i * 3 + 2] * b.normal[j * 3 + 2] > 0.999) smooth++
    }
    assert.ok(smooth / shared > 0.6, `${style}: only ${((smooth / shared) * 100).toFixed(0)} % smooth vertices`)
  }
  assert.equal(sizes.size, LOOKALIKE_STYLES.length, 'every style has its own proportions')
  // Seeded colours and trims: the palette is the style's own, and seeds pick different trims.
  const trims = new Set(Array.from({ length: 6 }, (_, s) => buildVehicle('car', { style: 'compact' }, s + 1).parts[1].mesh.color.slice(-3).join()))
  assert.ok(trims.size > 1, 'seeded wheel trims')
  // In the asset parameters (and so the mixed traffic pool) and with exhaust vents, except the electric saloon.
  for (const style of LOOKALIKE_STYLES) {
    assert.ok((VEHICLE_KINDS.car.params.style as { options: string[] }).options.includes(style))
    const vents = buildVehicle('car', { style }).vents
    if (style === 'electricSaloon') assert.equal(vents.length, 0)
    else assert.ok(vents.length > 0 && vents.every((v) => v.kind === 'tailpipe' && v.position[2] < 0), style)
  }
})

test('pickups: full-size cabs and beds, utes and the angular one match their references', () => {
  const variants: Record<string, string | number | boolean>[] = []
  for (const key of Object.keys(FULL_SIZE_DIMENSIONS)) { const [cab, bed] = key.split('/'); variants.push({ style: 'fullSize', cab, bed }) }
  variants.push({ style: 'ute', ute: 'coupe' }, { style: 'ute', ute: 'tray' }, { style: 'angular' })
  for (const params of variants) {
    const m = buildVehicle('pickup', params, 3)
    for (const part of m.parts) checkMesh(part.mesh, `pickup ${JSON.stringify(params)}`)
    within(`pickup ${JSON.stringify(params)}`, measure(m), pickupReference({ ...params, ute: params.ute ?? 'coupe' }))
    assert.deepEqual(m.parts[0].mesh.position, buildVehicle('pickup', params, 3).parts[0].mesh.position, 'deterministic')
    if (params.style === 'angular') assert.equal(m.vents.length, 0, 'electric: no exhaust')
    else assert.ok(m.vents.length > 0 && m.vents.every((v) => v.kind === 'tailpipe'))
  }
  // Longer cabs and beds are longer; a lift raises it; a hitch reaches behind the bumper; a load adds to the bed.
  const len = (p: Record<string, string | number | boolean>) => buildVehicle('pickup', { style: 'fullSize', ...p }).size
  assert.ok(len({ cab: 'crew', bed: 'long' })[2] > len({ cab: 'crew', bed: 'short' })[2])
  assert.ok(len({ cab: 'regular', bed: 'short' })[2] < len({ cab: 'crew', bed: 'short' })[2])
  assert.ok(len({ lift: 0.25 })[1] > len({})[1] + 0.2)
  assert.ok(len({ hitch: true })[2] > len({})[2] + 0.1)
  const verts = (p: Record<string, string | number | boolean>) => buildVehicle('pickup', { style: 'fullSize', ...p }).parts[0].mesh.position.length
  for (const load of ['crates', 'hay', 'gravel']) assert.ok(verts({ load }) > verts({}), load)
  // The angular body is brushed stainless unless painted.
  const finish = (m: VehicleModel, f: number) => { const st = m.parts[0].mesh.style; let n = 0; for (let i = 2; i < st.length; i += 3) if (st[i] === f) n++; return n / (st.length / 3) }
  assert.ok(finish(buildVehicle('pickup', { style: 'angular' }), 3) > 0.5, 'brushed steel')
  assert.equal(finish(buildVehicle('pickup', { style: 'angular', painted: true }), 3), 0)
  // The car style `truck` is now a full-size pickup body.
  assert.ok(buildVehicle('car', { style: 'truck' }).size[2] > 5.5)
})

test('traffic pools: counts add up, deterministic, pickups weigh into rural and dirt roads', () => {
  const route = { kind: 'roads' } as const
  for (const pool of Object.keys(TRAFFIC_POOLS) as (keyof typeof TRAFFIC_POOLS)[]) for (const n of [0, 1, 7, 100]) {
    const groups = trafficGroups(pool, n, route)
    assert.equal(groups.reduce((a, g) => a + g.count, 0), n)
    assert.deepEqual(groups, trafficGroups(pool, n, route))
  }
  const share = (pool: keyof typeof TRAFFIC_POOLS) => trafficGroups(pool, 1000, route).filter((g) => g.type === 'pickup').reduce((a, g) => a + g.count, 0) / 1000
  assert.ok(share('rural') > 2 * share('urban') && share('dirtRoad') > share('rural'))
  // Every entry builds.
  for (const pool of Object.values(TRAFFIC_POOLS)) for (const e of pool) assert.ok(buildVehicle(e.type, e.params, 1).parts.length > 0)
})

test('trucks: every cab and trailer within road-legal sizes, rigs couple up, deterministic', () => {
  // Width of everything below `below` metres (wheels at their mounts, mirrors left out above it) and the height.
  const span = (m: VehicleModel, below = Infinity) => {
    let w = 0
    for (const part of m.parts) for (const mt of part.mounts) {
      const pos = part.mesh.position
      for (let i = 0; i < pos.length; i += 3) if (mt.position[1] + pos[i + 1] <= below) w = Math.max(w, Math.abs(mt.position[0]) + Math.abs(pos[i]))
    }
    return { width: 2 * w, height: m.size[1] }
  }
  for (const cab of ['conventional', 'cabOver']) for (const sleeper of [true, false]) for (const body of ['tractor', 'rigid']) for (const axles of [2, 3, 4]) for (const stacks of [true, false]) {
    const params = { cab, sleeper, body, axles, stacks }
    const m = buildVehicle('truck', params, 5)
    for (const part of m.parts) checkMesh(part.mesh, `truck ${JSON.stringify(params)}`)
    // Mirrors stick out past the legal width (as they may); everything below them stays inside it.
    assert.ok(span(m, 1.95).width <= TRUCK_LIMITS.width + 1e-6, `${JSON.stringify(params)} width ${span(m, 1.95).width}`)
    assert.ok(m.size[1] <= TRUCK_LIMITS.height, `${JSON.stringify(params)} height ${m.size[1]}`)
    assert.ok(m.size[2] > 5.5 && m.size[2] < (body === 'rigid' ? 12 : 9.5), `${JSON.stringify(params)} length ${m.size[2]}`)
    assert.equal(m.vents.length, stacks ? 2 : 1)
    assert.ok(m.vents.every((v) => v.kind === 'stack'))
    if (body === 'tractor') assert.ok(m.hitch?.coupling !== undefined && m.hitch.coupling < 0, 'fifth wheel behind the cab')
    // Wheels: steer axle(s) single, the rest duals, all spinning with distance.
    const wheels = m.parts.filter((p) => p.name === 'wheel' || p.name === 'dual').reduce((a, p) => a + p.mounts.length, 0)
    assert.equal(wheels, axles === 4 && body === 'rigid' ? 2 * 4 : 2 * Math.min(axles, body === 'rigid' ? 3 : 4))
  }
  for (const trailer of TRAILER_KINDS) for (const trailers of [1, 2, 3]) for (let slot = 0; slot < trailers; slot++) {
    const params = { piece: 'trailer', trailer, trailers, slot, load: 'mixed' }
    const m = buildVehicle('truck', params, 9)
    for (const part of m.parts) checkMesh(part.mesh, `trailer ${JSON.stringify(params)}`)
    const s = span(m)
    assert.ok(s.width <= TRUCK_LIMITS.width + 1e-6 && s.height <= TRUCK_LIMITS.height && m.size[2] <= TRUCK_LIMITS.trailer, `${JSON.stringify(params)} ${s.width} ${s.height} ${m.size[2]}`)
    assert.ok(m.hitch?.kingpin! > 0 && m.hitch?.axle! < 0, 'kingpin ahead, axles behind')
    assert.equal(m.hitch?.coupling !== undefined, slot < trailers - 1, 'lead trailers carry the next fifth wheel')
    assert.equal(m.vents.length, 0)
    assert.deepEqual(m.parts[0].mesh.position, buildVehicle('truck', params, 9).parts[0].mesh.position)
  }
  // Flatbed loads differ; container trailers carry ISO boxes.
  const verts = (load: string) => buildVehicle('truck', { piece: 'trailer', trailer: 'flatbed', trailers: 1, load }, 1).parts[0].mesh.position.length
  assert.ok(verts('lumber') > verts('empty') && verts('pipes') > verts('empty') && verts('machinery') > verts('empty'))
  // A whole rig: one unit of tractor + trailers, within the longest road-train length.
  const g: FleetGroup = { type: 'truck', count: 1, params: { trailers: 3, trailer: 'mixed' }, route: { kind: 'static', position: [0, 0, 0] } }
  assert.equal(groupVehicleCount(g), 4)
  assert.equal(groupVehicleCount({ ...g, params: { body: 'rigid', trailers: 3 } }), 1)
  const rig = new FleetSim(settings([g]))
  let front = -Infinity, back = Infinity
  for (let v = 0; v < rig.count; v++) {
    const m = rig.models[rig.model[v]], z = rig.pose[v * 8 + 2]
    front = Math.max(front, z + m.size[2] / 2); back = Math.min(back, z - m.size[2] / 2)
  }
  assert.ok(front - back < TRUCK_LIMITS.rig && front - back > 30, `rig length ${(front - back).toFixed(1)}`)
})

test('truck articulation: trailers stay coupled, follow the tractor and off-track inside on curves', () => {
  const g: FleetGroup = { type: 'truck', count: 1, params: { trailers: 3, trailer: 'box' }, speed: [12, 12], route: { kind: 'circle', center: [0, 0, 0], radius: 40 } }
  const sim = new FleetSim(settings([g]))
  const world = (v: number, z: number) => [sim.pose[v * 8] + Math.sin(sim.pose[v * 8 + 3]) * z, sim.pose[v * 8 + 2] + Math.cos(sim.pose[v * 8 + 3]) * z]
  for (let i = 0; i < 400; i++) {
    sim.step(1 / 30)
    for (let v = 1; v < sim.count; v++) {
      const prev = sim.models[sim.model[v - 1]], m = sim.models[sim.model[v]]
      const [cx, cz] = world(v - 1, prev.hitch!.coupling!), [kx, kz] = world(v, m.hitch!.kingpin!)
      assert.ok(Math.hypot(cx - kx, cz - kz) < 1e-3, `trailer ${v} uncoupled by ${Math.hypot(cx - kx, cz - kz)}`)
      assert.ok(Number.isFinite(sim.pose[v * 8 + 3]))
    }
  }
  // Steady turn: each trailer's axles run on a smaller circle than the hitch it follows.
  let last = Infinity
  for (let v = 1; v < sim.count; v++) {
    const m = sim.models[sim.model[v]], [ax, az] = world(v, m.hitch!.axle!), r = Math.hypot(ax, az)
    const prev = sim.models[sim.model[v - 1]], [hx, hz] = world(v - 1, prev.hitch!.coupling!)
    const rh = Math.hypot(hx, hz), len = m.hitch!.kingpin! - m.hitch!.axle!
    assert.ok(r < rh && r < last, `trailer ${v} cuts inside (${r.toFixed(2)} < ${rh.toFixed(2)})`)
    assert.ok(Math.abs(r - Math.sqrt(rh * rh - len * len)) < 0.5, `trailer ${v} at the tractrix radius (${r.toFixed(2)} vs ${Math.sqrt(rh * rh - len * len).toFixed(2)})`)
    last = r
  }
  // On a straight they line up again; same seed, same motion.
  const run = () => { const s = new FleetSim(settings([{ ...g, route: { kind: 'path', points: [[0, 0, 0], [0, 0, 300], [200, 0, 300]], closed: false } }])); for (let i = 0; i < 300; i++) s.step(1 / 20); return [...s.pose] }
  assert.deepEqual(run(), run())
})

test('tractors: plausible wheels and track, implements, footprints that match the wheels, deterministic', () => {
  for (const cab of ['cab', 'rops']) for (const implement of TRACTOR_IMPLEMENTS) for (const family of ['green', 'red', 'blue', 'orange']) {
    const m = buildVehicle('tractor', { cab, implement, family }, 2)
    for (const part of m.parts) checkMesh(part.mesh, `tractor ${cab} ${implement}`)
    const rear = m.parts.find((p) => p.name === 'wheel')!, front = m.parts.find((p) => p.name === 'frontWheel')!
    const rR = rear.mesh.bounds[4], rF = front.mesh.bounds[4]
    // A mid-size row-crop tractor: 1.8–2.1 m rear tyres, front ones 70–85 % of that, a 1.5–2.3 m track.
    assert.ok(rR > 0.85 && rR < 1.06 && rF / rR > 0.65 && rF / rR < 0.9, `wheel radii ${rR.toFixed(2)} / ${rF.toFixed(2)}`)
    const track = 2 * Math.abs(rear.mounts[0].position[0])
    assert.ok(track > 1.5 && track < 2.3, `track ${track}`)
    assert.ok(m.wheelBase > 2.2 && m.wheelBase < 3.2)
    assert.ok(front.mounts.every((t) => t.steer) && rear.mounts.every((t) => !t.steer), 'front wheels steer')
    assert.equal(m.vents.length, 1)
    assert.equal(m.vents[0].kind, 'stack')
    assert.ok(m.vents[0].position[1] > 2.8, 'stack above the cab line')
    assert.ok(m.palette.every((c) => /^#[0-9a-f]{6}$/i.test(c)))
    assert.equal(m.hitch?.coupling !== undefined, implement === 'trailer')
    assert.deepEqual(m.parts[0].mesh.position, buildVehicle('tractor', { cab, implement, family }, 2).parts[0].mesh.position)
  }
  const plain = buildVehicle('tractor', { family: 'green' }).parts[0].mesh.position.length
  assert.ok(buildVehicle('tractor', { family: 'green', implement: 'plough' }).parts[0].mesh.position.length > plain)
  assert.ok(buildVehicle('tractor', { family: 'green', implement: 'seeder' }).parts[0].mesh.position.length > plain)
  // The trailer implement is a towed, articulated vehicle.
  const towing: FleetGroup = { type: 'tractor', count: 1, params: { implement: 'trailer' }, route: fieldRoute([0, 0, 0], 4, 8, 50) }
  assert.equal(groupVehicleCount(towing), 2)
  const sim = new FleetSim(settings([towing, { type: 'tractor', count: 1, params: { family: 'red' }, route: { kind: 'circle', center: [100, 0, 0], radius: 20 } }]))
  for (let i = 0; i < 300; i++) sim.step(1 / 20)
  assert.equal(sim.models[sim.model[1]].style, 'trailer')
  // Footprints: one per wheel, at the wheels' ground contact, radius matching the tyre width.
  const v = 2, prints = wheelFootprints(sim, v), m = sim.models[sim.model[v]]
  assert.equal(prints.length, 4)
  const yaw = sim.pose[v * 8 + 3]
  const wheels = m.parts.filter((p) => p.name === 'wheel' || p.name === 'frontWheel').flatMap((p) => p.mounts.map((mt) => ({ mt, width: p.mesh.bounds[3] - p.mesh.bounds[0] })))
  wheels.forEach(({ mt, width }, i) => {
    const x = sim.pose[v * 8] + Math.cos(yaw) * mt.position[0] + Math.sin(yaw) * mt.position[2]
    const z = sim.pose[v * 8 + 2] - Math.sin(yaw) * mt.position[0] + Math.cos(yaw) * mt.position[2]
    assert.ok(Math.hypot(prints[i].position[0] - x, prints[i].position[2] - z) < 1e-4, 'footprint under its wheel')
    assert.ok(Math.abs(prints[i].position[1] - sim.pose[v * 8 + 1]) < 1e-6, 'on the ground')
    assert.ok(prints[i].radius > width * 0.45 && prints[i].radius < width * 0.75, `radius ${prints[i].radius} for a ${width} m tyre`)
    assert.ok(prints[i].strength > 0 && prints[i].strength <= 1)
  })
  // The big rear tyres press hardest.
  assert.ok(prints[0].strength > prints[3].strength)
  // Field routes: closed, rows the given spacing apart.
  const route = fieldRoute([10, 0, 20], 6, 5, 40)
  assert.ok(route.kind === 'path' && route.closed && route.points.length > 12)
})

test('exhaust: emitters on every vent, none for electric vehicles, budget and distance respected', () => {
  const at = (x: number): FleetGroup['route'] => ({ kind: 'static', position: [x, 0, 0] })
  const groups: FleetGroup[] = [
    ...(['sedan', 'bus', ...LOOKALIKE_STYLES] as string[]).map((style, i): FleetGroup => ({ type: 'car', count: 1, params: { style }, speed: [0, 0], route: at(i * 8) })),
    ...(['fullSize', 'ute', 'angular'] as string[]).map((style, i): FleetGroup => ({ type: 'pickup', count: 1, params: { style }, speed: [0, 0], route: at(100 + i * 8) })),
    { type: 'truck', count: 1, params: { trailers: 1 }, speed: [0, 0], route: at(130) },
    { type: 'tractor', count: 1, speed: [0, 0], route: at(140) },
    ...(['steam', 'diesel', 'electric'] as string[]).map((traction, i): FleetGroup => ({ type: 'train', count: 1, params: { traction, wagons: 0 }, speed: [0, 0], route: at(160 + i * 10) })),
  ]
  const sim = new FleetSim(settings(groups))
  const s: ExhaustSettings = { ...structuredClone(DEFAULT_EXHAUST), temperature: -5, humidity: 0.9, maxVents: 500, maxDistance: 1000 }
  const out = createExhaustBuffers(500), state = createExhaustState(sim.count)
  const n = exhaustSources(sim, { x: 90, y: 2, z: 30 }, s, state, 1 / 30, out)
  for (let v = 0; v < sim.count; v++) {
    const m = sim.models[sim.model[v]]
    const mine = Array.from({ length: n }, (_, k) => k).filter((k) => out.vehicle[k] === v)
    const electric = m.style === 'electricSaloon' || m.style === 'angular' || m.style === 'electric' || m.style.startsWith('trailer')
    if (electric) { assert.equal(mine.length, 0, `${m.type}/${m.style} emits`); continue }
    assert.ok(m.vents.length > 0, `${m.type}/${m.style} has vents`)
    assert.equal(mine.length, m.vents.length, `${m.type}/${m.style}: one emitter per vent`)
    m.vents.forEach((vent, i) => {
      const k = mine[i], o = v * 8, yaw = sim.pose[o + 3]
      const x = sim.pose[o] + Math.cos(yaw) * vent.position[0] + Math.sin(yaw) * vent.position[2]
      const z = sim.pose[o + 2] - Math.sin(yaw) * vent.position[0] + Math.cos(yaw) * vent.position[2]
      assert.ok(Math.hypot(out.sources[k * SOURCE_STRIDE] - x, out.sources[k * SOURCE_STRIDE + 2] - z) < 1e-4, 'at the vent')
      assert.ok(Math.abs(out.sources[k * SOURCE_STRIDE + 1] - sim.pose[o + 1] - vent.position[1]) < 1e-4)
      assert.ok(out.sources[k * SOURCE_STRIDE + 3] > 0, 'weighted')
      const opacity = out.motion[k * MOTION_STRIDE + 3]
      assert.ok(opacity > 0 && opacity <= 1)
    })
  }
  // Moving vehicles hand their velocity to the particles.
  const moving = new FleetSim(settings([{ type: 'car', count: 1, params: { style: 'sedan' }, speed: [10, 10], route: { kind: 'path', points: [[0, 0, 0], [0, 0, 500]], closed: false } }]))
  for (let i = 0; i < 60; i++) moving.step(1 / 30)
  const one = createExhaustBuffers(4)
  exhaustSources(moving, { x: 0, y: 2, z: 0 }, s, createExhaustState(1), 1 / 30, one)
  assert.ok(Math.abs(one.motion[2] - (10 - s.kinds.tailpipe.speed)) < 0.2, `forward speed inherited, minus the gas blown back (${one.motion[2]})`)
  // Budget: the nearest `maxVents` vents of 200 cars, and nothing past maxDistance.
  const crowd = new FleetSim(settings([{ type: 'car', count: 200, params: { style: 'sedan' }, variants: 1, speed: [0, 0], route: { kind: 'static', position: [0, 0, 0], spacing: 6 } }]))
  const small = createExhaustBuffers(64)
  const count = exhaustSources(crowd, { x: 0, y: 2, z: 0 }, { ...s, maxVents: 64, maxDistance: 600 }, createExhaustState(crowd.count), 1 / 30, small)
  assert.equal(count, 64)
  const used = new Set(small.vehicle.subarray(0, count))
  for (let v = 0; v < 64; v++) assert.ok(used.has(v), 'nearest first')
  const near = exhaustSources(crowd, { x: 0, y: 2, z: 0 }, { ...s, maxVents: 500, maxDistance: 300 }, createExhaustState(crowd.count), 1 / 30, createExhaustBuffers(500))
  assert.ok(near > 0 && near <= 51, `only vehicles within 300 m (${near})`)
  let total = 0
  for (let k = 0; k < count; k++) total += small.sources[k * SOURCE_STRIDE + 3]
  assert.ok(spawnRate(1, total, s.capacity, (s.life[0] + s.life[1]) / 2) <= s.capacity / ((s.life[0] + s.life[1]) / 2) + 1e-6, 'the pool never overruns')
  // Condensation shows in cold, humid air; warm dry air hides it.
  assert.ok(condensation(-5, 0.9) > 0.8 && condensation(25, 0.3) < 0.05)
})

test('exhaust: steam chuffs with the wheels, engines smoke harder pulling away', () => {
  const s = structuredClone(DEFAULT_EXHAUST)
  const loco = new FleetSim(settings([{ type: 'train', count: 1, params: { traction: 'steam', wagons: 0 }, speed: [3, 3], route: { kind: 'path', points: circlePoints([0, 0, 0], 200, 64), closed: true } }]))
  const weights: number[] = []
  const state = createExhaustState(1), buf = createExhaustBuffers(4)
  for (let i = 0; i < 120; i++) {
    loco.step(1 / 60)
    exhaustSources(loco, { x: 0, y: 0, z: 0 }, s, state, 1 / 60, buf)
    weights.push(buf.sources[3])
  }
  assert.ok(Math.max(...weights) > 2 * Math.min(...weights), 'beats at low speed')
  // A truck: idling, then pulling away (cruise speed set), smokes more and darker while accelerating.
  const truck = new FleetSim(settings([{ type: 'truck', count: 1, params: { trailers: 1 }, speed: [0, 0], route: { kind: 'path', points: [[0, 0, 0], [0, 0, 1000]], closed: false } }]))
  const st = createExhaustState(truck.count), b = createExhaustBuffers(8)
  for (let i = 0; i < 30; i++) { truck.step(1 / 30); exhaustSources(truck, { x: 0, y: 0, z: 0 }, s, st, 1 / 30, b) }
  const idle = b.sources[3], idleAlpha = b.motion[3]
  truck.unitCruise[0] = 20
  for (let i = 0; i < 30; i++) { truck.step(1 / 30); exhaustSources(truck, { x: 0, y: 0, z: 0 }, s, st, 1 / 30, b) }
  assert.ok(b.sources[3] > 2 * idle && b.motion[3] > idleAlpha, `pulling away: ${b.sources[3].toFixed(1)} vs ${idle.toFixed(1)}`)
})

test('truck articulation on open (back and forth) paths: trailers stay behind their hitch on every leg', () => {
  for (const trailers of [1, 2]) {
    const sim = new FleetSim(settings([{ type: 'truck', count: 1, params: { trailers }, route: { kind: 'path', points: [[0, 0, 0], [0, 0, 200]], closed: false } }]))
    let legs = 0, lastDir = 0
    for (let i = 0; i < 1200; i++) {
      sim.step(0.1)
      const dir = Math.sign(Math.cos(sim.pose[3]))
      if (dir !== lastDir) { legs++; lastDir = dir }
      for (let v = 1; v < sim.count; v++) {
        const prev = sim.models[sim.model[v - 1]], m = sim.models[sim.model[v]]
        const py = sim.pose[(v - 1) * 8 + 3], ty = sim.pose[v * 8 + 3]
        const hx = sim.pose[(v - 1) * 8] + Math.sin(py) * prev.hitch!.coupling!, hz = sim.pose[(v - 1) * 8 + 2] + Math.cos(py) * prev.hitch!.coupling!
        const ax = sim.pose[v * 8] + Math.sin(ty) * m.hitch!.axle!, az = sim.pose[v * 8 + 2] + Math.cos(ty) * m.hitch!.axle!
        const lead = sim.pose[3]
        // Along the tractor's heading, every trailer's axle trails its hitch, and it points the same way.
        assert.ok((hx - ax) * Math.sin(lead) + (hz - az) * Math.cos(lead) > 0, `step ${i}: trailer ${v} axle ahead of its hitch`)
        assert.ok(Math.cos(ty - lead) > 0.5, `step ${i}: trailer ${v} yaw ${ty.toFixed(2)} vs tractor ${lead.toFixed(2)}`)
      }
    }
    assert.ok(legs >= 4, `drove ${legs} legs`)
  }
})

test('exhaust: the GPU source table follows maxVents, selection buffers are reused', () => {
  const fleet = new Fleet({ groups: [{ type: 'car', count: 3, params: { style: 'sedan' }, route: { kind: 'static', position: [0, 0, 0] } }] })
  const exhaust = new VehicleExhaust(fleet, { maxVents: 8 })
  assert.equal(exhaust.particles.sources.cdf.length, 8)
  const before = exhaust.particles
  exhaust.set({ temperature: -3 })
  assert.equal(exhaust.particles, before, 'live settings keep the pool')
  exhaust.set({ maxVents: 40.4 })
  assert.equal(exhaust.particles.sources.cdf.length, 40, 'raising maxVents resizes the source table')
  assert.notEqual(exhaust.particles, before)
  exhaust.dispose()
  fleet.dispose()
  // The per-frame selection reuses the state's buffers.
  const sim = new FleetSim(settings([{ type: 'car', count: 50, params: { style: 'sedan' }, variants: 1, speed: [0, 0], route: { kind: 'static', position: [0, 0, 0], spacing: 6 } }]))
  const state = createExhaustState(sim.count), out = createExhaustBuffers(16)
  exhaustSources(sim, { x: 0, y: 0, z: 0 }, { ...DEFAULT_EXHAUST, maxVents: 16 }, state, 1 / 30, out)
  const bufs = [state.dist, state.pick]
  const first = [...out.vehicle]
  exhaustSources(sim, { x: 0, y: 0, z: 0 }, { ...DEFAULT_EXHAUST, maxVents: 16 }, state, 1 / 30, out)
  assert.equal(state.dist, bufs[0]); assert.equal(state.pick, bufs[1])
  assert.deepEqual([...out.vehicle], first)
  assert.deepEqual(first, Array.from({ length: 16 }, (_, i) => i), 'the nearest 16, nearest first')
  // Seen from the far end, and with ties (all at one spot: lowest index first).
  exhaustSources(sim, { x: 400, y: 0, z: 0 }, { ...DEFAULT_EXHAUST, maxVents: 16 }, state, 1 / 30, out)
  assert.deepEqual([...out.vehicle], Array.from({ length: 16 }, (_, i) => 49 - i))
  const pile = new FleetSim(settings([{ type: 'car', count: 30, params: { style: 'sedan' }, variants: 1, speed: [0, 0], route: { kind: 'static', position: [0, 0, 0], spacing: 1e-9 } }]))
  const few = createExhaustBuffers(10)
  exhaustSources(pile, { x: 5, y: 0, z: 5 }, { ...DEFAULT_EXHAUST, maxVents: 10 }, createExhaustState(pile.count), 1 / 30, few)
  assert.deepEqual([...few.vehicle], Array.from({ length: 10 }, (_, i) => i))
})
