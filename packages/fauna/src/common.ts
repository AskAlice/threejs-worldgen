import { BufferAttribute, BufferGeometry, Matrix4, Sphere, Vector3, type Node, type NodeMaterial, type Object3D } from 'three/webgpu'
import { positionLocal } from 'three/tsl'
import type { LocalFrame } from 'threejs-biomes'
import type { MeshData } from './fish-geometry.ts'

/**
 * The shared material-state layer (as in `threejs-weathering`): four 0…1 states every asset can show.
 * Fish mostly ignore them; birds get darker when wet and white on top when snowy; both char when
 * burnt and dull when damaged.
 */
export interface MaterialStates {
  /** 0 dry … 1 soaked. */
  wetness: number
  /** 0 … 1 snow cover. */
  snow: number
  /** 0 … 1 burnt. */
  burn: number
  /** 0 … 1 damaged. */
  damage: number
}

/** No weathering. */
export const DEFAULT_STATES: MaterialStates = { wetness: 0, snow: 0, burn: 0, damage: 0 }

/** Something animals flee from: an object (or a React ref to one) and a radius of fear, metres. */
export interface Predator {
  /** The object; its world position is read every frame. */
  object: Object3D | {
    /** The referenced object; `null` until mounted. */
    current: Object3D | null
  }
  /** Animals closer than this flee. */
  radius: number
}

/** Recursive partial; arrays and tuples are replaced, not merged. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] }

/** Merges `input` into `target`: plain objects merge field by field, everything else replaces; `undefined` is ignored. */
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
 * Places `object` so its local axes are the frame's (x east, y up, z south) and its origin is the frame
 * origin, in a render space whose (0, 0, 0) is world position `origin` (floating origin).
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

/** Minimal renderer shape the fauna classes accept: a `WebGPURenderer` from `three/webgpu`. */
export interface FaunaRenderer {
  /** `true` on `WebGPURenderer`; anything else is rejected. */
  isWebGPURenderer?: boolean
  /** Whether `init()` has completed. */
  hasInitialized?: () => boolean
  /** Initialises the backend (WebGPU, or WebGL2 fallback). */
  init?: () => Promise<unknown>
}

/** Validates and initialises a renderer passed to a `create()` factory. */
export async function prepareRenderer(renderer: FaunaRenderer | undefined, what: string): Promise<void> {
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

/** Seconds since the previous call, clamped so a background tab doesn't jump the simulation. */
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

/** Turns {@link MeshData} into a `BufferGeometry` with `position`, `normal` and the `fauna` (s, h, part, w) attribute. */
export function toGeometry(data: MeshData): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(data.position, 3))
  g.setAttribute('normal', new BufferAttribute(data.normal, 3))
  g.setAttribute('fauna', new BufferAttribute(data.attr, 4))
  g.setIndex(new BufferAttribute(data.index, 1))
  const [x0, y0, z0, x1, y1, z1] = data.bounds
  g.boundingSphere = new Sphere(new Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 + 0.3)
  return g
}

/** Wraps an angle to [−π, π]. */
export function wrapAngle(a: number): number {
  return a - Math.PI * 2 * Math.round(a / (Math.PI * 2))
}

/**
 * Deforms vertices in the mesh's own space, before instancing. (A material's `positionNode` runs after
 * the instance transform and would replace it, so animated instanced meshes deform here instead.)
 */
export function deformBeforeInstancing<M extends NodeMaterial>(material: M, deformed: Node): M {
  const setup = material.setupPosition.bind(material)
  material.setupPosition = (builder) => {
    positionLocal.assign(deformed)
    return setup(builder)
  }
  return material
}
