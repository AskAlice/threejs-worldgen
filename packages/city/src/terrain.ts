import type { FlattenPath, LocalFrame, World } from 'threejs-biomes'
import type { Building } from './buildings.ts'
import type { RoadGraph } from './graph.ts'
import type { Site } from './site.ts'

/** How the settlement shapes the ground under it. */
export interface TerrainOptions {
  /** Register flatten modifiers on the world (roads and building pads). */
  flatten: boolean
  /** Also flatten a pad under every building. */
  flattenLots: boolean
  /** Steepest road grade after smoothing (rise / run). */
  maxGrade: number
  /** Spacing of road profile points, metres. */
  step: number
  /** Blend distance beyond a road's edge, metres. */
  roadFalloff: number
  /** Blend distance beyond a building pad, metres. */
  lotFalloff: number
  /** Bridge decks clear the water by at least this much, metres. */
  bridgeClearance: number
  /** Walls reach this far below the lowest ground under a building, metres. */
  foundation: number
  /** Road surfaces sit this far above the flattened ground (hides terrain mesh facets), metres. */
  roadOffset: number
}

/** Default terrain shaping. */
export const DEFAULT_TERRAIN: TerrainOptions = {
  flatten: true, flattenLots: true, maxGrade: 0.1, step: 6, roadFalloff: 7, lotFalloff: 5,
  bridgeClearance: 4, foundation: 1.5, roadOffset: 0.12,
}

/** The graded centreline of one road edge: points from node `a` to node `b` with surface heights. */
export interface RoadProfile {
  /** Edge id. */
  edge: number
  /** [x, y, z] points (frame-local), first at node `a`, last at node `b`. */
  points: [number, number, number][]
}

/**
 * Grades every road: node heights relaxed so no edge is steeper than `maxGrade`, then each edge
 * sampled every `step` metres, clamped to the grade limit from both ends and smoothed. Bridges arch
 * over the water instead. Writes `node.y` and returns one profile per edge (by edge id).
 */
export function gradeRoads(graph: RoadGraph, site: Site, o: TerrainOptions): RoadProfile[] {
  const { nodes, edges } = graph
  for (const n of nodes) n.y = site.height(n.x, n.z)
  // Relax node heights towards each other where an edge is too steep (bridges included: no ramps to the sky).
  for (let it = 0; it < 24; it++) {
    let moved = false
    for (const e of edges) {
      const a = nodes[e.a], b = nodes[e.b]
      const max = o.maxGrade * graph.length(e.id)
      const d = b.y - a.y
      if (Math.abs(d) <= max + 1e-6) continue
      const fix = (Math.abs(d) - max) / 2 * Math.sign(d)
      a.y += fix; b.y -= fix
      moved = true
    }
    if (!moved) break
  }
  return edges.map((e) => {
    const a = nodes[e.a], b = nodes[e.b]
    const len = graph.length(e.id)
    const n = Math.max(1, Math.ceil(len / o.step))
    const pts: [number, number, number][] = []
    if (e.bridge) {
      // Arch: at least `bridgeClearance` above the highest water under the deck at mid-span.
      let water = -Infinity
      for (let i = 0; i <= n; i++) {
        const w = site.waterLevel(a.x + ((b.x - a.x) * i) / n, a.z + ((b.z - a.z) * i) / n)
        if (w === w && w > water) water = w
      }
      const rise = Math.max(0, water + o.bridgeClearance - Math.max(a.y, b.y))
      for (let i = 0; i <= n; i++) {
        const t = i / n
        pts.push([a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t + rise * Math.sin(Math.PI * t), a.z + (b.z - a.z) * t])
      }
      return { edge: e.id, points: pts }
    }
    const ys = new Float64Array(n + 1)
    for (let i = 0; i <= n; i++) ys[i] = site.height(a.x + ((b.x - a.x) * i) / n, a.z + ((b.z - a.z) * i) / n)
    ys[0] = a.y; ys[n] = b.y
    const g = o.maxGrade * (len / n)
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < n; i++) ys[i] = Math.min(ys[i - 1] + g, Math.max(ys[i - 1] - g, ys[i]))
      for (let i = n - 1; i > 0; i--) ys[i] = Math.min(ys[i + 1] + g, Math.max(ys[i + 1] - g, ys[i]))
      for (let i = 1; i < n; i++) ys[i] = ys[i - 1] * 0.25 + ys[i] * 0.5 + ys[i + 1] * 0.25
    }
    for (let i = 0; i <= n; i++) pts.push([a.x + ((b.x - a.x) * i) / n, ys[i], a.z + ((b.z - a.z) * i) / n])
    return { edge: e.id, points: pts }
  })
}

/**
 * Converts a frame-local point and target height into a modifier point: the base-surface position
 * the world compares against and the elevation it flattens to. Identity on flat worlds; on planets
 * the tangent-plane point is projected onto the sphere and the local height turned into elevation.
 */
export function modifierPoint(world: World, frame: LocalFrame, x: number, z: number, y: number): [number, number, number, number] {
  if (world.options.surface !== 'sphere') return [x, 0, z, y]
  const p = frame.basePoint(x, z)
  const len = Math.hypot(p[0], p[1], p[2])
  const R = world.options.radius
  const u = frame.up
  const cos = (p[0] * u[0] + p[1] * u[1] + p[2] * u[2]) / len
  const drop = R - R * cos
  return [(p[0] * R) / len, (p[1] * R) / len, (p[2] * R) / len, (y + drop) / cos]
}

/**
 * Flatten modifiers for the roads: one path per run of edges between junctions (bridges skipped,
 * so rivers stay open), split into short pieces so the world's bounding-box culling stays effective.
 */
export function roadModifiers(graph: RoadGraph, profiles: RoadProfile[], toModifier: (x: number, z: number, y: number) => [number, number, number, number], o: TerrainOptions, maxPoints = 24): FlattenPath[] {
  const out: FlattenPath[] = []
  for (const e of graph.edges) {
    if (e.bridge) continue
    const pts = profiles[e.id].points
    const width = e.width / 2 + e.sidewalk + 0.5
    for (let s = 0; s < pts.length - 1; s += maxPoints - 1) {
      const piece = pts.slice(s, s + maxPoints)
      out.push({ type: 'path', points: piece.map(([x, y, z]) => toModifier(x, z, y)), width, falloff: o.roadFalloff })
    }
  }
  return out
}

/** A flat pad under a building: a path along its long axis whose flat strip covers the whole footprint. */
export function padModifier(b: Building, toModifier: (x: number, z: number, y: number) => [number, number, number, number], o: TerrainOptions): FlattenPath {
  // Fit the footprint's long axis.
  const p = b.parts[0].tiers[0].polygon
  let best = 0, ax = 1, az = 0
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length]
    const l = Math.hypot(q[0] - p[i][0], q[1] - p[i][1])
    if (l > best) { best = l; ax = (q[0] - p[i][0]) / l; az = (q[1] - p[i][1]) / l }
  }
  let minU = Infinity, maxU = -Infinity, maxV = 0
  for (const [x, z] of b.parts.flatMap((part) => part.tiers[0].polygon)) {
    const u = (x - b.center[0]) * ax + (z - b.center[1]) * az
    const v = Math.abs(-(x - b.center[0]) * az + (z - b.center[1]) * ax)
    minU = Math.min(minU, u); maxU = Math.max(maxU, u); maxV = Math.max(maxV, v)
  }
  const a = toModifier(b.center[0] + ax * minU, b.center[1] + az * minU, b.base)
  const c = toModifier(b.center[0] + ax * maxU, b.center[1] + az * maxU, b.base)
  return { type: 'path', points: [a, c], width: maxV + 0.5, falloff: o.lotFalloff }
}
