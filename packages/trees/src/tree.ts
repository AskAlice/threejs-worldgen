import { Box3, type BufferGeometry } from 'three/webgpu'
import { hash, mulberry32 } from 'threejs-scatter'
import { addLeafCards, addTreeFruit } from './leaves.ts'
import { growSkeleton, type TreeSkeleton } from './space-colonization.ts'
import { DEFAULT_TREE_PARAMS, type TreeParams } from './species.ts'
import {
  bezier, generateBamboo, generateCactus, generateFern, generateFlowers, generateLilyPads, generatePalm, generateReed, generateSucculent, generateTuft,
} from './special.ts'
import { addTube, createArrays, linearColor, toGeometry, type MeshArrays, type Vec3 } from './tube-mesh.ts'

/** Geometry of one generated tree. Both parts carry position, normal, uv and colour (linear rgb) attributes. */
export interface TreeGeometry {
  /** Trunk, branches and roots (bark material). */
  trunk: BufferGeometry
  /** Leaf cards and fronds (leaf material), or `null` for leafless plants. */
  leaves: BufferGeometry | null
  /** Fruit, berries and flower heads (fruit material), or `null` when there are none. */
  fruit: BufferGeometry | null
  /** Bounds of both parts together. */
  bounds: Box3
}

/** Options of {@link generateTree}. */
export interface TreeDetailOptions {
  /**
   * 1 = full detail. Lower values (e.g. 0.4 for a mid-distance level) use fewer sides per branch, drop thin twigs and
   * place fewer, larger leaf cards, while keeping the same skeleton and silhouette.
   */
  detail?: number
}

/**
 * Generates a tree (or shrub, palm, cactus, fern, reed) from parameters and a seed. Deterministic: the same params and
 * seed always give the same geometry. Missing params come from {@link DEFAULT_TREE_PARAMS}; start from a preset in
 * `species` for a particular kind of tree.
 *
 * @example
 * ```ts
 * const { trunk, leaves } = generateTree(species.oak, 7)
 * scene.add(new Mesh(trunk, createBarkMaterial(species.oak)), new Mesh(leaves!, createLeafMaterial(species.oak)))
 * ```
 */
export function generateTree(params: Partial<TreeParams>, seed = 1, options: TreeDetailOptions = {}): TreeGeometry {
  return generateTreeLevels(params, seed, [options.detail ?? 1])[0]
}

/**
 * Generates the same tree at several detail levels (see {@link TreeDetailOptions.detail}), growing its skeleton only
 * once. Used for levels of detail: `generateTreeLevels(species.oak, 3, [1, 0.4])`.
 */
export function generateTreeLevels(params: Partial<TreeParams>, seed: number, details: readonly number[]): TreeGeometry[] {
  const p: TreeParams = { ...DEFAULT_TREE_PARAMS, ...params }
  const skeleton = p.kind === 'colonization' ? growSkeleton(p, mulberry32(hash(seed, 0x7ee5))) : null
  return details.map((d) => {
    const detail = Math.min(1, Math.max(0.05, d))
    // Separate streams so leaves never change the branch structure and vice versa.
    const rand = mulberry32(hash(seed, 0x7ee5))
    const leafRand = mulberry32(hash(seed, 0x1eaf))
    const trunk = createArrays()
    const leaves = createArrays()
    const fruit = createArrays()
    switch (p.kind) {
      case 'palm': generatePalm(p, rand, detail, trunk, leaves); break
      case 'cactus': generateCactus(p, rand, detail, trunk); break
      case 'fern': generateFern(p, rand, detail, trunk, leaves); break
      case 'reed': generateReed(p, rand, detail, trunk, leaves); break
      case 'flowers': generateFlowers(p, rand, detail, trunk, leaves, fruit); break
      case 'tuft': generateTuft(p, rand, detail, trunk, leaves); break
      case 'succulent': generateSucculent(p, rand, detail, trunk); break
      case 'bamboo': generateBamboo(p, rand, detail, trunk, leaves); break
      case 'lilyPad': generateLilyPads(p, rand, detail, trunk, fruit); break
      default: {
        addBranches(trunk, skeleton!, p, detail)
        if (p.propRoots > 0) addPropRoots(trunk, skeleton!, p, mulberry32(hash(seed, 0x9007)), detail)
        addLeafCards(leaves, skeleton!, p, leafRand, detail)
        addTreeFruit(fruit, skeleton!, p, mulberry32(hash(seed, 0xf401)), detail)
      }
    }
    const trunkGeometry = toGeometry(trunk)
    const leafGeometry = leaves.positions.length ? toGeometry(leaves) : null
    const fruitGeometry = fruit.positions.length ? toGeometry(fruit) : null
    const bounds = trunkGeometry.boundingBox!.clone()
    if (leafGeometry) bounds.union(leafGeometry.boundingBox!)
    if (fruitGeometry) bounds.union(fruitGeometry.boundingBox!)
    return { trunk: trunkGeometry, leaves: leafGeometry, fruit: fruitGeometry, bounds }
  })
}

/**
 * Turns a skeleton into tapered tubes. Each node continues into its heaviest child; other children start new tubes
 * from inside the parent at their own radius. The trunk gets a root flare and optional buttress lobes.
 */
function addBranches(out: MeshArrays, sk: TreeSkeleton, p: TreeParams, detail: number) {
  const P = sk.positions
  const children: number[][] = Array.from({ length: sk.count }, () => [])
  for (let i = 1; i < sk.count; i++) children[sk.parent[i]].push(i)
  const main = children.map((c) => (c.length ? c.reduce((a, b) => (sk.tips[b] > sk.tips[a] ? b : a)) : -1))
  // Simplified levels drop twigs thinner than this.
  const prune = detail >= 1 ? 0 : p.tipRadius * (1 + (1 - detail) * 5)
  const bark = linearColor(p.barkColor)
  const at = (i: number): Vec3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]
  const trunkSegs = Math.max(3, Math.round((p.buttress > 0 ? Math.max(p.radialSegments, 16) : p.radialSegments) * (0.45 + 0.55 * detail)))
  const lobePhase = (P[3] * 7.1 + P[5] * 3.3) % (Math.PI * 2)

  const queue: [from: number, first: number][] = [[-1, 0]]
  let chainIndex = 0
  while (queue.length) {
    const [from, first] = queue.pop()!
    if (sk.radius[first] < prune) continue
    const nodes = from >= 0 ? [from, first] : [first]
    let cur = first
    for (;;) {
      for (const c of children[cur]) if (c !== main[cur]) queue.push([cur, c])
      const next = main[cur]
      if (next < 0 || sk.radius[next] < prune) break
      nodes.push(next)
      cur = next
    }
    if (nodes.length < 2) continue
    const pts = nodes.map(at)
    const radii = nodes.map((n, k) => (k === 0 && from >= 0 ? sk.radius[nodes[1]] : sk.radius[n]))
    const isTrunk = chainIndex++ === 0
    if (isTrunk) {
      // Reach below the ground (hides the base on slopes) and add rings near the ground for the flare.
      const r0 = pts[0]
      const b1 = pts[1]
      const lerp = (t: number): Vec3 => [r0[0] + (b1[0] - r0[0]) * t, r0[1] + (b1[1] - r0[1]) * t, r0[2] + (b1[2] - r0[2]) * t]
      const head: Vec3[] = [[r0[0], r0[1] - 0.4, r0[2]], r0, lerp(0.12), lerp(0.3), lerp(0.6)]
      pts.splice(0, 1, ...head)
      radii.splice(0, 1, ...head.map(() => radii[0]))
    }
    const base = sk.radius[0]
    const segments = isTrunk ? trunkSegs : Math.max(3, Math.round(p.radialSegments * Math.sqrt(radii[0] / Math.max(base, 1e-4)) * (0.45 + 0.55 * detail)))
    const shade = 0.88 + 0.12 * ((nodes[0] * 0.6180339) % 1)
    addTube(out, pts, radii, {
      segments,
      // Side branches carry a random number so materials can break some off per instance; the trunk never breaks.
      card: isTrunk ? -1 : hash(first, 0xb4a7) / 4294967296,
      color: [bark[0] * shade, bark[1] * shade, bark[2] * shade],
      closeEnd: true,
      shape: isTrunk ? (_k, theta, q) => {
        const y = Math.max(0, q[1])
        const flare = 1 + p.rootFlare * Math.exp(-y / (base * 1.2 + 0.05))
        const lobes = p.buttress > 0 ? 1 + p.buttress * 1.6 * Math.pow(Math.max(0, Math.cos(theta * 5 + lobePhase)), 3) * Math.exp(-y / (base * 2.2 + 0.1)) : 1
        return flare * lobes
      } : undefined,
      shade: isTrunk ? (_k, q) => 0.7 + 0.3 * Math.min(1, Math.max(0, q[1]) / 1.5) : undefined,
    })
  }
}

/** Arching prop roots from the lower trunk into the ground (mangroves). */
function addPropRoots(out: MeshArrays, sk: TreeSkeleton, p: TreeParams, rand: () => number, detail: number) {
  const color = linearColor(p.barkColor).map((c) => c * 0.8) as Vec3
  const steps = Math.max(4, Math.round(10 * detail))
  for (let k = 0; k < p.propRoots; k++) {
    const a = (k / p.propRoots) * Math.PI * 2 + rand() * 0.5
    const y0 = p.trunkHeight * (0.25 + 0.5 * rand())
    // Start on the trunk: the first skeleton node at or above y0 on the root's main chain.
    let n = 0
    while (n + 1 < sk.count && sk.parent[n + 1] === n && sk.positions[n * 3 + 1] < y0) n++
    const start: Vec3 = [sk.positions[n * 3], sk.positions[n * 3 + 1], sk.positions[n * 3 + 2]]
    const reach = p.crownRadius * (0.35 + 0.35 * rand()) + y0 * 0.3
    const end: Vec3 = [start[0] + Math.cos(a) * reach, -0.4, start[2] + Math.sin(a) * reach]
    const ctrl: Vec3 = [start[0] + Math.cos(a) * reach * 0.45, start[1] + 0.35, start[2] + Math.sin(a) * reach * 0.45]
    const pts = bezier(start, ctrl, end, steps)
    const r0 = p.baseRadius * 0.32
    addTube(out, pts, pts.map((_, i) => r0 * (1 - 0.35 * (i / steps))), { segments: Math.max(3, Math.round(6 * detail)), color })
  }
}
