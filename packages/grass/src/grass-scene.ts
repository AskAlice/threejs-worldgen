import { Vector3, type DirectionalLight, type Object3D, type Vector4 } from 'three/webgpu'
import type { Terrain } from 'threejs-heightfield'
import { MAX_INTERACTORS, type GrassUniforms } from './material.ts'
import type { Interactor, ObjectRef } from './grass-settings.ts'

/**
 * Per-scene update subscriptions. Each field adds its own listener, so disposing one never restores
 * a sibling's captured callback chain (which used to stop or resurrect the other field's updates).
 */
const sceneHooks = new WeakMap<Object3D, { listeners: Set<() => void>; previous: Object3D['onBeforeRender'] }>()

export function subscribeScene(scene: Object3D, listener: () => void): () => void {
  let hook = sceneHooks.get(scene)
  if (!hook) {
    const previous = scene.onBeforeRender
    const listeners = new Set<() => void>()
    hook = { listeners, previous }
    sceneHooks.set(scene, hook)
    scene.onBeforeRender = (...args) => {
      previous.apply(scene, args)
      for (const l of listeners) l()
    }
  }
  hook.listeners.add(listener)
  return () => {
    const current = sceneHooks.get(scene)
    if (!current) return
    current.listeners.delete(listener)
    if (current.listeners.size === 0) {
      scene.onBeforeRender = current.previous
      sceneHooks.delete(scene)
    }
  }
}

/** Resolves an object or a ref to it; a missing ref, or one whose `current` is `null`, resolves to `null`. */
export function resolveObject<T extends Object3D>(value: ObjectRef<T> | null | undefined): T | null {
  if (value == null) return null
  return isObjectRef(value) ? value.current : value
}

function isObjectRef<T extends Object3D>(value: ObjectRef<T>): value is { current: T | null } {
  return 'current' in value
}

/** Resolves a terrain object-or-ref; height functions pass through untouched. */
export function resolveTerrain(terrain: Terrain | ObjectRef<Object3D> | undefined): Terrain | undefined {
  return typeof terrain === 'function' ? terrain : resolveObject(terrain) ?? undefined
}

/** The interactor's object, or `null` while a React ref is unmounted. */
export function interactorObject(it: Interactor | undefined): Object3D | null {
  return it ? resolveObject(it.object) : null
}

const _v = new Vector3()
const _t = new Vector3()

/** Copies interactor positions and radii into the shader slots (shared by grass and corn). */
export function writeInteractors(u: Pick<GrassUniforms, 'interactors' | 'interactorCount'>, list: Interactor[]) {
  const slots = u.interactors.array as Vector4[]
  u.interactorCount.value = Math.min(list.length, MAX_INTERACTORS)
  for (let i = 0; i < MAX_INTERACTORS; i++) {
    const it = list[i]
    const obj = interactorObject(it)
    if (!obj) {
      slots[i].set(0, 0, 0, 0)
      continue
    }
    obj.getWorldPosition(_v)
    slots[i].set(_v.x, _v.y, _v.z, it.radius)
  }
}

/** The first DirectionalLight in the scene `object` belongs to. */
export function findSun(object: Object3D): DirectionalLight | null {
  let root: Object3D = object
  while (root.parent) root = root.parent
  let found: DirectionalLight | null = null
  root.traverse((o) => {
    if (!found && (o as DirectionalLight).isDirectionalLight) found = o as DirectionalLight
  })
  return found
}

/** Points the translucency uniforms at `sun` (no-op without one). */
export function writeSun(u: Pick<GrassUniforms, 'sunDirection' | 'sunColor'>, sun: DirectionalLight | null) {
  if (!sun) return
  sun.updateWorldMatrix(true, false)
  sun.target.updateWorldMatrix(true, false)
  u.sunDirection.value.setFromMatrixPosition(sun.matrixWorld).sub(_t.setFromMatrixPosition(sun.target.matrixWorld)).normalize()
  u.sunColor.value.copy(sun.color).multiplyScalar(sun.intensity)
}
