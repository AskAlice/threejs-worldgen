import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_FLEET, FleetSim } from 'threejs-vehicles'
import { JUNCTION, junctionLoop } from './vehicles-rows.ts'

test('the gallery road train turns through the junction without its trailers mounting the inside kerb', () => {
  const { points, corner } = junctionLoop()
  const sim = new FleetSim({
    ...structuredClone(DEFAULT_FLEET), seed: 4,
    groups: [{ type: 'truck', count: 1, params: { trailers: 3, trailer: 'mixed', cab: 'conventional', sleeper: true }, speed: [9, 9], route: { kind: 'path', points, closed: true, smooth: 1 } }],
  })
  assert.equal(sim.count, 4)
  let closest = Infinity, turned = 0
  for (let step = 0; step < 2600; step++) { // two laps
    sim.step(0.05)
    for (let v = 1; v < sim.count; v++) {
      const m = sim.models[sim.model[v]], o = v * 8, yaw = sim.pose[o + 3]
      const fx = Math.sin(yaw), fz = Math.cos(yaw), axle = m.hitch!.axle!
      // Every wheel of the trailer's rear axle group, at the tyre's outer edge.
      for (const dz of [0.7, -0.7, -2]) for (const side of [-1, 1]) {
        const x = sim.pose[o] + fx * (axle + dz) + fz * side * (m.size[0] / 2), z = sim.pose[o + 2] + fz * (axle + dz) - fx * side * (m.size[0] / 2)
        if (x < corner[0] && z < corner[1]) { closest = Math.min(closest, Math.hypot(x - corner[0], z - corner[1])); turned++ }
      }
    }
  }
  assert.ok(turned > 100, 'the trailers went round the junction corner')
  assert.ok(closest > JUNCTION.kerb + 0.2, `a trailer wheel came within ${closest.toFixed(2)} m of the corner centre (kerb at ${JUNCTION.kerb} m)`)
})
