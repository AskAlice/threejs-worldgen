import { test } from 'node:test'
import assert from 'node:assert/strict'
import { World } from 'threejs-biomes'
import { isPlausible } from '../../worldgen/src/assets.ts'
import { MeshBuilder, paint, type MeshData } from '../src/mesh.ts'
import { buildVehicle, VEHICLE_TYPES, VEHICLE_KINDS, type VehicleType } from '../src/models.ts'
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
  assert.equal(m.style.length, nv * 2)
}

// Expected size ranges (x width, y height, z length) in metres, loose enough for seeded variety.
const SIZES: Record<VehicleType, [number, number][]> = {
  car: [[1.5, 2.8], [1.2, 3.4], [3.4, 12.5]],
  bicycle: [[0.3, 0.7], [1.0, 2.0], [1.4, 2.0]],
  train: [[2.8, 3.4], [3.8, 5], [16, 22]],
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
