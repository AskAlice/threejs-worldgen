import { Matrix4, Vector3, type Object3D } from 'three/webgpu'
import type { LocalFrame } from 'threejs-biomes'

/** Merges `input` into `target`: plain objects merge field by field, everything else (arrays, class instances) replaces; `undefined` is ignored. */
export function mergeInput<T extends object>(target: T, input: object): T {
  const t = target as Record<string, unknown>
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue
    t[k] = isPlain(v) && isPlain(t[k]) ? mergeInput({ ...(t[k] as object) }, v) : v
  }
  return target
}

function isPlain(v: unknown): v is object {
  return !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype
}

const _m = new Matrix4()
const _x = new Vector3()
const _y = new Vector3()
const _z = new Vector3()
/**
 * Places `object` so its local axes are the frame's (x east, y up, z south) and its local origin is
 * the frame origin, in a render space whose (0, 0, 0) is world position `origin` (floating origin).
 * All arithmetic is float64, so the float32 GPU only ever sees small numbers.
 */
export function placeInFrame(object: Object3D, frame: LocalFrame, origin: readonly number[]): void {
  const o = frame.origin, e = frame.east, u = frame.up, n = frame.north
  object.position.set(o[0] - origin[0], o[1] - origin[1], o[2] - origin[2])
  _m.makeBasis(_x.set(e[0], e[1], e[2]), _y.set(u[0], u[1], u[2]), _z.set(-n[0], -n[1], -n[2]))
  object.quaternion.setFromRotationMatrix(_m)
  object.updateMatrix()
}

/** World (planet-centred or flat-world) position → frame-local [x, y, z]. */
export function worldToFrame(frame: LocalFrame, x: number, y: number, z: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const o = frame.origin, e = frame.east, u = frame.up, n = frame.north
  const dx = x - o[0], dy = y - o[1], dz = z - o[2]
  out[0] = dx * e[0] + dy * e[1] + dz * e[2]
  out[1] = dx * u[0] + dy * u[1] + dz * u[2]
  out[2] = -(dx * n[0] + dy * n[1] + dz * n[2])
  return out
}

/** Minimal renderer shape the water classes accept: a `WebGPURenderer` from `three/webgpu`. */
export interface WaterRenderer {
  /** `true` on `WebGPURenderer`; anything else is rejected. */
  isWebGPURenderer?: boolean
  /** Whether `init()` has completed. */
  hasInitialized?: () => boolean
  /** Initialises the backend (WebGPU, or WebGL2 fallback). */
  init?: () => Promise<unknown>
}

/** Validates and initialises a renderer passed to a `create()` factory. */
export async function prepareRenderer(renderer: WaterRenderer | undefined, what: string): Promise<void> {
  if (renderer && !renderer.isWebGPURenderer) {
    throw new Error(`${what} requires WebGPURenderer from "three/webgpu" (it falls back to WebGL2 by itself).`)
  }
  if (renderer?.hasInitialized?.() === false) await renderer.init?.()
}

/** Calls `update` whenever `scene` renders; returns the undo function. */
export function hookScene(scene: Object3D, update: () => void): () => void {
  const previous = scene.onBeforeRender
  scene.onBeforeRender = (...args) => {
    previous.apply(scene, args)
    update()
  }
  return () => { scene.onBeforeRender = previous }
}

/** Seconds since the previous call, clamped so a background tab doesn't jump the waves. */
export class Clock {
  private last = -1
  /** Returns the elapsed seconds (0 on the first call). */
  tick(): number {
    const now = performance.now() / 1000
    const dt = this.last < 0 ? 0 : Math.min(0.25, Math.max(0, now - this.last))
    this.last = now
    return dt
  }
}
