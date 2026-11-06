import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fresnel, screenEdgeFade, screenReflectionWeight } from '../src/material.ts'

test('fresnel: reflectivity head-on, 1 at grazing, monotonic in between', () => {
  assert.equal(fresnel(1, 0.02), 0.02, 'looking straight down gives F0')
  assert.equal(fresnel(0, 0.02), 1, 'grazing incidence is a perfect mirror')
  assert.ok(Math.abs(fresnel(0.5, 0.02) - 0.050625) < 1e-12, 'Schlick at 60° off normal')
  assert.equal(fresnel(-1, 0.02), 1, 'clamped below 0')
  assert.equal(fresnel(2, 0.02), 0.02, 'clamped above 1')

  let previous = 1
  for (let i = 0; i <= 100; i++) {
    const f = fresnel(i / 100, 0.02)
    assert.ok(f <= previous + 1e-12, `Fresnel must not rise with N·V (at ${i / 100})`)
    previous = f
  }
  const water = fresnel(0.1, 0.02)
  assert.ok(water > 0.5 && water < 1, 'near-grazing water reflects most of what it sees')
})

test('screen reflection weight: sharp on calm water, environment on rough water', () => {
  assert.equal(screenReflectionWeight(0.06), 1, 'the default calm surface traces the full reflection')
  assert.equal(screenReflectionWeight(0.02), 1, 'mirror-calm')
  assert.equal(screenReflectionWeight(0.45), 0, 'rough water is all environment')
  assert.equal(screenReflectionWeight(1), 0, 'clamped at 0 above the threshold')

  const mid = screenReflectionWeight(0.2)
  assert.ok(mid > 0 && mid < 1, 'transitions between the two')
  let previous = 1
  for (let i = 0; i <= 100; i++) {
    const w = screenReflectionWeight(i / 100)
    assert.ok(w <= previous + 1e-12, `weight must not rise with roughness (at ${i / 100})`)
    assert.ok(w >= 0 && w <= 1)
    previous = w
  }
})

test('screen edge fade: full inside the frame, 0 at and beyond its border', () => {
  assert.equal(screenEdgeFade(0.5, 0.5), 1, 'the middle of the frame is untouched')
  assert.equal(screenEdgeFade(0, 0.5), 0, 'left border')
  assert.equal(screenEdgeFade(1, 0.5), 0, 'right border')
  assert.equal(screenEdgeFade(0.5, 0), 0, 'bottom border')
  assert.equal(screenEdgeFade(0.5, 1), 0, 'top border')
  assert.equal(screenEdgeFade(-0.2, 0.5), 0, 'outside the frame')
  assert.ok(Math.abs(screenEdgeFade(0.04, 0.5) - 0.5) < 1e-12, 'halfway through the default 0.08 band')
  assert.ok(Math.abs(screenEdgeFade(0.5, 0.02, 0.08) - 0.15625) < 1e-12, 'quarter of the way through')

  let previous = 0
  for (let i = 0; i <= 50; i++) {
    const f = screenEdgeFade(i / 100, 0.5)
    assert.ok(f >= previous - 1e-12, 'fade grows towards the middle')
    previous = f
  }
})

test('fallback selection: a hit at the frame edge or on rough water reads the environment', () => {
  // What the shader does: traced = hit ? screenEdgeFade(hitUv) : 0, then × (1 − rough fade).
  const weight = (hit: boolean, u: number, v: number, roughness: number) =>
    (hit ? screenEdgeFade(u, v) : 0) * screenReflectionWeight(roughness)

  assert.equal(weight(true, 0.5, 0.5, 0.06), 1, 'a calm hit in the frame is fully traced')
  assert.equal(weight(false, 0.5, 0.5, 0.06), 0, 'a miss is fully environment')
  assert.equal(weight(true, 0, 0.5, 0.06), 0, 'a hit on the border is environment')
  assert.equal(weight(true, 0.5, 0.5, 0.6), 0, 'a hit on rough water is environment')
  assert.ok(weight(true, 0.52, 0.5, 0.06) > 0.9, 'just inside the border still traces')
  assert.ok(weight(true, 0.5, 0.5, 0.2) > 0.5, 'slightly rough water still traces mostly')
})
