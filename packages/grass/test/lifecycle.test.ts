import { test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Mesh, Object3D, PerspectiveCamera, type MeshPhysicalNodeMaterial, type InstancedBufferGeometry } from 'three/webgpu'
import type { Grass as GrassType, GrassLOD } from '../src/grass.ts'
import type { GrassMap as GrassMapType } from '../src/grass-map.ts'

const { Grass } = (await import('../src/grass.ts')) as { Grass: typeof GrassType }
const { GrassMap } = (await import('../src/grass-map.ts')) as { GrassMap: typeof GrassMapType }
const { neutralGrassMap } = (await import('../src/material.ts')) as {
  neutralGrassMap: { image: { data: Uint8Array } }
}

const camera = () => new PerspectiveCamera()
const flatten = (v: { x: number; y: number; z: number; w: number }) => [v.x, v.y, v.z, v.w]

afterEach(() => mock.timers.reset())

// ---------------------------------------------------------------- 01: map removal

test('removing a grass map rebinds the neutral texture', () => {
  const grass = new Grass({ camera: camera() })
  // A map whose centre texel is empty coverage: a bounds-only fix would still sample it.
  const map = new GrassMap({ center: [0, 0], size: 64, resolution: 64 })
  map.fill(1, 1)
  map.data[(32 * 64 + 32) * 4] = 0
  map.texture.needsUpdate = true

  grass.set({ grassMap: map })
  assert.equal(grass.uniforms.map.value, map.texture)

  grass.set({ grassMap: null })
  assert.equal(grass.uniforms.map.value, neutralGrassMap)
  assert.deepEqual(Array.from(neutralGrassMap.image.data), [255, 128, 0, 255])
  assert.deepEqual(flatten(grass.uniforms.mapBounds.value), [-1e6, -1e6, 2e6, 2e6])

  // Re-applying after removal behaves like a fresh field.
  grass.set({ grassMap: map })
  assert.equal(grass.uniforms.map.value, map.texture)
  assert.deepEqual(flatten(grass.uniforms.mapBounds.value), [map.minX, map.minZ, map.size, map.size])
})

test('removing a map that was never set stays neutral', () => {
  const grass = new Grass({ camera: camera() })
  grass.set({ grassMap: null })
  assert.equal(grass.uniforms.map.value, neutralGrassMap)
  assert.deepEqual(flatten(grass.uniforms.mapBounds.value), [-1e6, -1e6, 2e6, 2e6])
})

// ---------------------------------------------------------------- 02: scene subscriptions

function render(scene: Object3D, cam: PerspectiveCamera) {
  ;(scene.onBeforeRender as any)(null, scene, cam, null, null, null)
}

test('two fields on one scene update independently, disposing A leaves B running', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const scene = new Object3D()
  const cam = camera()
  const a = new Grass({ camera: cam, scene })
  const b = new Grass({ camera: cam, scene })
  let ca = 0
  let cb = 0
  a.update = () => { ca++ }
  b.update = () => { cb++ }

  render(scene, cam)
  assert.deepEqual([ca, cb], [1, 1])

  a.dispose()
  render(scene, cam)
  assert.deepEqual([ca, cb], [1, 2], 'B keeps updating and A never runs again')

  b.dispose()
  render(scene, cam)
  assert.deepEqual([ca, cb], [1, 2])
  mock.timers.reset()
})

test('disposing B first then A leaves no disposed field running', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const scene = new Object3D()
  const cam = camera()
  const a = new Grass({ camera: cam, scene })
  const b = new Grass({ camera: cam, scene })
  let ca = 0
  let cb = 0
  a.update = () => { ca++ }
  b.update = () => { cb++ }

  render(scene, cam)
  assert.deepEqual([ca, cb], [1, 1])

  b.dispose()
  render(scene, cam)
  assert.deepEqual([ca, cb], [2, 1], 'A keeps updating and B never runs again')

  a.dispose()
  render(scene, cam)
  assert.deepEqual([ca, cb], [2, 1])

  // A field created after disposal must not resurrect either disposed callback.
  const c = new Grass({ camera: cam, scene })
  let cc = 0
  c.update = () => { cc++ }
  render(scene, cam)
  assert.deepEqual([ca, cb, cc], [2, 1, 1])
  c.dispose()
})

// ---------------------------------------------------------------- 03: tile size changes

function visible(grass: GrassType) {
  return grass.object.children.filter((o) => o.visible).length
}

function settle(grass: GrassType) {
  // Stale tiles are extra meshes beyond the live grid; keep updating until none are left.
  for (let i = 0; i < 20; i++) grass.update(Infinity)
  assert.equal(grass.object.children.length, grass.stats.tiles, 'stale tiles were retired')
}

function assertNoOverlap(grass: GrassType) {
  const meshes = grass.object.children
  for (let i = 0; i < meshes.length; i++) {
    for (let j = i + 1; j < meshes.length; j++) {
      const a = meshes[i].position
      const b = meshes[j].position
      const ts = grass.settings.tileSize
      assert.ok(
        Math.abs(a.x - b.x) >= ts || Math.abs(a.z - b.z) >= ts,
        `tiles at ${a.x},${a.z} and ${b.x},${b.z} overlap`,
      )
    }
  }
}

test('a tileSize change keeps the old field visible until replacements exist', () => {
  const grass = new Grass({ camera: camera(), tileSize: 25, maxDistance: 30 })
  grass.update(Infinity)
  assert.ok(visible(grass) > 0, 'field starts visible')

  grass.set({ tileSize: 10 })
  assert.ok(visible(grass) > 0, 'old tiles stay visible immediately after the change')

  grass.update(0) // build at most one replacement tile
  assert.ok(visible(grass) > 0, 'old tiles stay visible while the new grid streams in')

  settle(grass)
  assert.equal(grass.object.children.length, grass.stats.tiles, 'no leftover tile meshes')
  assertNoOverlap(grass)
  for (const mesh of grass.object.children) {
    assert.ok(Math.abs(mesh.position.x % 10) < 1e-9, `x ${mesh.position.x} is on the new grid`)
    assert.ok(Math.abs(mesh.position.z % 10) < 1e-9, `z ${mesh.position.z} is on the new grid`)
  }
})

test('repeated tileSize changes do not pile up tile meshes', () => {
  const grass = new Grass({ camera: camera(), tileSize: 25, maxDistance: 30 })
  grass.update(Infinity)
  for (const tileSize of [10, 15, 8, 12]) {
    grass.set({ tileSize })
    grass.update(0)
    assert.ok(visible(grass) > 0, `field visible after changing to ${tileSize}`)
  }
  settle(grass)
  assert.equal(grass.object.children.length, grass.stats.tiles)
  assertNoOverlap(grass)
})

test('stale tiles are released when the new grid legitimately has no blades', () => {
  // Off-terrain: every candidate is rejected, so replacements never get instances.
  const grass = new Grass({ camera: camera(), tileSize: 25, maxDistance: 20, terrain: () => NaN })
  grass.update(Infinity)
  grass.set({ tileSize: 10 })
  for (let i = 0; i < 61; i++) grass.update(Infinity)
  assert.equal(grass.object.children.length, grass.stats.tiles, 'empty replacements do not pin the old grid forever')
})

// ---------------------------------------------------------------- 06: delayed disposal / material reuse

test('dispose retires geometries and material instead of freeing them synchronously', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const grass = new Grass({ camera: camera(), tileSize: 25, maxDistance: 30 })
  grass.update(Infinity)

  const tile = grass.object.children[0] as Mesh<InstancedBufferGeometry, MeshPhysicalNodeMaterial>
  const geometry = tile.geometry
  const material = tile.material
  let geometryDisposed = 0
  let materialDisposed = 0
  const disposeGeometry = geometry.dispose.bind(geometry)
  const disposeMaterial = material.dispose.bind(material)
  geometry.dispose = () => { geometryDisposed++; disposeGeometry() }
  material.dispose = () => { materialDisposed++; disposeMaterial() }

  grass.dispose()
  assert.equal(geometryDisposed, 0, 'geometry is not freed while a pipeline may reference it')
  assert.equal(materialDisposed, 0, 'material is retired, not disposed in place')

  mock.timers.tick(2000)
  assert.equal(geometryDisposed, 1, 'geometry is freed eventually')
  assert.equal(materialDisposed, 1, 'material is freed eventually')
  mock.timers.reset()
})

test('repeated create/dispose cycles free every geometry', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const counts: number[] = []
  const fields: { get count(): number }[] = []
  for (let i = 0; i < 3; i++) {
    const grass = new Grass({ camera: camera(), tileSize: 25, maxDistance: 30 })
    grass.update(Infinity)
    const geometry = (grass.object.children[0] as Mesh).geometry
    let count = 0
    const original = geometry.dispose.bind(geometry)
    geometry.dispose = () => { count++; original() }
    grass.dispose()
    counts.push(count)
    fields.push({ get count() { return count } })
  }
  assert.deepEqual(counts, [0, 0, 0])
  mock.timers.tick(2000)
  assert.deepEqual(fields.map((f) => f.count), [1, 1, 1])
})

test('only the draw type rebuilds the material; other layout changes keep it', () => {
  const grass = new Grass({ camera: camera() })
  grass.update(Infinity)
  const material = (grass.object.children[0] as Mesh).material
  const lods: GrassLOD[] = [
    { distance: 4, density: 0.9, segments: 5 },
    { distance: 12, density: 0.5, segments: 3 },
    { distance: 30, density: 0.2, segments: 2 },
    { distance: 75, density: 0.1, segments: 1 },
  ]

  grass.set({ lods })
  assert.equal((grass.object.children[0] as Mesh).material, material, 'LOD distances/densities are uniform-driven')
  assert.deepEqual(flatten(grass.uniforms.lodDistances.value), lods.map((l) => l.distance))
  assert.deepEqual(flatten(grass.uniforms.lodDensities.value), lods.map((l) => l.density))

  grass.set({ tileSize: 10, density: 300, maxSlope: 0.5 })
  assert.equal((grass.object.children[0] as Mesh).material, material, 'layout settings are uniform-driven, so they keep the material')

  grass.set({ type: 'billboards' })
  grass.update(Infinity)
  assert.notEqual((grass.object.children[0] as Mesh).material, material, 'a different draw type rebuilds the material')
})
