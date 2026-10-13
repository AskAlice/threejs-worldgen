import { test } from 'node:test'
import assert from 'node:assert/strict'
import { World } from 'threejs-biomes'
import { Weather, createWeatherSample } from '../src/weather.ts'
import { StateField } from '../src/state-field.ts'
import { InstanceStates } from '../src/instance-states.ts'
import { StormDamage, applyDamage } from '../src/damage.ts'

const HOUR = 3600

test('weather is a pure function of seed, position and time (scrubbing works)', () => {
  const a = new Weather({ seed: 'scrub' })
  const b = new Weather({ seed: 'scrub' })
  const times = [0, 5000, 123.4, 86400 * 3, 42, 5000]
  const forward = times.map((t) => ({ ...a.at(300, -200, t) }))
  const shuffled = [...times].reverse().map((t) => ({ ...b.at(300, -200, t) })).reverse()
  assert.deepEqual(forward, shuffled)
  assert.deepEqual(forward[1], forward[5])
  assert.notDeepEqual(a.at(0, 0, 0), new Weather({ seed: 'other' }).at(0, 0, 0))
})

const rainyHours = (moisture: number) => {
  const w = new Weather({ seed: 3, climate: { temperature: 18, moisture }, storms: { enabled: false } })
  const s = createWeatherSample()
  let wet = 0
  for (let h = 0; h < 24 * 60; h++) if (w.at(h * 517, h * -211, h * HOUR, s).precipitation > 0.1) wet++
  return wet
}

test('climate-aware: deserts rarely rain, rainforests often do', () => {
  const desert = rainyHours(0.04)
  const temperate = rainyHours(0.5)
  const rainforest = rainyHours(0.93)
  assert.ok(desert < temperate && temperate < rainforest, `${desert} < ${temperate} < ${rainforest}`)
  assert.ok(desert < 24 * 60 * 0.05)
  assert.ok(temperate < 24 * 60 * 0.2, `temperate rains ${temperate} of ${24 * 60} hours`) // real: ~10 %
  assert.ok(rainforest > 24 * 60 * 0.25)
})

test('cold precipitation is snow, warm is rain, sleet in between', () => {
  const at = (temperature: number) => {
    const w = new Weather({ seed: 9, climate: { temperature, moisture: 0.95 }, fronts: { coverage: 1 }, storms: { enabled: false } })
    return w.at(0, 0, 1000)
  }
  assert.equal(at(-8).type, 'snow')
  assert.equal(at(12).type, 'rain')
  assert.equal(at(1.25).type, 'sleet')
})

test('a world: colder mountains snow where the lowlands rain', () => {
  const world = new World({ seed: 4 })
  const w = new Weather({ seed: 4, fronts: { coverage: 1 } }, world)
  const low = w.climateAt(0, 0)
  assert.ok(Number.isFinite(low.temperature) && low.moisture >= 0 && low.moisture <= 1)
  const s = w.at(0, 0, 0)
  assert.ok(s.windSpeed > 0 && s.humidity >= 0 && s.humidity <= 1)
})

test('lightning strikes are deterministic, inside the box, and split windows agree', () => {
  const w = new Weather({ seed: 'thunder', climate: { temperature: 28, moisture: 0.9 }, storms: { chance: 1 } })
  const box = [-20000, -20000, 20000, 20000] as const
  const whole = w.strikes(...box, 0, 4 * HOUR)
  assert.ok(whole.length > 10, `got ${whole.length} strikes`)
  for (const s of whole) assert.ok(s.x >= box[0] && s.x <= box[2] && s.z >= box[1] && s.z <= box[3] && s.time >= 0 && s.time < 4 * HOUR)
  const parts = [...w.strikes(...box, 0, 1234.5), ...w.strikes(...box, 1234.5, 4 * HOUR)]
  assert.deepEqual(parts, whole)
  assert.deepEqual(new Weather({ seed: 'thunder', climate: { temperature: 28, moisture: 0.9 }, storms: { chance: 1 } }).strikes(...box, 0, 4 * HOUR), whole)
  // Too cold for thunderstorms.
  assert.equal(new Weather({ seed: 'thunder', climate: { temperature: -5, moisture: 0.9 }, storms: { chance: 1 } }).strikes(...box, 0, 4 * HOUR).length, 0)
})

test('surfaces get wet in rain and dry afterwards; snow accumulates in the cold', () => {
  const wet = new Weather({ seed: 2, climate: { temperature: 14, moisture: 1 }, fronts: { coverage: 1 }, storms: { enabled: false } })
  assert.ok(wet.surfaceAt(0, 0, 10 * HOUR).wetness > 0.8)
  const dry = new Weather({ seed: 2, climate: { temperature: 25, moisture: 0 }, fronts: { coverage: -1 }, storms: { enabled: false } })
  assert.equal(dry.surfaceAt(0, 0, 10 * HOUR).wetness, 0)
  const cold = new Weather({ seed: 2, climate: { temperature: -10, moisture: 1 }, fronts: { coverage: 1 }, storms: { enabled: false } })
  const s = cold.surfaceAt(0, 0, 10 * HOUR)
  assert.ok(s.snow > 0.8 && s.snowDepth > 0)
})

test('state field paints, samples, recentres and fills from the weather', () => {
  const field = new StateField({ size: 64, resolution: 16 })
  field.paint(0, 0, 10, { burn: 1 }, 'max', 0)
  assert.ok(Math.abs(field.value('burn', 0, 0) - 1) < 1e-6)
  assert.equal(field.value('burn', 30, 30), 0)
  assert.equal(field.value('burn', 500, 0), 0)
  field.set({ center: [16, 0] }) // shift by 4 texels: the scar stays where it was in the world
  assert.ok(Math.abs(field.value('burn', 0, 0) - 1) < 1e-6)
  const w = new Weather({ seed: 2, climate: { temperature: 14, moisture: 1 }, fronts: { coverage: 1 }, storms: { enabled: false } })
  while (!field.updateFromWeather(w, 10 * HOUR, 50));
  assert.ok(field.value('wetness', 5, 5) > 0.8)
  field.update()
  assert.ok((field.texture.image.data as Uint8Array).some((v) => v > 200))
})

test('damage: point impacts and storm gusts, deterministic per tick', () => {
  const field = new StateField({ size: 64, resolution: 16 })
  const states = new InstanceStates(3)
  const positions = new Float32Array([0, 0, 0, 3, 0, 0, 40, 0, 40])
  const hit = applyDamage({ field, instances: states, positions }, 0, 0, 5, 0.8)
  assert.equal(hit, 2)
  assert.ok(states.value(0, 'damage') > states.value(1, 'damage') && states.value(1, 'damage') > 0)
  assert.equal(states.value(2, 'damage'), 0)
  assert.ok(field.value('damage', 0, 0) > 0.6)

  const run = () => {
    const w = new Weather({ seed: 'gale', wind: { speed: 30, gustiness: 1 }, storms: { enabled: false } })
    const s = new InstanceStates(3)
    const storm = new StormDamage(w, { instances: s, positions }, { threshold: 25, interval: 10 })
    storm.update(0)
    storm.update(HOUR)
    return Array.from(s.array)
  }
  const a = run()
  assert.ok(a[3] > 0, 'gale force wind damages')
  assert.deepEqual(run(), a)
})
