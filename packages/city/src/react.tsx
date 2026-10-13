/**
 * React Three Fiber entry point: `<City>` (one settlement), `<Settlements>` (every settlement of a
 * population), `usePopulation` and `<PopulationOverlay>`, plus everything from `threejs-city` (the classes
 * are re-exported as `CityImpl`, `SettlementsImpl` and `PopulationOverlayImpl`).
 *
 * @module threejs-city/react
 */
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Camera } from 'three/webgpu'
import type { LocalFrame, World } from 'threejs-biomes'
import { City as CityImpl } from './city.ts'
import type { CityInput } from './options.ts'
import { Population } from './population.ts'
import type { PopulationInput } from './population-model.ts'
import { PopulationOverlay as PopulationOverlayImpl, type OverlayInput } from './population-overlay.ts'
import { Settlements as SettlementsImpl, type SettlementsOptions } from './settlements.ts'

export * from './index.ts'
/** The imperative {@link CityImpl | City} class, renamed because `City` is the component here. */
export { City as CityImpl } from './city.ts'
/** The imperative {@link SettlementsImpl | Settlements} class, renamed because `Settlements` is the component here. */
export { Settlements as SettlementsImpl } from './settlements.ts'
/** The imperative {@link PopulationOverlayImpl | PopulationOverlay} class, renamed because `PopulationOverlay` is the component here. */
export { PopulationOverlay as PopulationOverlayImpl } from './population-overlay.ts'

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
 * Every settlement of a population: placed and sized by the population model, one city each.
 *
 * @example
 * ```tsx
 * <Settlements world={world} population={{ radius: 8000, totalPopulation: 300_000 }} city={{ facade: { night } }} />
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

/**
 * A {@link Population} on `world` that follows `input` declaratively: created once per world, then
 * `reset(input)` whenever the settings change (compared by value, so inline objects are fine).
 */
export function usePopulation(world: World, input: PopulationInput = {}): Population {
  const population = useMemo(() => new Population(world, input), [world])
  const key = JSON.stringify(input)
  useEffect(() => {
    population.reset(input)
  }, [population, key])
  useEffect(() => population.follow(), [population])
  return population
}

/** Props of `<PopulationOverlay>`: every overlay setting plus the ones below. */
export interface PopulationOverlayProps extends OverlayInput {
  /** The population to draw (see {@link usePopulation}). */
  population: Population
  /** Receives the underlying overlay instance. */
  ref?: Ref<PopulationOverlayImpl | null>
  /** Camera for `resolution: 'auto'`. Defaults to the R3F default camera. */
  camera?: Camera
}

/**
 * Hex choropleth of population (and its networks) over the terrain. Props are the full truth: removing a
 * prop reverts it.
 *
 * @example
 * ```tsx
 * function Scene() {
 *   const world = useWorld({ seed: 'meadow' })
 *   const population = usePopulation(world, { totalPopulation: 900_000 })
 *   return <PopulationOverlay population={population} mode="lights" extrude={0} />
 * }
 * ```
 */
export function PopulationOverlay({ population, ref, camera, ...options }: PopulationOverlayProps): React.JSX.Element | null {
  const { camera: defaultCamera } = useThree()
  const activeCamera = camera ?? defaultCamera
  const [overlay, setOverlay] = useState<PopulationOverlayImpl | null>(null)
  const latest = useRef(options)
  latest.current = options

  useEffect(() => {
    const o = new PopulationOverlayImpl({ population, camera: activeCamera, ...latest.current })
    setOverlay(o)
    return () => {
      o.dispose()
      setOverlay(null)
    }
  }, [population])

  useEffect(() => {
    if (overlay) overlay.camera = activeCamera
  }, [overlay, activeCamera])

  const key = JSON.stringify(options)
  useEffect(() => {
    overlay?.reset(options)
  }, [overlay, key])

  useImperativeHandle(ref, () => overlay!, [overlay])
  useFrame(() => overlay?.update())
  return overlay ? <primitive object={overlay.object} /> : null
}
