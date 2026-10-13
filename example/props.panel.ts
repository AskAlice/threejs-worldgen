import { DEFAULT_DECORATE, DEFAULT_PROPS, DEFAULT_ROAD_SURFACE, type RoadSurfaceOptions } from 'threejs-props'
import type { PanelClassSpec, PanelSpec } from './panel'

// Panel manifest of the props sandboxes (props.ts and props-r3f.tsx); checked by scripts/options-coverage.mjs.
const weather = 'the weather folder sets it for every prop and road at once (and dims the light for night)'
const unit: [number, number, number] = [0, 1, 0.01]
const surface = (target: RoadSurfaceOptions): PanelClassSpec => ({
  defaults: DEFAULT_ROAD_SURFACE,
  target,
  skip: { states: weather, width: 'each road\'s own width (RoadPath `width`)' },
  choices: { surface: ['asphalt', 'cobblestone', 'gravel', 'dirt'], centreLine: ['none', 'dashed', 'solid', 'double'] },
  ranges: { lanes: [1, 3, 1], wear: unit, cracks: unit, patches: unit, ruts: unit, potholes: unit, slabSize: [0.3, 3, 0.01] },
})

export const panels: PanelSpec = {
  'threejs-props': {
    Props: {
      defaults: DEFAULT_PROPS,
      skip: {
        placements: 'planned by the sandbox: the gallery, decorateRoads (its own folder) and planPowerLine',
        states: weather,
        night: weather,
      },
      ranges: { heat: unit, lean: [0, 1.2, 0.01], sag: [0, 0.12, 0.001], iceSag: [0, 2, 0.01], segments: [1, 24, 1], thickness: [0.005, 0.1, 0.001], lampIntensity: [0, 20, 0.1], trafficCycle: [4, 60, 1] },
    },
    // The town roads (the junction square and its four arms) start as the avenue arms; the lane east of the gravel road is dirt.
    'RoadSurface (avenue)': surface({ ...structuredClone(DEFAULT_ROAD_SURFACE), width: 10, lanes: 2, centreLine: 'double' }),
    'RoadSurface (dirt lane)': surface({ ...structuredClone(DEFAULT_ROAD_SURFACE), surface: 'dirt', width: 3.2 }),
    decorateRoads: {
      defaults: DEFAULT_DECORATE,
      target: { ...structuredClone(DEFAULT_DECORATE), seed: 7 },
      choices: { style: ['auto', 'picket', 'rail', 'adobe', 'stone'], 'mailboxes/style': ['us', 'eu'], kind: ['power-pole', 'pylon'], variant: ['auto', 'cobra', 'post'] },
      ranges: { seed: [1, 100, 1] },
    },
  },
}

/** The classes props-r3f.tsx shows (with `useSpec`, from this manifest); checked the same way. */
export const r3f = { 'props-r3f.tsx': ['Props', 'RoadSurface (avenue)', 'RoadSurface (dirt lane)', 'decorateRoads'] }
