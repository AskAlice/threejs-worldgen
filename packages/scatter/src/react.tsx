/**
 * React Three Fiber entry point: the `<Scatter>` component plus everything from `threejs-scatter` (the imperative
 * class is re-exported as `ScatterImpl`).
 *
 * @module threejs-scatter/react
 */
import { useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Camera, Object3D } from 'three/webgpu'
import type { HeightFn, Terrain } from 'threejs-heightfield'
import { Scatter as ScatterImpl, type ScatterInput } from './scatter.ts'

export * from './index.ts'
/** The imperative {@link ScatterImpl | Scatter} class, re-exported under another name because `Scatter` is the component here. */
export { Scatter as ScatterImpl } from './scatter.ts'

/** Props of the `<Scatter>` component: every {@link ScatterInput} setting plus the ones below. */
export interface ScatterProps extends ScatterInput {
  /** Receives the underlying Scatter instance (for `query`, `stats`, `sampleHeight`, …). */
  ref?: Ref<ScatterImpl | null>
  /**
   * Mesh/group (or a ref to one), baked when the component mounts or the object changes, or a `(x, z) => y` height
   * function. Inline functions are fine: the latest one is always used, but tiles already generated keep their heights
   * (call `scatter.setTerrain()` to force a rebuild).
   */
  terrain?: Terrain | RefObject<Object3D | null>
  /** Camera the tiles follow. Defaults to the R3F default camera. */
  camera?: Camera
}

/**
 * Streams instanced objects over terrain around the camera, for react-three-fiber.
 *
 * @example
 * ```tsx
 * <mesh ref={ground} geometry={hills} />
 * <Scatter terrain={ground} layers={[{ name: 'rock', spacing: 8, lods: [{ distance: 120, geometry, material }] }]} />
 * ```
 */
export function Scatter({ ref, terrain, camera, ...options }: ScatterProps): React.JSX.Element | null {
  const { camera: defaultCamera } = useThree()
  const activeCamera = camera ?? defaultCamera
  const [scatter, setScatter] = useState<ScatterImpl | null>(null)
  const latest = useRef(options)
  latest.current = options

  // Height functions are often written inline; only an object/ref change recreates the scatter.
  const terrainRef = useRef(terrain)
  terrainRef.current = terrain
  const terrainKey = typeof terrain === 'function' ? 'function' : terrain

  useEffect(() => {
    const t = terrainRef.current
    const resolved: Terrain | undefined =
      typeof t === 'function' ? (x, z) => (terrainRef.current as HeightFn)(x, z)
      : t && 'current' in t ? t.current ?? undefined
      : t
    const s = ScatterImpl.create({ camera: activeCamera, terrain: resolved, ...latest.current })
    setScatter(s)
    return () => {
      s.dispose()
      setScatter(null)
    }
  }, [activeCamera, terrainKey])

  // Props are the full truth: reset() drops overrides whose props were removed. Only what changed is rebuilt.
  useEffect(() => {
    scatter?.reset(options)
  })

  useImperativeHandle(ref, () => scatter!, [scatter])
  useFrame(() => scatter?.update())

  return scatter ? <primitive object={scatter.object} /> : null
}
