// Internal: instanced quad geometry and billboard maths shared by precipitation and fire rendering.
import { BufferAttribute, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry, Sphere, Vector3, type Node } from 'three/webgpu'
import { cameraPosition, cross, modelWorldMatrix, normalize, vec3, vec4 } from 'three/tsl'
import { mulberry32 } from 'threejs-biomes'

/**
 * An instanced unit quad (x in −0.5…0.5, y in `y0`…`y0 + 1`) with a per-instance `aRand` vec4 of seeded
 * random numbers and, optionally, a per-instance `aData` vec4 the CPU fills. One draw call for all instances.
 */
export function createQuadInstances(max: number, seed: number, y0 = 0, withData = false): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, y0, 0, 0.5, y0, 0, 0.5, y0 + 1, 0, -0.5, y0 + 1, 0]), 3))
  g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2))
  g.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1))
  const rand = new Float32Array(max * 4)
  const r = mulberry32(seed)
  for (let i = 0; i < rand.length; i++) rand[i] = r()
  g.setAttribute('aRand', new InstancedBufferAttribute(rand, 4))
  if (withData) {
    const data = new InstancedBufferAttribute(new Float32Array(max * 4), 4)
    data.setUsage(DynamicDrawUsage)
    g.setAttribute('aData', data)
  }
  g.instanceCount = 0
  g.boundingSphere = new Sphere(new Vector3(), 1e9) // particles are placed in the shader
  return g
}

/**
 * Local-space position of a quad corner around `center` (object space of an unrotated, unscaled
 * object). `axis` = the quad's long axis (e.g. up for flames, velocity for rain streaks); the quad
 * turns around it to face the camera. `corner` is the geometry position (x across, y along).
 */
export function axisBillboard(center: Node<'vec3'>, axis: Node<'vec3'>, corner: Node<'vec3'>, width: Node<'float'>, length: Node<'float'>): Node<'vec3'> {
  const world = modelWorldMatrix.mul(vec4(center, 1)).xyz
  const toCam = normalize(cameraPosition.sub(world))
  const side = normalize(cross(axis, toCam))
  return center.add(side.mul(corner.x.mul(width))).add(axis.mul(corner.y.mul(length)))
}

/** Like {@link axisBillboard} but fully camera-facing (snowflakes, smoke puffs). */
export function sphereBillboard(center: Node<'vec3'>, corner: Node<'vec3'>, size: Node<'float'>): Node<'vec3'> {
  const world = modelWorldMatrix.mul(vec4(center, 1)).xyz
  const toCam = normalize(cameraPosition.sub(world))
  const side = normalize(cross(vec3(0, 1, 0), toCam))
  const up = cross(toCam, side)
  return center.add(side.mul(corner.x.mul(size))).add(up.mul(corner.y.mul(size)))
}
