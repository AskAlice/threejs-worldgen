import * as THREE from 'three/webgpu'
import type { HeightFn } from 'threejs-heightfield'

// The scene of the heightfield sandboxes (heightfield.ts and heightfield-r3f.tsx): the two sources threejs-heightfield
// supports, a height function and meshes baked into a heightfield.

/** The sampled square, metres. */
export const SIZE = 200

/** Rolling hills with a steep ridge along z at x = 30. */
export const hills: HeightFn = (x, z) => 8 * Math.sin(x * 0.045) * Math.cos(z * 0.038) + 3 * Math.sin((x + 2 * z) * 0.09) + 14 * Math.exp(-(((x - 30) / 12) ** 2))

/** The hills as a `size` m square mesh with `segments` quads a side. */
export function surface(size: number, segments: number): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(size, size, segments, segments).rotateX(-Math.PI / 2)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) pos.setY(i, hills(pos.getX(i), pos.getZ(i)))
  geo.computeVertexNormals()
  return geo
}

/** Marker colour from slope (rise / run): green flat → red at 45° and steeper; grey where there is no slope. */
export function slopeColor(slope: number | null, out: THREE.Color): THREE.Color {
  return slope === null ? out.set('#8a8a8a') : out.setHSL(0.33 * (1 - Math.min(1, slope)), 0.75, 0.45)
}
