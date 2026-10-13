/**
 * React Three Fiber entry point: `usePopulation` and the `<PopulationOverlay>` component, plus everything
 * from `threejs-population` (the imperative overlay class is re-exported as `PopulationOverlayImpl`).
 *
 * @module threejs-population/react
 */
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Camera } from 'three/webgpu'
import type { World } from 'threejs-biomes'
import { Population } from './population.ts'
import type { PopulationInput } from './model.ts'
import { PopulationOverlay as PopulationOverlayImpl, type OverlayInput } from './overlay.ts'

export * from './index.ts'
/** The imperative {@link PopulationOverlayImpl | PopulationOverlay} class, renamed because `PopulationOverlay` is the component here. */
export { PopulationOverlay as PopulationOverlayImpl } from './overlay.ts'

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
