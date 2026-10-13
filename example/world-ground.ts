import * as THREE from 'three/webgpu'
import { GROUND_MATERIALS, createSample, type World, type WorldSample } from 'threejs-biomes'

/**
 * Terrain and water geometry over a `size` m square around frame-local `[cx, cz]` (`n` × `n` quads), for the
 * sandboxes: terrain heights from the world, vertex colours from its ground mix at each vertex's slope, and a water
 * sheet at the water level (2 m under the ground where there is none). Each vertex is sampled once: the colours of a
 * row are worked out when the next row is in, from the slope by central differences.
 */
export function worldGround(world: Pick<World, 'sample' | 'ground'>, [cx, cz]: [number, number], size: number, n: number) {
  const terrain = new THREE.PlaneGeometry(size, size, n, n).rotateX(-Math.PI / 2).translate(cx, 0, cz)
  const water = terrain.clone()
  const pos = terrain.attributes.position, wpos = water.attributes.position
  const colors = new Float32Array(pos.count * 3)
  const row = n + 1, step = size / n
  const rows: WorldSample[][] = [0, 1].map(() => Array.from({ length: row }, () => createSample(32)))
  const weights = new Float32Array(GROUND_MATERIALS.length), rgb = new Float32Array(3), c = new THREE.Color()
  const h = (i: number, j: number) => pos.getY(j * row + i)
  const shade = (j: number, samples: WorldSample[]) => {
    for (let i = 0; i < row; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(n, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(n, j + 1)
      const dx = (h(i1, j) - h(i0, j)) / ((i1 - i0) * step), dz = (h(i, j1) - h(i, j0)) / ((j1 - j0) * step)
      world.ground(samples[i], Math.min(20, Math.hypot(dx, dz)), weights, rgb) // 20 ≈ the old normal.y ≥ 0.05 clamp
      c.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace).toArray(colors, (j * row + i) * 3)
    }
  }
  for (let j = 0; j <= n; j++) {
    const samples = rows[j & 1]
    for (let i = 0, k = j * row; i < row; i++, k++) {
      const s = world.sample(pos.getX(k), pos.getZ(k), samples[i])
      pos.setY(k, s.elevation)
      wpos.setY(k, s.waterLevel === s.waterLevel ? s.waterLevel : s.elevation - 2)
    }
    if (j > 0) shade(j - 1, rows[(j - 1) & 1])
  }
  shade(n, rows[n & 1])
  terrain.computeVertexNormals()
  terrain.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  terrain.computeBoundingSphere()
  water.computeBoundingSphere()
  return { terrain, water }
}
