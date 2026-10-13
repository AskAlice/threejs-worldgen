/**
 * React Three Fiber entry point: `<Ocean>`, `<Rivers>`, `<Water>` (both at once) and `<Lakes>`, plus
 * everything from `threejs-water` (the imperative classes are re-exported as `OceanImpl`,
 * `RiversImpl` and `LakesImpl`). Props are the classes' settings; every render calls `reset(props)`,
 * so removing a prop reverts it, and `update()` runs in `useFrame`.
 *
 * @module threejs-water/react
 */
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Camera } from 'three/webgpu'
import type { LocalFrame, World } from 'threejs-biomes'
import type { WaterRenderer } from './common.ts'
import type { HydrologyResult } from './hydrology.ts'
import { Lakes as LakesImpl, type LakesInput } from './lakes.ts'
import type { WaterAppearance } from './material.ts'
import { Ocean as OceanImpl, type OceanInput } from './ocean.ts'
import { Rivers as RiversImpl, type RiversInput } from './rivers.ts'

export * from './index.ts'
/** The imperative {@link OceanImpl | Ocean} class, renamed because `Ocean` is the component here. */
export { Ocean as OceanImpl } from './ocean.ts'
/** The imperative {@link RiversImpl | Rivers} class, renamed because `Rivers` is the component here. */
export { Rivers as RiversImpl } from './rivers.ts'
/** The imperative {@link LakesImpl | Lakes} class, renamed because `Lakes` is the component here. */
export { Lakes as LakesImpl } from './lakes.ts'

/** Props of `<Ocean>`: every {@link OceanInput} setting plus the ones below. */
export interface OceanProps extends OceanInput {
  /** Receives the underlying Ocean (for `waterAt`, `stats`, …). */
  ref?: Ref<OceanImpl | null>
  /** World whose sea level and planet radius to use. Omit to use the `seaLevel`/`radius` props. */
  world?: World | null
  /** Camera the rings follow. Defaults to the R3F default camera. */
  camera?: Camera
}

/**
 * A sea-level ocean for react-three-fiber (needs a WebGPURenderer).
 *
 * @example
 * ```tsx
 * <Ocean world={world} sun={sunRef.current} waves={{ amplitude: 0.8 }} deepColor="#06283a" />
 * ```
 */
export function Ocean({ ref, world = null, camera, ...options }: OceanProps): React.JSX.Element | null {
  const { camera: defaultCamera, gl } = useThree()
  const activeCamera = camera ?? defaultCamera
  const [ocean, setOcean] = useState<OceanImpl | null>(null)
  const latest = useRef(options)
  latest.current = options

  useEffect(() => {
    let created: OceanImpl | null = null
    let cancelled = false
    OceanImpl.create({ camera: activeCamera, world, renderer: gl as unknown as WaterRenderer, ...latest.current }).then((o) => {
      if (cancelled) return o.dispose()
      created = o
      setOcean(o)
    })
    return () => {
      cancelled = true
      created?.dispose()
      setOcean(null)
    }
  }, [gl])

  useEffect(() => {
    if (!ocean) return
    ocean.camera = activeCamera
    ocean.world = world
    ocean.reset(options)
  })
  useImperativeHandle(ref, () => ocean!, [ocean])
  useFrame((_, delta) => ocean?.update(delta))
  return ocean ? <primitive object={ocean.object} /> : null
}

/** Props of `<Rivers>`: every {@link RiversInput} setting plus the ones below. */
export interface RiversProps extends RiversInput {
  /** Receives the underlying Rivers (for `stats`, …). */
  ref?: Ref<RiversImpl | null>
  /** World whose rivers to draw. A different world recreates the tiles. */
  world: World
  /** Camera the tiles stream around. Defaults to the R3F default camera. */
  camera?: Camera
}

/**
 * Streamed river surfaces for a `threejs-biomes` world (needs a WebGPURenderer).
 *
 * @example
 * ```tsx
 * <Rivers world={world} maxDistance={2000} flowSpeed={1.4} />
 * ```
 */
export function Rivers({ ref, world, camera, ...options }: RiversProps): React.JSX.Element | null {
  const { camera: defaultCamera, gl } = useThree()
  const activeCamera = camera ?? defaultCamera
  const [rivers, setRivers] = useState<RiversImpl | null>(null)
  const latest = useRef(options)
  latest.current = options

  useEffect(() => {
    let created: RiversImpl | null = null
    let cancelled = false
    RiversImpl.create({ camera: activeCamera, world, renderer: gl as unknown as WaterRenderer, ...latest.current }).then((r) => {
      if (cancelled) return r.dispose()
      created = r
      setRivers(r)
    })
    return () => {
      cancelled = true
      created?.dispose()
      setRivers(null)
    }
  }, [gl, world])

  useEffect(() => {
    if (!rivers) return
    rivers.camera = activeCamera
    rivers.reset(options)
  })
  useImperativeHandle(ref, () => rivers!, [rivers])
  useFrame((_, delta) => rivers?.update(delta))
  return rivers ? <primitive object={rivers.object} /> : null
}

/** Props of `<Water>`: the settings both surfaces share, plus per-surface overrides. */
export interface WaterProps extends Partial<Pick<WaterAppearance, 'sun' | 'environment'>> {
  /** The world. */
  world: World
  /** Camera. Defaults to the R3F default camera. */
  camera?: Camera
  /** Floating origin shared by both surfaces. */
  origin?: [x: number, y: number, z: number]
  /** Ocean settings, or `false` for no ocean. */
  ocean?: OceanInput | false
  /** River settings, or `false` for no rivers. */
  rivers?: RiversInput | false
}

/**
 * All of a world's water at once: `<Ocean>` at its sea level and `<Rivers>` along its rivers.
 *
 * @example
 * ```tsx
 * <Water world={world} sun={sun} ocean={{ waves: { amplitude: 1 } }} rivers={{ maxDistance: 2500 }} />
 * ```
 */
export function Water({ world, camera, origin, sun, environment, ocean = {}, rivers = {} }: WaterProps): React.JSX.Element {
  const shared = { origin, sun, environment }
  return (
    <>
      {ocean !== false && <Ocean world={world} camera={camera} {...shared} {...ocean} />}
      {rivers !== false && <Rivers world={world} camera={camera} {...shared} {...rivers} />}
    </>
  )
}

/** Props of `<Lakes>`: every {@link LakesInput} setting plus the ones below. */
export interface LakesProps extends LakesInput {
  /** Receives the underlying Lakes. */
  ref?: Ref<LakesImpl | null>
  /** The hydrology to draw (from `computeHydrology`). Memoise it: a new object rebuilds the meshes. */
  hydrology: HydrologyResult
  /** Frame the hydrology was sampled in (e.g. `world.frame`); omit on a flat world in world coordinates. */
  frame?: LocalFrame | null
  /** Camera (for the detail fade). Defaults to the R3F default camera. */
  camera?: Camera
}

/**
 * Lakes and rivers of a bounded-map hydrology result (needs a WebGPURenderer).
 *
 * @example
 * ```tsx
 * const hydrology = useMemo(() => computeHydrology(world.height, region, { seaLevel: 0 }), [world])
 * <Lakes hydrology={hydrology} frame={world.frame} />
 * ```
 */
export function Lakes({ ref, hydrology, frame = null, camera, ...options }: LakesProps): React.JSX.Element | null {
  const { camera: defaultCamera, gl } = useThree()
  const activeCamera = camera ?? defaultCamera
  const [lakes, setLakes] = useState<LakesImpl | null>(null)
  const latest = useRef({ options, hydrology, frame })
  latest.current = { options, hydrology, frame }

  useEffect(() => {
    let created: LakesImpl | null = null
    let cancelled = false
    const l = latest.current
    LakesImpl.create({ hydrology: l.hydrology, frame: l.frame, camera: activeCamera, renderer: gl as unknown as WaterRenderer, ...l.options }).then((x) => {
      if (cancelled) return x.dispose()
      created = x
      setLakes(x)
    })
    return () => {
      cancelled = true
      created?.dispose()
      setLakes(null)
    }
  }, [gl])

  useEffect(() => {
    if (!lakes) return
    lakes.camera = activeCamera
    if (lakes.hydrology !== hydrology || lakes.frame !== frame) lakes.setHydrology(hydrology, frame)
    lakes.reset(options)
  })
  useImperativeHandle(ref, () => lakes!, [lakes])
  useFrame((_, delta) => lakes?.update(delta))
  return lakes ? <primitive object={lakes.object} /> : null
}
