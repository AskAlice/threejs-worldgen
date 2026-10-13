import { chunkSize, cubeToSphere, type ChunkKey } from './chunk.ts'
import type { Vec3 } from './noise.ts'
import type { World } from './world.ts'

/** Level-of-detail settings for the terrain quadtree. */
export interface LodSettings {
  /** Edge length of a level-0 chunk on flat worlds, metres. */
  rootSize: number
  /** A chunk splits when the camera is closer than `size × lodFactor` (higher = more detail further out). */
  lodFactor: number
  /** Chunks never get smaller than this, metres (0.5 lets an ant walk on centimetre-scale ground). */
  minChunkSize: number
  /** Flat worlds: terrain is drawn out to this distance from the camera, metres. Planets cull by the horizon. */
  viewDistance: number
}

/** What the renderer knows about a built chunk, for culling and distance tests. */
export interface ChunkBounds {
  /** Bounding-sphere centre (planet-centred / world position). */
  center: Vec3
  /** Bounding-sphere radius, metres. */
  radius: number
  /** Highest elevation in the chunk, metres. */
  maxElevation: number
}

/** Result of {@link selectChunks}. */
export interface ChunkSelection {
  /** Built chunks to draw this frame (together they cover the visible terrain without overlap). */
  show: ChunkKey[]
  /** Chunks to build, most urgent first. */
  need: ChunkKey[]
}

/** Deepest quadtree level for these settings. */
export function maxLevel(world: World, s: LodSettings): number {
  const root = world.options.surface === 'sphere' ? (world.options.radius * Math.PI) / 2 : s.rootSize
  return Math.max(0, Math.ceil(Math.log2(root / Math.max(1e-3, s.minChunkSize))))
}

/** The four children of a chunk. */
export function children(k: ChunkKey): ChunkKey[] {
  const l = k.level + 1, x = k.x * 2, y = k.y * 2
  return [
    { face: k.face, level: l, x, y }, { face: k.face, level: l, x: x + 1, y },
    { face: k.face, level: l, x, y: y + 1 }, { face: k.face, level: l, x: x + 1, y: y + 1 },
  ]
}

/**
 * Chooses which chunks to draw and which to build for a camera position (planet-centred or flat-world
 * metres). Splits by distance, culls by view distance (flat) or horizon (planet), and never leaves a
 * hole: while a chunk's children are being built it keeps drawing the chunk, and while a merged chunk
 * is being built it keeps drawing its children.
 *
 * @param bounds Returns bounds for built chunks, `undefined` for chunks not built yet.
 * @param maxElevation Conservative highest terrain height, for chunks not built yet.
 */
export function selectChunks(world: World, camera: Vec3, s: LodSettings, bounds: (k: ChunkKey) => ChunkBounds | undefined, maxElevation: number): ChunkSelection {
  const sphere = world.options.surface === 'sphere'
  const R = world.options.radius
  const deepest = maxLevel(world, s)
  const show: ChunkKey[] = []
  const need: { key: ChunkKey; priority: number }[] = []
  const tmp: Vec3 = [0, 0, 0]
  const camDist = Math.hypot(camera[0], camera[1], camera[2])
  const horizon = sphere ? Math.sqrt(Math.max(0, camDist * camDist - R * R)) : Infinity

  const estimate = (k: ChunkKey): ChunkBounds => {
    const b = bounds(k)
    if (b) return b
    const size = chunkSize(world, k, s.rootSize)
    if (!sphere) {
      return { center: [(k.x + 0.5) * size, 0, (k.y + 0.5) * size], radius: size * 0.71 + Math.max(maxElevation, 200), maxElevation }
    }
    const step = 2 / 2 ** k.level
    const d = cubeToSphere(k.face, -1 + (k.x + 0.5) * step, -1 + (k.y + 0.5) * step, tmp)
    return { center: [d[0] * R, d[1] * R, d[2] * R], radius: size * 0.75 + Math.max(maxElevation, 200), maxElevation }
  }

  const distance = (b: ChunkBounds) => Math.hypot(camera[0] - b.center[0], camera[1] - b.center[1], camera[2] - b.center[2])
  const size = (k: ChunkKey) => chunkSize(world, k, s.rootSize)
  const shouldSplit = (k: ChunkKey, b: ChunkBounds) => k.level < deepest && distance(b) - size(k) * 0.5 < size(k) * s.lodFactor
  const visible = (b: ChunkBounds) => {
    const d = distance(b)
    if (!sphere) return d - b.radius < s.viewDistance
    const reach = Math.sqrt(Math.max(0, (R + b.maxElevation) ** 2 - R * R))
    return d - b.radius < horizon + reach
  }
  const built = (k: ChunkKey) => bounds(k) !== undefined
  const want = (k: ChunkKey, b: ChunkBounds) => need.push({ key: k, priority: distance(b) / size(k) - k.level * 0.01 })

  const visit = (k: ChunkKey) => {
    const b = estimate(k)
    if (!visible(b)) return
    if (shouldSplit(k, b)) {
      const kids = children(k)
      // Recurse only once every child can be drawn (built, or covered by its own built children).
      const ready = kids.every((c) => built(c) || children(c).every(built))
      if (ready) {
        for (const c of kids) visit(c)
        return
      }
      for (const c of kids) if (!built(c)) want(c, estimate(c))
      if (built(k)) show.push(k)
      else {
        want(k, b)
        for (const c of kids) if (built(c)) show.push(c)
      }
      return
    }
    if (built(k)) show.push(k)
    else {
      want(k, b)
      // Merging: keep drawing the finer children until the coarser chunk is ready.
      const kids = children(k)
      if (kids.every(built)) show.push(...kids)
    }
  }

  if (sphere) {
    for (let f = 0; f < 6; f++) visit({ face: f, level: 0, x: 0, y: 0 })
  } else {
    const r = s.rootSize
    const x0 = Math.floor((camera[0] - s.viewDistance) / r), x1 = Math.floor((camera[0] + s.viewDistance) / r)
    const z0 = Math.floor((camera[2] - s.viewDistance) / r), z1 = Math.floor((camera[2] + s.viewDistance) / r)
    for (let y = z0; y <= z1; y++) for (let x = x0; x <= x1; x++) visit({ face: -1, level: 0, x, y })
  }
  need.sort((a, b) => a.priority - b.priority)
  return { show, need: need.map((n) => n.key) }
}
