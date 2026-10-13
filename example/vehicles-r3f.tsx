import * as THREE from 'three/webgpu'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useControls } from 'leva'
import { RoadGraph } from 'threejs-city'
import { DEFAULT_FLEET, DEFAULT_VEHICLE, Fleet, VEHICLE_KINDS, VEHICLE_TYPES, Vehicle, defaultParams, fieldRoute, type FleetGroup, type FleetImpl, type VehicleImpl, type VehicleType } from 'threejs-vehicles/react'
import type { Choices, Ranges } from './leva-options'
import { Daylight, View, mount, useHud, useOptions, type V3 } from './r3f-shared'
import { FIELD, GALLERY_ROWS, JUNCTION, fieldMesh, junctionLoop, junctionMesh, rowPosition, skyEnvironment } from './vehicles-rows'

// threejs-vehicles in React Three Fiber. Gallery: a <Vehicle> per type, with shared settings and each
// type's own parameters, plus the real-scale rows (car lookalikes, pickups, trucks, tractors) behind it. Traffic: one <Fleet> on a threejs-city RoadGraph street grid, with planes
// overhead and a rocket launch. Every control is a component prop; the instances are never remounted.
const { type: _t, params: _p, tint: _c, heading: _h, ...SHARED } = { ...DEFAULT_VEHICLE, speed: 6 }

const defs = VEHICLE_TYPES.flatMap((type) => Object.entries(VEHICLE_KINDS[type].params).map(([k, d]) => [`${type}/${k}`, d] as const))
const PARAM_CONTROLS = {
  ranges: Object.fromEntries(defs.flatMap(([k, d]) => (d.type === 'number' ? [[k, [d.min, d.max, d.step ?? 0.01]]] : []))) as Ranges,
  choices: Object.fromEntries(defs.flatMap(([k, d]) => (d.type === 'choice' ? [[k, d.options]] : []))) as Choices,
}

/** One vehicle on a turntable, shown about 9 m long so a bicycle and a carrier compare by shape. */
function Exhibit({ type, index, turntable, settings }: { type: VehicleType; index: number; turntable: boolean; settings: Record<string, any> }) {
  const pivot = useRef<THREE.Group>(null)
  const [vehicle, setVehicle] = useState<VehicleImpl | null>(null)
  useEffect(() => {
    if (!vehicle) return
    const m = vehicle.fleet.sim.models[0]
    const k = 9 / Math.max(...m.size)
    vehicle.object.scale.setScalar(k)
    vehicle.object.position.y = -Math.min(...m.parts.map((p) => p.mesh.bounds[1])) * k
  })
  useFrame((_, dt) => void (turntable && pivot.current && (pivot.current.rotation.y += dt * 0.3)))
  return (
    <group ref={pivot} position={[((index % 4) - 1.5) * 15, 0, (Math.floor(index / 4) - 1) * 15]}>
      <Vehicle ref={setVehicle} type={type} seed={index + 1} {...settings} />
    </group>
  )
}

/** Reflections for paint, glass and metal: the sky gradient as the scene environment. */
function SkyEnvironment() {
  const { gl, scene } = useThree()
  useEffect(() => skyEnvironment(gl as unknown as THREE.WebGPURenderer, scene), [gl, scene])
  return null
}

function Gallery({ night }: { night: number }) {
  const { turntable, frame } = useControls('Gallery', { turntable: true, frame: { value: 'all types', options: ['all types', ...GALLERY_ROWS.map((r) => r.name), 'junction', 'field'] } })
  const field = useMemo(() => ({ mesh: fieldMesh(), groups: [{ type: 'tractor', count: 1, params: { family: 'green', implement: 'seeder' }, speed: [3.5, 3.5], route: fieldRoute(FIELD.center, FIELD.rows, FIELD.spacing, FIELD.length) }] as FleetGroup[] }), [])
  const junction = useMemo(() => ({ mesh: junctionMesh(), groups: [{ type: 'truck', count: 1, params: { trailers: 3, trailer: 'mixed', cab: 'conventional', sleeper: true }, speed: [9, 9], route: { kind: 'path', points: junctionLoop().points, closed: true, smooth: 1 } }] as FleetGroup[] }), [])
  const view = useMemo(() => {
    if (frame === 'field') return { position: [FIELD.center[0] + 40, 30, FIELD.center[2] - 55] as V3, target: [FIELD.center[0], 0, FIELD.center[2] - 10] as V3 }
    if (frame === 'junction') return { position: [JUNCTION.min[0] - 45, 38, JUNCTION.min[1] - 40] as V3, target: [JUNCTION.min[0] + 25, 0, JUNCTION.min[1] + 25] as V3 }
    const r = GALLERY_ROWS.findIndex((row) => row.name === frame)
    if (r < 0) return { position: [0, 26, 52] as V3, target: [0, 2, 0] as V3 }
    const [x0, z] = rowPosition(r, 0), [x1] = rowPosition(r, GALLERY_ROWS[r].items.length - 1)
    return { position: [(x0 + x1) / 2 + 4, 6, z + Math.abs(x1 - x0) * 0.9 + 6] as V3, target: [(x0 + x1) / 2, 0.8, z] as V3 }
  }, [frame])
  const shared = useOptions('All vehicles', SHARED, {
    ranges: { speed: [0, 30], lights: [0, 1], crumple: [0, 0.5], period: [20, 300, 1], seed: [1, 100, 1], wetness: [0, 1], snow: [0, 1], burn: [0, 1], damage: [0, 1], heat: [0, 1] },
  })
  // Each type's own parameters, one folder per type (ranges and choices keyed by path, as names repeat across types).
  const perType = useOptions('Per type', Object.fromEntries(VEHICLE_TYPES.map((type) => [type, { ...defaultParams(type), ...(type === 'train' ? { wagons: 2 } : {}), tint: '' }])), PARAM_CONTROLS, true)
  useHud(() => `threejs-vehicles · <Vehicle> × ${VEHICLE_TYPES.length}, each at ~9 m for comparison\none InstancedMesh per part (body, wheels, fans, stages), one material`)
  return (
    <>
      <Daylight night={night} target={[0, 0, 30]} extent={90} />
      <gridHelper args={[120, 60, '#6d8aa0', '#86a3b8']} />
      <SkyEnvironment />
      {/* A road train on a loop through a large-radius junction: trailers off-track inside the kerb, not over it. */}
      <primitive object={junction.mesh} />
      <Fleet seed={4} groups={junction.groups} lights={night} />
      {/* A tractor working a field in rows (its WheelInteractors are what threejs-grass bends blades around). */}
      <primitive object={field.mesh} />
      <Fleet seed={2} groups={field.groups} lights={night} />
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.01, 80]} receiveShadow>
        <planeGeometry args={[400, 400]} />
        <meshStandardNodeMaterial color="#8b8d8f" roughness={0.92} />
      </mesh>
      {GALLERY_ROWS.flatMap((row, r) => row.items.map((item, i) => {
        const [x, z] = rowPosition(r, i)
        return (
          <group key={`${row.name}-${i}`} position={[x, 0, z]}>
            <Vehicle type={item.type} seed={11 + r * 17 + i} {...shared} params={item.params} lights={Math.max(shared.lights, night)} />
          </group>
        )
      }))}
      {VEHICLE_TYPES.map((type, i) => {
        const { tint, ...params } = perType[type] ?? {}
        return <Exhibit key={type} type={type} index={i} turntable={turntable} settings={{ ...shared, params, tint, lights: Math.max(shared.lights, night) }} />
      })}
      <View position={view.position} target={view.target} />
    </>
  )
}

// Traffic: a 7 × 7 street grid as a threejs-city RoadGraph (what `city.graph` gives you on a generated city).
const N = 7, S = 75, X0 = -820, Z0 = -260
const graph = new RoadGraph(70)
{
  const ids: number[] = []
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) ids.push(graph.addNode(X0 + i * S + (j % 2) * 6, Z0 + j * S + (i % 3) * 4))
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const main = i === 3 || j === 3
    if (i < N - 1) graph.addEdge(ids[j * N + i], ids[j * N + i + 1], main ? 'primary' : 'minor', main ? 12 : 8, 2)
    if (j < N - 1) graph.addEdge(ids[j * N + i], ids[(j + 1) * N + i], main ? 'primary' : 'minor', main ? 12 : 8, 2)
  }
}
const center: [number, number, number] = [X0 + S * 3, 0, Z0 + S * 3]

function Traffic({ night }: { night: number }) {
  const [fleet, setFleet] = useState<FleetImpl | null>(null)
  const counts = useControls('Traffic', {
    cars: { value: 140, min: 0, max: 600, step: 1 },
    buses: { value: 6, min: 0, max: 40, step: 1 },
    bicycles: { value: 30, min: 0, max: 200, step: 1 },
    airplanes: { value: 3, min: 0, max: 12, step: 1 },
  })
  const settings = useOptions('Fleet', DEFAULT_FLEET, {
    skip: ['groups', 'waves', 'rocket', 'lights'],
    ranges: { seed: [1, 100, 1], timeScale: [0, 5], crumple: [0, 0.5], tilt: [0, 1], wetness: [0, 1], snow: [0, 1], burn: [0, 1], damage: [0, 1], heat: [0, 1], rain: [0, 1], snowfall: [0, 1], budget: [10, 2000, 1] },
  })
  const groups = useMemo<FleetGroup[]>(() => [
    { type: 'car', count: counts.cars, variants: 8, route: { kind: 'roads' } },
    { type: 'car', count: counts.buses, params: { style: 'bus' }, route: { kind: 'roads' } },
    { type: 'bicycle', count: counts.bicycles, route: { kind: 'roads' } },
    { type: 'airplane', count: counts.airplanes, route: { kind: 'circle', center: [center[0], 450, center[2]], radius: 1600 } },
    { type: 'rocket', count: 1, route: { kind: 'pad', position: [X0 - 250, 0, Z0 + S * 3], heading: Math.PI / 2, period: 90, delay: 4, countdown: 8 } },
  ], [counts.cars, counts.buses, counts.bicycles, counts.airplanes])
  const ground = useMemo(() => streets(graph), [])
  useEffect(() => void Object.assign(window, { fleet }), [fleet]) // for the console
  useHud(() => (fleet ? `threejs-vehicles · <Fleet> on a RoadGraph\n${fleet.count} vehicles · ${fleet.drawCalls} draw calls` : ''))
  return (
    <>
      <Daylight night={night} target={center} extent={600} fog={[1500, 9000]} />
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[8000, 8000]} />
        <meshStandardNodeMaterial color="#6b8f45" roughness={0.95} />
      </mesh>
      <mesh geometry={ground} receiveShadow>
        <meshStandardNodeMaterial color="#3a3b3e" roughness={0.9} />
      </mesh>
      <Fleet ref={setFleet} roads={graph} height={() => 0.05} {...settings} groups={groups} lights={night} />
      <View position={[center[0] + 90, 90, center[2] + 235]} target={[center[0], 0, center[2] + 75]} />
    </>
  )
}

/** Road surfaces of a RoadGraph as one geometry. */
function streets(g: RoadGraph): THREE.BufferGeometry {
  const pos: number[] = []
  for (const e of g.edges) {
    const a = g.nodes[e.a], b = g.nodes[e.b]
    const l = Math.hypot(b.x - a.x, b.z - a.z), w = e.width / 2
    const nx = (-(b.z - a.z) / l) * w, nz = ((b.x - a.x) / l) * w, ex = ((b.x - a.x) / l) * w, ez = ((b.z - a.z) / l) * w
    const q = [[a.x - nx - ex, a.z - nz - ez], [b.x - nx + ex, b.z - nz + ez], [b.x + nx + ex, b.z + nz + ez], [a.x + nx - ex, a.z + nz - ez]]
    for (const k of [0, 2, 1, 0, 3, 2]) pos.push(q[k][0], 0.03, q[k][1])
  }
  const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.computeVertexNormals()
  return geo
}

function Scene() {
  const { view, night } = useControls('Scene', { view: { value: 'gallery', options: ['gallery', 'traffic'] }, night: { value: 0, min: 0, max: 1, step: 0.01 } })
  return view === 'gallery' ? <Gallery night={night} /> : <Traffic night={night} />
}

mount(<Scene />, { fov: 50, near: 0.1, far: 30_000 })
