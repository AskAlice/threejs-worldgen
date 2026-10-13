import type { TreeSkeleton } from './space-colonization.ts'
import type { LeafShape, TreeParams } from './species.ts'
import { addFruit } from './special.ts'
import { cross, dot, linearColor, normalize, pushVertex, type MeshArrays, type Vec3 } from './tube-mesh.ts'

/** Card width / height per leaf shape (cards are taller than wide for needle sprays). */
const ASPECT: Record<LeafShape, number> = { broad: 1, needle: 0.62, palm: 1, fern: 1, blade: 0.12, none: 1 }

/**
 * Appends leaf cards on the outer twigs of a skeleton: `leafDensity` cards per node within `leafDepth` steps of a
 * branch tip. Broadleaf cards hang outward from their twig; needle sprays lie along the branch. Normals are bent
 * away from the crown centre so the canopy shades as one rounded mass, and inner leaves are darkened (cheap
 * ambient occlusion).
 *
 * @param detail 1 = full; lower values place fewer, larger cards (for simplified levels of detail).
 */
export function addLeafCards(out: MeshArrays, sk: TreeSkeleton, params: TreeParams, rand: () => number, detail = 1): void {
  if (params.leafShape === 'none' || params.leafDensity <= 0) return
  const keep = Math.min(1, Math.max(0.2, detail))
  const size = params.leafSize / Math.min(1.8, Math.sqrt(keep))
  const aspect = ASPECT[params.leafShape]
  const needle = params.leafShape === 'needle'
  const base = linearColor(params.leafColor)
  const [cx, cy, cz] = sk.crownCenter
  const R = Math.max(params.crownRadius, 0.1)
  const H = Math.max(params.crownShape === 'sphere' ? R : params.crownHeight / 2, 0.1)
  const P = sk.positions

  for (let i = 1; i < sk.count; i++) {
    if (sk.tipDistance[i] > params.leafDepth) continue
    let cards = params.leafDensity * keep
    const p: Vec3 = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]
    if (p[1] < params.trunkHeight * 0.5 && !needle) continue // no leaves on the bare lower trunk
    const q = sk.parent[i]
    const along = normalize([p[0] - P[q * 3], p[1] - P[q * 3 + 1], p[2] - P[q * 3 + 2]])
    const rel: Vec3 = [(p[0] - cx) / R, (p[1] - cy) / H, (p[2] - cz) / R]
    const outward = normalize(rel)
    const depth = Math.min(1, Math.hypot(...rel))
    while (cards > 0) {
      if (cards < 1 && rand() > cards) break
      cards--
      const r3: Vec3 = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1]
      let axis: Vec3
      let normal: Vec3
      if (needle) {
        // Sprays follow the branch and face mostly up.
        axis = normalize([along[0] + r3[0] * 0.3, along[1] * 0.6 + r3[1] * 0.2, along[2] + r3[2] * 0.3])
        const up: Vec3 = [r3[0] * 0.5, 1, r3[2] * 0.5]
        normal = normalize(sub(up, scale(axis, dot(up, axis))))
      } else {
        // Clusters hang outward from the twig, turned randomly about it.
        axis = normalize([outward[0] * 0.8 + along[0] * 0.6 + r3[0] * 0.7, outward[1] * 0.5 + along[1] * 0.6 + r3[1] * 0.7 - 0.15, outward[2] * 0.8 + along[2] * 0.6 + r3[2] * 0.7])
        const r = normalize([rand() * 2 - 1, rand() * 2 - 1 + 0.6, rand() * 2 - 1])
        normal = normalize(sub(r, scale(axis, dot(r, axis))))
      }
      const side = normalize(cross(axis, normal))
      const h = size * (0.75 + 0.5 * rand())
      const w = h * aspect
      const startAlong = (needle ? -0.15 : -0.05) * h
      const origin: Vec3 = [p[0] + axis[0] * startAlong, p[1] + axis[1] * startAlong, p[2] + axis[2] * startAlong]
      const vary = 1 + (rand() * 2 - 1) * params.leafColorVariation
      const warm = (rand() * 2 - 1) * params.leafColorVariation * 0.6
      const ao = 0.5 + 0.5 * Math.pow(depth, 1.5)
      const card = rand()
      const color: Vec3 = [base[0] * vary * ao * (1 + warm), base[1] * vary * ao, base[2] * vary * ao * (1 - warm)]
      // Needle sprays get a second card crossed at 90° so they don't vanish when seen edge-on.
      for (const [cardSide, cardNormal] of needle ? [[side, normal], [normal, side]] : [[side, normal]]) {
        const v0 = out.positions.length / 3
        for (let corner = 0; corner < 4; corner++) {
          const u = corner === 1 || corner === 2 ? 1 : 0
          const v = corner >= 2 ? 1 : 0
          const x = (u - 0.5) * w
          const y = v * h
          const px = origin[0] + cardSide[0] * x + axis[0] * y
          const py = origin[1] + cardSide[1] * x + axis[1] * y
          const pz = origin[2] + cardSide[2] * x + axis[2] * y
          // Blend the card normal with the direction away from the crown centre ("spherical" foliage normals).
          let sx = (px - cx) / R
          let sy = (py - cy) / H
          let sz = (pz - cz) / R
          const sl = Math.hypot(sx, sy, sz) || 1
          sx = cardNormal[0] * 0.3 + (sx / sl) * 0.7
          sy = cardNormal[1] * 0.3 + (sy / sl) * 0.7 + 0.15
          sz = cardNormal[2] * 0.3 + (sz / sl) * 0.7
          const nl = Math.hypot(sx, sy, sz) || 1
          pushVertex(out, px, py, pz, sx / nl, sy / nl, sz / nl, u, v, color[0], color[1], color[2], card)
        }
        out.indices.push3(v0, v0 + 1, v0 + 2)
        out.indices.push3(v0, v0 + 2, v0 + 3)
      }
    }
  }
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]

/** Hangs fruit (apples, berries) under the outer twigs: `fruit` per node within two steps of a tip. */
export function addTreeFruit(out: MeshArrays, sk: TreeSkeleton, params: TreeParams, rand: () => number, detail = 1): void {
  if (params.fruit <= 0) return
  const P = sk.positions
  const keep = Math.min(1, Math.max(0.3, detail))
  for (let i = 1; i < sk.count; i++) {
    if (sk.tipDistance[i] > Math.min(2, params.leafDepth)) continue
    if (rand() > params.fruit * keep) continue
    const r = params.fruitSize / 2 * (0.8 + 0.4 * rand())
    const center: Vec3 = [P[i * 3] + (rand() - 0.5) * params.leafSize * 0.4, P[i * 3 + 1] - r * 1.6, P[i * 3 + 2] + (rand() - 0.5) * params.leafSize * 0.4]
    const palette = params.fruitColors.length ? params.fruitColors : ['#b3261e']
    const c = linearColor(palette[Math.floor(rand() * palette.length) % palette.length])
    const v = 0.85 + 0.3 * rand()
    addFruit(out, center, r, [c[0] * v, c[1] * v, c[2] * v], rand())
  }
}
