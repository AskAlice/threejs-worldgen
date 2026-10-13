import { BufferAttribute, BufferGeometry, Float32BufferAttribute, Group, Mesh, type Material, type Renderer } from 'three/webgpu'
import { bakeImpostor, hash, hashString, type ImpostorOptions, type PlacementRules, type ScatterLayer, type ScatterLOD } from 'threejs-scatter'
import { float } from 'three/tsl'
import {
  applyImpostorWeather, createBarkMaterial, createFruitMaterial, createLeafMaterial, createRockMaterial, impostorFoliageMask, treeUniforms, type WeatherInputs,
} from './materials.ts'
import { generateRock, rocks, type RockParams } from './rock.ts'
import { DEFAULT_TREE_PARAMS, species as speciesPresets, type TreeParams } from './species.ts'
import { generateTreeLevels, type TreeGeometry } from './tree.ts'

/**
 * One kind of plant (or rock) in a vegetation set. Any placement rule left out gets a sensible default for the kind
 * (rocks tilt onto the slope and sink in, trees stand upright and avoid cliffs).
 */
export interface VegetationSpecies extends Partial<Omit<PlacementRules, 'name' | 'density'>> {
  /** A `species` preset (`'oak'`, `'spruce'`, …), a `rocks` preset (`'boulder'`, …), or any name when `params` is given. */
  name: string
  /** Overrides on top of the preset: tree params, or rock params for rock presets. */
  params?: Partial<TreeParams> | Partial<RockParams>
  /** Share (0..1) of the blue-noise points this species takes. */
  density: number
  /** Distinct generated variants (overrides `VegetationOptions.variants`). */
  variants?: number
}

/** Options of {@link createVegetationLayers}. Plain data except `density` and `renderer`. */
export interface VegetationOptions {
  /** What grows. */
  species: VegetationSpecies[]
  /** Generated variants per species (each a different seed; instances pick one at random). */
  variants?: number
  /** Seed for the variants' shapes. */
  seed?: number
  /**
   * Per-position density multiplier for each species, e.g. biome weights:
   * `(name, x, z) => biomes.weights(x, z).forest`. Multiplies the species' own `density`.
   */
  density?: ((species: string, x: number, z: number) => number) | null
  /** An initialised WebGPURenderer: when given, far levels are baked octahedral impostors. */
  renderer?: Renderer | null
  /**
   * End distances of the full mesh, simplified mesh and impostor for a 15 m tree. Each species scales them by its size
   * (clamped to ×0.12…×3), so ferns switch level sooner than redwoods.
   */
  lodDistances?: [full: number, simplified: number, impostor: number]
  /** Detail (0..1) of the simplified mesh level. */
  simplifiedDetail?: number
  /** Impostor bake settings. */
  impostor?: Partial<ImpostorOptions>
  /** Whether mesh levels cast shadows (impostors never do). */
  castShadow?: boolean
  /** Weather inputs for every generated material (see `WeatherInputs`); defaults follow the global `treeUniforms`. */
  weather?: WeatherInputs
}

const DEFAULT_LOD_DISTANCES: [number, number, number] = [35, 110, 600]

/**
 * Builds scatter layers for a set of species: a few generated variants each, with a full mesh, a simplified mesh and
 * (with a renderer) a baked impostor, plus placement rules. Variants of a species share one blue-noise point set, so
 * they never overlap; give several species the same `group` to make them share one too (a mixed canopy).
 *
 * Pass the result as `layers` to a `Scatter`; free it with `disposeLayers` from threejs-scatter.
 *
 * @example
 * ```ts
 * const layers = await createVegetationLayers({
 *   species: [{ name: 'oak', density: 0.5, group: 'canopy' }, { name: 'beech', density: 0.4, group: 'canopy' }, { name: 'fern', density: 0.6 }],
 *   renderer,
 * })
 * Scatter.create({ camera, scene, terrain, layers })
 * ```
 */
export async function createVegetationLayers(options: VegetationOptions): Promise<ScatterLayer[]> {
  const seed = options.seed ?? 1
  const [nearD, midD, farD] = options.lodDistances ?? DEFAULT_LOD_DISTANCES
  const layers: ScatterLayer[] = []
  for (const sp of options.species) {
    const isRock = sp.name in rocks && !(sp.name in speciesPresets)
    const preset = isRock ? undefined : (speciesPresets as Record<string, TreeParams | undefined>)[sp.name]
    if (!isRock && !preset && !sp.params) throw new Error(`createVegetationLayers: unknown species "${sp.name}" (give \`params\` for a custom one)`)
    const variants = Math.max(1, Math.round(sp.variants ?? options.variants ?? 3))
    const tree: TreeParams = { ...DEFAULT_TREE_PARAMS, ...preset, ...(sp.params as Partial<TreeParams>) }
    const rock: RockParams = { ...rocks[sp.name as keyof typeof rocks], ...(sp.params as Partial<RockParams>) }
    const size = isRock ? rock.size : tree.height
    const k = Math.min(3, Math.max(0.12, size / 15))
    const mo = { weather: options.weather }
    const materialsFor = (o: typeof mo): Material | Material[] =>
      isRock ? createRockMaterial(o) : [createBarkMaterial(tree, o), createLeafMaterial(tree, o), createFruitMaterial(tree, o)]
    const material = materialsFor(mo)
    // Impostors are baked from clear-weather copies; the live weather is applied on top (applyImpostorWeather), as on
    // the meshes, so it is not baked in twice or frozen at bake time.
    const clear = { weather: { wetness: float(0), snow: float(0), burn: float(0), damage: float(0) } }
    const bakeMaterials = options.renderer ? materialsFor(clear) : null
    const foliage = new Set(Array.isArray(bakeMaterials) ? bakeMaterials.slice(1) : [])
    const share = sp.density / variants
    const userDensity = options.density
    const density = userDensity ? (x: number, z: number) => share * userDensity(sp.name, x, z) : share

    for (let v = 0; v < variants; v++) {
      const vSeed = hash(seed, hashString(sp.name), v)
      let full: BufferGeometry
      let simple: BufferGeometry
      if (isRock) {
        full = generateRock(rock, vSeed)
        simple = generateRock({ ...rock, detail: Math.max(1, rock.detail - 2) }, vSeed)
      } else {
        const [a, b] = generateTreeLevels(tree, vSeed, [1, options.simplifiedDetail ?? 0.35])
        full = mergeTreeGeometry(a)
        simple = mergeTreeGeometry(b)
      }
      let impostor: ScatterLOD | null = null
      if (options.renderer && bakeMaterials) {
        const group = new Group()
        const mats = Array.isArray(bakeMaterials) ? bakeMaterials : [bakeMaterials]
        const mesh = new Mesh(full, mats.length > 1 ? mats : mats[0])
        group.add(mesh)
        const wind = treeUniforms.windStrength.value
        treeUniforms.windStrength.value = 0
        try {
          const baked = await bakeImpostor(options.renderer, group, { size: 512, ...options.impostor }, (m) => impostorFoliageMask(foliage.has(m)))
          applyImpostorWeather(baked.material, baked.surface, { ...mo, rock: isRock })
          impostor = { distance: farD * k, geometry: baked.geometry, material: baked.material, castShadow: false }
        } finally {
          treeUniforms.windStrength.value = wind
        }
      }
      layers.push({
        name: `${sp.name}#${v}`,
        group: sp.group ?? sp.name,
        spacing: sp.spacing ?? (isRock ? rock.spacing : tree.spacing),
        density,
        minSlope: sp.minSlope ?? 0,
        maxSlope: sp.maxSlope ?? (isRock ? Infinity : 1),
        minHeight: sp.minHeight ?? -Infinity,
        maxHeight: sp.maxHeight ?? Infinity,
        cluster: sp.cluster ?? null,
        scale: sp.scale ?? (isRock ? [0.5, 1.6] : tree.scaleRange),
        align: sp.align ?? (isRock ? 1 : 0),
        randomYaw: sp.randomYaw ?? true,
        tilt: sp.tilt ?? (isRock ? 0 : tree.leanVariation),
        sink: sp.sink ?? (isRock ? size * 0.1 : 0.05),
        colorVariation: sp.colorVariation ?? 0.12,
        lods: [
          { distance: nearD * k, geometry: full, material },
          { distance: (impostor ? midD : farD) * k, geometry: simple, material },
        ],
        impostor,
        castShadow: options.castShadow ?? true,
        receiveShadow: true,
      })
    }
    // Only ever cloned by the bake (never rendered themselves).
    for (const m of [bakeMaterials ?? []].flat()) m.dispose()
  }
  return layers
}

/**
 * Merges a tree's parts into one geometry with groups by material index (0 = bark, 1 = leaves, 2 = fruit), ready for a
 * `[bark, leaves, fruit]` material array and a single instanced draw per level of detail. Disposes the parts.
 */
export function mergeTreeGeometry(tree: TreeGeometry): BufferGeometry {
  const parts = ([[tree.trunk, 0], [tree.leaves, 1], [tree.fruit, 2]] as const).filter((p): p is readonly [BufferGeometry, 0 | 1 | 2] => !!p[0])
  const out = new BufferGeometry()
  for (const name of ['position', 'normal', 'uv', 'color', 'cardRandom']) {
    const size = tree.trunk.getAttribute(name).itemSize
    const arrays = parts.map(([g]) => g.getAttribute(name).array as Float32Array)
    const merged = new Float32Array(arrays.reduce((n, a) => n + a.length, 0))
    let o = 0
    for (const a of arrays) {
      merged.set(a, o)
      o += a.length
    }
    out.setAttribute(name, new Float32BufferAttribute(merged, size))
  }
  const vertexCount = out.getAttribute('position').count
  const indices = vertexCount <= 65536 ? new Uint16Array(parts.reduce((n, [g]) => n + g.index!.count, 0)) : new Uint32Array(parts.reduce((n, [g]) => n + g.index!.count, 0))
  let start = 0
  let offset = 0
  for (const [g, materialIndex] of parts) {
    const index = g.index!.array
    if (index.length) out.addGroup(start, index.length, materialIndex) // empty parts (a twig-less simplified shrub) are skipped
    for (let k = 0; k < index.length; k++) indices[start + k] = index[k] + offset
    start += index.length
    offset += g.getAttribute('position').count
  }
  out.setIndex(new BufferAttribute(indices, 1))
  out.boundingBox = tree.bounds.clone()
  out.computeBoundingSphere()
  for (const [g] of parts) g.dispose()
  return out
}
