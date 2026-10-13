import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSample, type WorldSample } from 'threejs-biomes'
import { worldGround } from './world-ground.ts'

// A plane rising 1 m per 2 m along x, with water below x = 0; ground() records the slope it is given.
function plane() {
  let samples = 0
  const slopes: number[] = []
  const world = {
    sample(x: number, _z: number, out: WorldSample = createSample(8)) {
      samples++
      out.elevation = x / 2
      out.waterLevel = x < 0 ? 0 : NaN
      return out
    },
    ground(_s: WorldSample, slope: number, weights = new Float32Array(7), color = new Float32Array(3)) {
      slopes.push(slope)
      color.fill(0.5)
      return { weights, color }
    },
  }
  return { world, slopes, samples: () => samples }
}

test('worldGround samples each vertex once and colours it at the right slope', () => {
  const p = plane()
  const n = 8
  const { terrain, water } = worldGround(p.world as any, [10, 0], 40, n)
  const count = (n + 1) ** 2
  assert.equal(p.samples(), count)
  assert.equal(p.slopes.length, count)
  for (const s of p.slopes) assert.ok(Math.abs(s - 0.5) < 1e-6, `slope ${s}`) // edges too (one-sided differences)
  const pos = terrain.attributes.position, wpos = water.attributes.position
  for (let i = 0; i < count; i++) {
    const x = pos.getX(i)
    assert.ok(Math.abs(pos.getY(i) - x / 2) < 1e-4)
    assert.ok(Math.abs(wpos.getY(i) - (x < 0 ? 0 : x / 2 - 2)) < 1e-4) // no water: 2 m under the ground
  }
  assert.equal(terrain.attributes.color.count, count)
  assert.ok(terrain.attributes.normal && terrain.boundingSphere && water.boundingSphere)
})
