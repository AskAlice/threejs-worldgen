/**
 * React Three Fiber entry point: the `<Grass>` and `<Corn>` components plus everything from `threejs-grass`
 * (the imperative classes are re-exported as `GrassImpl` and `CornImpl`).
 *
 * @module threejs-grass/react
 */
import { useEffect, useRef, type Ref, type RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Camera, Object3D } from 'three/webgpu'
import { Grass as GrassImpl, type GrassRenderer } from './grass.ts'
import type { GrassInput } from './grass-settings.ts'
import { TerrainPainter, type Brush } from './grass-map.ts'
import { Corn as CornImpl, type CornInput } from './corn.ts'
import type { Terrain } from 'threejs-heightfield'
import { useInstance, useTerrain } from 'threejs-heightfield/react'

export * from './index.ts'
/** The imperative {@link GrassImpl | Grass} class, re-exported under another name because `Grass` is the component here. */
export { Grass as GrassImpl } from './grass.ts'
/** The imperative {@link CornImpl | Corn} class, re-exported under another name because `Corn` is the component here. */
export { Corn as CornImpl } from './corn.ts'

/** Props of the `<Grass>` component: every {@link GrassInput} setting plus the ones below. */
export interface GrassProps extends GrassInput {
  /** Receives the underlying Grass instance (for `sampleHeight`, `mapNode`, `stats`, …). */
  ref?: Ref<GrassImpl | null>
  /**
   * Mesh/group (or a ref to one) or a `(x, z) => y` height function. A ref may be empty when the component
   * mounts: the field adopts its object on the next update (the same rule as the vanilla `Grass`), so the
   * component never recreates the field when the ref fills. Inline functions are fine: the latest one is
   * always used, but tiles already built keep their heights (call `grass.setTerrain()` to force a rebuild).
   */
  terrain?: Terrain | RefObject<Object3D | null>
  /** Camera the field follows. Defaults to the R3F default camera. */
  camera?: Camera
  /** Turns on the {@link TerrainPainter} with this brush (needs `grassMap`). `false` = off. */
  paint?: Partial<Brush> | false
}

/**
 * Infinite, camera-centred grass for react-three-fiber. Needs a WebGPURenderer:
 *
 * @example
 * ```tsx
 * <Canvas gl={async (props) => { const r = new WebGPURenderer(props as any); await r.init(); return r }}>
 *   <mesh ref={terrain} geometry={hills} />
 *   <Grass terrain={terrain} preset="tallFescue" tileSize={25} maxDistance={200} />
 * </Canvas>
 * ```
 */
export function Grass({ ref, terrain, camera, paint = false, ...options }: GrassProps): React.JSX.Element | null {
  const { camera: defaultCamera, gl } = useThree()
  const activeCamera = camera ?? defaultCamera
  const latest = useRef(options)
  latest.current = options

  // Height functions are often written inline; only an object/ref prop change should recreate the field.
  const terrainSource = useTerrain(terrain)

  const grass = useInstance(
    () =>
      GrassImpl.create({
        camera: activeCamera,
        renderer: gl as unknown as GrassRenderer,
        terrain: terrainSource.source,
        ...latest.current
      }),
    {
      dispose: (g) => g.dispose(),
      // Props are the full truth: reset() drops overrides whose props were removed. Cheap: visual props
      // only touch uniforms; tiles rebuild only when layout props actually change.
      reset: (g) => g.reset(latest.current),
      deps: [activeCamera, gl, terrainSource.key],
      ref
    }
  )

  const painter = useRef<TerrainPainter | null>(null)
  const painting = !!paint
  useEffect(() => {
    if (!grass || !painting) return
    const p = (painter.current = new TerrainPainter(grass, gl.domElement))
    return () => {
      p.dispose()
      painter.current = null
    }
  }, [grass, gl, painting])
  useEffect(() => {
    if (painter.current && paint) Object.assign(painter.current.brush, paint)
  })

  // update() also adopts a terrain ref that mounted after the field; see `Grass.update`.
  useFrame(() => grass?.update())

  return grass ? <primitive object={grass.object} /> : null
}

/** Props of the `<Corn>` component: every {@link CornInput} setting plus the ones below. */
export interface CornProps extends CornInput {
  /** Receives the underlying Corn instance (for `flatten`, `flattened`, `stats`, …). */
  ref?: Ref<CornImpl | null>
  /** Mesh/group (or a ref to one) or a `(x, z) => y` height function, as for `<Grass>` (late refs are adopted). */
  terrain?: Terrain | RefObject<Object3D | null>
  /** Camera the levels of detail follow. Defaults to the R3F default camera. */
  camera?: Camera
}

/**
 * Corn fields for react-three-fiber: tall row-planted stalks that interactors push aside and flatten. Needs a
 * WebGPURenderer. Props are applied with `reset()`, so removing one reverts it; only fields, spacing, seed and
 * chunk size rebuild plants.
 *
 * @example
 * ```tsx
 * <Corn terrain={terrain} fields={[{ polygon, rowDirection: 0, rowSpacing: 0.76 }]} growth={0.8} interactors={[{ object: tractor, radius: 1.5 }]} />
 * ```
 */
export function Corn({ ref, terrain, camera, ...options }: CornProps): React.JSX.Element | null {
  const { camera: defaultCamera, gl } = useThree()
  const activeCamera = camera ?? defaultCamera
  const latest = useRef(options)
  latest.current = options
  const terrainSource = useTerrain(terrain)

  const corn = useInstance(
    () =>
      CornImpl.create({
        camera: activeCamera,
        renderer: gl as unknown as GrassRenderer,
        terrain: terrainSource.source,
        ...latest.current
      }),
    {
      dispose: (c) => c.dispose(),
      reset: (c) => c.reset(latest.current),
      deps: [activeCamera, gl, terrainSource.key],
      ref
    }
  )

  useFrame(() => corn?.update())
  return corn ? <primitive object={corn.object} /> : null
}
