import { DataTexture, LinearFilter, Mesh, MeshBasicNodeMaterial, Raycaster, RingGeometry, Vector2 } from 'three/webgpu'
import { raycastHeight } from 'threejs-heightfield'
import type { Grass } from './grass.ts'

/** Options for {@link GrassMap}. */
export interface GrassMapOptions {
  /** World XZ centre of the mapped square. Default `[0, 0]`. */
  center?: [x: number, z: number]
  /** Edge length of the mapped square in metres. Default 256. */
  size?: number
  /** Texels per side. Default 512. */
  resolution?: number
  /** Initial coverage 0..1. Default 1 (grass everywhere). */
  coverage?: number
  /** Initial height multiplier 0..2 (1 = preset height). Default 1. */
  height?: number
}

/** What a brush stroke does: add/erase coverage, or raise/lower grass height. */
export type BrushMode = 'add' | 'erase' | 'raise' | 'lower'

/** A soft round brush used by {@link GrassMap.paint} and {@link TerrainPainter}. */
export interface Brush {
  /** What the stroke does: add/erase coverage or raise/lower height. */
  mode: BrushMode
  /** World radius in metres. */
  radius: number
  /** 0..1 amount applied per stroke event at the brush center. */
  strength: number
}

/**
 * A world-space control texture covering a square of terrain: where grass grows and how tall.
 * Channels: R = coverage (0 none … 1 full), G = height (0.5 = 1x … 1 = 2x). Outside its square,
 * grass grows normally. Edits (paint/fill/load) show up immediately.
 *
 * @example
 * ```ts
 * const map = new GrassMap({ center: [0, 0], size: 300 })
 * map.paint(10, -4, { mode: 'erase', radius: 2, strength: 1 }) // a clearing
 * grass.set({ grassMap: map })
 * ```
 */
export class GrassMap {
  /** GPU texture sampled by the grass (and by `grass.mapNode()`). */
  readonly texture: DataTexture
  /** Raw RGBA bytes, row-major, row 0 at `minZ`. Set `texture.needsUpdate = true` after editing directly. */
  readonly data: Uint8Array
  /** Texels per side. */
  readonly resolution: number
  /** Edge length of the mapped square in metres. */
  readonly size: number
  /** World X of the square's west edge. */
  readonly minX: number
  /** World Z of the square's north (−Z) edge. */
  readonly minZ: number

  /** Creates a map covering `size × size` metres around `center`, filled with `coverage` and `height`. */
  constructor({ center = [0, 0], size = 256, resolution = 512, coverage = 1, height = 1 }: GrassMapOptions = {}) {
    this.resolution = resolution
    this.size = size
    this.minX = center[0] - size / 2
    this.minZ = center[1] - size / 2
    this.data = new Uint8Array(resolution * resolution * 4)
    this.texture = new DataTexture(this.data, resolution, resolution)
    this.texture.magFilter = this.texture.minFilter = LinearFilter
    this.fill(coverage, height)
  }

  /**
   * Creates a map from an image (red = coverage, green = height, mid-grey = 1x), read as a top-down
   * view with its top edge towards −Z. Round-trips with {@link GrassMap.toDataURL}.
   */
  static fromImage(image: CanvasImageSource & { width: number; height: number }, options: Omit<GrassMapOptions, 'coverage' | 'height'> = {}): GrassMap {
    return new GrassMap(options).load(image)
  }

  /** Replaces the map's contents with an image (scaled to `resolution`). See {@link GrassMap.fromImage}. */
  load(image: CanvasImageSource & { width: number; height: number }): this {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = this.resolution
    const ctx = canvas.getContext('2d')!
    // Row 0 of the data is minZ, so the image reads as a top-down view with its top edge at -Z.
    ctx.drawImage(image, 0, 0, this.resolution, this.resolution)
    this.data.set(ctx.getImageData(0, 0, this.resolution, this.resolution).data)
    this.texture.needsUpdate = true
    return this
  }

  /** Sets the whole map to one coverage (0..1) and height multiplier (0..2). `fill(0)` clears all grass. */
  fill(coverage = 1, height = 1): void {
    const r = Math.round(clamp01(coverage) * 255)
    const g = Math.round(clamp01(height / 2) * 255)
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = r
      this.data[i + 1] = g
      this.data[i + 2] = 0
      this.data[i + 3] = 255
    }
    this.texture.needsUpdate = true
  }

  /**
   * Applies a soft round brush at world (x, z).
   * @returns `false` if the brush is entirely outside the map.
   */
  paint(x: number, z: number, { mode, radius, strength }: Brush): boolean {
    const res = this.resolution
    const texel = this.size / res
    const cx = (x - this.minX) / texel - 0.5
    const cz = (z - this.minZ) / texel - 0.5
    const rr = radius / texel
    const channel = mode === 'add' || mode === 'erase' ? 0 : 1
    const sign = mode === 'add' || mode === 'raise' ? 1 : -1
    const i0 = Math.max(0, Math.floor(cx - rr))
    const i1 = Math.min(res - 1, Math.ceil(cx + rr))
    const j0 = Math.max(0, Math.floor(cz - rr))
    const j1 = Math.min(res - 1, Math.ceil(cz + rr))
    if (i0 > i1 || j0 > j1) return false
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i - cx, j - cz) / rr
        if (d >= 1) continue
        const falloff = (1 - d * d) ** 2
        const k = (j * res + i) * 4 + channel
        this.data[k] = Math.max(0, Math.min(255, this.data[k] + sign * strength * falloff * 255))
      }
    }
    this.texture.needsUpdate = true
    return true
  }

  /** Raw map as a canvas (R = coverage, G = height); round-trips through `GrassMap.fromImage`. */
  toCanvas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = this.resolution
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(this.data), this.resolution, this.resolution), 0, 0)
    return canvas
  }

  /** PNG data URL of the map, e.g. to save a painted layout. */
  toDataURL(): string {
    return this.toCanvas().toDataURL('image/png')
  }

  /** Frees the GPU texture. */
  dispose(): void {
    this.texture.dispose()
  }
}

/**
 * Paint a Grass's `grassMap` directly on the terrain: left-drag to apply the brush; a ring follows
 * the pointer. Works with mesh and height-function terrain alike. Disable your camera controls
 * while painting — they listen to the same pointer events.
 *
 * @example
 * ```ts
 * const painter = new TerrainPainter(grass, renderer.domElement, { mode: 'add', radius: 3 })
 * painter.brush.mode = 'erase' // change the brush at any time
 * painter.enabled = false      // pause painting
 * ```
 */
export class TerrainPainter {
  /** When false, pointer events are ignored and the cursor is hidden. */
  enabled = true
  /** Current brush. Mutate freely. Defaults: erase, 3 m radius, 0.25 strength. */
  brush: Brush
  /** Brush outline that follows the terrain under the pointer. */
  readonly cursor: Mesh
  /** Field whose `grassMap` is painted. */
  readonly grass: Grass
  /** Element receiving pointer events. */
  readonly domElement: HTMLElement

  private painting = false
  private raycaster = new Raycaster()
  private ndc = new Vector2()

  /**
   * @param grass Field whose `grassMap` is painted. Must have a grass map.
   * @param domElement Element receiving pointer events, usually `renderer.domElement`.
   * @param brush Initial brush settings.
   * @throws If the grass has no `grassMap`.
   */
  constructor(grass: Grass, domElement: HTMLElement, brush: Partial<Brush> = {}) {
    this.grass = grass
    this.domElement = domElement
    if (!grass.settings.grassMap) throw new Error('TerrainPainter: set a `grassMap` on the Grass first.')
    this.brush = { mode: 'erase', radius: 3, strength: 0.25, ...brush }
    this.cursor = new Mesh(
      new RingGeometry(0.92, 1, 64).rotateX(-Math.PI / 2),
      new MeshBasicNodeMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }),
    )
    this.cursor.renderOrder = 999
    this.cursor.visible = false
    grass.object.add(this.cursor)
    domElement.addEventListener('pointerdown', this.onDown)
    domElement.addEventListener('pointermove', this.onMove)
    domElement.addEventListener('pointerup', this.onUp)
    domElement.addEventListener('pointerleave', this.onLeave)
  }

  /** Removes listeners and the cursor. */
  dispose(): void {
    this.domElement.removeEventListener('pointerdown', this.onDown)
    this.domElement.removeEventListener('pointermove', this.onMove)
    this.domElement.removeEventListener('pointerup', this.onUp)
    this.domElement.removeEventListener('pointerleave', this.onLeave)
    this.cursor.removeFromParent()
    this.cursor.geometry.dispose()
    ;(this.cursor.material as MeshBasicNodeMaterial).dispose()
  }

  private hit(e: PointerEvent) {
    const rect = this.domElement.getBoundingClientRect()
    this.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.ndc, this.grass.camera)
    const { origin, direction } = this.raycaster.ray
    return raycastHeight(this.grass.sampleHeight, origin, direction, this.grass.settings.maxDistance * 2)
  }

  private stroke(e: PointerEvent) {
    const p = this.enabled ? this.hit(e) : null
    this.cursor.visible = !!p
    if (!p) return
    this.cursor.position.set(p.x, p.y + 0.05, p.z)
    this.cursor.scale.setScalar(this.brush.radius)
    if (this.painting) this.grass.settings.grassMap?.paint(p.x, p.z, this.brush)
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled || e.button !== 0) return
    this.painting = true
    this.domElement.setPointerCapture(e.pointerId)
    this.stroke(e)
  }
  private onMove = (e: PointerEvent) => this.stroke(e)
  private onUp = (e: PointerEvent) => {
    this.painting = false
    if (this.domElement.hasPointerCapture(e.pointerId)) this.domElement.releasePointerCapture(e.pointerId)
  }
  private onLeave = () => {
    this.cursor.visible = false
  }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
