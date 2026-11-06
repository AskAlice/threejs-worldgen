/**
 * Ground under a three.js scene as a fast `(x, z) => y` lookup: bake any mesh into a heightfield, ray-march
 * it, and measure slope. The shared base for placing grass, rocks, trees and structures on terrain.
 *
 * @module threejs-heightfield
 */
import { Box3, Vector3, type Object3D, type Mesh, type BufferGeometry } from 'three/webgpu'

export { merge, resolve } from './merge.ts'

/** Returns terrain height at world (x, z), or NaN where there is no terrain. */
export type HeightFn = (x: number, z: number) => number

/** What grass grows on: a mesh/group (baked into a heightfield once) or a height function (infinite worlds). */
export type Terrain = Object3D | HeightFn

/**
 * Turns a {@link Terrain} into a fast height lookup. Functions are used as-is; meshes are baked via
 * {@link bakeHeightfield}; no terrain means flat ground at y = 0.
 * @param maxResolution Max heightfield samples per side when baking a mesh.
 */
export function createHeightSampler(terrain?: Terrain, maxResolution = 1024): HeightFn {
  if (!terrain) return () => 0
  if (typeof terrain === 'function') return terrain
  return bakeHeightfield(terrain, maxResolution)
}

/**
 * Bakes every mesh under `root` (world transforms included) into a heightfield by rasterising its
 * triangles on the CPU — works for any geometry and avoids per-blade raycasts. Where surfaces
 * overlap, the highest wins. Returns a bilinear sampler that yields NaN outside the terrain.
 * @param maxResolution Samples along the longer side of the terrain's bounding box.
 */
export function bakeHeightfield(root: Object3D, maxResolution = 1024): HeightFn {
  root.updateWorldMatrix(true, true)
  const box = new Box3().setFromObject(root)
  if (box.isEmpty()) return () => NaN

  const cell = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / (maxResolution - 1) || 1
  const x0 = box.min.x
  const z0 = box.min.z
  const nx = Math.floor((box.max.x - x0) / cell) + 2
  const nz = Math.floor((box.max.z - z0) / cell) + 2
  const heights = new Float32Array(nx * nz).fill(NaN)

  const a = new Vector3()
  const b = new Vector3()
  const c = new Vector3()
  root.traverse((obj) => {
    const mesh = obj as Mesh
    if (!mesh.isMesh) return
    const geometry = mesh.geometry as BufferGeometry
    const pos = geometry.attributes.position
    if (!pos) return
    const index = geometry.index
    const triCount = (index ? index.count : pos.count) / 3
    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2
      a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld)
      b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld)
      c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld)
      rasterizeTriangle(a, b, c)
    }
  })

  function rasterizeTriangle(a: Vector3, b: Vector3, c: Vector3) {
    const det = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z)
    if (Math.abs(det) < 1e-12) return // vertical or degenerate in xz
    const iMin = Math.max(0, Math.ceil((Math.min(a.x, b.x, c.x) - x0) / cell))
    const iMax = Math.min(nx - 1, Math.floor((Math.max(a.x, b.x, c.x) - x0) / cell))
    const jMin = Math.max(0, Math.ceil((Math.min(a.z, b.z, c.z) - z0) / cell))
    const jMax = Math.min(nz - 1, Math.floor((Math.max(a.z, b.z, c.z) - z0) / cell))
    const eps = -1e-6
    for (let j = jMin; j <= jMax; j++) {
      const z = z0 + j * cell
      for (let i = iMin; i <= iMax; i++) {
        const x = x0 + i * cell
        const w0 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / det
        const w1 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / det
        const w2 = 1 - w0 - w1
        if (w0 < eps || w1 < eps || w2 < eps) continue
        const y = w0 * a.y + w1 * b.y + w2 * c.y
        const k = j * nx + i
        // Keep the highest surface so overhangs/bridges don't put grass underneath.
        if (!(heights[k] >= y)) heights[k] = y
      }
    }
  }

  return (x, z) => {
    const fx = (x - x0) / cell
    const fz = (z - z0) / cell
    const i = Math.floor(fx)
    const j = Math.floor(fz)
    if (i < 0 || j < 0 || i >= nx - 1 || j >= nz - 1) return NaN
    const tx = fx - i
    const tz = fz - j
    const k = j * nx + i
    const h00 = heights[k],
      h10 = heights[k + 1],
      h01 = heights[k + nx],
      h11 = heights[k + nx + 1]
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz // NaN propagates at terrain edges
  }
}

/** Terrain steepness (gradient magnitude, rise / run) at (x, z), by central differences over `e` metres. */
export function slopeAt(sample: HeightFn, x: number, z: number, e = 0.25): number {
  const dx = (sample(x + e, z) - sample(x - e, z)) / (2 * e)
  const dz = (sample(x, z + e) - sample(x, z - e)) / (2 * e)
  return Math.sqrt(dx * dx + dz * dz)
}

/**
 * Intersects a ray with a height function by ray-marching then bisecting. Works for baked meshes and
 * procedural terrain alike (`threejs-grass` uses it for its terrain painter).
 * @param dir Normalised ray direction.
 * @param step March step in metres; smaller catches thinner ridges.
 * @returns The hit point (a new Vector3), or `null`.
 */
export function raycastHeight(
  sample: HeightFn,
  origin: Vector3,
  dir: Vector3,
  maxDistance = 2000,
  step = 0.5
): Vector3 | null {
  const p = new Vector3()
  let prevT = 0
  for (let t = step; t <= maxDistance; t += step) {
    p.copy(origin).addScaledVector(dir, t)
    const h = sample(p.x, p.z)
    if (h === h && p.y <= h) {
      let lo = prevT
      let hi = t
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) / 2
        p.copy(origin).addScaledVector(dir, mid)
        const hm = sample(p.x, p.z)
        if (hm === hm && p.y <= hm) hi = mid
        else lo = mid
      }
      p.copy(origin).addScaledVector(dir, hi)
      p.y = sample(p.x, p.z)
      return p
    }
    prevT = t
  }
  return null
}
