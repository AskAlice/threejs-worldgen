import type { FlattenPath, LocalFrame } from 'threejs-biomes'

/**
 * Drainage-basin hydrology for bounded maps: fill depressions, route flow downhill, accumulate it,
 * and read off rivers and lakes. Pure functions on plain arrays (no three.js), so they run in tests,
 * workers and build scripts.
 *
 * Grids are row-major: cell `(col, row)` is index `row * cols + col`, centred at
 * `(x0 + col * cellSize, z0 + row * cellSize)` in the frame the heights were sampled in.
 */

/** A rectangular area of a frame to analyse. All numbers, so it can be saved and sent to a worker. */
export interface HydrologyRegion {
  /** Minimum x (west edge) in the frame, metres. */
  x: number
  /** Minimum z (north edge) in the frame, metres. */
  z: number
  /** Extent along x, metres. */
  width: number
  /** Extent along z, metres. */
  depth: number
  /** Grid spacing, metres. Rivers are traced cell by cell, so this is their finest detail. */
  cellSize: number
}

/** Heights sampled on a regular grid. */
export interface HydrologyGrid {
  /** Cells along x. */
  cols: number
  /** Cells along z. */
  rows: number
  /** Grid spacing, metres. */
  cellSize: number
  /** x of column 0, metres. */
  x0: number
  /** z of row 0, metres. */
  z0: number
  /** Heights, row-major, metres. */
  heights: Float64Array
}

/** Settings of {@link analyzeHydrology}. */
export interface HydrologyOptions {
  /** Height (metres) added per cell across filled flats so every cell drains (Priority-Flood+ε). */
  epsilon: number
  /** Cells at or below this height are sea: they absorb flow and are never filled. `-Infinity` = only the map edges drain. */
  seaLevel: number
  /** Upstream area (m²) at which a channel becomes a river. */
  riverArea: number
  /** River width (metres) where it drains 1 km². */
  widthFactor: number
  /** Width grows as (area / 1 km²)^widthExponent; 0.5 is typical of real rivers. */
  widthExponent: number
  /** Narrowest river, metres. */
  minWidth: number
  /** Widest river, metres. */
  maxWidth: number
  /** Channel depth as a fraction of its width. */
  depthFactor: number
  /** Shallowest channel, metres. */
  minDepth: number
  /** 0 … 1: how full channels are (the water surface sits this far from the bed to the bank top). */
  fill: number
  /** Bank slope width as a multiple of the channel half-width (the carving modifier's falloff). */
  bankFalloff: number
  /** Smallest lake kept, m². */
  minLakeArea: number
  /** Shallowest lake kept (its deepest point), metres. */
  minLakeDepth: number
  /** Smoothing passes over river polylines (removes the D8 zig-zag). */
  smoothing: number
}

/** Default hydrology settings: rivers from 0.25 km² of catchment, lakes from 400 m² and 0.3 m deep. */
export const DEFAULT_HYDROLOGY: HydrologyOptions = {
  epsilon: 1e-4,
  seaLevel: -Infinity,
  riverArea: 250_000,
  widthFactor: 4,
  widthExponent: 0.5,
  minWidth: 1.5,
  maxWidth: 120,
  depthFactor: 0.12,
  minDepth: 0.4,
  fill: 0.75,
  bankFalloff: 1.5,
  minLakeArea: 400,
  minLakeDepth: 0.3,
  smoothing: 2,
}

/** A river polyline, from source (or confluence, or lake outlet) downstream to a confluence, lake, sea or map edge. */
export interface RiverPath {
  /** Points [x, z] in the frame, metres. */
  points: [x: number, z: number][]
  /** Water surface height at each point, metres. Never rises downstream. */
  surface: number[]
  /** Channel bed height at each point, metres. Never rises downstream. */
  bed: number[]
  /** Channel width at each point, metres. */
  width: number[]
  /** Upstream area at each point, m². */
  area: number[]
}

/** A lake: a filled depression. */
export interface Lake {
  /** Water surface height (the spill level of the depression), metres. */
  level: number
  /** Surface area, m². */
  area: number
  /** Deepest point below `level`, metres. */
  maxDepth: number
  /** Bounding box in grid cells: first column, first row, columns, rows. */
  bounds: [col: number, row: number, cols: number, rows: number]
  /** 1 where the lake covers a cell of `bounds` (row-major within the box). */
  mask: Uint8Array
}

/** Everything {@link analyzeHydrology} finds. */
export interface HydrologyResult {
  /** The analysed grid. */
  grid: HydrologyGrid
  /** Settings used. */
  options: HydrologyOptions
  /** Heights with depressions filled (+ε gradients), metres. */
  filled: Float64Array
  /** Index of the cell each cell drains to, or −1 for outlets (sea, map edge sinks). */
  receivers: Int32Array
  /** Upstream area of each cell including itself, m². */
  accumulation: Float64Array
  /** Lake index of each cell, or −1. */
  lakeIndex: Int32Array
  /** Rivers. */
  rivers: RiverPath[]
  /** Lakes. */
  lakes: Lake[]
}

/** Samples `height(x, z)` on a grid covering `region` (both edges included). */
export function sampleGrid(height: (x: number, z: number) => number, region: HydrologyRegion): HydrologyGrid {
  const cs = region.cellSize
  const cols = Math.max(2, Math.floor(region.width / cs) + 1)
  const rows = Math.max(2, Math.floor(region.depth / cs) + 1)
  const heights = new Float64Array(cols * rows)
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = height(region.x + c * cs, region.z + r * cs)
  return { cols, rows, cellSize: cs, x0: region.x, z0: region.z, heights }
}

const DC = [1, 1, 0, -1, -1, -1, 0, 1]
const DR = [0, 1, 1, 1, 0, -1, -1, -1]
const DIST = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2]

/**
 * Priority-Flood depression filling (Barnes, Lehman & Mulla 2014). Every cell is raised to the
 * lowest level water there could spill out at, through the map edge or into the sea. With
 * `epsilon > 0` filled flats also get a tiny gradient (Priority-Flood+ε), so every cell has a strictly
 * lower neighbour and flow routing never gets stuck.
 */
export function fillDepressions(heights: ArrayLike<number>, cols: number, rows: number, epsilon = 0, seaLevel = -Infinity): Float64Array {
  const n = cols * rows
  const filled = Float64Array.from(heights)
  const closed = new Uint8Array(n)
  const open = new MinHeap(n)
  const pit = new Int32Array(n)
  let pitHead = 0, pitTail = 0
  for (let i = 0; i < n; i++) {
    const c = i % cols, r = (i / cols) | 0
    if (c === 0 || r === 0 || c === cols - 1 || r === rows - 1 || filled[i] <= seaLevel) {
      closed[i] = 1
      open.push(filled[i], i)
    }
  }
  while (pitHead < pitTail || open.size) {
    const i = pitHead < pitTail ? pit[pitHead++] : open.pop()
    const c = i % cols, r = (i / cols) | 0
    for (let d = 0; d < 8; d++) {
      const nc = c + DC[d], nr = r + DR[d]
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
      const j = nr * cols + nc
      if (closed[j]) continue
      closed[j] = 1
      if (filled[j] <= filled[i]) {
        filled[j] = filled[i] + epsilon
        pit[pitTail++] = j
      } else {
        open.push(filled[j], j)
      }
    }
  }
  return filled
}

/**
 * D8 flow routing: each cell drains to its steepest strictly-lower neighbour, or is an outlet (−1).
 * Sea cells (at or below `seaLevel` in the unfilled `heights`) are always outlets.
 */
export function flowReceivers(filled: ArrayLike<number>, cols: number, rows: number, heights: ArrayLike<number> = filled, seaLevel = -Infinity): Int32Array {
  const receivers = new Int32Array(cols * rows).fill(-1)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (heights[i] <= seaLevel) continue
      let best = -1, steepest = 0
      for (let d = 0; d < 8; d++) {
        const nc = c + DC[d], nr = r + DR[d]
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
        const j = nr * cols + nc
        const slope = (filled[i] - filled[j]) / DIST[d]
        if (slope > steepest) { steepest = slope; best = j }
      }
      receivers[i] = best
    }
  }
  return receivers
}

/**
 * Flow accumulation: each cell's own `cellArea` plus everything upstream of it. Also returns the
 * cells in upstream-to-downstream order (a topological order of the drainage tree).
 */
export function flowAccumulation(receivers: Int32Array, cellArea = 1): { accumulation: Float64Array; order: Int32Array } {
  const n = receivers.length
  const inflow = new Int32Array(n)
  for (let i = 0; i < n; i++) if (receivers[i] >= 0) inflow[receivers[i]]++
  const order = new Int32Array(n)
  let head = 0, tail = 0
  for (let i = 0; i < n; i++) if (inflow[i] === 0) order[tail++] = i
  const acc = new Float64Array(n).fill(cellArea)
  while (head < tail) {
    const i = order[head++]
    const j = receivers[i]
    if (j < 0) continue
    acc[j] += acc[i]
    if (--inflow[j] === 0) order[tail++] = j
  }
  return { accumulation: acc, order }
}

/** Runs the whole analysis on a sampled grid: filling, routing, accumulation, lakes and rivers. */
export function analyzeHydrology(grid: HydrologyGrid, input: Partial<HydrologyOptions> = {}): HydrologyResult {
  const o: HydrologyOptions = { ...DEFAULT_HYDROLOGY, ...stripUndefined(input) }
  const { cols, rows, cellSize: cs, heights } = grid
  const n = cols * rows
  const cellArea = cs * cs
  const filled = fillDepressions(heights, cols, rows, Math.max(0, o.epsilon), o.seaLevel)
  const receivers = flowReceivers(filled, cols, rows, heights, o.seaLevel)
  const { accumulation, order } = flowAccumulation(receivers, cellArea)

  // Lakes from an exact (ε = 0) fill, so each lake is flat at its true spill level.
  const level = o.epsilon > 0 ? fillDepressions(heights, cols, rows, 0, o.seaLevel) : filled
  const lakeIndex = new Int32Array(n).fill(-1)
  const lakes: Lake[] = []
  const stack: number[] = []
  const members: number[] = []
  const tol = 1e-9
  for (let s = 0; s < n; s++) {
    if (lakeIndex[s] !== -1 || !(level[s] - heights[s] > tol)) continue
    // Flood the connected set of filled cells.
    members.length = 0
    stack.push(s)
    lakeIndex[s] = -2
    let maxDepth = 0, top = -Infinity
    let c0 = cols, r0 = rows, c1 = 0, r1 = 0
    while (stack.length) {
      const i = stack.pop()!
      members.push(i)
      const c = i % cols, r = (i / cols) | 0
      maxDepth = Math.max(maxDepth, level[i] - heights[i])
      top = Math.max(top, level[i])
      c0 = Math.min(c0, c); r0 = Math.min(r0, r); c1 = Math.max(c1, c); r1 = Math.max(r1, r)
      for (let d = 0; d < 8; d++) {
        const nc = c + DC[d], nr = r + DR[d]
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
        const j = nr * cols + nc
        if (lakeIndex[j] === -1 && level[j] - heights[j] > tol) { lakeIndex[j] = -2; stack.push(j) }
      }
    }
    const keep = members.length * cellArea >= o.minLakeArea && maxDepth >= o.minLakeDepth
    const id = keep ? lakes.length : -3 // -3: visited, too small
    for (const i of members) lakeIndex[i] = id
    if (!keep) continue
    const bw = c1 - c0 + 1, bh = r1 - r0 + 1
    const mask = new Uint8Array(bw * bh)
    for (const i of members) mask[(((i / cols) | 0) - r0) * bw + (i % cols) - c0] = 1
    lakes.push({ level: top, area: members.length * cellArea, maxDepth, bounds: [c0, r0, bw, bh], mask })
  }
  for (let i = 0; i < n; i++) if (lakeIndex[i] < -1) lakeIndex[i] = -1

  // Rivers: cells draining at least `riverArea`, outside lakes. Bed and surface never rise downstream.
  const isRiver = new Uint8Array(n)
  const bed = new Float64Array(n)
  const surface = new Float64Array(n)
  const width = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    if (accumulation[i] < o.riverArea || lakeIndex[i] >= 0 || heights[i] <= o.seaLevel) continue
    isRiver[i] = 1
    const w = Math.min(o.maxWidth, Math.max(o.minWidth, o.widthFactor * Math.pow(accumulation[i] / 1e6, o.widthExponent)))
    const depth = Math.max(o.minDepth, w * o.depthFactor)
    width[i] = w
    bed[i] = filled[i] - depth
    surface[i] = bed[i] + depth * o.fill
  }
  // Each river cell continues the upstream branch that drains the most; other branches end there (confluences).
  const mainParent = new Int32Array(n).fill(-1)
  for (let k = 0; k < n; k++) {
    const i = order[k], j = receivers[i]
    if (!isRiver[i] || j < 0 || !isRiver[j]) continue
    if (mainParent[j] < 0 || accumulation[i] > accumulation[mainParent[j]]) mainParent[j] = i
    bed[j] = Math.min(bed[j], bed[i])
    surface[j] = Math.min(surface[j], surface[i])
  }

  const rivers: RiverPath[] = []
  const point = (path: RiverPath, i: number, s: number, b: number, w: number) => {
    path.points.push([grid.x0 + (i % cols) * cs, grid.z0 + ((i / cols) | 0) * cs])
    path.surface.push(s); path.bed.push(b); path.width.push(w); path.area.push(accumulation[i])
  }
  // Walk down from every head (a river cell no river flows into) until a confluence, lake, the sea or an outlet.
  for (let i0 = 0; i0 < n; i0++) {
    if (!isRiver[i0] || mainParent[i0] >= 0) continue // only sources and lake outlets start a path
    const path: RiverPath = { points: [], surface: [], bed: [], width: [], area: [] }
    let i = i0
    while (true) {
      point(path, i, surface[i], bed[i], width[i])
      const j = receivers[i]
      if (j < 0) break
      if (isRiver[j]) {
        if (mainParent[j] === i) { i = j; continue }
        point(path, j, surface[j], bed[j], width[j]) // joins a bigger river
        break
      }
      point(path, j, surface[i], bed[i], width[i]) // into a lake or the sea, at this river's level
      break
    }
    if (path.points.length >= 2) rivers.push(smoothPath(path, o.smoothing))
  }
  return { grid, options: o, filled, receivers, accumulation, lakeIndex, rivers, lakes }
}

/** Samples `height` over `region` and analyses it: the one-call version of {@link sampleGrid} + {@link analyzeHydrology}. */
export function computeHydrology(height: (x: number, z: number) => number, region: HydrologyRegion, options: Partial<HydrologyOptions> = {}): HydrologyResult {
  return analyzeHydrology(sampleGrid(height, region), options)
}

/** What {@link riverModifiers} needs of a frame: a flat frame has `origin` at [0, 0, 0]. */
export type ModifierFrame = Pick<LocalFrame, 'origin' | 'up' | 'basePoint'>

/**
 * Height modifiers that carve the rivers into a world: `path` modifiers along each river with
 * descending bed heights. Add them with `world.addModifier(m)` (or `world.set({ modifiers })`). Pass
 * the frame the heights were sampled in; on a planet, points are projected onto the sphere and
 * heights converted to elevations, as the world expects.
 * @param chunk Points per modifier. Each modifier has one width, so rivers are split to widen downstream.
 */
export function riverModifiers(result: HydrologyResult, frame?: ModifierFrame, chunk = 8): FlattenPath[] {
  const o = result.options
  const cs = result.grid.cellSize
  const out: FlattenPath[] = []
  const step = Math.max(2, Math.floor(chunk))
  for (const river of result.rivers) {
    for (let a = 0; a < river.points.length - 1; a += step - 1) {
      const b = Math.min(river.points.length, a + step)
      let w = 0
      const points: [number, number, number, number][] = []
      for (let i = a; i < b; i++) {
        const [x, z] = river.points[i]
        points.push(toModifierPoint(frame, x, z, river.bed[i]))
        w += river.width[i]
      }
      const half = w / (b - a) / 2
      out.push({ type: 'path', points, width: half, falloff: Math.max(cs, half * o.bankFalloff) })
    }
  }
  return out
}

const _p: [number, number, number] = [0, 0, 0]
/** Frame-local (x, z) and local height → modifier point [x, y, z, elevation] on the world's base surface. */
function toModifierPoint(frame: ModifierFrame | undefined, x: number, z: number, y: number): [number, number, number, number] {
  const o = frame?.origin
  const R = o ? Math.hypot(o[0], o[1], o[2]) : 0
  if (!frame || R === 0) return [x, 0, z, y]
  const p = frame.basePoint(x, z, _p)
  const len = Math.hypot(p[0], p[1], p[2])
  const u = frame.up
  const cos = (p[0] * u[0] + p[1] * u[1] + p[2] * u[2]) / len
  // Local y = elevation·cos − drop (see LocalFrame.sample), drop = R(1 − cos).
  const elevation = (y + R * (1 - cos)) / cos
  const k = R / len
  return [p[0] * k, p[1] * k, p[2] * k, elevation]
}

/** Water at a point, from {@link waterAt} or {@link hydrologyWaterAt}. */
export interface WaterSample {
  /** What kind of water is here. */
  kind: 'none' | 'sea' | 'lake' | 'river'
  /** Water surface height (frame-local y), or NaN where dry. */
  level: number
  /** Water depth (surface minus ground), metres; 0 where dry. */
  depth: number
  /** Surface flow velocity along x, m/s. */
  flowX: number
  /** Surface flow velocity along z, m/s. */
  flowZ: number
}

/** Creates an empty {@link WaterSample}. */
export function createWaterSample(): WaterSample {
  return { kind: 'none', level: NaN, depth: 0, flowX: 0, flowZ: 0 }
}

/**
 * Water at frame position (x, z) according to a hydrology result (nearest cell): lake level, or
 * river surface with a flow velocity downstream. Speeds follow `√slope` (1 m/s at a 1% slope).
 */
export function hydrologyWaterAt(result: HydrologyResult, x: number, z: number, out: WaterSample = createWaterSample()): WaterSample {
  const { cols, rows, cellSize: cs, x0, z0, heights } = result.grid
  out.kind = 'none'; out.level = NaN; out.depth = 0; out.flowX = 0; out.flowZ = 0
  const c = Math.round((x - x0) / cs), r = Math.round((z - z0) / cs)
  if (c < 0 || r < 0 || c >= cols || r >= rows) return out
  const i = r * cols + c
  const o = result.options
  const lake = result.lakeIndex[i]
  if (lake >= 0) {
    const l = result.lakes[lake].level
    out.kind = 'lake'; out.level = l; out.depth = Math.max(0, l - heights[i])
    return out
  }
  if (heights[i] <= o.seaLevel) {
    out.kind = 'sea'; out.level = o.seaLevel; out.depth = o.seaLevel - heights[i]
    return out
  }
  if (result.accumulation[i] < o.riverArea) return out
  const w = Math.min(o.maxWidth, Math.max(o.minWidth, o.widthFactor * Math.pow(result.accumulation[i] / 1e6, o.widthExponent)))
  const depth = Math.max(o.minDepth, w * o.depthFactor)
  out.kind = 'river'
  out.level = result.filled[i] - depth * (1 - o.fill)
  out.depth = depth * o.fill
  const j = result.receivers[i]
  if (j >= 0) {
    const dx = ((j % cols) - c) * cs, dz = (((j / cols) | 0) - r) * cs
    const dist = Math.hypot(dx, dz)
    const speed = Math.min(4, Math.max(0.1, Math.sqrt(Math.max(0, result.filled[i] - result.filled[j]) / dist / 0.01)))
    out.flowX = (dx / dist) * speed
    out.flowZ = (dz / dist) * speed
  }
  return out
}

function smoothPath(path: RiverPath, passes: number): RiverPath {
  const p = path.points
  for (let k = 0; k < passes; k++) {
    let prev = p[0]
    for (let i = 1; i < p.length - 1; i++) {
      const cur = p[i]
      const next = p[i + 1]
      const sx = prev[0] * 0.25 + cur[0] * 0.5 + next[0] * 0.25
      const sz = prev[1] * 0.25 + cur[1] * 0.5 + next[1] * 0.25
      prev = [cur[0], cur[1]]
      cur[0] = sx; cur[1] = sz
    }
  }
  return path
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

/** Binary min-heap of (key, index) pairs in typed arrays. */
class MinHeap {
  size = 0
  private keys: Float64Array
  private items: Int32Array
  constructor(capacity: number) {
    this.keys = new Float64Array(Math.max(1, capacity))
    this.items = new Int32Array(Math.max(1, capacity))
  }
  push(key: number, item: number) {
    let i = this.size++
    const k = this.keys, it = this.items
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (k[parent] <= key) break
      k[i] = k[parent]; it[i] = it[parent]
      i = parent
    }
    k[i] = key; it[i] = item
  }
  pop(): number {
    const k = this.keys, it = this.items
    const top = it[0]
    const n = --this.size
    const key = k[n], item = it[n]
    let i = 0
    while (true) {
      let c = 2 * i + 1
      if (c >= n) break
      if (c + 1 < n && k[c + 1] < k[c]) c++
      if (k[c] >= key) break
      k[i] = k[c]; it[i] = it[c]
      i = c
    }
    k[i] = key; it[i] = item
    return top
  }
}
