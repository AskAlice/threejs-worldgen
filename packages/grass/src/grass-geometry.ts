import {
  BufferGeometry, Float32BufferAttribute, InstancedBufferAttribute, InstancedBufferGeometry, Sphere, Vector3,
  type MeshPhysicalNodeMaterial,
} from 'three/webgpu'
import type { GrassSettings } from './grass-settings.ts'
import type { Tile } from './grass-tiles.ts'
import type { Retirement } from './grass-scene.ts'

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
    const half = 0.5 * Math.pow(1 - y, 0.75) * (0.72 + 0.28 * Math.min(1, y / 0.25))
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
  settings: () => GrassSettings
  material: () => MeshPhysicalNodeMaterial
}

/** Owns the shared blade/billboard shapes and the per-tile instance buffers that reference them. */
export class TileGeometryStore {
  private baseGeometries = new Map<string, BufferGeometry>()
  private readonly ctx: GeometryContext
  private readonly retirement: Retirement

  constructor(ctx: GeometryContext, retirement: Retirement) {
    this.ctx = ctx
    this.retirement = retirement
  }

  /**
   * Fills a tile's instance buffers with its cells' blades, growing the buffers only when needed:
   * reusing them across LOD changes is what keeps camera moves from stuttering.
   */
  write(tile: Tile, take: Int32Array, segments: number, billboard: boolean): void {
    const written = take.reduce((a, b) => a + b, 0)

    let geometry = tile.mesh.geometry
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
      tile.mesh.geometry = geometry
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
      const cell = tile.cells[c]!
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

    tile.minY = minY
    tile.maxY = maxY
  }

  /** Applies material, shadow flags and the manual bounding sphere (instanced geometry can't compute one). */
  applyTileSettings(tile: Tile): void {
    const s = this.ctx.settings()
    const { mesh } = tile
    const ts = s.tileSize
    mesh.material = this.ctx.material()
    mesh.receiveShadow = s.receiveShadow
    mesh.visible = mesh.geometry.instanceCount > 0
    if (!mesh.visible) return
    // Instanced geometry can't compute its own bounds; frustum culling needs a manual sphere.
    const reach = s.bladeHeight * (1 + s.heightVariation) * 2 + s.clumpSize // map can double height; tufts spill over edges
    mesh.geometry.boundingSphere = new Sphere(
      new Vector3(ts / 2, (tile.minY + tile.maxY) / 2, ts / 2),
      Math.hypot(ts / Math.SQRT2, (tile.maxY - tile.minY) / 2) + reach,
    )
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
