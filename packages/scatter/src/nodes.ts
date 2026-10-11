import { Fn, attribute, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

/**
 * TSL: the per-instance `scatterParams` of a scattered object (x = yaw in radians, y = brightness tint, z = random
 * 0..1, w = 0). On geometry without that attribute (e.g. the same material on a single hand-placed mesh) it is the
 * neutral `vec4(0, 1, 0.5, 0)`, so materials can use it unconditionally.
 */
export function scatterParamsNode(): Node<'vec4'> {
  return Fn((builder: any) => (builder.geometry?.hasAttribute('scatterParams') ? attribute('scatterParams', 'vec4') : vec4(0, 1, 0.5, 0)))() as any
}
