import {
  BufferGeometry,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  Sphere,
  Vector3,
  type MeshPhysicalNodeMaterial,
  type Object3D
} from 'three/webgpu'
import type { GrassSettings } from './grass-settings.ts'
import type { CellCache } from './grass-tiles.ts'
import type { Retirement } from './retirement.ts'

/**
 * The base blade shape: a tapered, folded strip with x in [-0.5, 0.5] and y in [0, 1]. Each of the
 * `segments` rows has three vertices (left edge, midrib, right edge) so the shader can fold the
 * blade along its midrib; a single vertex forms the tip. Exposed for custom instancing setups;
 * Grass creates these for you.
 */
export function createBladeGeometry(segments: number): BufferGeometry {
  const pos: number[] = []
  const uv: number[] = []
  const index: number[] = []
  for (let r = 0; r < segments; r++) {
    const y = r / segments
    // Pinched at the base, widest around a quarter of the way up, tapering to a sharp tip.
    const half = 0.5 * (1 - y) ** 0.75 * (0.72 + 0.28 * Math.min(1, y / 0.25))
    pos.push(-half, y, 0, 0, y, 0, half, y, 0)
    uv.push(0, y, 0.5, y, 1, y)
    if (r > 0) {
      const a = (r - 1) * 3
      index.push(a, a + 1, a + 3, a + 1, a + 4, a + 3) // left half
      index.push(a + 1, a + 2, a + 4, a + 2, a + 5, a + 4) // right half
    }
  }
  const b = (segments - 1) * 3
  const tip = segments * 3
  pos.push(0, 1, 0)
  uv.push(0.5, 1)
  index.push(b, b + 1, tip, b + 1, b + 2, tip)
  return indexedGeometry(pos, uv, index)
}

/** The base billboard shape: a unit quad strip with `segments` rows so it bends smoothly in the wind. */
export function createBillboardGeometry(segments: number): BufferGeometry {
  const pos: number[] = []
  const uv: number[] = []
  const index: number[] = []
  for (let r = 0; r <= segments; r++) {
    const y = r / segments
    pos.push(-0.5, y, 0, 0.5, y, 0)
    uv.push(0, y, 1, y)
    if (r > 0) {
      const a = (r - 1) * 2
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  return indexedGeometry(pos, uv, index)
}

function indexedGeometry(pos: number[], uv: number[], index: number[]) {
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  g.setIndex(index)
  return g
}

/** Disposes only the per-tile instance buffers. The renderer frees every attribute on a geometry's
 *  dispose, so the shared blade index/position/uv must be detached first. */
export function disposeInstanced(geometry: InstancedBufferGeometry) {
  geometry.setIndex(null)
  geometry.deleteAttribute('position')
  geometry.deleteAttribute('uv')
  geometry.dispose()
}

interface GeometryContext {
  /** Root the tile meshes are added to and removed from. */
  object: Object3D
  settings: () => GrassSettings
  /** `null` until the field has created its material; tiles cannot be written or drawn before then. */
  material: () => MeshPhysicalNodeMaterial | null
}

/**
 * A tile's mesh and the height bounds of the blades uploaded to it. Owned by {@link TileGeometryStore}:
 * the stream keeps one per tile but only reads through it.
 */
export interface TileGeometry {
  readonly mesh: Mesh<InstancedBufferGeometry, MeshPhysicalNodeMaterial>
  /** Edge length of the grid this tile was built on (a stale tile keeps the size it was retired at). */
  readonly size: number
  /** Lowest blade height uploaded to the tile (written by {@link TileGeometryStore.write}). */
  minY: number
  /** Highest blade height uploaded to the tile (written by {@link TileGeometryStore.write}). */
  maxY: number
}

/** Owns the shared blade/billboard shapes, the per-tile meshes and their instance buffers. */
export class TileGeometryStore {
  private baseGeometries = new Map<string, BufferGeometry>()
  private readonly ctx: GeometryContext
  private readonly retirement: Retirement

  constructor(ctx: GeometryContext, retirement: Retirement) {
    this.ctx = ctx
    this.retirement = retirement
  }

  /** Creates a tile's mesh on the grid, attaches it and hides it until it has blades. */
  create(ix: number, iz: number, size: number): TileGeometry {
    const material = this.ctx.material()
    if (!material) throw new Error('Grass: tiles were updated before the material was created.')
    const geometry = new InstancedBufferGeometry()
    geometry.instanceCount = 0
    const mesh = new Mesh(geometry, material)
    mesh.position.set(ix * size, 0, iz * size)
    mesh.updateMatrix()
    mesh.matrixAutoUpdate = false
    mesh.visible = false
    this.ctx.object.add(mesh)
    return { mesh, size, minY: 0, maxY: 0 }
  }

  /**
   * Fills a tile's instance buffers with its cells' blades, growing the buffers only when needed:
   * reusing them across LOD changes is what keeps camera moves from stuttering.
   */
  write(
    target: TileGeometry,
    cells: (CellCache | undefined)[],
    take: Int32Array,
    segments: number,
    billboard: boolean
  ): void {
    const written = take.reduce((a, b) => a + b, 0)

    let geometry = target.mesh.geometry
    const base = this.baseGeometry(segments, billboard)
    const current = geometry.getAttribute('aOffset') as InstancedBufferAttribute | undefined
    if (!current || current.count < written || geometry.attributes.position !== base.attributes.position) {
      const capacity = Math.ceil(written * 1.5) + 16
      const old = geometry
      geometry = new InstancedBufferGeometry()
      geometry.setIndex(base.index)
      geometry.setAttribute('position', base.attributes.position)
      geometry.setAttribute('uv', base.attributes.uv)
      geometry.setAttribute('aOffset', new InstancedBufferAttribute(new Float32Array(capacity * 4), 4))
      geometry.setAttribute('aParams', new InstancedBufferAttribute(new Float32Array(capacity * 4), 4))
      geometry.setAttribute('aPatch', new InstancedBufferAttribute(new Float32Array(capacity * 3), 3))
      target.mesh.geometry = geometry
      this.retirement.retire(() => disposeInstanced(old))
    }
    const aOffset = geometry.getAttribute('aOffset') as InstancedBufferAttribute
    const aParams = geometry.getAttribute('aParams') as InstancedBufferAttribute
    const aPatch = geometry.getAttribute('aPatch') as InstancedBufferAttribute
    const offsets = aOffset.array as Float32Array
    const params = aParams.array as Float32Array
    const patches = aPatch.array as Float32Array
    let w = 0
    let minY = Infinity
    let maxY = -Infinity
    take.forEach((k, c) => {
      if (!k) return
      const cell = cells[c]!
      offsets.set(cell.offsets.subarray(0, k * 4), w * 4)
      params.set(cell.params.subarray(0, k * 4), w * 4)
      patches.set(cell.patches.subarray(0, k * 3), w * 3)
      for (let i = 0; i < k; i++) {
        const y = cell.offsets[i * 4 + 1]
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      w += k
    })

    for (const attr of [aOffset, aParams, aPatch]) {
      attr.clearUpdateRanges()
      attr.addUpdateRange(0, written * attr.itemSize)
      attr.needsUpdate = true
    }
    geometry.instanceCount = written

    target.minY = minY
    target.maxY = maxY
  }

  /** Applies material, shadow flags and the manual bounding sphere (instanced geometry can't compute one).
   *  The sphere uses the grid the mesh was built on, which a stale tile keeps. */
  applyTileSettings(target: TileGeometry, dist: number): void {
    const s = this.ctx.settings()
    const { mesh, size } = target
    const material = this.ctx.material()
    if (!material) throw new Error('Grass: tile settings applied before the material was created.')
    mesh.material = material
    mesh.receiveShadow = s.receiveShadow
    this.applyShadow(target, dist)
    mesh.visible = mesh.geometry.instanceCount > 0
    if (!mesh.visible) return
    // Instanced geometry can't compute its own bounds; frustum culling needs a manual sphere.
    const reach = s.bladeHeight * (1 + s.heightVariation) * 2 + s.clumpSize // map can double height; tufts spill over edges
    mesh.geometry.boundingSphere = new Sphere(
      new Vector3(size / 2, (target.minY + target.maxY) / 2, size / 2),
      Math.hypot(size / Math.SQRT2, (target.maxY - target.minY) / 2) + reach
    )
  }

  /** Refreshes just the distance-dependent shadow flag, once per frame. */
  applyShadow(target: TileGeometry, dist: number): void {
    const s = this.ctx.settings()
    target.mesh.castShadow = s.castShadow && dist < s.shadowDistance
  }

  /** Blades currently uploaded to the tile. */
  count(target: TileGeometry): number {
    return target.mesh.geometry.instanceCount
  }

  /** Detaches a tile's mesh and retires its instance buffers. */
  remove(target: TileGeometry): void {
    target.mesh.removeFromParent()
    const geometry = target.mesh.geometry
    this.retirement.retire(() => disposeInstanced(geometry))
  }

  /** Retires the shared base shapes; per-tile buffers are retired with their tiles. */
  dispose(): void {
    for (const g of this.baseGeometries.values()) this.retirement.retire(() => g.dispose())
    this.baseGeometries.clear()
  }

  private baseGeometry(segments: number, billboard: boolean) {
    const key = `${billboard}|${segments}`
    let g = this.baseGeometries.get(key)
    if (!g) {
      g = billboard ? createBillboardGeometry(segments) : createBladeGeometry(segments)
      this.baseGeometries.set(key, g)
    }
    return g
  }
}
