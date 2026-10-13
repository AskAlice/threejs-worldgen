import type { PerspectiveCamera } from 'three/webgpu'
import type { Vec3 } from './noise.ts'
import { createSample, type World } from './world.ts'

/** Settings for {@link SurfaceControls}. */
export interface SurfaceControlsOptions {
  /** Closest the camera gets to the focus point, metres (0.01 ≈ an ant's eye). */
  minDistance: number
  /** Farthest, metres. `0` = automatic (6 planet radii, or 80 km on flat worlds). */
  maxDistance: number
  /** Wheel zoom speed (exponential, so it feels the same at every scale). */
  zoomSpeed: number
  /** Drag rotation speed. */
  rotateSpeed: number
  /** Pan / WASD speed as a fraction of the camera distance per second. */
  moveSpeed: number
  /** Lowest view angle above the horizon, radians. */
  minElevation: number
  /** Highest view angle (straight down = π/2), radians. */
  maxElevation: number
  /** Keep the camera at least this far above the ground, metres (scaled down near `minDistance`). */
  clearance: number
  /** Set the camera's near/far planes from its altitude every frame. */
  autoClip: boolean
  /** Smoothing of motion (0 = none, 0.9 = very smooth). */
  damping: number
}

/** Default controls: 1 cm to orbit. */
export const DEFAULT_SURFACE_CONTROLS: SurfaceControlsOptions = {
  minDistance: 0.01, maxDistance: 0, zoomSpeed: 1, rotateSpeed: 1, moveSpeed: 0.8,
  minElevation: 0.03, maxElevation: Math.PI / 2 - 0.01, clearance: 0.3, autoClip: true, damping: 0.8,
}

/**
 * Camera controls that work at every scale, on flat worlds and planets: orbit around a focus point that
 * stays on the ground, exponential zoom from centimetres to orbit, pan/WASD at a speed proportional to
 * the distance, the camera's "up" always the local up, and automatic near/far planes. The focus point is
 * also the floating origin: the camera is placed in render space relative to it, so pass
 * {@link SurfaceControls.origin} to terrain, water and anything else that uses a floating origin.
 */
export class SurfaceControls {
  /** Planet-centred (or flat-world) focus point on the ground, float64. Render-space zero. */
  focus: Vec3
  /** Distance from the focus to the camera, metres. */
  distance: number
  /** Horizontal view angle, radians. */
  azimuth = 0.6
  /** Angle above the horizon, radians. */
  elevation = 0.45
  /** Settings. */
  options: SurfaceControlsOptions
  /** Camera altitude above the ground under it, metres (updated every frame). */
  altitude = 0

  private target = { azimuth: 0.6, elevation: 0.45, distance: 0, focus: [0, 0, 0] as Vec3 }
  private keys = new Set<string>()
  private sample = createSample()
  private cleanup: () => void
  private last = performance.now()

  /** The controlled camera. */
  readonly camera: PerspectiveCamera
  /** Element that receives pointer and wheel input. */
  readonly dom: HTMLElement
  /** The world the camera moves over. */
  readonly world: World

  /** Attaches to `dom` for pointer, wheel and keyboard input. */
  constructor(camera: PerspectiveCamera, dom: HTMLElement, world: World, input: Partial<SurfaceControlsOptions> & { focus?: Vec3; distance?: number } = {}) {
    this.camera = camera
    this.dom = dom
    this.world = world
    const { focus, distance, ...rest } = input
    this.options = { ...DEFAULT_SURFACE_CONTROLS, ...rest }
    const R = world.options.surface === 'sphere' ? world.options.radius : 0
    this.focus = focus ? [...focus] : R ? [...world.frame.origin] : [0, 0, 0]
    this.distance = distance ?? (R ? R * 0.02 : 400)
    this.target.distance = this.distance
    this.target.focus = [...this.focus]
    this.snapFocus(this.target.focus)
    this.focus = [...this.target.focus]
    this.cleanup = this.listen()
  }

  /** Merges settings. */
  set(input: Partial<SurfaceControlsOptions>): this {
    this.options = { ...this.options, ...input }
    return this
  }

  /** Render-space zero, i.e. the focus point. */
  get origin(): Vec3 {
    return this.focus
  }

  /** Jumps to look at `focus` from `distance` metres. */
  lookAt(focus: Vec3, distance = this.distance): this {
    this.target.focus = [...focus]
    this.snapFocus(this.target.focus)
    this.focus = [...this.target.focus]
    this.target.distance = this.distance = distance
    return this
  }

  /** Applies input and places the camera. Call once per frame. */
  update(): this {
    const now = performance.now()
    const dt = Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    const o = this.options
    const sphere = this.world.options.surface === 'sphere'
    const R = this.world.options.radius
    const maxD = o.maxDistance || (sphere ? R * 6 : 80_000)
    this.target.distance = Math.min(maxD, Math.max(o.minDistance, this.target.distance))
    this.target.elevation = Math.min(o.maxElevation, Math.max(o.minElevation, this.target.elevation))

    // Keyboard panning.
    const kx = (this.keys.has('d') ? 1 : 0) - (this.keys.has('a') ? 1 : 0)
    const kz = (this.keys.has('w') ? 1 : 0) - (this.keys.has('s') ? 1 : 0)
    if (kx || kz) this.pan(kx * o.moveSpeed * this.distance * dt, kz * o.moveSpeed * this.distance * dt)

    // Smooth towards the targets (zoom in log space so it feels the same at every scale).
    const k = 1 - Math.pow(o.damping, dt * 60)
    this.azimuth += (this.target.azimuth - this.azimuth) * k
    this.elevation += (this.target.elevation - this.elevation) * k
    this.distance = Math.exp(Math.log(this.distance) + (Math.log(this.target.distance) - Math.log(this.distance)) * k)
    for (let i = 0; i < 3; i++) this.focus[i] += (this.target.focus[i] - this.focus[i]) * k
    if (sphere) this.snapFocus(this.focus)

    // Camera direction in the local frame at the focus.
    const { up, east, north } = this.frameAt(this.focus)
    const ce = Math.cos(this.elevation), se = Math.sin(this.elevation)
    const ca = Math.cos(this.azimuth), sa = Math.sin(this.azimuth)
    const dir: Vec3 = [
      up[0] * se + (east[0] * ca + north[0] * sa) * ce,
      up[1] * se + (east[1] * ca + north[1] * sa) * ce,
      up[2] * se + (east[2] * ca + north[2] * sa) * ce,
    ]
    let off: Vec3 = [dir[0] * this.distance, dir[1] * this.distance, dir[2] * this.distance]

    // Stay above the ground under the camera.
    const cam: Vec3 = [this.focus[0] + off[0], this.focus[1] + off[1], this.focus[2] + off[2]]
    const ground = this.groundAt(cam)
    const camHeight = sphere ? Math.hypot(...cam) - R : cam[1]
    const clearance = Math.min(o.clearance, this.distance * 0.3)
    if (camHeight < ground + clearance) {
      const lift = ground + clearance - camHeight
      off = [off[0] + up[0] * lift, off[1] + up[1] * lift, off[2] + up[2] * lift]
    }
    this.altitude = Math.max(0, camHeight - ground)

    const c = this.camera
    c.up.set(up[0], up[1], up[2])
    c.position.set(off[0], off[1], off[2])
    c.lookAt(0, 0, 0)
    if (o.autoClip) {
      c.near = Math.max(1e-4, Math.min(this.altitude, this.distance) * 0.05)
      c.far = sphere ? Math.hypot(...cam) + R * 4 : Math.max(200_000, this.distance * 10)
      c.updateProjectionMatrix()
    }
    c.updateMatrixWorld()
    return this
  }

  /** Detaches all event listeners. */
  dispose(): void {
    this.cleanup()
  }

  private frameAt(p: Vec3): { up: Vec3; east: Vec3; north: Vec3 } {
    if (this.world.options.surface !== 'sphere') return { up: [0, 1, 0], east: [1, 0, 0], north: [0, 0, -1] }
    const l = Math.hypot(...p) || 1
    const up: Vec3 = [p[0] / l, p[1] / l, p[2] / l]
    // East = Y × up (falls back near the poles).
    let ex = up[2], ez = -up[0]
    let el = Math.hypot(ex, ez)
    if (el < 1e-6) { ex = 1; ez = 0; el = 1 }
    const east: Vec3 = [ex / el, 0, ez / el]
    const north: Vec3 = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]]
    return { up, east, north }
  }

  private groundAt(p: Vec3): number {
    const w = this.world
    if (w.options.surface === 'sphere') return w.sampleAt(p[0], p[1], p[2], this.sample).elevation
    return w.sampleAt(p[0], 0, p[2], this.sample).elevation
  }

  // Puts a focus point on the terrain surface (keeps its direction on planets, its x/z on flat worlds).
  private snapFocus(p: Vec3) {
    const w = this.world
    if (w.options.surface === 'sphere') {
      const l = Math.hypot(...p) || 1
      const h = w.sampleAt(p[0], p[1], p[2], this.sample).elevation
      const r = w.options.radius + Math.max(h, w.options.seaLevel)
      p[0] = (p[0] / l) * r; p[1] = (p[1] / l) * r; p[2] = (p[2] / l) * r
    } else {
      p[1] = Math.max(w.sampleAt(p[0], 0, p[2], this.sample).elevation, w.options.seaLevel)
    }
  }

  private pan(dx: number, dz: number) {
    const { east, north } = this.frameAt(this.target.focus)
    const ca = Math.cos(this.azimuth), sa = Math.sin(this.azimuth)
    // Forward = away from the camera, along the ground.
    const fx = -(east[0] * ca + north[0] * sa), fy = -(east[1] * ca + north[1] * sa), fz = -(east[2] * ca + north[2] * sa)
    const rx = -(east[0] * -sa + north[0] * ca), ry = -(east[1] * -sa + north[1] * ca), rz = -(east[2] * -sa + north[2] * ca)
    const f = this.target.focus
    f[0] += fx * dz - rx * dx; f[1] += fy * dz - ry * dx; f[2] += fz * dz - rz * dx
    this.snapFocus(f)
  }

  private listen(): () => void {
    const dom = this.dom
    let button = -1, lx = 0, ly = 0
    const down = (e: PointerEvent) => { button = e.button; lx = e.clientX; ly = e.clientY; dom.setPointerCapture(e.pointerId) }
    const move = (e: PointerEvent) => {
      if (button < 0) return
      const dx = e.clientX - lx, dy = e.clientY - ly
      lx = e.clientX; ly = e.clientY
      if (button === 0 && !e.shiftKey) {
        this.target.azimuth += dx * 0.005 * this.options.rotateSpeed
        this.target.elevation += dy * 0.005 * this.options.rotateSpeed
      } else {
        const s = (this.distance / dom.clientHeight) * 1.2
        this.pan(-dx * s, dy * s)
      }
    }
    const up = (e: PointerEvent) => { button = -1; dom.releasePointerCapture?.(e.pointerId) }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      this.target.distance *= Math.exp(e.deltaY * 0.0012 * this.options.zoomSpeed)
    }
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.type === 'keydown') this.keys.add(e.key.toLowerCase())
      else this.keys.delete(e.key.toLowerCase())
    }
    const menu = (e: Event) => e.preventDefault()
    dom.addEventListener('pointerdown', down)
    dom.addEventListener('pointermove', move)
    dom.addEventListener('pointerup', up)
    dom.addEventListener('wheel', wheel, { passive: false })
    dom.addEventListener('contextmenu', menu)
    addEventListener('keydown', key)
    addEventListener('keyup', key)
    return () => {
      dom.removeEventListener('pointerdown', down)
      dom.removeEventListener('pointermove', move)
      dom.removeEventListener('pointerup', up)
      dom.removeEventListener('wheel', wheel)
      dom.removeEventListener('contextmenu', menu)
      removeEventListener('keydown', key)
      removeEventListener('keyup', key)
    }
  }
}
