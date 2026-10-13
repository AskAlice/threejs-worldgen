import { GROUND_MATERIALS } from './biomes.ts'
import { createSample, hexToRgb, type World } from './world.ts'
import type { Vec3 } from './noise.ts'

/**
 * Address of one terrain patch in the LOD quadtree.
 * - Flat worlds: `face = -1`; the patch covers `[x, x+1] × [y, y+1]` times `rootSize / 2^level` metres (x → +X, y → +Z).
 * - Planets: `face` 0…5 is a cube face (+X, −X, +Y, −Y, +Z, −Z); the patch covers face coordinates
 *   `−1 + [x, x+1] × 2/2^level` (and the same for y), projected onto the sphere.
 */
export interface ChunkKey {
  /** −1 on flat worlds, 0…5 cube face on planets. */
  face: number
  /** Quadtree depth (0 = root). */
  level: number
  /** Column at this level. */
  x: number
  /** Row at this level. */
  y: number
}

/** String id of a {@link ChunkKey}, for maps and caches. */
export function chunkId(k: ChunkKey): string {
  return `${k.face}/${k.level}/${k.x}/${k.y}`
}

/** Geometry settings shared by every chunk. */
export interface ChunkSettings {
  /** Vertices per chunk side (e.g. 33 = 32 × 32 quads). */
  resolution: number
  /** Edge length of a level-0 chunk on flat worlds, metres. */
  rootSize: number
  /** Skirt depth as a fraction of the chunk's edge length (hides cracks between LODs). */
  skirt: number
}

/** A built chunk: plain typed arrays, transferable from a worker. Positions are relative to `center`. */
export interface ChunkData {
  /** Which chunk this is. */
  key: ChunkKey
  /** World version it was built from. */
  version: number
  /** Planet-centred (or flat-world) position of the chunk's centre, float64. */
  center: Vec3
  /** Vertex positions relative to `center` (xyz). Skirt vertices follow the grid. */
  positions: Float32Array
  /** Vertex normals (xyz). */
  normals: Float32Array
  /** Ground colour (rgb, sRGB 0…1). */
  colors: Float32Array
  /**
   * Per-vertex inputs for the shader's ground overrides: height above sea level (m), temperature (°C),
   * river strength (0…1) and slope (rise/run).
   */
  climate: Float32Array
  /** Biome debug-map colour (rgb, sRGB 0…1). */
  biomeColors: Float32Array
  /** Triangle indices. */
  index: Uint32Array
  /** Lowest elevation in the chunk, metres. */
  minElevation: number
  /** Highest elevation in the chunk, metres. */
  maxElevation: number
  /** Radius of a bounding sphere around `center`, metres. */
  radius: number
  /** Edge length, metres (approximate on planets). */
  size: number
}

// Cube faces: (u, v) in [-1, 1]² → a point on the unit cube.
const FACES: ((u: number, v: number, out: Vec3) => void)[] = [
  (u, v, o) => { o[0] = 1; o[1] = v; o[2] = -u },
  (u, v, o) => { o[0] = -1; o[1] = v; o[2] = u },
  (u, v, o) => { o[0] = u; o[1] = 1; o[2] = -v },
  (u, v, o) => { o[0] = u; o[1] = -1; o[2] = v },
  (u, v, o) => { o[0] = u; o[1] = v; o[2] = 1 },
  (u, v, o) => { o[0] = -u; o[1] = v; o[2] = -1 },
]

/** Unit-sphere direction for face coordinates (u, v), using the area-preserving-ish "spherified cube" map. */
export function cubeToSphere(face: number, u: number, v: number, out: Vec3 = [0, 0, 0]): Vec3 {
  FACES[face](u, v, out)
  const [x, y, z] = out
  const x2 = x * x, y2 = y * y, z2 = z * z
  out[0] = x * Math.sqrt(1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3)
  out[1] = y * Math.sqrt(1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3)
  out[2] = z * Math.sqrt(1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3)
  return out
}

/** Which cube face a direction falls on, and its face coordinates (inverse of the cube projection, before spherifying). */
export function sphereToFace(x: number, y: number, z: number): { face: number; u: number; v: number } {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z)
  if (ax >= ay && ax >= az) return x > 0 ? { face: 0, u: -z / ax, v: y / ax } : { face: 1, u: z / ax, v: y / ax }
  if (ay >= az) return y > 0 ? { face: 2, u: x / ay, v: -z / ay } : { face: 3, u: x / ay, v: z / ay }
  return z > 0 ? { face: 4, u: x / az, v: y / az } : { face: 5, u: -x / az, v: y / az }
}

/** Edge length of a chunk, metres (arc length on planets). */
export function chunkSize(world: World, k: ChunkKey, rootSize: number): number {
  return k.face < 0 ? rootSize / 2 ** k.level : (world.options.radius * Math.PI) / 2 / 2 ** k.level
}

// Does the (i, j+1, i+1) triangle order face outward on each cube face? Computed once.
const FLIP: boolean[] = FACES.map((_, f) => {
  const a = cubeToSphere(f, 0, 0), b = cubeToSphere(f, 0, 0.01), c = cubeToSphere(f, 0.01, 0)
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
  return n[0] * a[0] + n[1] * a[1] + n[2] * a[2] < 0
})

const indexCache = new Map<string, Uint32Array>()

/** Triangle indices for a grid of `n × n` vertices plus a skirt ring, optionally flipped. Cached. */
export function chunkIndex(n: number, flip: boolean): Uint32Array {
  const id = `${n}/${flip}`
  let idx = indexCache.get(id)
  if (idx) return idx
  const tris: number[] = []
  const tri = (a: number, b: number, c: number) => (flip ? tris.push(a, c, b) : tris.push(a, b, c))
  const v = (i: number, j: number) => j * n + i
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    tri(v(i, j), v(i, j + 1), v(i + 1, j))
    tri(v(i + 1, j), v(i, j + 1), v(i + 1, j + 1))
  }
  // Skirt: one extra vertex below each border vertex, walked around the border.
  const border = borderLoop(n)
  const base = n * n
  for (let k = 0; k < border.length; k++) {
    const a = border[k], b = border[(k + 1) % border.length]
    const sa = base + k, sb = base + ((k + 1) % border.length)
    tri(a, b, sa)
    tri(b, sb, sa)
  }
  idx = new Uint32Array(tris)
  indexCache.set(id, idx)
  return idx
}

/** Border vertex indices of an `n × n` grid, walked counter-clockwise from (0, 0). */
function borderLoop(n: number): number[] {
  const loop: number[] = []
  for (let i = 0; i < n - 1; i++) loop.push(i) // j = 0, i rising
  for (let j = 0; j < n - 1; j++) loop.push(j * n + n - 1) // i = n-1, j rising
  for (let i = n - 1; i > 0; i--) loop.push((n - 1) * n + i) // j = n-1, i falling
  for (let j = n - 1; j > 0; j--) loop.push(j * n) // i = 0, j falling
  return loop
}

/**
 * Builds one terrain chunk: heights, normals, ground colours, material splat, biome colours and a skirt.
 * Pure (no three.js, no DOM), so it runs the same on the main thread and in a worker.
 */
export function buildChunk(world: World, key: ChunkKey, settings: ChunkSettings): ChunkData {
  const n = settings.resolution
  const g = n + 2 // grid with a one-vertex ring for normals
  const sphere = key.face >= 0
  const R = world.options.radius
  const size = chunkSize(world, key, settings.rootSize)
  const spacing = size / (n - 1)
  const minWavelength = spacing * 2

  // Base-surface point and "up" direction for grid cell (i, j), i, j in [-1, n].
  const base: Vec3 = [0, 0, 0]
  const up: Vec3 = [0, 1, 0]
  const cellBase = (i: number, j: number) => {
    if (!sphere) {
      base[0] = (key.x + i / (n - 1)) * size
      base[1] = 0
      base[2] = (key.y + j / (n - 1)) * size
      return
    }
    const step = 2 / 2 ** key.level
    const u = -1 + (key.x + i / (n - 1)) * step
    const v = -1 + (key.y + j / (n - 1)) * step
    cubeToSphere(key.face, u, v, up)
    base[0] = up[0] * R; base[1] = up[1] * R; base[2] = up[2] * R
  }

  // Centre (for relative positions and bounds).
  cellBase((n - 1) / 2, (n - 1) / 2)
  const center: Vec3 = [base[0], base[1], base[2]]

  const pos = new Float64Array(g * g * 3)
  const ups = sphere ? new Float64Array(g * g * 3) : null
  const maxB = world.options.rules.maxBiomes
  const biomeIdx = new Int32Array(n * n * maxB)
  const biomeW = new Float32Array(n * n * maxB)
  const biomeN = new Uint8Array(n * n)
  const temp = new Float32Array(n * n)
  const river = new Float32Array(n * n)
  const elev = new Float32Array(n * n)
  const s = createSample(Math.max(8, maxB))
  let minE = Infinity, maxE = -Infinity

  for (let j = -1; j <= n; j++) for (let i = -1; i <= n; i++) {
    cellBase(i, j)
    world.sampleAt(base[0], base[1], base[2], s, minWavelength)
    const e = s.elevation
    const gi = ((j + 1) * g + (i + 1)) * 3
    if (sphere) {
      pos[gi] = up[0] * (R + e); pos[gi + 1] = up[1] * (R + e); pos[gi + 2] = up[2] * (R + e)
      ups![gi] = up[0]; ups![gi + 1] = up[1]; ups![gi + 2] = up[2]
    } else {
      pos[gi] = base[0]; pos[gi + 1] = e; pos[gi + 2] = base[2]
    }
    if (i >= 0 && j >= 0 && i < n && j < n) {
      const vi = j * n + i
      elev[vi] = e
      temp[vi] = s.temperature
      river[vi] = s.river
      biomeN[vi] = s.count
      for (let k = 0; k < s.count; k++) { biomeIdx[vi * maxB + k] = s.biomes[k]; biomeW[vi * maxB + k] = s.weights[k] }
      if (e < minE) minE = e
      if (e > maxE) maxE = e
    }
  }

  const border = borderLoop(n)
  const total = n * n + border.length
  const positions = new Float32Array(total * 3)
  const normals = new Float32Array(total * 3)
  const colors = new Float32Array(total * 3)
  const climate = new Float32Array(total * 4)
  const biomeColors = new Float32Array(total * 3)
  const biomeRgb = world.options.biomes.map((b) => hexToRgb(b.color))
  const weights = new Float32Array(GROUND_MATERIALS.length)
  const color = new Float32Array(3)
  let radius = 0

  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const vi = j * n + i
    const gi = ((j + 1) * g + (i + 1)) * 3
    const px = pos[gi] - center[0], py = pos[gi + 1] - center[1], pz = pos[gi + 2] - center[2]
    positions[vi * 3] = px; positions[vi * 3 + 1] = py; positions[vi * 3 + 2] = pz
    radius = Math.max(radius, Math.hypot(px, py, pz))

    // Normal from the four neighbours (exact heights, so neighbouring chunks agree at their seams).
    const l = gi - 3, r = gi + 3, d = gi - g * 3, u = gi + g * 3
    const ax = pos[r] - pos[l], ay = pos[r + 1] - pos[l + 1], az = pos[r + 2] - pos[l + 2]
    const bx = pos[u] - pos[d], by = pos[u + 1] - pos[d + 1], bz = pos[u + 2] - pos[d + 2]
    let nx = by * az - bz * ay, ny = bz * ax - bx * az, nz = bx * ay - by * ax
    const ux = ups ? ups[gi] : 0, uy = ups ? ups[gi + 1] : 1, uz = ups ? ups[gi + 2] : 0
    if (nx * ux + ny * uy + nz * uz < 0) { nx = -nx; ny = -ny; nz = -nz }
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len; ny /= len; nz /= len
    normals[vi * 3] = nx; normals[vi * 3 + 1] = ny; normals[vi * 3 + 2] = nz
    const cos = Math.max(1e-3, nx * ux + ny * uy + nz * uz)
    const slope = Math.sqrt(Math.max(0, 1 - cos * cos)) / cos

    // Ground colour and splat.
    s.elevation = elev[vi]; s.temperature = temp[vi]; s.river = river[vi]; s.count = biomeN[vi]
    let br = 0, bg = 0, bb = 0
    for (let k = 0; k < s.count; k++) {
      const b = biomeIdx[vi * maxB + k], w = biomeW[vi * maxB + k]
      s.biomes[k] = b; s.weights[k] = w
      br += w * biomeRgb[b][0]; bg += w * biomeRgb[b][1]; bb += w * biomeRgb[b][2]
    }
    world.ground(s, slope, weights, color, false)
    colors[vi * 3] = srgbToLinear(color[0]); colors[vi * 3 + 1] = srgbToLinear(color[1]); colors[vi * 3 + 2] = srgbToLinear(color[2])
    climate[vi * 4] = elev[vi] - world.options.seaLevel
    climate[vi * 4 + 1] = temp[vi]
    climate[vi * 4 + 2] = river[vi]
    climate[vi * 4 + 3] = slope
    biomeColors[vi * 3] = srgbToLinear(br); biomeColors[vi * 3 + 1] = srgbToLinear(bg); biomeColors[vi * 3 + 2] = srgbToLinear(bb)
  }

  // Skirt vertices: copies of the border pushed down (towards the planet centre on spheres).
  const depth = size * settings.skirt + 1
  border.forEach((vi, k) => {
    const si = n * n + k
    const gi = ((Math.floor(vi / n) + 1) * g + ((vi % n) + 1)) * 3
    const ux = ups ? ups[gi] : 0, uy = ups ? ups[gi + 1] : 1, uz = ups ? ups[gi + 2] : 0
    positions[si * 3] = positions[vi * 3] - ux * depth
    positions[si * 3 + 1] = positions[vi * 3 + 1] - uy * depth
    positions[si * 3 + 2] = positions[vi * 3 + 2] - uz * depth
    normals.copyWithin(si * 3, vi * 3, vi * 3 + 3)
    colors.copyWithin(si * 3, vi * 3, vi * 3 + 3)
    climate.copyWithin(si * 4, vi * 4, vi * 4 + 4)
    biomeColors.copyWithin(si * 3, vi * 3, vi * 3 + 3)
  })

  return {
    key, version: world.version, center, positions, normals, colors, climate, biomeColors,
    index: chunkIndex(n, sphere ? FLIP[key.face] : false),
    minElevation: minE, maxElevation: maxE, radius: radius + depth, size,
  }
}

// Vertex colours are linear in three.js; the biome table and ground colours are sRGB.
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
