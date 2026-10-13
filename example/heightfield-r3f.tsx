import * as THREE from 'three/webgpu'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { useControls } from 'leva'
import { raycastHeight, slopeAt, useHeightSampler } from 'threejs-heightfield/react'
import { panels } from './heightfield.panel'
import { SIZE, hills, slopeColor, surface } from './heightfield-scene'
import { Backdrop, View, mount, useHud, useSpec } from './r3f-shared'

// threejs-heightfield in React Three Fiber: the sandbox of heightfield.ts with useHeightSampler. The two sources the
// package supports, a height function (used as-is) and meshes baked into a heightfield (a 140 m patch, a rotated block
// and an arch: the highest surface wins), sampled on a grid of instanced markers coloured by slopeAt, with
// raycastHeight under the pointer. Every parameter default of the package is a control, from the same panel manifest
// (heightfield.panel.ts).
const spec = panels['threejs-heightfield']
const fnSurface = surface(SIZE, 160), patch = surface(140, 140)
const markerGeometry = new THREE.SphereGeometry(0.45, 8, 6)

function Sandbox() {
  const { maxResolution } = useSpec('createHeightSampler', spec.createHeightSampler)
  const { e } = useSpec('slopeAt', spec.slopeAt)
  const { maxDistance, step } = useSpec('raycastHeight', spec.raycastHeight)
  const view = useControls('view', { source: { value: 'mesh', options: ['function', 'mesh'] }, markers: { value: 96, min: 8, max: 256, step: 1 }, showSource: true })

  // Re-bakes only when the source or maxResolution changes (timed for the HUD).
  const [meshSource, setMeshSource] = useState<THREE.Group | null>(null)
  const t0 = performance.now()
  const sample = useHeightSampler(view.source === 'mesh' ? meshSource : hills, maxResolution)
  const bake = useRef({ sample, ms: 0 })
  if (bake.current.sample !== sample) bake.current = { sample, ms: performance.now() - t0 }

  // slopeAt is NaN where one of its probes falls off the baked patch (near its edge): no slope there, not a guess.
  const slope = (x: number, z: number) => {
    const s = slopeAt(sample, x, z, e)
    return Number.isFinite(s) ? s : null
  }

  // Markers: one instanced sphere per grid sample, at the sampled height, hidden where the sampler gives NaN.
  const n = view.markers
  const markers = useRef<THREE.InstancedMesh>(null)
  const hits = useRef(0)
  useLayoutEffect(() => {
    const mesh = markers.current!
    const m = new THREE.Matrix4(), c = new THREE.Color()
    hits.current = 0
    for (let j = 0, k = 0; j < n; j++) {
      for (let i = 0; i < n; i++, k++) {
        const x = (i / (n - 1) - 0.5) * SIZE, z = (j / (n - 1) - 0.5) * SIZE
        const y = sample(x, z)
        if (y !== y) { mesh.setMatrixAt(k, m.makeScale(0, 0, 0)); continue }
        hits.current++
        mesh.setMatrixAt(k, m.makeTranslation(x, y + 0.3, z))
        mesh.setColorAt(k, slopeColor(slope(x, z), c))
      }
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [sample, e, n])

  // raycastHeight under the pointer, every frame.
  const cursor = useRef<THREE.Mesh>(null)
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const ray = useRef<{ hit: THREE.Vector3 | null; us: number }>({ hit: null, us: 0 })
  useFrame(({ camera, pointer }) => {
    raycaster.setFromCamera(pointer, camera)
    const t = performance.now()
    const hit = raycastHeight(sample, raycaster.ray.origin, raycaster.ray.direction, maxDistance, step)
    ray.current = { hit, us: (performance.now() - t) * 1000 }
    cursor.current!.visible = !!hit
    if (hit) cursor.current!.position.copy(hit)
  })
  useEffect(() => void Object.assign(window, { sample }), [sample]) // for the console

  useHud(() => {
    const source = view.source === 'mesh' ? `mesh baked at maxResolution ${maxResolution} in ${bake.current.ms.toFixed(1)} ms` : 'height function (used as-is; maxResolution only applies to meshes)'
    const { hit, us } = ray.current
    const s = hit ? slope(hit.x, hit.z) : null
    const at = hit ? `hit (${hit.x.toFixed(1)}, ${hit.y.toFixed(2)}, ${hit.z.toFixed(1)}) · slope ${s?.toFixed(2) ?? '—'}` : 'no hit'
    return `threejs-heightfield · useHeightSampler — ${source}\n${hits.current.toLocaleString()} / ${(n ** 2).toLocaleString()} samples on terrain (NaN elsewhere)\nraycastHeight: ${at} · ${us.toFixed(0)} µs`
  })

  return (
    <>
      {/* Function source: drawn as a mesh, sampled straight from `hills`. */}
      <mesh geometry={fnSurface} visible={view.showSource && view.source === 'function'}>
        <meshStandardNodeMaterial color="#7d8659" roughness={0.95} />
      </mesh>
      {/* Mesh source: a 140 m patch (NaN outside it), a rotated block on it and an arch over it. */}
      <group ref={setMeshSource} visible={view.showSource && view.source === 'mesh'}>
        <mesh geometry={patch}>
          <meshStandardNodeMaterial color="#7d8659" roughness={0.95} />
        </mesh>
        <mesh position={[-35, hills(-35, 10) + 3, 10]} rotation-y={0.6}>
          <boxGeometry args={[18, 12, 30]} />
          <meshStandardNodeMaterial color="#a59d90" roughness={0.85} />
        </mesh>
        <mesh position={[-5, hills(-5, -40), -40]}>
          <torusGeometry args={[22, 2.5, 12, 48, Math.PI]} />
          <meshStandardNodeMaterial color="#a59d90" roughness={0.85} />
        </mesh>
      </group>
      <instancedMesh key={n} ref={markers} args={[markerGeometry, undefined, n * n]}>
        <meshStandardNodeMaterial roughness={0.5} />
      </instancedMesh>
      <mesh ref={cursor} visible={false}>
        <sphereGeometry args={[1.4, 16, 12]} />
        <meshStandardNodeMaterial color="#ffffff" emissive="#ff5a1f" />
      </mesh>
    </>
  )
}

function Scene() {
  return (
    <>
      <Backdrop color="#9cb8cc" />
      <directionalLight color="#fff1dc" intensity={2.6} position={[80, 140, 40]} />
      <hemisphereLight args={['#cfe3ff', '#5a5040', 1.1]} />
      <Sandbox />
      <View position={[150, 110, 150]} target={[0, 0, 0]} />
    </>
  )
}

mount(<Scene />, { fov: 50, near: 0.5, far: 5000 }, { toneMapping: THREE.ACESFilmicToneMapping })
