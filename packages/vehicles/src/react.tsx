/**
 * React Three Fiber entry point: `<Fleet>` (instanced traffic, trains, boats, aircraft, rockets) and
 * `<Vehicle>` (one vehicle), plus everything from `threejs-vehicles` (the classes are re-exported as
 * `FleetImpl` and `VehicleImpl`). Props are the classes' JSON settings; every render calls `reset(props)`
 * (rebuilding only when groups or seed change), and `update()` runs in `useFrame`.
 *
 * @module threejs-vehicles/react
 */
import { useEffect, useImperativeHandle, useMemo, type Ref } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Renderer } from 'three/webgpu'
import { Fleet as FleetImpl, Vehicle as VehicleImpl, type VehicleSettings } from './fleet.ts'
import { VehicleExhaust, type ExhaustInput } from './exhaust.ts'
import type { RoadNetwork } from './paths.ts'
import type { FleetEnvironment, FleetInput } from './sim.ts'
import type { StateLook } from 'threejs-weathering'

export * from './index.ts'
/** The imperative {@link FleetImpl | Fleet} class, renamed because `Fleet` is the component here. */
export { Fleet as FleetImpl, Vehicle as VehicleImpl } from './fleet.ts'

/** Props of `<Fleet>`: every {@link FleetInput} setting plus the ones below. */
export interface FleetProps extends FleetInput {
  /** Receives the underlying Fleet. */
  ref?: Ref<FleetImpl | null>
  /** Road network for `roads` routes (threejs-city's `city.graph`). */
  roads?: RoadNetwork | null
  /** Ground height for road nodes without `y`. */
  height?: (x: number, z: number) => number
  /** Weather, fire and ground states the vehicles react to. */
  env?: FleetEnvironment
  /** Shared weathering look. */
  look?: StateLook
}

/**
 * Instanced, animated vehicles: traffic on a road graph, trains on rails, boats, aircraft and rockets.
 *
 * @example
 * ```tsx
 * <Fleet roads={city.graph} groups={[{ type: 'car', count: 300, route: { kind: 'roads' } }]} lights={night} exposure={{ rain: 1 }} />
 * ```
 */
export function Fleet({ ref, roads = null, height, env, look, ...settings }: FleetProps): React.JSX.Element {
  const fleet = useMemo(() => new FleetImpl(settings, { roads, height, look }), [look])
  useEffect(() => () => fleet.dispose(), [fleet])
  useEffect(() => { fleet.setRoads(roads) }, [fleet, roads])
  useEffect(() => { fleet.reset(settings) })
  useImperativeHandle(ref, () => fleet, [fleet])
  useFrame((_, delta) => fleet.update(delta, env))
  return <primitive object={fleet.object} />
}

/** Props of `<Vehicle>`: every {@link VehicleSettings} setting plus a ref and an environment. */
export interface VehicleProps extends Partial<VehicleSettings> {
  /** Receives the underlying Vehicle. */
  ref?: Ref<VehicleImpl | null>
  /** Weather, fire and ground states it reacts to. */
  env?: FleetEnvironment
}

/**
 * One procedural vehicle standing at its origin (position it with a parent `<group>`), parts turning at `speed`.
 *
 * @example
 * ```tsx
 * <group position={[0, 0, 5]}><Vehicle type="car" params={{ style: 'suv' }} speed={6} states={{ snow: 0.7 }} /></group>
 * ```
 */
export function Vehicle({ ref, env, ...settings }: VehicleProps): React.JSX.Element {
  const vehicle = useMemo(() => new VehicleImpl(settings), [])
  useEffect(() => () => vehicle.dispose(), [vehicle])
  useEffect(() => { vehicle.reset(settings) })
  useImperativeHandle(ref, () => vehicle, [vehicle])
  useFrame((_, delta) => vehicle.update(delta, env))
  return <primitive object={vehicle.object} />
}

/** Props of `<Exhaust>`: every {@link ExhaustInput} setting plus the fleet it smokes for. */
export interface ExhaustProps extends ExhaustInput {
  /** The fleet (from `<Fleet ref={...}>`). */
  fleet: FleetImpl
  /** Receives the underlying VehicleExhaust. */
  ref?: Ref<VehicleExhaust | null>
}

/**
 * Engine smoke, steam and exhaust for a fleet's vehicles (threejs-particles), updated every frame
 * after the fleet. Settings are props (`reset` on every render).
 *
 * @example
 * ```tsx
 * const [fleet, setFleet] = useState<FleetImpl | null>(null)
 * <Fleet ref={setFleet} groups={groups} />
 * {fleet && <Exhaust fleet={fleet} temperature={-5} humidity={0.8} />}
 * ```
 */
export function Exhaust({ fleet, ref, ...settings }: ExhaustProps): null {
  const { gl, camera } = useThree()
  const exhaust = useMemo(() => new VehicleExhaust(fleet, settings), [fleet])
  useEffect(() => () => exhaust.dispose(), [exhaust])
  useEffect(() => { exhaust.reset(settings) })
  useImperativeHandle(ref, () => exhaust, [exhaust])
  useFrame((_, delta) => exhaust.update(gl as unknown as Renderer, delta, camera)) // after the fleet (mounted after it); a positive priority would take over rendering
  return null
}
