import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PerspectiveCamera, Vector3 } from 'three/webgpu'
// world.ts directly: the threejs-biomes barrel also exports DOM/terrain code.
import { World } from '../../biomes/src/world.ts'
import { Ocean, createRingGeometry } from '../src/ocean.ts'
import { Lakes } from '../src/lakes.ts'
import { computeHydrology } from '../src/hydrology.ts'

function planetOcean() {
  const world = new World({ surface: 'sphere', radius: 6.4e6 })
  const frame = world.frameAt(30, 40)
  const camera = new PerspectiveCamera()
  // Floating origin at the camera's foot, 6.4 million metres from the planet centre.
  const ocean = new Ocean({ camera, world, origin: frame.toWorld(0, 0, 0) })
  const up = new Vector3(...frame.up), east = new Vector3(...frame.east)
  const place = (along: number, height: number) => {
    camera.position.copy(east).multiplyScalar(along).addScaledVector(up, height)
    camera.updateMatrixWorld()
  }
  return { ocean, place }
}

test('planet ocean: surface under a camera 3 m up, millions of metres from the planet centre', () => {
  const { ocean, place } = planetOcean()
  place(0, 3)
  ocean.update(0)
  assert.ok(Math.abs(ocean.stats.altitude - 3) < 1e-6)
  assert.ok(ocean.object.position.length() < 1e-6, 'grid sits at the render origin')
  assert.ok(ocean.stats.extent > 6000 && ocean.stats.extent < 12_000, 'clamped near the ~6 km horizon')
  const w = ocean.waterAt(0, 0, 0)
  assert.ok(Math.abs(w.depth - w.height) < 1e-6)
  assert.ok(Math.abs(w.height) < 3)
  assert.ok(w.normal[1] > 0.5)
})

test('planet ocean: waves under the camera stay continuous while re-anchoring over 30 km of travel', () => {
  const { ocean, place } = planetOcean()
  let jump = 0, reanchors = 0
  const anchorOf = () => JSON.stringify((ocean as any).anchor.point)
  for (let k = 0; k <= 300; k++) {
    place(k * 100, 3)
    const p = ocean.camera.position
    const before = k ? ocean.waterAt(p.x, 0, p.z).height : 0
    const anchor = anchorOf()
    ocean.update(0)
    if (k && anchor !== anchorOf()) reanchors++
    if (k) jump = Math.max(jump, Math.abs(ocean.waterAt(p.x, 0, p.z).height - before))
  }
  assert.ok(reanchors >= 2, 'travelled through re-anchors')
  assert.ok(jump < 1e-4, `wave under the camera jumped ${jump} m`)
})

test('ring grid: rings map onto rings under ×2 scaling', () => {
  const g = createRingGeometry(128, 1e4)
  const pos = g.attributes.position
  const radii: number[] = []
  for (let i = 1; i < pos.count; i += 128) radii.push(Math.hypot(pos.getX(i), pos.getZ(i)))
  let matched = 0
  for (const r of radii) if (radii.some((q) => Math.abs(q - 2 * r) < 1e-5 * r)) matched++
  assert.ok(matched >= radii.length - 15, 'all but the outermost octave of rings reappear at twice the radius')
})

test('lakes: one lake mesh at the spill level of a basin', () => {
  const bowl = (x: number, z: number) => 5 + Math.hypot(x, z) * 0.05 - (Math.hypot(x, z) < 50 ? 4 : 0)
  const hydrology = computeHydrology(bowl, { x: -200, z: -200, width: 400, depth: 400, cellSize: 4 }, { minLakeArea: 10 })
  assert.equal(hydrology.lakes.length, 1)
  const lakes = new Lakes({ hydrology })
  lakes.update(0.016)
  const mesh = lakes.object.children[0] as any
  const y = mesh.geometry.attributes.position.getY(0)
  assert.ok(Math.abs(y - hydrology.lakes[0].level) < 1e-4)
  lakes.dispose()
})
