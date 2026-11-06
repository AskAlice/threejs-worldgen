import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PerspectiveCamera } from 'three/webgpu'
import { Grass, type GrassLOD } from '../src/index.ts'

type Vec4 = [number, number, number, number]

/** Independent transcription of the shader curve in src/material.ts: four LOD levels, linearly
 *  interpolated between consecutive distances, clamped outside the first and last. */
function shaderDensity(dist: number, d: Vec4, k: Vec4) {
  const seg = (a: number, b: number) => Math.min(1, Math.max(0, (dist - a) / Math.max(b - a, 1e-3)))
  const mix = (a: number, b: number, t: number) => a + (b - a) * t
  return mix(mix(mix(k[0], k[1], seg(d[0], d[1])), k[2], seg(d[1], d[2])), k[3], seg(d[2], d[3]))
}

const field = (lods?: GrassLOD[]) => new Grass({ camera: new PerspectiveCamera(), lods })

const near = (a: number, b: number) => Math.abs(a - b) < 1e-12

test('lod density: CPU densityAt matches the shader curve at every LOD distance and segment midpoint', () => {
  const lods: GrassLOD[] = [
    { distance: 5, density: 0.9, segments: 5 },
    { distance: 18, density: 0.4, segments: 3 },
    { distance: 41, density: 0.12, segments: 2 },
    { distance: 90, density: 0.02, segments: 1 },
  ]
  const d: Vec4 = [5, 18, 41, 90]
  const k: Vec4 = [0.9, 0.4, 0.12, 0.02]
  const grass = field(lods)

  // The GPU reads the same thresholds and densities as the CPU curve.
  assert.deepEqual(grass.uniforms.lodDistances.value.toArray(), [...d])
  assert.deepEqual(grass.uniforms.lodDensities.value.toArray(), [...k])

  // Each LOD distance, one midpoint per segment, and the clamped ends.
  const samples = [0, d[0], (d[0] + d[1]) / 2, d[1], (d[1] + d[2]) / 2, d[2], (d[2] + d[3]) / 2, d[3], d[3] + 110]
  for (const dist of samples) assert.ok(near(grass.densityAt(dist), shaderDensity(dist, d, k)), `density at ${dist}`)

  // The control points are hit exactly (within float error).
  for (let i = 0; i < 4; i++) assert.ok(near(grass.densityAt(d[i]), k[i]), `control point ${i}`)
  grass.dispose()
})

test('lod density: documented default LODs also follow the formula (the preset values are not pinned)', () => {
  const grass = field()
  const lods = grass.settings.lods
  assert.equal(lods.length, 4)
  const d = lods.map((l) => l.distance) as Vec4
  const k = lods.map((l) => l.density) as Vec4
  for (let i = 0; i < 3; i++) {
    for (const dist of [d[i], (d[i] + d[i + 1]) / 2, d[i + 1]]) {
      assert.ok(near(grass.densityAt(dist), shaderDensity(dist, d, k)), `default density at ${dist}`)
    }
  }
  grass.dispose()
})

test('lod density: material.ts still implements the pinned four-level curve', () => {
  // A text pin: the CPU values alone cannot catch the shader drifting away from this formula.
  // shortcut: pins source text, not evaluated behaviour; upgrade if the shader becomes runnable headless.
  const src = readFileSync(new URL('../src/material.ts', import.meta.url), 'utf8').replace(/\s+/g, ' ')
  for (const line of [
    'const seg = (a: any, b: any) => dist.sub(a).div(max(b.sub(a), 1e-3)).clamp(0, 1)',
    'const density = mix(mix(mix(k.x, k.y, seg(d.x, d.y)), k.z, seg(d.y, d.z)), k.w, seg(d.z, d.w))',
  ]) assert.ok(src.includes(line.replace(/\s+/g, ' ')), `material.ts lost: ${line}`)
})
