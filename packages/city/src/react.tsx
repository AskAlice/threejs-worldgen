/**
 * React Three Fiber entry point: `<City>` (one settlement) and `<Settlements>` (every settlement in
 * a region), plus everything from `threejs-city` (the classes are re-exported as `CityImpl` and
 * `SettlementsImpl`).
 *
 * @module threejs-city/react
 */
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Camera } from 'three/webgpu'
import type { LocalFrame, World } from 'threejs-biomes'
import { City as CityImpl } from './city.ts'
import type { CityInput } from './options.ts'
import { Settlements as SettlementsImpl, type SettlementsOptions } from './settlements.ts'

export * from './index.ts'
/** The imperative {@link CityImpl | City} class, renamed because `City` is the component here. */
export { City as CityImpl } from './city.ts'
/** The imperative {@link SettlementsImpl | Settlements} class, renamed because `Settlements` is the component here. */
export { Settlements as SettlementsImpl } from './settlements.ts'

/** Props of `<City>`: every {@link CityInput} setting plus the objects below. */
export interface CityProps extends CityInput {
  /** The world to build on. */
  world: World
  /** Layout frame (`world.frame` by default). Changing it rebuilds the city. */
  frame?: LocalFrame
  /** LOD camera; defaults to the R3F camera. */
  camera?: Camera
  /** Receives the underlying City (for `graph`, `data()`, `buildingAt`, `stats`, …). */
  ref?: Ref<CityImpl | null>
}

/**
 * One procedural settlement. Props are its settings: looks update instantly, layout changes
 * regenerate it. Needs a WebGPURenderer.
 *
 * @example
 * ```tsx
 * <City world={world} size="village" center={[200, -50]} facade={{ night }} />
 * ```
 */
export function City({ world, frame, camera, ref, ...options }: CityProps): React.JSX.Element | null {
  const { camera: defaultCamera } = useThree()
  const [city, setCity] = useState<CityImpl | null>(null)
  const latest = useRef(options)
  latest.current = options
  useEffect(() => {
    const c = new CityImpl({ world, frame, ...latest.current })
    setCity(c)
    return () => {
      c.dispose()
      setCity(null)
    }
  }, [world, frame])
  useEffect(() => {
    city?.reset(options)
  })
  useImperativeHandle(ref, () => city!, [city])
  useFrame(() => {
    if (!city) return
    city.camera = camera ?? defaultCamera
    city.update()
  })
  return city ? <primitive object={city.object} /> : null
}

/** Props of `<Settlements>`: every {@link SettlementsOptions} setting plus the objects below. */
export interface SettlementsProps extends Partial<SettlementsOptions> {
  /** The world to populate. */
  world: World
  /** Layout frame (`world.frame` by default). */
  frame?: LocalFrame
  /** LOD camera; defaults to the R3F camera. */
  camera?: Camera
  /** Receives the underlying Settlements group. */
  ref?: Ref<SettlementsImpl | null>
}

/**
 * Every settlement in a region, placed where the land suits them and sized by how well it does.
 *
 * @example
 * ```tsx
 * <Settlements world={world} region={{ minX: -8000, minZ: -8000, maxX: 8000, maxZ: 8000 }} city={{ facade: { night } }} />
 * ```
 */
export function Settlements({ world, frame, camera, ref, ...options }: SettlementsProps): React.JSX.Element | null {
  const { camera: defaultCamera } = useThree()
  const [group, setGroup] = useState<SettlementsImpl | null>(null)
  const latest = useRef(options)
  latest.current = options
  useEffect(() => {
    const s = new SettlementsImpl({ world, frame, ...latest.current })
    setGroup(s)
    return () => {
      s.dispose()
      setGroup(null)
    }
  }, [world, frame])
  useEffect(() => {
    group?.reset(options)
  })
  useImperativeHandle(ref, () => group!, [group])
  useFrame(() => {
    if (!group) return
    group.setCamera(camera ?? defaultCamera)
    group.update()
  })
  return group ? <primitive object={group.object} /> : null
}
