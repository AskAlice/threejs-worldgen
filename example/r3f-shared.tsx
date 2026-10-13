// Shared pieces of the per-package React Three Fiber sandboxes (`<pkg>-r3f.html`): a WebGPU canvas,
// daylight, a terrain patch from a threejs-biomes world, orbit controls, a HUD, and leva controls
// generated from a package's JSON options.
import * as THREE from 'three/webgpu'
import { createRoot } from 'react-dom/client'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Canvas, extend, useFrame, useThree, type CameraProps, type ThreeToJSXElements } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { folder, levaStore, useControls } from 'leva'
import type { World } from 'threejs-biomes'
import { levaSchema, nest, specSchema, type SchemaOptions } from './leva-options'
import type { PanelClassSpec } from './panel'
import { worldGround } from './world-ground'

declare module '@react-three/fiber' {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}
extend(THREE as any)

export type V3 = [number, number, number]

/** Renders `scene` into `#root` on a WebGPURenderer (`?webgl` forces the WebGL backend), as the grass R3F demo does. */
export function mount(scene: ReactNode, camera: CameraProps) {
  Object.assign(window, { levaStore }) // for the console: levaStore.setValueAtPath('City.facade.facade/night', 1, true)
  createRoot(document.getElementById('root')!).render(
    <Canvas
      dpr={[1, 1.5]}
      shadows="percentage"
      camera={camera}
      gl={async (props) => {
        const renderer = new THREE.WebGPURenderer({ ...(props as any), antialias: true, forceWebGL: location.search.includes('webgl') })
        await renderer.init()
        return renderer
      }}
    >
      {scene}
    </Canvas>,
  )
}

/** leva controls for a package's JSON options (see {@link levaSchema}), returned nested, ready to spread onto the package's component. */
export function useOptions(name: string, defaults: object, opts: SchemaOptions = {}, collapsed = false): Record<string, any> {
  const [values] = useControls(name, () => levaSchema(defaults, folder, opts) as any, { collapsed }, []) as unknown as [Record<string, unknown>]
  return nest(values)
}

/**
 * leva controls for one class of a panel manifest (`example/<demo>.panel.ts`): its `target` (or `defaults`) with the
 * manifest's skips, ranges, choices and arrays, so the R3F sandbox shows what the three.js sandbox shows. The folder
 * is named after the class; scripts/options-coverage.mjs checks every class a manifest's `r3f` lists this way.
 */
export function useSpec(name: string, spec: PanelClassSpec, collapsed = false): Record<string, any> {
  return useOptions(name, (spec.target ?? spec.defaults) as object, specSchema(spec), collapsed)
}

/** Writes `text()` into `#hud` twice a second. */
export function useHud(text: () => string) {
  const last = useRef(0)
  useFrame(() => {
    const now = performance.now()
    if (now - last.current < 500) return
    last.current = now
    document.getElementById('hud')!.textContent = text()
  })
}

const DAY = new THREE.Color('#9cc4e4'), NIGHT = new THREE.Color('#0b1020')

/** Sky colour, fog, a shadow-casting sun over `target` (shadows cover ±`extent` m) and sky light; `night` 0…1 dims it all. */
export function Daylight({ night = 0, target = [0, 0, 0], extent = 200, fog }: { night?: number; target?: V3; extent?: number; fog?: [near: number, far: number] }) {
  const scene = useThree((s) => s.scene)
  const sun = useRef<THREE.DirectionalLight>(null)
  const [aim] = useState(() => new THREE.Object3D())
  const background = useMemo(() => DAY.clone().lerp(NIGHT, night), [night])
  useEffect(() => {
    scene.background = background
    scene.fog = fog ? new THREE.Fog(background, fog[0], fog[1]) : null
  }, [scene, background, fog?.[0], fog?.[1]])
  useLayoutEffect(() => {
    const cam = sun.current!.shadow.camera
    Object.assign(cam, { left: -extent, right: extent, top: extent, bottom: -extent, near: 1, far: extent * 6 })
    cam.updateProjectionMatrix()
  }, [extent])
  const [x, y, z] = target
  return (
    <>
      <primitive object={aim} position={target} />
      <directionalLight ref={sun} target={aim} position={[x - extent * 0.8, y + extent * 2, z - extent * 0.6]} color="#fff1dc" intensity={3 * (1 - night) + 0.05} castShadow shadow-mapSize={[2048, 2048]} />
      <hemisphereLight color="#cfe3ff" groundColor="#5a5040" intensity={1.2 * (1 - night * 0.85)} />
    </>
  )
}

/** Orbit controls around `target`; the camera jumps to `position` whenever either changes. */
export function View({ position, target }: { position: V3; target: V3 }) {
  const camera = useThree((s) => s.camera)
  useEffect(() => void camera.position.set(...position), [camera, ...position, ...target])
  return <OrbitControls makeDefault enableDamping target={target} />
}

/**
 * Terrain and water over a `size` m square around `center` (frame-local [x, z]), coloured by the world's
 * ground mix like the three.js demos. Rebuilt when the world changes (e.g. a city flattening its site).
 */
export function Ground({ world, center, size, segments = 200, waterOpacity = 0.85 }: { world: World; center: [number, number]; size: number; segments?: number; waterOpacity?: number }) {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = world.onChange(() => {
      clearTimeout(timer)
      timer = setTimeout(() => setVersion((v) => v + 1), 50)
    })
    return () => (clearTimeout(timer), off())
  }, [world])
  const { terrain, water } = useMemo(() => worldGround(world, center, size, segments), [world, center[0], center[1], size, segments, version])
  useEffect(() => () => (terrain.dispose(), water.dispose()), [terrain, water])
  return (
    <>
      <mesh geometry={terrain} receiveShadow>
        <meshStandardNodeMaterial vertexColors roughness={0.95} />
      </mesh>
      <mesh geometry={water}>
        <meshStandardNodeMaterial color="#3a6f8f" roughness={0.08} metalness={0.1} transparent opacity={waterOpacity} depthWrite={waterOpacity > 0.5} />
      </mesh>
    </>
  )
}
