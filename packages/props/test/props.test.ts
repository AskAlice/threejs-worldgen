import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Matrix4, Quaternion, Vector3 } from 'three/webgpu'
import { World, createSample } from 'threejs-biomes'
import {
  buildProp, catenaryParameter, catenaryPoints, decorateRoads, planPowerLine, propAssets, PROP_KIND_IDS, PROP_KINDS, Props, roadRibbon, ROAD_PART,
  SHAPES, shapeData, type PropPlacement, type RoadNetworkLike,
} from '../src/index.ts'

const world = new World({ seed: 7 })
const C = [-3000, 2000] as const

// A small town: a primary avenue (x) crossed by a minor street (z), and a rural dirt road leaving east.
const net: RoadNetworkLike = {
  nodes: [
    { x: C[0], z: C[1] }, { x: C[0] - 160, z: C[1] }, { x: C[0] + 160, z: C[1] }, { x: C[0], z: C[1] - 140 }, { x: C[0], z: C[1] + 140 },
    { x: C[0] + 400, z: C[1] + 60 }, { x: C[0] + 650, z: C[1] - 20 },
  ],
  edges: [
    { a: 0, b: 1, type: 'primary', width: 10, sidewalk: 3, surface: 'asphalt' },
    { a: 0, b: 2, type: 'primary', width: 10, sidewalk: 3, surface: 'asphalt' },
    { a: 0, b: 3, type: 'minor', width: 7, sidewalk: 2, surface: 'asphalt' },
    { a: 0, b: 4, type: 'minor', width: 7, sidewalk: 2, surface: 'asphalt' },
    { a: 2, b: 5, type: 'minor', width: 5, sidewalk: 0, surface: 'dirt' },
    { a: 5, b: 6, type: 'minor', width: 5, sidewalk: 0, surface: 'dirt' },
  ],
}

function distToEdge(x: number, z: number, e: RoadNetworkLike['edges'][number]) {
  const a = net.nodes[e.a], b = net.nodes[e.b]
  const dx = b.x - a.x, dz = b.z - a.z
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)))
  return Math.hypot(a.x + dx * t - x, a.z + dz * t - z)
}

test('shapes: finite, indices in range, unit normals, outward-facing triangles, inside the unit box', () => {
  for (const id of SHAPES) {
    const m = shapeData(id)
    const nv = m.position.length / 3
    for (const v of [...m.position, ...m.normal, ...m.uv]) assert.ok(Number.isFinite(v), `${id}: non-finite`)
    for (const i of m.index) assert.ok(i < nv, `${id}: index out of range`)
    for (let i = 0; i < nv; i++) {
      assert.ok(Math.abs(Math.hypot(m.normal[i * 3], m.normal[i * 3 + 1], m.normal[i * 3 + 2]) - 1) < 1e-4, `${id}: normal length`)
      assert.ok(Math.abs(m.position[i * 3]) <= 0.5 + 1e-6 && Math.abs(m.position[i * 3 + 2]) <= 0.5 + 1e-6, `${id}: outside x/z`)
      assert.ok(m.position[i * 3 + 1] >= -1e-6 && m.position[i * 3 + 1] <= 1 + 1e-6, `${id}: outside y`)
    }
    let bad = 0
    for (let t = 0; t < m.index.length; t += 3) {
      const [a, b, c] = [m.index[t], m.index[t + 1], m.index[t + 2]]
      const p = (k: number) => new Vector3(m.position[k * 3], m.position[k * 3 + 1], m.position[k * 3 + 2])
      const fn = p(b).sub(p(a)).cross(p(c).sub(p(a)))
      if (fn.lengthSq() < 1e-12) continue
      const vn = new Vector3(m.normal[a * 3] + m.normal[b * 3] + m.normal[c * 3], m.normal[a * 3 + 1] + m.normal[b * 3 + 1] + m.normal[c * 3 + 1], m.normal[a * 3 + 2] + m.normal[b * 3 + 2] + m.normal[c * 3 + 2])
      if (fn.dot(vn) <= 0) bad++
    }
    assert.equal(bad, 0, `${id}: ${bad} triangles wound against their normals`)
  }
})

test('every kind and variant builds valid, seeded parts', () => {
  for (const kind of PROP_KIND_IDS) {
    for (const variant of PROP_KINDS[kind].variants) {
      const a = buildProp({ kind, seed: 42, variant })
      assert.ok(a.parts.length > 0, `${kind}/${variant}: no parts`)
      assert.deepEqual(buildProp({ kind, seed: 42, variant }), a, `${kind}/${variant}: not deterministic`)
      for (const p of a.parts) {
        for (const v of [...p.p, ...p.q, ...p.s, ...p.color]) assert.ok(Number.isFinite(v), `${kind}/${variant}: non-finite part`)
        assert.ok(p.s.every((s) => s > 0), `${kind}/${variant}: non-positive size`)
        assert.ok(Math.abs(Math.hypot(...p.q) - 1) < 1e-9, `${kind}/${variant}: quaternion not unit`)
        assert.ok(p.color.every((c) => c >= 0 && c <= 1))
      }
    }
  }
  const seeds = new Set(Array.from({ length: 12 }, (_, i) => JSON.stringify(buildProp({ kind: 'mailbox-us', seed: i }).parts.map((p) => p.color))))
  assert.ok(seeds.size > 2, 'seeds should vary colours')
  assert.equal(buildProp({ kind: 'power-pole', seed: 1 }).attach.length, 3)
  assert.equal(buildProp({ kind: 'pylon', seed: 1 }).attach.length, 5)
})

test('catenary: endpoints exact, sag exact at midspan, symmetric, below the chord', () => {
  const a = [0, 10, 0], b = [100, 10, 0]
  for (const sag of [0.5, 2.5, 10, 40]) {
    const pts = catenaryPoints(a, b, sag, 20)
    assert.deepEqual([...pts.slice(0, 3)], a)
    assert.deepEqual([...pts.slice(-3)], b)
    assert.ok(Math.abs(10 - pts[10 * 3 + 1] - sag) < 1e-3 * Math.max(1, sag), `sag ${sag}: got ${10 - pts[31]}`)
    for (let i = 0; i <= 20; i++) {
      assert.ok(Math.abs(pts[i * 3 + 1] - pts[(20 - i) * 3 + 1]) < 1e-4, 'not symmetric')
      assert.ok(pts[i * 3 + 1] <= 10 + 1e-6, 'above the chord')
      if (i > 0 && i <= 10) assert.ok(pts[i * 3 + 1] < pts[(i - 1) * 3 + 1], 'not falling to midspan')
    }
  }
  // A catenary is steeper near the supports than a parabola of the same sag would be at large sag.
  const k = catenaryParameter(100, 40)
  assert.ok(Math.abs(k * (Math.cosh(50 / k) - 1) - 40) < 1e-6)
  // Inclined span: still exact at the ends; no sag = a straight line.
  const inc = catenaryPoints([0, 0, 0], [30, 12, 40], 1.2, 8)
  assert.ok(Math.abs(inc[8 * 3 + 1] - 12) < 1e-5 && Math.abs(inc[8 * 3 + 2] - 40) < 1e-5)
  const straight = catenaryPoints([0, 0, 0], [10, 5, 0], 0, 4)
  for (let i = 0; i <= 4; i++) assert.ok(Math.abs(straight[i * 3 + 1] - i * 1.25) < 1e-6)
})

test('road ribbon: valid mesh, carriageway faces up and stays above the ground', () => {
  const pts: [number, number][] = [[C[0], C[1]], [C[0] + 60, C[1] + 20], [C[0] + 140, C[1] + 5]]
  for (const sidewalk of [0, 2]) {
    const d = roadRibbon(pts, { width: 6, sidewalk }, world.height)
    const nv = d.position.length / 3
    assert.ok(nv > 0 && d.index.length % 3 === 0)
    for (const v of d.position) assert.ok(Number.isFinite(v))
    for (const i of d.index) assert.ok(i < nv)
    assert.ok(Math.abs(d.length - (Math.hypot(60, 20) + Math.hypot(80, 15))) < 1e-6)
    for (let i = 0; i < nv; i++) {
      if (d.part[i] !== ROAD_PART.carriageway) continue
      assert.ok(d.normal[i * 3 + 1] > (Math.abs(d.uv[i * 2]) < 3 - 1e-6 ? 0.5 : 0), 'carriageway or verge facing down')
      if (Math.abs(d.uv[i * 2]) >= 3 - 1e-6) continue
      const x = d.position[i * 3], y = d.position[i * 3 + 1], z = d.position[i * 3 + 2]
      assert.ok(y >= world.height(x, z) - 0.05, 'carriageway under the ground')
    }
    if (sidewalk) assert.ok(d.part.includes(ROAD_PART.sidewalk) && d.part.includes(ROAD_PART.curb))
  }
})

test('decorateRoads: deterministic, off the carriageway, out of water, the right props in the right places', () => {
  const place = () => decorateRoads(net, world, { seed: 3 })
  const a = place()
  assert.deepEqual(place(), a)
  assert.notDeepEqual(decorateRoads(net, world, { seed: 4 }), a)
  const count = (k: string) => a.filter((p) => p.kind === k).length
  for (const k of ['street-light', 'hydrant', 'traffic-light', 'power-pole', 'bin']) assert.ok(count(k) > 0, `no ${k}`)
  const s = createSample()
  const urban = net.edges.filter((e) => e.sidewalk > 0), rural = net.edges.filter((e) => e.sidewalk === 0)
  for (const p of a) {
    world.sample(p.x, p.z, s)
    assert.ok(!(s.waterLevel > s.elevation), `${p.kind} in water`)
    for (const e of net.edges) assert.ok(distToEdge(p.x, p.z, e) > e.width / 2 + 0.2, `${p.kind} on the carriageway`)
    const nearUrban = Math.min(...urban.map((e) => distToEdge(p.x, p.z, e) - e.width / 2 - e.sidewalk))
    const nearRural = Math.min(...rural.map((e) => distToEdge(p.x, p.z, e) - e.width / 2))
    if (p.kind === 'hydrant' || p.kind === 'bin' || p.kind === 'bench' || p.kind === 'street-light') assert.ok(nearUrban <= 0.01, `${p.kind} off the sidewalk`)
    if (p.kind === 'power-pole') assert.ok(nearRural < 6 && nearUrban > 0, 'power pole away from the rural road')
    if (p.kind === 'traffic-light') assert.ok(Math.hypot(p.x - C[0], p.z - C[1]) < 25, 'traffic light away from the junction')
    assert.ok(Math.abs(p.y - world.height(p.x, p.z)) < 3, `${p.kind} floating or buried`)
  }
  // Props never overlap.
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
    if (a[i].kind === 'hay-bale' || a[j].kind === 'hay-bale') continue
    assert.ok(Math.hypot(a[i].x - a[j].x, a[i].z - a[j].z) > 0.3, `${a[i].kind} on ${a[j].kind}`)
  }
  // Power poles: one line along the rural run, roughly evenly spaced.
  const poles = a.filter((p) => p.kind === 'power-pole')
  assert.equal(new Set(poles.map((p) => p.line)).size, 1)
  for (let i = 1; i < poles.length; i++) {
    const d = Math.hypot(poles[i].x - poles[i - 1].x, poles[i].z - poles[i - 1].z)
    assert.ok(d > 25 && d < 100, `pole spacing ${d.toFixed(1)}`)
  }
  // Mailboxes go to lot frontages when lots are given.
  const lots = [{ district: 'residential', building: 0, frontage: { x: C[0] + 300, z: C[1] + 38, nx: 0, nz: 1, edge: 4 } }]
  const withLots = decorateRoads(net, world, { seed: 3 }, { lots })
  const box = withLots.find((p) => p.kind === 'mailbox-us')
  assert.ok(box && Math.hypot(box.x - (C[0] + 300), box.z - (C[1] + 38)) < 40, 'mailbox not at the lot')
})

test('planPowerLine: evenly spaced pylons on one line, turned across it, never in water', () => {
  const line = planPowerLine([[C[0] - 600, C[1] - 400], [C[0] + 600, C[1] + 300]], world, { seed: 2, spacing: 250 })
  assert.deepEqual(planPowerLine([[C[0] - 600, C[1] - 400], [C[0] + 600, C[1] + 300]], world, { seed: 2, spacing: 250 }), line)
  assert.ok(line.length >= 5)
  assert.equal(new Set(line.map((p) => p.line)).size, 1)
  const s = createSample()
  for (const p of line) {
    world.sample(p.x, p.z, s)
    assert.ok(!(s.waterLevel > s.elevation))
    assert.ok(Math.abs(Math.sin(p.yaw) - 1200 / Math.hypot(1200, 700)) < 1e-6, 'pylon not along the line')
  }
})

test('Props: one instanced mesh per (shape, material), cables per span, damage leans, states reach the shader attribute', () => {
  const placements: PropPlacement[] = [
    { kind: 'power-pole', x: 0, y: 0, z: 0, yaw: 0, seed: 1, line: 1 },
    { kind: 'power-pole', x: 0, y: 0, z: 40, yaw: 0, seed: 2, line: 1 },
    { kind: 'power-pole', x: 0, y: 0, z: 80, yaw: 0, seed: 3, line: 1 },
    { kind: 'street-light', x: 5, y: 0, z: 0, yaw: 0, seed: 4 },
    { kind: 'fence', x: 9, y: 0, z: 0, yaw: 0, seed: 5, variant: 'adobe', length: 3 },
  ]
  const props = new Props({ placements, cables: { segments: 6 } })
  const keys = [...props.meshes.keys()]
  assert.equal(new Set(keys).size, keys.length)
  const parts = placements.reduce((n, p) => n + buildProp(p).parts.length, 0)
  const instanced = [...props.meshes.entries()].filter(([k]) => k !== 'cables').reduce((n, [, m]) => n + m.count, 0)
  assert.equal(instanced, parts)
  assert.equal(props.meshes.get('cables')!.count, 2 * 3 * 6)
  for (const m of props.meshes.values()) {
    assert.ok(!Array.isArray(m.material), 'multi-material mesh')
    assert.equal(m.instanceColor, null, 'instanceColor tints snow')
    assert.ok(m.geometry.getAttribute('aTint') && m.geometry.getAttribute('aStates'))
  }
  // The middle pole's top before and after full damage.
  const poleTop = () => {
    const pole = props.meshes.get('cylinder|wood')!
    const m = new Matrix4().fromArray(pole.instanceMatrix.array as Float32Array, 16)
    const p = new Vector3(), q = new Quaternion(), s = new Vector3()
    m.decompose(p, q, s)
    return new Vector3(0, 1, 0).applyQuaternion(q)
  }
  assert.ok(poleTop().y > 0.9999)
  props.states.set(1, { damage: 1, snow: 0.5 })
  props.update()
  assert.ok(Math.acos(poleTop().y) > 0.3, 'damaged pole does not lean')
  const st = props.meshes.get('cylinder|wood')!.geometry.getAttribute('aStates').array
  assert.equal(st[4 + 3], 1)
  assert.equal(st[4 + 1], 0.5)
  props.set({ placements: placements.slice(3) })
  assert.equal(props.meshes.has('cables'), false)
  assert.equal(props.states.count, 2)
  props.dispose()
})

test('propAssets: unique ids, valid rules, every kind and fence style covered', () => {
  const defs = propAssets()
  assert.equal(new Set(defs.map((d) => d.id)).size, defs.length)
  for (const kind of PROP_KIND_IDS) assert.ok(defs.some((d) => d.id === `props/${kind}`))
  for (const s of ['picket', 'rail', 'adobe', 'stone']) assert.ok(defs.find((d) => d.id === `props/fence-${s}`)!.placement.biomes!.length > 0)
  const ids = new Set(world.options.biomes.map((b) => b.id))
  for (const d of defs) {
    for (const b of d.placement.biomes ?? []) assert.ok(ids.has(b), `${d.id}: unknown biome ${b}`)
    if (d.placement.slope) assert.ok(d.placement.slope[0] <= d.placement.slope[1])
    assert.equal(d.package, 'threejs-props')
  }
  assert.ok(defs.find((d) => d.id === 'props/fence-adobe')!.placement.biomes!.includes('desert'))
  assert.ok(defs.find((d) => d.id === 'props/hay-bale')!.placement.biomes!.includes('grassland'))
})
