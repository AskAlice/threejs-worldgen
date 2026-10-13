/**
 * React Three Fiber entry point: `useWorld` and the `<WorldTerrain>` component, plus everything from
 * `threejs-biomes` (the imperative terrain class is re-exported as `WorldTerrainImpl`).
 *
 * @module threejs-biomes/react
 */
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Camera } from 'three/webgpu'
import { World, type WorldInput } from './world.ts'
import { WorldTerrain as WorldTerrainImpl, type TerrainInput } from './terrain.ts'

export * from './index.ts'
/** The imperative {@link WorldTerrainImpl | WorldTerrain} class, renamed because `WorldTerrain` is the component here. */
export { WorldTerrain as WorldTerrainImpl } from './terrain.ts'

/**
 * A {@link World} that follows `input` declaratively: created once, then `reset(input)` whenever the
 * settings change (compared by value, so inline objects are fine).
 */
export function useWorld(input: WorldInput = {}): World {
  const world = useMemo(() => new World(input), [])
  const key = JSON.stringify(input)
  useEffect(() => {
    world.reset(input)
  }, [world, key])
  return world
}

/** Props of `<WorldTerrain>`: every terrain setting plus the ones below. */
export interface WorldTerrainProps extends TerrainInput {
  /** The world to render (see {@link useWorld}). */
  world: World
  /** Receives the underlying terrain instance (stats, uniforms, `setOrigin`, …). */
  ref?: Ref<WorldTerrainImpl | null>
  /** Camera that drives the level of detail. Defaults to the R3F default camera. */
  camera?: Camera
  /** Creates build workers (e.g. Vite: `() => new TerrainWorker()` from `threejs-biomes/worker?worker`). */
  createWorker?: () => Worker
  /** Number of workers when `createWorker` is set. */
  workers?: number
}

/**
 * Streaming LOD terrain for react-three-fiber. Props are the full truth: removing a prop reverts it.
 *
 * @example
 * ```tsx
 * function Scene() {
 *   const world = useWorld({ seed: 'meadow', mountains: { height: 1200 } })
 *   return <WorldTerrain world={world} lodFactor={2.5} material={{ debug: 'none' }} />
 * }
 * ```
 */
export function WorldTerrain({ world, ref, camera, createWorker, workers, ...options }: WorldTerrainProps): React.JSX.Element | null {
  const { camera: defaultCamera } = useThree()
  const activeCamera = camera ?? defaultCamera
  const [terrain, setTerrain] = useState<WorldTerrainImpl | null>(null)
  const latest = useRef(options)
  latest.current = options
  const workerFactory = useRef(createWorker)
  workerFactory.current = createWorker

  useEffect(() => {
    const t = new WorldTerrainImpl({ world, camera: activeCamera, createWorker: workerFactory.current, workers, ...latest.current })
    setTerrain(t)
    return () => {
      t.dispose()
      setTerrain(null)
    }
  }, [world, activeCamera, workers, !!createWorker])

  useEffect(() => {
    terrain?.reset(options)
  })

  useImperativeHandle(ref, () => terrain!, [terrain])
  useFrame(() => terrain?.update())
  return terrain ? <primitive object={terrain.object} /> : null
}
