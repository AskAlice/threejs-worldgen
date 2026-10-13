/**
 * React Three Fiber entry point: `<Tree>` (one generated tree, for hero placement) and `<Forest>` (species scattered
 * over terrain with LODs and impostors), plus everything from `threejs-trees`.
 *
 * @module threejs-trees/react
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree, type ThreeElements } from '@react-three/fiber'
import type { DirectionalLight, Renderer } from 'three/webgpu'
import { disposeLayers, type ScatterLayer } from 'threejs-scatter'
import { Scatter, type ScatterProps } from 'threejs-scatter/react'
import { createVegetationLayers, type VegetationOptions } from './layers.ts'
import { createBarkMaterial, createFruitMaterial, createLeafMaterial, setTreeEnvironment, type TreeEnvironment, type WeatherInputs } from './materials.ts'
import { species as presets, type SpeciesName, type TreeParams } from './species.ts'
import { generateTree } from './tree.ts'

export * from './index.ts'

/** Props of `<Tree>`: which tree to generate, plus any `<group>` prop (position, rotation, scale, …). */
export type TreeProps = Omit<ThreeElements['group'], 'children'> & {
  /** Species preset to start from. */
  species?: SpeciesName
  /** Overrides on top of the preset. */
  params?: Partial<TreeParams>
  /** Variant seed: same seed, same tree. */
  seed?: number
  /** 1 = full detail; lower = fewer segments and leaves. */
  detail?: number
  /** Whether the tree casts shadows. */
  castShadow?: boolean
  /** Whether the tree receives shadows. */
  receiveShadow?: boolean
  /** Weather inputs for its materials (read when the tree is generated); defaults follow the global `treeUniforms`. */
  weather?: WeatherInputs
}

/**
 * One generated tree, for hero placement. Regenerates when `species`, `params`, `seed` or `detail` change.
 *
 * @example
 * ```tsx
 * <Tree species="oak" seed={7} position={[0, 0, -10]} />
 * ```
 */
export function Tree({ species = 'oak', params, seed = 1, detail = 1, castShadow = true, receiveShadow = true, weather, ...group }: TreeProps): React.JSX.Element {
  const key = JSON.stringify([species, params, seed, detail])
  const built = useMemo(() => {
    const p = { ...presets[species], ...params }
    const o = { weather }
    // One single-material mesh per part (bark / leaves / fruit). Not one mesh with a material array: three.js shadow
    // passes key render objects by object, so the parts would share one and rebuild its GPU bindings every frame.
    const tree = generateTree(p, seed, { detail })
    const materials = [createBarkMaterial(p, o), createLeafMaterial(p, o), createFruitMaterial(p, o)]
    return { parts: [tree.trunk, tree.leaves, tree.fruit].flatMap((geometry, i) => (geometry ? [{ geometry, material: materials[i] }] : [])), materials }
  }, [key])
  useEffect(() => () => {
    for (const part of built.parts) part.geometry.dispose()
    for (const m of built.materials) m.dispose()
  }, [built])
  return (
    <group {...group}>
      {built.parts.map((part, i) => (
        <mesh key={i} geometry={part.geometry} material={part.material} castShadow={castShadow} receiveShadow={receiveShadow} />
      ))}
    </group>
  )
}

/** Props of `<Forest>`: the vegetation set plus every `<Scatter>` prop except `layers`. */
export type ForestProps = Omit<ScatterProps, 'layers'> & Omit<VegetationOptions, 'renderer'> & {
  /** Bake octahedral impostors for far levels with the R3F renderer (needs a WebGPURenderer). */
  impostors?: boolean
  /** Wind for all tree materials. The sun defaults to the first DirectionalLight in the scene. */
  environment?: TreeEnvironment
}

/**
 * Species scattered over terrain around the camera: wraps `createVegetationLayers` and `<Scatter>`. `seed` drives both
 * the variants' shapes and their placement. Changing the species list regenerates the layers; other props apply live.
 *
 * @example
 * ```tsx
 * <Forest terrain={ground} species={[{ name: 'spruce', density: 0.7 }, { name: 'birch', density: 0.2 }]} />
 * ```
 */
export function Forest({ species, variants, seed, density, lodDistances, simplifiedDetail, impostor, castShadow, weather, impostors = true, environment, ...scatter }: ForestProps): React.JSX.Element | null {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const [layers, setLayers] = useState<ScatterLayer[] | null>(null)
  const latest = useRef({ species, density })
  latest.current = { species, density }
  const key = JSON.stringify([species, variants, seed, lodDistances, simplifiedDetail, impostor, castShadow, impostors, !!density])

  useEffect(() => {
    let cancelled = false
    let made: ScatterLayer[] | null = null
    const userDensity = latest.current.density
    createVegetationLayers({
      species: latest.current.species,
      variants,
      seed,
      density: userDensity ? (name, x, z) => (latest.current.density ?? userDensity)(name, x, z) : null,
      renderer: impostors && (gl as unknown as { isWebGPURenderer?: boolean }).isWebGPURenderer ? (gl as unknown as Renderer) : null,
      lodDistances,
      simplifiedDetail,
      impostor,
      castShadow,
      weather,
    }).then((l) => {
      if (cancelled) return disposeLayers(l)
      made = l
      setLayers(l)
    })
    return () => {
      cancelled = true
      if (made) disposeLayers(made)
      setLayers(null)
    }
  }, [key, gl])

  const sun = useRef<DirectionalLight | null>(null)
  useFrame(() => {
    if (!environment?.sun && !sun.current) scene.traverse((o) => { if (!sun.current && (o as DirectionalLight).isDirectionalLight) sun.current = o as DirectionalLight })
    setTreeEnvironment({ ...environment, sun: environment?.sun ?? sun.current })
  })

  return layers ? <Scatter {...scatter} seed={seed} layers={layers} /> : null
}
