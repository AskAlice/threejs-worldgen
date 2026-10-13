import { DEFAULT_BIRD_FLOCKS, DEFAULT_FISH_SCHOOLS, Fish } from 'threejs-fauna'
import type { PanelClassSpec, PanelSpec } from './panel'

// Panel manifest of the fauna sandbox (fauna.ts); checked by scripts/options-coverage.mjs. The gallery shows one
// `Fish` class per species; `?world` shows `FishSchools` and `BirdFlocks` (the layers `Fauna` manages; its shared
// seed and states are each layer's `seed` and `states`).
const choices = { shape: ['forked', 'lunate', 'rounded', 'truncate'], water: ['fresh', 'sea', 'any'] }
const ranges = { rings: [4, 48, 1], sides: [4, 32, 1], finColumns: [2, 16, 1], count: [0, 20, 1], size: [1, 200, 1], hueVariation: [0, 1, 0.01] } satisfies PanelClassSpec['ranges']
const layer = {
  predators: 'objects the animals flee from (the camera here), not JSON',
  origin: 'floating origin, set by the sandbox (render-space zero at the river mouth)',
}

export const panels: PanelSpec = {
  'threejs-fauna': {
    Fish: {
      defaults: () => new Fish().settings, // the hero fish's defaults aren't exported as one object
      arrays: true,
      skip: {
        preset: 'each gallery fish is one preset; its species options are in its own folder',
        habitat: 'where schools spawn: only FishSchools reads it (edit it under ?world)',
        school: 'school size: only FishSchools reads it (edit it under ?world)',
      },
      choices,
      ranges: { ...ranges, width: [0.02, 0.4], bodyLength: [0.5, 0.95], nose: [0.3, 1.5], peduncle: [0.05, 0.6], squareness: [1.5, 4], density: [0, 30], amplitude: [0, 0.3] },
    },
    FishSchools: { defaults: DEFAULT_FISH_SCHOOLS, arrays: true, skip: layer, choices, ranges: { ...ranges, density: [0, 2000], gridResolution: [3, 9, 1], tileSize: [16, 256, 1], stepRate: [5, 120, 1] } },
    BirdFlocks: { defaults: DEFAULT_BIRD_FLOCKS, arrays: true, skip: layer, choices, ranges: { ...ranges, density: [0, 50], gridResolution: [3, 9, 1], tileSize: [64, 1024, 1], stepRate: [5, 120, 1] } },
  },
}
