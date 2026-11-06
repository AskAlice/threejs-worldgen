import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Color } from 'three/webgpu'
import {
  DEFAULT_APPEARANCE,
  absorptionCoefficients,
  applyAppearance,
  behindSample,
  createWaterUniforms,
  transmittance
} from '../src/material.ts'
import { DEFAULT_LAKES } from '../src/lakes.ts'
import { DEFAULT_RIVERS } from '../src/rivers.ts'

const close = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps

test('absorption: every channel fades with path, red fastest', () => {
  const sigma = absorptionCoefficients(DEFAULT_APPEARANCE)
  assert.deepEqual(transmittance(sigma, 0), [1, 1, 1])

  const shallow = transmittance(sigma, 1)
  const deep = transmittance(sigma, 100)
  for (let c = 0; c < 3; c++) assert.ok(deep[c] < shallow[c] && shallow[c] < 1, `channel ${c} fades with depth`)
  assert.ok(shallow[0] < shallow[1] && shallow[1] < shallow[2], 'red is absorbed fastest')
  assert.ok(
    shallow.every((t) => t > 0.5),
    'the first metre keeps most of the bed'
  )
  assert.ok(
    deep.every((t) => t < 1e-3),
    'deep water keeps none of the bed'
  )

  // Halving absorption doubles the depth at which a channel is 63% absorbed (Beer–Lambert is exponential).
  const half = transmittance(
    sigma.map((s) => s / 2),
    2
  )
  for (let c = 0; c < 3; c++) assert.ok(close(half[c], shallow[c]))
})

test('absorption: ocean, lake and river defaults are per-channel and red-first', () => {
  for (const a of [DEFAULT_APPEARANCE, DEFAULT_LAKES, DEFAULT_RIVERS]) {
    const [r, g, b] = absorptionCoefficients(a)
    assert.ok(r > g && g > b && b > 0, `ordered coefficients ${r} > ${g} > ${b}`)
  }
  assert.deepEqual(
    absorptionCoefficients({ absorption: [-1, 0.5, 0.25] }),
    [0, 0.5, 0.25],
    'negative coefficients are clamped'
  )
})

test('depth rejection: foreground samples fall back, and never leak', () => {
  const viewZ = -10 // surface 10 m from the camera; farther geometry is more negative
  const dist = 10.1

  const refracted = behindSample(viewZ, -14, -30, dist)
  assert.equal(refracted.uv, 'refracted')
  assert.ok(close(refracted.path, dist * (14 / 10 - 1)), 'path to the refracted sample')

  // The offset crossed a silhouette: the refracted sample is nearer than the water, so use the pixel's own.
  const blocked = behindSample(viewZ, -9, -14, dist)
  assert.equal(blocked.uv, 'self')
  assert.ok(close(blocked.path, dist * (14 / 10 - 1)))

  // Both samples are foreground: nothing valid behind, so the body colour stands in.
  const none = behindSample(viewZ, -9, -8, dist)
  assert.equal(none.uv, 'none')
  assert.equal(none.path, Infinity)

  // No accepted sample ever yields a negative path (which would show a foreground object through the water).
  for (const ownZ of [-8, -9, -10.5]) {
    for (const refractedZ of [-8, -9, -14]) {
      const s = behindSample(viewZ, refractedZ, ownZ, dist)
      assert.ok(s.path >= 0)
      if (refractedZ < viewZ) assert.equal(s.uv, 'refracted', 'a valid refracted sample is always taken')
    }
  }
})

test('appearance: absorption and scatter drive the uniforms', () => {
  const u = createWaterUniforms()
  applyAppearance(u, { ...DEFAULT_APPEARANCE, absorption: [0.5, 0.2, 0.1], scatterColor: '#123456' })
  assert.deepEqual([u.absorption.value.x, u.absorption.value.y, u.absorption.value.z], [0.5, 0.2, 0.1])
  assert.ok(u.scatterColor.value.equals(new Color('#123456')))
})
