import type { TreeParams } from './species.ts'

/** A grown branching structure: nodes connected to their parents, with pipe-model radii. */
export interface TreeSkeleton {
  /** Number of nodes. */
  count: number
  /** xyz per node, metres; the base of the trunk is at the origin. */
  positions: Float32Array
  /** Parent node index, or -1 for the root. Parents always come before their children. */
  parent: Int32Array
  /** Branch radius at each node (pipe model). */
  radius: Float32Array
  /** Steps from each node to its nearest branch tip (0 = a tip). */
  tipDistance: Int32Array
  /** Number of branch tips above each node. */
  tips: Int32Array
  /** Centre of the crown envelope; leaf normals point away from it. */
  crownCenter: [x: number, y: number, z: number]
}

/** Horizontal radius factor (0..1) of a crown envelope at relative height `t` (0 = bottom, 1 = top). */
export function crownProfile(shape: TreeParams['crownShape'], t: number): number {
  if (t < 0 || t > 1) return 0
  switch (shape) {
    case 'cone': return Math.min(1, (1 - t) * 1.08)
    case 'hemisphere': return Math.sqrt(1 - t * t)
    case 'column': return Math.sqrt(Math.max(0, 1 - Math.pow(2 * t - 1, 8))) * (1 - 0.35 * t)
    case 'umbrella': return Math.pow(t, 0.35)
    case 'vase': return 0.25 + 0.75 * Math.pow(t, 0.7)
    default: return Math.sqrt(Math.max(0, 1 - (2 * t - 1) * (2 * t - 1))) // sphere, ellipsoid
  }
}

/** Bottom y and height of the crown envelope. A `sphere` crown is as tall as it is wide. */
export function crownExtent(params: TreeParams): { bottom: number; height: number } {
  const height = params.crownShape === 'sphere' ? params.crownRadius * 2 : params.crownHeight
  return { bottom: params.height - height, height }
}

/**
 * Samples `params.attractionPoints` points uniformly inside the crown envelope, centred above `(cx, cz)`.
 * @returns Interleaved xyz.
 */
export function sampleCrown(params: TreeParams, rand: () => number, cx = 0, cz = 0): Float32Array {
  const { bottom, height } = crownExtent(params)
  const R = params.crownRadius
  const out = new Float32Array(params.attractionPoints * 3)
  let n = 0
  for (let tries = 0; n < params.attractionPoints && tries < params.attractionPoints * 50; tries++) {
    const x = (rand() * 2 - 1) * R
    const z = (rand() * 2 - 1) * R
    const t = rand()
    if (Math.hypot(x, z) > R * crownProfile(params.crownShape, t)) continue
    out[n * 3] = cx + x
    out[n * 3 + 1] = bottom + t * height
    out[n * 3 + 2] = cz + z
    n++
  }
  return out.subarray(0, n * 3)
}

/**
 * Grows a tree skeleton by space colonisation (Runions, Lane & Prusinkiewicz 2007): attraction points fill the crown,
 * each pulls the nearest branch node within `influenceDistance`, nodes grow one `segmentLength` step towards the
 * average pull (plus tropism and jitter), and points within `killDistance` of a branch are removed. Radii then follow
 * the pipe model with `radiusExponent`.
 *
 * Each point remembers its nearest node; since nodes never move, only nodes added in the last step need checking,
 * which keeps a few thousand nodes well under a few milliseconds.
 */
export function growSkeleton(params: TreeParams, rand: () => number): TreeSkeleton {
  const seg = params.segmentLength
  const px: number[] = []
  const py: number[] = []
  const pz: number[] = []
  const parent: number[] = []
  const lastDir: number[] = []
  const add = (x: number, y: number, z: number, p: number, dx = 0, dy = 0, dz = 0) => {
    px.push(x)
    py.push(y)
    pz.push(z)
    parent.push(p)
    lastDir.push(dx, dy, dz)
    return px.length - 1
  }
  const jitterDir = (dx: number, dy: number, dz: number, amount: number) => {
    const x = dx + (rand() * 2 - 1) * amount
    const y = dy + (rand() * 2 - 1) * amount
    const z = dz + (rand() * 2 - 1) * amount
    const l = Math.hypot(x, y, z) || 1
    return [x / l, y / l, z / l]
  }

  // Trunk (or stems), grown straight up with a lean before colonisation starts.
  add(0, 0, 0, -1)
  const stems = Math.max(1, Math.round(params.stems))
  const trunkTop = params.leader ? params.height * 0.97 : params.trunkHeight
  let topX = 0
  let topZ = 0
  for (let s = 0; s < stems; s++) {
    const azimuth = (s / stems) * Math.PI * 2 + rand() * 1.2
    const lean = params.trunkLean * (stems > 1 ? 0.6 + 0.4 * rand() : rand())
    let dir = [Math.sin(lean) * Math.cos(azimuth), Math.cos(lean), Math.sin(lean) * Math.sin(azimuth)]
    const length = stems > 1 ? Math.max(seg, trunkTop * (0.7 + 0.3 * rand())) : trunkTop
    const steps = Math.max(1, Math.round(length / seg))
    let node = 0
    for (let k = 0; k < steps; k++) {
      dir = jitterDir(dir[0], dir[1] + (params.leader ? 0.3 : 0), dir[2], params.jitter * 0.15)
      const step = length / steps
      node = add(px[node] + dir[0] * step, py[node] + dir[1] * step, pz[node] + dir[2] * step, node, dir[0], dir[1], dir[2])
    }
    if (s === 0) {
      topX = px[node]
      topZ = pz[node]
    }
  }

  // Attraction points, each tracking its nearest node.
  const pts = sampleCrown(params, rand, stems > 1 ? 0 : topX, stems > 1 ? 0 : topZ)
  const np = pts.length / 3
  const alive = new Uint8Array(np).fill(1)
  const nearest = new Int32Array(np).fill(-1)
  const nearestD2 = new Float64Array(np).fill(Infinity)
  const influence2 = params.influenceDistance * params.influenceDistance
  const kill2 = params.killDistance * params.killDistance

  // Static grid over the points so new nodes only look at points near them.
  const cell = Math.max(params.influenceDistance, 1e-3)
  const grid = new Map<number, number[]>()
  // Numeric cell keys (cells are within ±512 of the origin for any sane tree).
  const cellKey = (cx: number, cy: number, cz: number) => ((cx + 512) * 1024 + (cy + 512)) * 1024 + (cz + 512)
  const key = (x: number, y: number, z: number) => cellKey(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell))
  for (let i = 0; i < np; i++) {
    const k = key(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2])
    const list = grid.get(k)
    if (list) list.push(i)
    else grid.set(k, [i])
  }
  const visit = (n: number) => {
    const cx = Math.floor(px[n] / cell)
    const cy = Math.floor(py[n] / cell)
    const cz = Math.floor(pz[n] / cell)
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (let c = -1; c <= 1; c++) {
          const list = grid.get(cellKey(cx + a, cy + b, cz + c))
          if (!list) continue
          // Compact dead points out of the cell as we go; later visits get cheaper as the crown fills.
          const nx = px[n]
          const ny = py[n]
          const nz = pz[n]
          let w = 0
          for (let r = 0; r < list.length; r++) {
            const i = list[r]
            if (!alive[i]) continue
            const dx = pts[i * 3] - nx
            const dy = pts[i * 3 + 1] - ny
            const dz = pts[i * 3 + 2] - nz
            const d2 = dx * dx + dy * dy + dz * dz
            if (d2 < kill2) {
              alive[i] = 0
              continue
            }
            if (d2 < nearestD2[i]) {
              nearestD2[i] = d2
              nearest[i] = n
            }
            list[w++] = i
          }
          list.length = w
        }
      }
    }
  }
  for (let n = 0; n < px.length; n++) visit(n)

  const [tx, ty, tz] = params.tropism
  const pull = new Map<number, [number, number, number]>()
  for (let iter = 0; iter < params.iterations; iter++) {
    pull.clear()
    for (let i = 0; i < np; i++) {
      if (!alive[i] || nearestD2[i] > influence2) continue
      const n = nearest[i]
      const d = Math.sqrt(nearestD2[i])
      const v = pull.get(n) ?? [0, 0, 0]
      v[0] += (pts[i * 3] - px[n]) / d
      v[1] += (pts[i * 3 + 1] - py[n]) / d
      v[2] += (pts[i * 3 + 2] - pz[n]) / d
      pull.set(n, v)
    }
    if (!pull.size) break
    const first = px.length
    for (const [n, v] of pull) {
      const l = Math.hypot(v[0], v[1], v[2]) || 1
      const [dx, dy, dz] = jitterDir(v[0] / l + tx, v[1] / l + ty, v[2] / l + tz, params.jitter * 0.5)
      // A node pulled the same way twice in a row would stack duplicate children; skip it instead.
      const o = n * 3
      if (dx * lastDir[o] + dy * lastDir[o + 1] + dz * lastDir[o + 2] > 0.9995 && hasChild(parent, n, first)) continue
      add(px[n] + dx * seg, py[n] + dy * seg, pz[n] + dz * seg, n, dx, dy, dz)
      lastDir[o] = dx
      lastDir[o + 1] = dy
      lastDir[o + 2] = dz
    }
    if (px.length === first) break
    for (let n = first; n < px.length; n++) visit(n)
  }

  return finish(px, py, pz, parent, params, [stems > 1 ? 0 : topX, crownExtent(params).bottom + crownExtent(params).height * 0.5, stems > 1 ? 0 : topZ])
}

function hasChild(parent: number[], n: number, before: number) {
  for (let i = before - 1; i > n; i--) if (parent[i] === n) return true
  return false
}

/** Smooths kinks, then computes tip counts, pipe-model radii and distance to tips. */
function finish(px: number[], py: number[], pz: number[], parentList: number[], params: TreeParams, crownCenter: [number, number, number]): TreeSkeleton {
  const count = px.length
  const parent = Int32Array.from(parentList)
  const children = new Int32Array(count)
  for (let i = 1; i < count; i++) children[parent[i]]++

  // One Laplacian pass on simple chain nodes takes the zig-zag out of segment-length steps.
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    positions[i * 3] = px[i]
    positions[i * 3 + 1] = py[i]
    positions[i * 3 + 2] = pz[i]
  }
  const onlyChild = new Int32Array(count).fill(-1)
  for (let i = 1; i < count; i++) if (children[parent[i]] === 1) onlyChild[parent[i]] = i
  for (let i = 1; i < count; i++) {
    const c = onlyChild[i]
    if (c < 0) continue
    const p = parent[i]
    positions[i * 3] = (px[p] + 2 * px[i] + px[c]) / 4
    positions[i * 3 + 1] = (py[p] + 2 * py[i] + py[c]) / 4
    positions[i * 3 + 2] = (pz[p] + 2 * pz[i] + pz[c]) / 4
  }

  const tips = new Int32Array(count)
  const tipDistance = new Int32Array(count).fill(1 << 30)
  for (let i = count - 1; i >= 0; i--) {
    if (children[i] === 0) {
      tips[i] = 1
      tipDistance[i] = 0
    }
    const p = parent[i]
    if (p >= 0) {
      tips[p] += tips[i]
      tipDistance[p] = Math.min(tipDistance[p], tipDistance[i] + 1)
    }
  }
  const radius = new Float32Array(count)
  const total = Math.max(1, tips[0])
  const inv = 1 / Math.max(0.5, params.radiusExponent)
  for (let i = 0; i < count; i++) radius[i] = Math.max(params.tipRadius, params.baseRadius * Math.pow(tips[i] / total, inv))
  return { count, positions, parent, radius, tipDistance, tips, crownCenter }
}
