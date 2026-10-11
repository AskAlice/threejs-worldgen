/**
 * React Three Fiber entry point: `<Props>` and `<RoadPath>`, plus everything from `threejs-props` (the
 * imperative classes are re-exported as `PropsImpl` and `RoadPathImpl`). Props of the components are the
 * classes' settings; every render calls `set(props)`, and `<Props>` updates in `useFrame`.
 *
 * @module threejs-props/react
 */
import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from 'react'
import { useFrame } from '@react-three/fiber'
import type { Node } from 'three/webgpu'
import type { StateLook } from 'threejs-weathering'
import { Props as PropsImpl, type PropsInput } from './props.ts'
import { RoadPath as RoadPathImpl, type RoadPathOptions, type RoadSurfaceContext } from './roads.ts'

export * from './index.ts'
/** The imperative {@link PropsImpl | Props} class, renamed because `Props` is the component here. */
export { Props as PropsImpl } from './props.ts'
/** The imperative {@link RoadPathImpl | RoadPath} class, renamed because `RoadPath` is the component here. */
export { RoadPath as RoadPathImpl } from './roads.ts'

/** Props of `<Props>`: every {@link PropsInput} setting plus live inputs (changing those recreates the materials). */
export interface PropsProps extends PropsInput {
  /** Receives the underlying Props (for `states`, `positions`, …). */
  ref?: Ref<PropsImpl | null>
  /** Night as a TSL node, e.g. threejs-sky's `sky.uniforms.night`. */
  nightNode?: Node
  /** Seconds as a TSL node. */
  time?: Node
  /** Weathering look. */
  look?: StateLook
}

/**
 * Street and countryside props, instanced.
 *
 * @example
 * ```tsx
 * const placements = useMemo(() => decorateRoads(city.data()!.roads, world, { seed: 7 }), [city, world])
 * <Props placements={placements} nightNode={sky.uniforms.night} states={{ wetness: rain }} />
 * ```
 */
export function Props({ ref, nightNode, time, look, ...options }: PropsProps): React.JSX.Element {
  const props = useMemo(() => new PropsImpl({ nightNode, time, look }), [nightNode, time, look])
  useEffect(() => () => props.dispose(), [props])
  const last = useRef('')
  // Settings are JSON: only re-apply when they changed (placements can be large).
  const key = JSON.stringify(options)
  if (key !== last.current) {
    last.current = key
    props.reset(options)
  }
  useImperativeHandle(ref, () => props, [props])
  useFrame(() => props.update())
  return <primitive object={props.object} />
}

/** Props of `<RoadPath>`: every {@link RoadPathOptions} setting plus live inputs. */
export interface RoadPathProps extends Partial<RoadPathOptions>, RoadSurfaceContext {
  /** Receives the underlying RoadPath. */
  ref?: Ref<RoadPathImpl | null>
  /** Ground height `(x, z) => y` to drape on, e.g. `world.height`. */
  height?: (x: number, z: number) => number
}

/**
 * A road, sidewalk or path ribbon following a polyline over the terrain.
 *
 * @example
 * ```tsx
 * <RoadPath points={[[0, 0], [60, 20], [140, 10]]} height={world.height} width={4} surface={{ surface: 'gravel', states: { wetness } }} />
 * ```
 */
export function RoadPath({ ref, height, states, part, halfWidth, surfaceIndex, coords, look, time, ...options }: RoadPathProps): React.JSX.Element {
  const path = useMemo(() => new RoadPathImpl({ height, states, part, halfWidth, surfaceIndex, coords, look, time }), [height, states, part, halfWidth, surfaceIndex, coords, look, time])
  useEffect(() => () => path.dispose(), [path])
  const last = useRef('')
  const key = JSON.stringify(options)
  if (key !== last.current) {
    last.current = key
    path.set(options)
  }
  useImperativeHandle(ref, () => path, [path])
  return <primitive object={path.object} />
}
