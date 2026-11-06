import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PerspectiveCamera } from 'three/webgpu'
import { createWaterMaterial, createWaterUniforms } from '../src/material.ts'
import { Ocean } from '../src/ocean.ts'
import { WaterPrepass } from '../src/prepass.ts'

test('prepass: half resolution by default, clamped, and small before the first update', () => {
  const camera = new PerspectiveCamera()
  const prepass = new WaterPrepass({ camera })
  assert.equal(prepass.resolutionScale, 0.5, 'documented half-resolution default')
  assert.equal(prepass.size.x, 1)
  assert.equal(prepass.target.width, 1)
  assert.equal(prepass.target.height, 1)
  assert.ok(prepass.target.depthTexture, 'the pass owns a depth texture')
  const big = new WaterPrepass({ camera, resolutionScale: 4 })
  const small = new WaterPrepass({ camera, resolutionScale: 0.01 })
  assert.equal(big.resolutionScale, 1)
  assert.equal(small.resolutionScale, 0.1)
  for (const p of [prepass, big, small]) p.dispose()
})

test('prepass: scene depth, view-space normals and colour are available as TSL nodes', () => {
  const camera = new PerspectiveCamera()
  const prepass = new WaterPrepass({ camera })
  for (const node of [prepass.viewZ(), prepass.normal(), prepass.colour()]) {
    assert.ok(node && (node as any).isNode, 'exposes a TSL node')
  }
  prepass.dispose()
})

test('water material: samples the prepass when given and falls back to the renderer readback without one', () => {
  const camera = new PerspectiveCamera()
  const prepass = new WaterPrepass({ camera })
  const withPrepass = createWaterMaterial(createWaterUniforms(), 'waves', null, prepass)
  assert.equal(withPrepass.userData.prepass, prepass)
  const fallback = createWaterMaterial(createWaterUniforms(), 'waves')
  assert.equal(fallback.userData.prepass, null)
  withPrepass.dispose()
  fallback.dispose()
  prepass.dispose()
})

test('ocean: attaching and dropping a prepass rebuilds the material and restores the fallback', () => {
  const camera = new PerspectiveCamera()
  const ocean = new Ocean({ camera })
  const prepass = new WaterPrepass({ camera })
  const before = ocean.object.material
  ocean.setPrepass(prepass)
  assert.notEqual(ocean.object.material, before, 'rebuilt the material')
  assert.equal(ocean.object.material.userData.prepass, prepass)
  ocean.setPrepass(prepass) // unchanged: no rebuild
  ocean.setPrepass(null)
  assert.equal(ocean.object.material.userData.prepass, null)
  ocean.dispose()
  prepass.dispose()
})
