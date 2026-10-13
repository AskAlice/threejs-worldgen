import type { RoadGraph } from './graph.ts'
import { insetPolygon, polygonArea, simplifyPolygon, type Vec2 } from './polygon.ts'

/** A city block: one face of the road graph, shrunk away from the roads around it. */
export interface Block {
  /** Index in the block list. */
  id: number
  /** The face outline along road centrelines, counter-clockwise. */
  outline: Vec2[]
  /** Buildable area: `outline` inset by each road's half width and sidewalk, counter-clockwise. */
  polygon: Vec2[]
  /** Area of `polygon`, m². */
  area: number
}

/** Block extraction limits. */
export interface BlockOptions {
  /** Faces smaller than this (after inset) are dropped, m². */
  minArea: number
  /** Faces larger than this (before inset) are dropped: they are open country, not blocks, m². */
  maxArea: number
  /** Extra clearance between the sidewalk and the block, metres. */
  margin: number
}

/** Default block limits. */
export const DEFAULT_BLOCKS: BlockOptions = { minArea: 120, maxArea: 400_000, margin: 0.5 }

/**
 * Finds the faces of a planar road graph by half-edge traversal (always taking the next road
 * clockwise), drops the outer faces (clockwise ones) and dead-end spurs, and insets each face by the
 * half width plus sidewalk of every road around it.
 */
export function extractBlocks(graph: RoadGraph, options: BlockOptions = DEFAULT_BLOCKS): Block[] {
  const { nodes, edges } = graph
  // Prune dead ends (repeatedly), so every remaining edge borders two real faces.
  const alive = new Uint8Array(edges.length).fill(1)
  const degree = new Int32Array(nodes.length)
  for (const e of edges) { degree[e.a]++; degree[e.b]++ }
  const stack: number[] = []
  for (let i = 0; i < nodes.length; i++) if (degree[i] === 1) stack.push(i)
  while (stack.length) {
    const n = stack.pop()!
    for (const e of nodes[n].edges) {
      if (!alive[e]) continue
      alive[e] = 0
      const m = graph.other(e, n)
      degree[n]--
      if (--degree[m] === 1) stack.push(m)
    }
  }

  // Edges around each node, sorted counter-clockwise by angle.
  const around: number[][] = nodes.map((node) => {
    const list = node.edges.filter((e) => alive[e])
    const ang = (e: number) => { const m = nodes[graph.other(e, node.id)]; return Math.atan2(m.z - node.z, m.x - node.x) }
    return list.sort((p, q) => ang(p) - ang(q))
  })

  // Half-edge e travelled a→b is 2e, b→a is 2e+1.
  const visited = new Uint8Array(edges.length * 2)
  const blocks: Block[] = []
  for (let start = 0; start < edges.length * 2; start++) {
    if (visited[start] || !alive[start >> 1]) continue
    const outline: Vec2[] = []
    const inset: number[] = []
    let h = start
    let guard = 0
    while (!visited[h] && guard++ < 100_000) {
      visited[h] = 1
      const e = edges[h >> 1]
      const from = h & 1 ? e.b : e.a
      const to = h & 1 ? e.a : e.b
      outline.push([nodes[from].x, nodes[from].z])
      inset.push(e.width / 2 + e.sidewalk + options.margin)
      // At `to`, turn onto the next road clockwise from the one we arrived on.
      const list = around[to]
      const i = list.indexOf(h >> 1)
      const next = list[(i - 1 + list.length) % list.length]
      h = next * 2 + (edges[next].a === to ? 0 : 1)
    }
    const area = polygonArea(outline)
    if (area <= 0 || area > options.maxArea || outline.length < 3) continue
    const simple = simplifyPolygon(outline, inset)
    const polygon = insetPolygon(simple.polygon, simple.tags)
    if (!polygon) continue
    const a = polygonArea(polygon)
    if (a < options.minArea) continue
    blocks.push({ id: blocks.length, outline, polygon, area: a })
  }
  return blocks
}
