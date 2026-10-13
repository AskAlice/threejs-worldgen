import * as THREE from 'three/webgpu'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useControls } from 'leva'
import { Corn, Grass, type CornImpl, type GrassImpl } from 'threejs-grass/react'
import { panels } from './corn.panel'
import { FIELDS, SUN, TRACTOR_RADIUS, createTractor, driveTractor, farm, farmGeometry, farmGrassMap, predrive, view } from './corn-shared'
import { View, mount, useHud, useSpec } from './r3f-shared'
import { createEnvironment, createGroundMaterial, keepAboveGround } from './shared'

// threejs-grass corn in React Three Fiber: a <Corn> per field (every option of the mature one is a leva prop, from
// the same manifest as the three.js sandbox) and a box tractor driving laps through it. `?view=2|20|200|path`, `?t=`.
const params = new URLSearchParams(location.search)
const start = view(params.get('view') ?? '20')
const t0 = Number(params.get('t') ?? 50)
const grassMap = farmGrassMap()

/** Sky, sun + shadows, IBL, haze and bloom, as in the grass demo. Takes over rendering (useFrame priority 1). */
function Environment() {
  const { gl, scene, camera, controls } = useThree() as any
  const env = useMemo(() => {
    const e = createEnvironment(gl, scene, camera)
    scene.fog.density = 0.0011 // clear farmland air, as in the three.js sandbox
    e.setSun(...SUN)
    return e
  }, [gl, scene, camera])
  useEffect(() => () => env.dispose(), [env])
  useFrame(() => {
    keepAboveGround(camera, farm, 0.5)
    if (controls) env.follow(controls.target)
    env.render()
  }, 1)
  return null
}

function Scene() {
  const terrain = useRef<THREE.Mesh>(null)
  const geometry = useMemo(() => farmGeometry(), [])
  const tractor = useMemo(() => createTractor(), [])
  const [grass, setGrass] = useState<GrassImpl | null>(null)
  const [corn, setCorn] = useState<CornImpl | null>(null)
  const time = useRef(t0)
  const mature = useSpec('Corn', panels['threejs-grass'].Corn)
  const field = useControls('Field (mature)', {
    rowDirection: { value: FIELDS[0].field.rowDirection, min: -Math.PI, max: Math.PI, step: 0.01 },
    rowSpacing: { value: FIELDS[0].field.rowSpacing, min: 0.4, max: 1.5, step: 0.01 },
  })
  const drive = useControls('Tractor', { speed: { value: 1, min: 0, max: 5 }, radius: { value: TRACTOR_RADIUS, min: 0.3, max: 3 } })

  useEffect(() => {
    if (grass && terrain.current) terrain.current.material = createGroundMaterial(grass)
  }, [grass])
  // Flatten the track driven before the page loaded (again whenever the field is rebuilt).
  useEffect(() => void (corn && predrive(corn, time.current)), [corn, field.rowDirection, field.rowSpacing])
  useEffect(() => void Object.assign(window, { demo: { corn, grass, tractor } }), [corn, grass, tractor])
  const frames = useRef(0)
  useFrame((_, dt) => {
    time.current += dt * drive.speed
    driveTractor(tractor, time.current)
    if (corn && ++frames.current === 30) Object.assign((window as any).demo, { ready: true }) // for screenshot scripts
  })
  useHud(() => `threejs-grass · <Corn> × ${FIELDS.length} fields · ${corn?.stats.plants.toLocaleString() ?? 0} plants near the camera\nbox tractor: interactor of radius ${drive.radius.toFixed(1)} m, flattening a track`)

  return (
    <>
      <Environment />
      <mesh ref={terrain} geometry={geometry} receiveShadow>
        <meshStandardNodeMaterial color="#1c2a10" />
      </mesh>
      <primitive object={tractor} />
      <Grass ref={setGrass} terrain={farm} grassMap={grassMap} maxDistance={120} preset="perennialRyegrass" bladeHeight={0.35} patchiness={0.12} />
      <Corn ref={setCorn} terrain={farm} {...mature}
        fields={[{ ...FIELDS[0].field, rowDirection: field.rowDirection, rowSpacing: field.rowSpacing }]}
        interactors={[{ object: tractor, radius: drive.radius }]} />
      {FIELDS.slice(1).map(({ name, field, input }) => <Corn key={name} terrain={farm} fields={[field]} {...input} />)}
      <View position={start.position} target={start.target} />
    </>
  )
}

mount(<Scene />, { position: start.position, fov: 50, near: 0.1, far: 5000 })
