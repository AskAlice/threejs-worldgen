/**
 * React entry point: `useHeightSampler`, plus everything from `threejs-heightfield`.
 *
 * @module threejs-heightfield/react
 */
import { useMemo } from 'react'
import { createHeightSampler, type HeightFn, type Terrain } from './index.ts'

export * from './index.ts'

/**
 * {@link createHeightSampler} for React: a height function is used as-is, a mesh or group (e.g. from a `ref`
 * callback) is baked once, and again only when `terrain` or `maxResolution` changes. No terrain: flat ground at 0.
 *
 * @example
 * ```tsx
 * const [ground, setGround] = useState<Object3D | null>(null)
 * const sample = useHeightSampler(ground, 512)
 * return <mesh ref={setGround} geometry={terrain} />
 * ```
 */
export function useHeightSampler(terrain?: Terrain | null, maxResolution = 1024): HeightFn {
  return useMemo(() => createHeightSampler(terrain ?? undefined, maxResolution), [terrain, maxResolution])
}
