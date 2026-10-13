import { DEFAULT_OVERLAY, DEFAULT_POPULATION, DEFAULT_POPULATION_MAP } from 'threejs-population'
import type { PanelSpec } from './panel'

// Panel manifest of the population sandboxes (population.ts, and population-r3f.tsx for the classes in `r3f`);
// checked by scripts/options-coverage.mjs.
const unit: [number, number, number] = [0, 1, 0.01]
const modes = ['density', 'landUse', 'lights', 'habitability']

export const panels: PanelSpec = {
  'threejs-population': {
    Population: {
      defaults: DEFAULT_POPULATION,
      arrays: true,
      skip: { location: 'null = the world\'s own frame (this is a flat world); planets take a [lat, lon]' },
      choices: { avoid: Object.keys(DEFAULT_POPULATION.habitability.fertility) },
      ranges: { seed: [0, 1000, 1], ruralShare: unit, zipf: [0.5, 2, 0.01], levels: [1, 4, 1], jitter: unit, hamletChance: unit, farmsteadChance: unit, water: unit, center: [-20000, 20000, 1], neighbours: [1, 12, 1], smoothing: [0, 8, 1] },
    },
    PopulationOverlay: {
      defaults: DEFAULT_OVERLAY,
      arrays: true,
      // resolution: −1 = 'auto' in this panel.
      target: { ...DEFAULT_OVERLAY, resolution: -1 },
      skip: { origin: 'floating origin; this sandbox renders at world zero' },
      choices: { mode: modes },
      ranges: { resolution: [-1, 10, 1], coarsest: [0, 6, 1], opacity: unit, gap: [0, 0.5, 0.01], densityRamp: unit, lightRamp: unit, habitabilityRamp: unit },
    },
    renderPopulationMap: {
      defaults: DEFAULT_POPULATION_MAP,
      // hexResolution: −1 = the data's own.
      target: { mode: 'density', hexResolution: -1, settlements: true, networks: true },
      skip: {
        center: 'the map shows the population\'s whole region, over a world map of the same area',
        size: 'the map shows the population\'s whole region, over a world map of the same area',
        resolution: 'fixed by the 256 px map canvas',
      },
      choices: { mode: modes },
      ranges: { hexResolution: [-1, 10, 1] },
    },
  },
}

/** The classes population-r3f.tsx shows (with `useSpec`, from this manifest); checked the same way. */
export const r3f = { 'population-r3f.tsx': ['Population', 'PopulationOverlay'] }
