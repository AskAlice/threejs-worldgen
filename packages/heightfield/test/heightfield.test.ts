import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Mesh, PlaneGeometry, Vector3 } from 'three/webgpu'
import { bakeHeightfield, raycastHeight, slopeAt } from '../src/index.ts'

const surface = (x: number, z: number) => Math.sin(x * 0.1) * 3 + z * 0.2

function terrainMesh() {
  const geo = new PlaneGeometry(100, 100, 100, 100).rotateX(-Math.PI / 2)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) pos.setY(i, surface(pos.getX(i), pos.getZ(i)))
  const mesh = new Mesh(geo)
  mesh.position.set(10, 0, -5) // world transform must be honoured
  return mesh
}

test('baked mesh heights match the surface, NaN outside', () => {
  const h = bakeHeightfield(terrainMesh(), 512)
  for (const [x, z] of [
    [10, -5],
    [40, 20],
    [-30, -40],
    [55, 40]
  ]) {
    assert.ok(Math.abs(h(x, z) - surface(x - 10, z + 5)) < 0.05, `height at ${x},${z}`)
  }
  assert.ok(Number.isNaN(h(200, 0)))
  assert.ok(Math.abs(slopeAt(h, 10, 0) - Math.hypot(0.3, 0.2)) < 0.02)
})

test('ray-march lands on the terrain', () => {
  const h = bakeHeightfield(terrainMesh(), 512)
  const origin = new Vector3(0, 50, 0)
  const dir = new Vector3(0.3, -1, 0.2).normalize()
  const p = raycastHeight(h, origin, dir)!
  assert.ok(p, 'hit')
  assert.ok(Math.abs(p.y - surface(p.x - 10, p.z + 5)) < 0.05)
  assert.equal(raycastHeight(h, origin, new Vector3(0, 1, 0)), null)
})
