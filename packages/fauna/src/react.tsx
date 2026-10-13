/**
 * React Three Fiber entry point: `<Fish>` (one hero fish), `<FishSchools>`, `<BirdFlocks>` and
 * `<Fauna>` (every kind), plus everything from `threejs-fauna` (the imperative classes are re-exported
 * as `FishImpl`, `FishSchoolsImpl`, `BirdFlocksImpl` and `FaunaImpl`). Props are the classes' settings;
 * every render calls `reset(props)`, so removing a prop reverts it, and `update()` runs in `useFrame`.
 *
 * @module threejs-fauna/react
 */
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Camera } from 'three/webgpu'
import type { World } from 'threejs-biomes'
import { BirdFlocks as BirdFlocksImpl, type BirdFlocksInput } from './birds.ts'
import type { FaunaRenderer } from './common.ts'
import { Fauna as FaunaImpl, type FaunaInput } from './fauna.ts'
import { Fish as FishImpl, FishSchools as FishSchoolsImpl, type FishInput, type FishSchoolsInput } from './fish.ts'

export * from './index.ts'
/** The imperative {@link FishImpl | Fish} class, renamed because `Fish` is the component here. */
export { Fish as FishImpl, FishSchools as FishSchoolsImpl } from './fish.ts'
/** The imperative {@link BirdFlocksImpl | BirdFlocks} class, renamed because `BirdFlocks` is the component here. */
export { BirdFlocks as BirdFlocksImpl } from './birds.ts'
/** The imperative {@link FaunaImpl | Fauna} class, renamed because `Fauna` is the component here. */
export { Fauna as FaunaImpl } from './fauna.ts'

/** Something with the shape every fauna class shares. */
interface Updatable {
  object: import('three/webgpu').Object3D
  reset(input: any): unknown
  update(delta?: number): void
  dispose(): void
}

/** Creates `create()` once per `deps`, resets it with `props` on every render and updates it every frame. */
function useFaunaObject<T extends Updatable>(create: () => Promise<T>, props: object, deps: unknown[], ref: Ref<T | null> | undefined, sync?: (obj: T) => void) {
  const [obj, setObj] = useState<T | null>(null)
  const latest = useRef(create)
  latest.current = create
  useEffect(() => {
    let made: T | null = null
    let cancelled = false
    latest.current().then((o) => {
      if (cancelled) return o.dispose()
      made = o
      setObj(o)
    })
    return () => {
      cancelled = true
      made?.dispose()
      setObj(null)
    }
  }, deps)
  useEffect(() => {
    if (!obj) return
    sync?.(obj)
    obj.reset(props)
  })
  useImperativeHandle(ref, () => obj!, [obj])
  useFrame((_, delta) => obj?.update(delta))
  return obj
}

/** Props of `<Fish>`: every {@link FishInput} setting plus a ref. Position it with a parent `<group>`. */
export interface FishProps extends FishInput {
  /** Receives the underlying Fish. */
  ref?: Ref<FishImpl | null>
}

/**
 * One procedural fish that swims in place (a hero asset, a gallery item, an aquarium).
 *
 * @example
 * ```tsx
 * <group position={[0, 1, 0]}><Fish preset="clownfish" speed={1.5} species={{ pattern: { stripes: { count: 4 } } }} /></group>
 * ```
 */
export function Fish({ ref, ...options }: FishProps): React.JSX.Element | null {
  const { gl } = useThree()
  const fish = useFaunaObject(() => FishImpl.create({ renderer: gl as unknown as FaunaRenderer, ...options }), options, [gl], ref)
  return fish ? <primitive object={fish.object} /> : null
}

/** Props of `<FishSchools>`: every {@link FishSchoolsInput} setting plus the ones below. */
export interface FishSchoolsProps extends FishSchoolsInput {
  /** Receives the underlying FishSchools (for `stats`, `groups()`, …). */
  ref?: Ref<FishSchoolsImpl | null>
  /** The world whose water the fish live in. A different world respawns everything. */
  world: World
  /** Camera the schools stream around. Defaults to the R3F default camera. */
  camera?: Camera
}

/**
 * Fish schools streamed around the camera wherever the world has water deep enough.
 *
 * @example
 * ```tsx
 * <FishSchools world={world} density={200} species={{ shark: { habitat: { weight: 0 } } }} />
 * ```
 */
export function FishSchools({ ref, world, camera, ...options }: FishSchoolsProps): React.JSX.Element | null {
  const { camera: defaultCamera, gl } = useThree()
  const cam = camera ?? defaultCamera
  const fish = useFaunaObject(() => FishSchoolsImpl.create({ camera: cam, world, renderer: gl as unknown as FaunaRenderer, ...options }), options, [gl, world], ref, (f) => { f.camera = cam })
  return fish ? <primitive object={fish.object} /> : null
}

/** Props of `<BirdFlocks>`: every {@link BirdFlocksInput} setting plus the ones below. */
export interface BirdFlocksProps extends BirdFlocksInput {
  /** Receives the underlying BirdFlocks. */
  ref?: Ref<BirdFlocksImpl | null>
  /** The world whose biomes the birds live over. */
  world: World
  /** Camera the flocks stream around. Defaults to the R3F default camera. */
  camera?: Camera
}

/**
 * Bird flocks over the biomes each species likes.
 *
 * @example
 * ```tsx
 * <BirdFlocks world={world} density={8} />
 * ```
 */
export function BirdFlocks({ ref, world, camera, ...options }: BirdFlocksProps): React.JSX.Element | null {
  const { camera: defaultCamera, gl } = useThree()
  const cam = camera ?? defaultCamera
  const birds = useFaunaObject(() => BirdFlocksImpl.create({ camera: cam, world, renderer: gl as unknown as FaunaRenderer, ...options }), options, [gl, world], ref, (b) => { b.camera = cam })
  return birds ? <primitive object={birds.object} /> : null
}

/** Props of `<Fauna>`: every {@link FaunaInput} setting plus the ones below. */
export interface FaunaProps extends FaunaInput {
  /** Receives the underlying Fauna (for `layers`, …). */
  ref?: Ref<FaunaImpl | null>
  /** The world animals live in. */
  world: World
  /** Camera everything streams around. Defaults to the R3F default camera. */
  camera?: Camera
}

/**
 * Every kind of animal at once (fish and birds; set a kind to `false` to leave it out).
 *
 * @example
 * ```tsx
 * <Fauna world={world} seed={7} birds={{ density: 6 }} fish={{ density: 250 }} />
 * ```
 */
export function Fauna({ ref, world, camera, ...options }: FaunaProps): React.JSX.Element | null {
  const { camera: defaultCamera, gl } = useThree()
  const cam = camera ?? defaultCamera
  const fauna = useFaunaObject(() => FaunaImpl.create({ camera: cam, world, renderer: gl as unknown as FaunaRenderer, ...options }), options, [gl, world], ref, (f) => { f.camera = cam })
  return fauna ? <primitive object={fauna.object} /> : null
}
