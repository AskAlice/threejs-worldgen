import { InstancedBufferGeometry, Mesh, type Group, type MeshPhysicalNodeMaterial, type Vector3 } from 'three/webgpu'
import { slopeAt, type HeightFn } from 'threejs-heightfield'
import { hash2, mulberry32, valueNoise } from './random.ts'
import { BILLBOARD_DENSITY_RATIO, type GrassSettings } from './grass-settings.ts'
import { disposeInstanced, type TileGeometryStore } from './grass-geometry.ts'
import type { Retirement } from './retirement.ts'

export interface CellCache {
  rand: () => number
  clumpX: Float32Array
  clumpZ: Float32Array
  clumpH: Float32Array
  /** Candidates drawn so far (some are rejected: off-terrain / too steep). */
  candidates: number
  /** Accepted blades, in candidate order. */
  count: number
  offsets: Float32Array
  params: Float32Array
  patches: Float32Array
}

export interface Tile {
  ix: number
  iz: number
  /** Edge length of the grid this tile was built on (kept when a tileSize change retires it). */
  size: number
  /** Blade candidates currently built per cell. */
  built: Int32Array
  segments: number
  /** Generated blades per cell, kept so LOD changes are a copy instead of a regeneration. */
  cells: (CellCache | undefined)[]
  mesh: Mesh<InstancedBufferGeometry, MeshPhysicalNodeMaterial>
  minY: number
  maxY: number
  seen: number
  dist: number
  /** Frames spent stale (0 while live); releases a stale tile whose area is legitimately empty. */
  staleFor: number
}

export interface TileStreamContext {
  object: Group
  settings: () => GrassSettings
  billboard: () => boolean
  height: () => HeightFn
  densityAt: (dist: number) => number
  /** `null` until the field has created its material; no tiles exist before then. */
  material: () => MeshPhysicalNodeMaterial | null
  geometry: TileGeometryStore
  retirement: Retirement
}

/** Cells are built with this many times the blades they currently need. */
const HEADROOM = 1.3

/** How long a stale tile may wait for a replacement that legitimately has no blades. */
const STALE_MAX_FRAMES = 60

/** Rebuild when a cell needs more than it holds, holds far more than it needs, or detail changed.
 *  Headroom on the way up and slack on the way down stop tiles rebuilding as the camera wanders. */
function needsRebuild(tile: Tile, needs: Int32Array, segments: number) {
  if (tile.segments !== segments || tile.built.length !== needs.length) return true
  for (let c = 0; c < needs.length; c++) {
    const built = tile.built[c]
    const need = needs[c]
    if (need > built || built > need * 2.5 + 8) return true
  }
  return false
}

/**
 * Streams the tile grid around the camera: creates/retires tiles, generates their cells' blades and
 * hands each rebuilt tile to the geometry store for upload.
 */
export class TileStream {
  /** Live tiles, keyed by grid coords. */
  readonly tiles = new Map<string, Tile>()
  /** Tiles from the previous grid, kept on screen until the new grid covers their area. */
  staleTiles: Tile[] = []
  private frame = 0
  private needScratch = new Int32Array(0)
  private readonly ctx: TileStreamContext

  constructor(ctx: TileStreamContext) {
    this.ctx = ctx
  }

  /**
   * Re-centres the grid on `cam`, retires tiles that left the view and rebuilds what needs it,
   * nearest first, until `budget` ms are spent.
   */
  update(cam: Vector3, budget: number, castShadow: boolean, shadowDistance: number): { tiles: number; instances: number } {
    const s = this.ctx.settings()
    const frame = ++this.frame
    const ts = s.tileSize
    const r = Math.ceil(s.maxDistance / ts)
    const ci = Math.floor(cam.x / ts)
    const cj = Math.floor(cam.z / ts)
    const pending: { tile: Tile; dist: number; needs: Int32Array; segments: number }[] = []

    for (let i = ci - r; i <= ci + r; i++) {
      for (let j = cj - r; j <= cj + r; j++) {
        const dx = Math.max(i * ts - cam.x, 0, cam.x - (i + 1) * ts)
        const dz = Math.max(j * ts - cam.z, 0, cam.z - (j + 1) * ts)
        const dist = Math.hypot(dx, dz)
        if (dist >= s.maxDistance) continue
        const key = `${i},${j}`
        let tile = this.tiles.get(key)
        if (!tile) {
          tile = this.createTile(i, j)
          this.tiles.set(key, tile)
        }
        tile.seen = frame
        tile.dist = dist
        const needs = this.cellNeeds(tile, cam)
        const segments = this.segmentsAt(dist)
        if (needsRebuild(tile, needs, segments)) pending.push({ tile, dist, needs: needs.slice(), segments })
      }
    }

    for (const [key, tile] of this.tiles) {
      if (tile.seen !== frame) {
        this.removeTile(tile)
        this.tiles.delete(key)
      }
    }
    this.retireStaleTiles()
    this.ctx.retirement.flush()

    pending.sort((a, b) => a.dist - b.dist)
    const start = performance.now()
    for (const p of pending) {
      this.buildTile(p.tile, p.needs, p.segments)
      if (performance.now() - start > budget) break
    }

    let instances = 0
    for (const tile of this.tiles.values()) {
      instances += tile.mesh.geometry.instanceCount
      tile.mesh.castShadow = castShadow && tile.dist < shadowDistance
    }
    return { tiles: this.tiles.size, instances }
  }

  /** Keeps the old blades visible until each tile is rebuilt (layout changed, grid unchanged). */
  resetCells(): void {
    for (const tile of this.tiles.values()) {
      tile.cells = []
      tile.built = new Int32Array(0)
    }
  }

  /** Moves the current grid aside so it keeps rendering until the new grid covers its area. */
  retireForResize(): void {
    for (const tile of this.tiles.values()) this.staleTiles.push(tile)
    this.tiles.clear()
  }

  /** Pushes the current material and per-tile settings to every live (and stale) tile. */
  applySettings(): void {
    for (const tile of this.tiles.values()) this.ctx.geometry.applyTileSettings(tile)
    for (const tile of this.staleTiles) this.ctx.geometry.applyTileSettings(tile)
  }

  /** Removes and frees every tile, live or stale. */
  clear(): void {
    for (const tile of this.tiles.values()) this.removeTile(tile)
    this.tiles.clear()
    for (const tile of this.staleTiles) this.removeTile(tile)
    this.staleTiles.length = 0
  }

  /** Tiles are split into ~5 m cells, each holding only as many blades as its own distance needs.
   *  Without this, the tiles around the camera would carry full density across their whole area. */
  get cellsPerSide() {
    return Math.max(1, Math.round(this.ctx.settings().tileSize / 5))
  }

  /** Full-density blade candidates per cell. */
  get cellFull() {
    const s = this.ctx.settings()
    const cs = s.tileSize / this.cellsPerSide
    return Math.ceil(s.density * cs * cs * (this.ctx.billboard() ? BILLBOARD_DENSITY_RATIO : 1))
  }

  /** Blade candidates each cell of a tile needs for the current camera position. */
  private cellNeeds(tile: Tile, cam: Vector3) {
    const s = this.ctx.settings()
    const n = this.cellsPerSide
    const cs = s.tileSize / n
    const full = this.cellFull
    if (this.needScratch.length !== n * n) this.needScratch = new Int32Array(n * n)
    const needs = this.needScratch
    for (let b = 0; b < n; b++) {
      for (let a = 0; a < n; a++) {
        const x0 = tile.ix * s.tileSize + a * cs
        const z0 = tile.iz * s.tileSize + b * cs
        const dist = Math.hypot(Math.max(x0 - cam.x, 0, cam.x - x0 - cs), Math.max(z0 - cam.z, 0, cam.z - z0 - cs))
        needs[b * n + a] = dist >= s.maxDistance ? 0 : Math.ceil(full * Math.min(1, this.ctx.densityAt(dist)))
      }
    }
    return needs
  }

  private segmentsAt(dist: number) {
    const lods = this.ctx.settings().lods
    let lod = 0
    while (lod < 3 && dist >= lods[lod + 1].distance) lod++
    return lods[lod].segments
  }

  private createTile(ix: number, iz: number): Tile {
    const material = this.ctx.material()
    if (!material) throw new Error('Grass: tiles were updated before the material was created.')
    const geometry = new InstancedBufferGeometry()
    geometry.instanceCount = 0
    const mesh = new Mesh(geometry, material)
    mesh.position.set(ix * this.ctx.settings().tileSize, 0, iz * this.ctx.settings().tileSize)
    mesh.updateMatrix()
    mesh.matrixAutoUpdate = false
    mesh.visible = false
    this.ctx.object.add(mesh)
    return { ix, iz, size: this.ctx.settings().tileSize, built: new Int32Array(0), segments: 0, cells: [], mesh, minY: 0, maxY: 0, seen: 0, dist: 0, staleFor: 0 }
  }

  private buildTile(tile: Tile, needs: Int32Array, segments: number) {
    const s = this.ctx.settings()
    const cs = s.tileSize / this.cellsPerSide
    const full = this.cellFull
    // Build with headroom so a camera creeping closer doesn't trigger a rebuild every frame.
    const counts = needs.map((need) => (need ? Math.min(full, Math.ceil(need * HEADROOM)) : 0))

    // Ensure each cell has generated enough candidates, then count how many accepted blades fall in
    // the first `counts[c]` candidates (rank encodes the candidate index).
    const take = counts.map((count, c) => {
      if (!count) return 0
      const cell = (tile.cells[c] ??= this.createCell(tile, c, cs))
      if (cell.candidates < count) this.generate(tile, cell, c, cs, full, count)
      let k = cell.count
      while (k > 0 && cell.params[(k - 1) * 4 + 2] * full > count) k--
      return k
    })

    this.ctx.geometry.write(tile, take, segments, this.ctx.billboard())
    tile.built = counts
    tile.segments = segments
    this.ctx.geometry.applyTileSettings(tile)
  }

  createCell(tile: Pick<Tile, 'ix' | 'iz'>, c: number, cs: number): CellCache {
    const s = this.ctx.settings()
    const n = this.cellsPerSide
    const a = c % n
    const b = Math.floor(c / n)
    // Each cell has its own random streams keyed by global cell coords. Blades are drawn in a fixed
    // order with a fixed number of draws, so fewer blades is always an exact prefix of more blades:
    // LOD changes only add/remove blades, never reshuffle them.
    const cellSeed = hash2(tile.ix * n + a, tile.iz * n + b)
    const clumpRand = mulberry32(cellSeed ^ 0x9e3779b9)
    const clumps = Math.max(1, Math.ceil((cs * cs) / (s.clumpSize * s.clumpSize)))
    const cell: CellCache = {
      rand: mulberry32(cellSeed),
      clumpX: new Float32Array(clumps),
      clumpZ: new Float32Array(clumps),
      clumpH: new Float32Array(clumps),
      candidates: 0,
      count: 0,
      offsets: new Float32Array(0),
      params: new Float32Array(0),
      patches: new Float32Array(0),
    }
    for (let k = 0; k < clumps; k++) {
      cell.clumpX[k] = a * cs + clumpRand() * cs
      cell.clumpZ[k] = b * cs + clumpRand() * cs
      cell.clumpH[k] = clumpRand()
    }
    return cell
  }

  /** Continues a cell's blade stream until `upTo` candidates have been drawn. */
  generate(tile: Pick<Tile, 'ix' | 'iz'>, cell: CellCache, c: number, cs: number, full: number, upTo: number) {
    const s = this.ctx.settings()
    const height = this.ctx.height()
    const n = this.cellsPerSide
    const cx = (c % n) * cs
    const cz = Math.floor(c / n) * cs
    const ox = tile.ix * s.tileSize
    const oz = tile.iz * s.tileSize
    const clumping = this.ctx.billboard() ? 0 : s.clumping // a billboard already is a tuft
    const checkSlope = Number.isFinite(s.maxSlope)
    const { rand, clumpX, clumpZ, clumpH } = cell
    const clumps = clumpX.length

    const grow = upTo - cell.candidates
    if (cell.offsets.length < (cell.count + grow) * 4) {
      const cap = Math.max(cell.count + grow, cell.count * 2)
      const resize = (arr: Float32Array, stride: number) => {
        const next = new Float32Array(cap * stride)
        next.set(arr.subarray(0, cell.count * stride))
        return next
      }
      cell.offsets = resize(cell.offsets, 4)
      cell.params = resize(cell.params, 4)
      cell.patches = resize(cell.patches, 3)
    }
    const { offsets, params, patches } = cell

    for (let i = cell.candidates; i < upTo; i++) {
      let lx = cx + rand() * cs
      let lz = cz + rand() * cs
      let yaw = rand() * Math.PI * 2
      let hr = rand()
      const ws = 1 + (rand() * 2 - 1) * s.widthVariation
      const seed = rand()
      const k = Math.floor(rand() * clumps)
      const angle = rand() * Math.PI * 2
      const radius = Math.sqrt(rand()) * s.clumpSize * 0.5
      // Tufts: blades gather around clump centres, face outwards (so they droop outwards) and share
      // a clump-level height.
      if (rand() < clumping) {
        lx = clumpX[k] + Math.sin(angle) * radius
        lz = clumpZ[k] + Math.cos(angle) * radius
        yaw = angle + (yaw / Math.PI - 1) * 0.5
        hr = clumpH[k] * 0.65 + hr * 0.35
      }
      const wx = ox + lx
      const wz = oz + lz
      const y = height(wx, wz)
      if (y !== y) continue
      if (checkSlope && slopeAt(height, wx, wz) > s.maxSlope) continue
      const o = cell.count * 4
      offsets[o] = lx
      offsets[o + 1] = y
      offsets[o + 2] = lz
      offsets[o + 3] = yaw
      params[o] = 1 + (hr * 2 - 1) * s.heightVariation
      params[o + 1] = ws
      params[o + 2] = (i + 0.5) / full
      params[o + 3] = seed
      const p = cell.count * 3
      patches[p] = valueNoise(wx * 0.05, wz * 0.05) * 0.7 // light/dark patches
      patches[p + 1] = valueNoise(wx * 0.018 + 31.7, wz * 0.018 - 12.3) * 0.7 // dry patches
      // Flow field: a slowly meandering lean direction, so the field looks brushed into swirls
      // rather than combed in one direction.
      patches[p + 2] = valueNoise(wx * 0.07 - 5.1, wz * 0.07 + 9.4) + valueNoise(wx * 0.19 + 2.3, wz * 0.19 - 7.7) * 0.4
      cell.count++
    }
    cell.candidates = upTo
  }

  /** Drops a stale tile once every new tile overlapping its area has been built (or it left the view). */
  private retireStaleTiles() {
    if (!this.staleTiles.length) return
    const ts = this.ctx.settings().tileSize
    const keep: Tile[] = []
    for (const stale of this.staleTiles) {
      const x0 = stale.ix * stale.size
      const x1 = x0 + stale.size
      const z0 = stale.iz * stale.size
      const z1 = z0 + stale.size
      let overlaps = false
      let ready = true
      let shown = false
      for (const tile of this.tiles.values()) {
        const nx0 = tile.ix * ts
        const nx1 = nx0 + ts
        const nz0 = tile.iz * ts
        const nz1 = nz0 + ts
        if (x0 < nx1 && nx0 < x1 && z0 < nz1 && nz0 < z1) {
          overlaps = true
          // Not yet built: its blades are still coming.
          if (tile.built.length === 0) {
            ready = false
            break
          }
          if (tile.mesh.geometry.instanceCount > 0) shown = true
        }
      }
      stale.staleFor++
      // A built replacement with no instances may be thinning blades out or may cover ground that has
      // no grass at all; wait a bounded number of frames for blades, then let the empty grid stand
      // instead of pinning this tile forever.
      const covered = ready && shown
      if (overlaps && !covered && stale.staleFor <= STALE_MAX_FRAMES) keep.push(stale)
      else this.removeTile(stale)
    }
    this.staleTiles = keep
  }

  private removeTile(tile: Tile) {
    tile.mesh.removeFromParent()
    const geometry = tile.mesh.geometry
    this.ctx.retirement.retire(() => disposeInstanced(geometry))
  }
}
