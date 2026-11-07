/**
 * The lifecycle shared by the React field wrappers: create (maybe async) with cancellation, dispose on
 * unmount or rebuild, prop-to-reset sync, the imperative handle and terrain keying. No JSX and no
 * `@react-three/fiber`, so the components keep their own frame loop and the entry point is re-exported
 * from `threejs-heightfield/react`.
 *
 * @module threejs-heightfield/react
 */
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref, type RefObject } from 'react'
import type { Object3D } from 'three/webgpu'
import type { HeightFn, Terrain } from './index.ts'

/** A terrain prop: a mesh/group, a ref to one (which may mount late), or an `(x, z) => y` height function. */
export type TerrainProp = Terrain | RefObject<Object3D | null> | undefined

/**
 * The identity a field is keyed on. Functions are read live (key `null`), so a new inline function never
 * looks like a new terrain; objects and refs keep their own identity, so a ref that fills later is adopted
 * by `update()` instead of recreating the field.
 */
export function terrainKey(terrain: TerrainProp): unknown {
  return typeof terrain === 'function' ? null : terrain
}

/**
 * {@link TerrainProp} as a field option. Inline height functions are wrapped once (reading the latest prop
 * through a ref); refs are passed straight through, so a ref that mounts late behaves exactly as in the
 * vanilla entry point.
 */
export function useTerrain(terrain: TerrainProp) {
  const latest = useRef(terrain)
  latest.current = terrain
  const height: HeightFn = useMemo(
    () => (x, z) => {
      const t = latest.current
      return typeof t === 'function' ? t(x, z) : NaN
    },
    []
  )
  return { source: typeof terrain === 'function' ? height : terrain, key: terrainKey(terrain) }
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T> | null)?.then === 'function'
}

/**
 * Runs `create`, then `attach` with the result. The returned cancel function disposes an attached
 * instance, or one whose create is still pending (it is then never attached). Every created instance is
 * disposed exactly once, however the create and the cancel interleave.
 */
export function mount<T>(
  create: () => T | Promise<T>,
  dispose: (instance: T) => void,
  attach: (instance: T) => void
): () => void {
  let cancelled = false
  let created: T | null = null
  const result = create()
  if (isPromise(result)) {
    void result.then((instance) => {
      if (cancelled) dispose(instance)
      else {
        created = instance
        attach(instance)
      }
    })
  } else {
    created = result
    attach(result)
  }
  return () => {
    cancelled = true
    if (created !== null) {
      const instance = created
      created = null
      dispose(instance)
    }
  }
}

/** Options of {@link useInstance}. */
export interface InstanceOptions<T> {
  /** Releases an instance. Called exactly once per instance, including one whose create resolved after unmount. */
  dispose: (instance: T) => void
  /** Applies the latest props after every committed render while an instance is attached. */
  reset?: (instance: T) => void
  /** Dispose and create again when one of these changes (compared as `useEffect` dependencies). */
  deps?: readonly unknown[]
  /** Receives the instance: `null` while it is being created and after unmount. */
  ref?: Ref<T | null>
}

const NO_DEPS: readonly unknown[] = []

/**
 * The shared lifecycle of the React field components: `create` runs when `deps` change (or on mount) and
 * may be a promise; the instance is disposed on unmount or rebuild and never attached after unmount;
 * `reset` runs after every committed render; `ref` receives the instance; the instance is returned.
 *
 * @example
 * ```tsx
 * const grass = useInstance(() => GrassImpl.create({ ...latest.current }), {
 *   dispose: (g) => g.dispose(),
 *   reset: (g) => g.reset(latest.current),
 *   deps: [camera, renderer, terrain.key],
 *   ref
 * })
 * ```
 */
export function useInstance<T>(create: () => T | Promise<T>, options: InstanceOptions<T>): T | null {
  const { dispose, reset, deps = NO_DEPS, ref } = options
  const [instance, setInstance] = useState<T | null>(null)

  useEffect(() => {
    const cancel = mount(create, dispose, setInstance)
    return () => {
      cancel()
      setInstance(null)
    }
  }, deps)

  useEffect(() => {
    if (instance) reset?.(instance)
  })

  useImperativeHandle<T | null, T | null>(ref, () => instance, [instance])
  return instance
}
