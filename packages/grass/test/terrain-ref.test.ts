import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Mesh, PerspectiveCamera, PlaneGeometry, type InstancedBufferGeometry } from 'three/webgpu'
import { Grass } from '../src/index.ts'
import type { ObjectRef } from '../src/grass-settings.ts'

// Review follow-up 04: one rule for both entry points. A terrain ref that is null at construction grows on
// flat ground, is adopted on the next update() once its object mounts, and is dropped again if it unmounts.
// The React wrapper hands refs straight to the field and only calls update(), so vanilla Grass is the whole
// rule; these tests pin the behaviour the wrapper relies on.

const camera = () => new PerspectiveCamera()
const field = (terrain?: ObjectRef) => new Grass({ camera: camera(), terrain, tileSize: 20, maxDistance: 20, density: 10 })

/** A flat 40 m ground plane at height `y` (mounted: world matrix updated). */
function ground(y: number) {
  const mesh = new Mesh(new PlaneGeometry(40, 40))
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = y
  mesh.updateMatrixWorld(true)
  return mesh
}

/** Every drawn blade height, in world metres. */
function bladeHeights(grass: Grass) {
  const heights: number[] = []
  for (const mesh of grass.object.children) {
    const geometry = (mesh as Mesh<InstancedBufferGeometry>).geometry
    const offset = geometry.getAttribute('aOffset')
    if (!offset) continue
    for (let i = 0; i < geometry.instanceCount; i++) heights.push(offset.getY(i))
  }
  return heights
}

test('a terrain ref that is null at construction is adopted by both entry points', () => {
  const terrain: { current: ReturnType<typeof ground> | null } = { current: null }
  // Vanilla: the ref goes straight to the constructor.
  const vanilla = field(terrain)
  // React: the wrapper hands the same ref to Grass.create and calls update() from useFrame.
  const react = field(terrain)

  for (const grass of [vanilla, react]) {
    assert.equal(grass.sampleHeight(0, 0), 0, 'flat ground until the ref mounts')
    grass.update(0)
    assert.equal(grass.sampleHeight(0, 0), 0, 'still flat while the ref is empty')
  }

  terrain.current = ground(4)
  vanilla.update(Infinity)
  react.update(Infinity)
  for (const grass of [vanilla, react]) {
    assert.ok(Math.abs(grass.sampleHeight(0, 0) - 4) < 1e-3, 'the mounted terrain is used')
    const heights = bladeHeights(grass)
    assert.ok(heights.length > 0, 'blades are built on it')
    for (const y of heights) assert.ok(Math.abs(y - 4) < 1e-3, `blade at y ${y} sits on the new terrain`)
  }
  assert.deepEqual(bladeHeights(react), bladeHeights(vanilla), 'both entry points planted the same field')

  // Adopting is a one-off: later frames keep the tiles, so the React component never has to recreate the field.
  const tiles = [...vanilla.object.children]
  vanilla.update(Infinity)
  assert.deepEqual([...vanilla.object.children], tiles, 'an unchanged ref does not rebuild the field')

  // Unmounting the ref drops the field back to flat ground, the same rule in both entry points.
  terrain.current = null
  vanilla.update(0)
  react.update(0)
  for (const grass of [vanilla, react]) {
    assert.equal(grass.sampleHeight(0, 0), 0, 'the removed terrain is dropped')
    for (const y of bladeHeights(grass)) assert.ok(Math.abs(y) < 1e-3, `blade at y ${y} is not on the old terrain`)
  }
  vanilla.dispose()
  react.dispose()
})

test('plain object terrain and height functions behave exactly as before', () => {
  // A mounted object: usable immediately, no update needed.
  const object = field(ground(3))
  assert.ok(Math.abs(object.sampleHeight(5, -5) - 3) < 1e-3)

  // A height function: called directly, and a stable function never triggers an adoption.
  const height = (x: number, z: number) => x * 0.5 + z
  const fn = new Grass({ camera: camera(), terrain: height, tileSize: 20, maxDistance: 20, density: 10 })
  assert.equal(fn.sampleHeight(2, 3), 4)
  fn.update(Infinity)
  const tiles = [...fn.object.children]
  const blades = bladeHeights(fn)
  assert.ok(blades.length > 0)
  fn.update(Infinity)
  assert.deepEqual([...fn.object.children], tiles, 'no adoption, no rebuild')
  assert.deepEqual(bladeHeights(fn), blades, 'same blades on the next frame')
  for (const y of blades) assert.ok(Number.isFinite(y))

  // Swapping the source still rebuilds, as it always did.
  object.setTerrain(height)
  assert.equal(object.sampleHeight(2, 3), 4)
  object.dispose()
  fn.dispose()
})
