import type { Camera } from 'three/webgpu'
import type { Vec3 } from './noise.ts'

/** Settings for {@link FloatingOrigin}. */
export interface FloatingOriginOptions {
  /** Rebase when the camera is farther than this from render-space zero, metres. */
  threshold: number
}

/**
 * Keeps the camera near render-space (0, 0, 0) so float32 GPU math stays precise at planet scale.
 * When the camera drifts past `threshold`, the world position at render zero (`origin`) moves to the
 * camera, the camera moves back to zero, and listeners shift whatever they render (terrain, water,
 * controls targets, …) by the same amount.
 *
 * @example
 * ```ts
 * const floating = new FloatingOrigin(camera)
 * floating.onRebase((origin, shift) => { terrain.setOrigin(origin); controls.target.sub(shiftVector(shift)) })
 * // each frame: floating.update()
 * ```
 */
export class FloatingOrigin {
  /** World (planet-centred) position currently at render-space zero, float64. */
  origin: Vec3
  /** Settings. */
  options: FloatingOriginOptions
  /** The camera being followed. */
  camera: Camera
  private listeners = new Set<(origin: Vec3, shift: Vec3) => void>()

  /** Follows `camera`, starting with `origin` at render zero. */
  constructor(camera: Camera, origin: Vec3 = [0, 0, 0], options: Partial<FloatingOriginOptions> = {}) {
    this.camera = camera
    this.origin = [origin[0], origin[1], origin[2]]
    this.options = { threshold: 1000, ...options }
  }

  /** Calls `listener(origin, shift)` after each rebase. Returns an unsubscribe function. */
  onRebase(listener: (origin: Vec3, shift: Vec3) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Rebases if the camera is past the threshold. Returns true when it did. */
  update(): boolean {
    const p = this.camera.position
    if (p.length() < this.options.threshold) return false
    return this.rebase([p.x, p.y, p.z])
  }

  /** Moves render zero by `shift` (render-space metres): the camera and every listener move by −shift. */
  rebase(shift: Vec3): boolean {
    this.origin[0] += shift[0]; this.origin[1] += shift[1]; this.origin[2] += shift[2]
    this.camera.position.set(this.camera.position.x - shift[0], this.camera.position.y - shift[1], this.camera.position.z - shift[2])
    this.camera.updateMatrixWorld()
    for (const l of this.listeners) l(this.origin, shift)
    return true
  }

  /** Converts a world (planet-centred) position to render space. */
  toRender(p: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
    out[0] = p[0] - this.origin[0]; out[1] = p[1] - this.origin[1]; out[2] = p[2] - this.origin[2]
    return out
  }

  /** Converts a render-space position to world (planet-centred) space. */
  toWorld(p: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
    out[0] = p[0] + this.origin[0]; out[1] = p[1] + this.origin[1]; out[2] = p[2] + this.origin[2]
    return out
  }
}
