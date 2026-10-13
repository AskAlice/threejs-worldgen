import { ARCHITECTURES, DEFAULT_CITY } from 'threejs-city'
import type { PanelSpec } from './panel'

// Panel manifest of the city sandboxes (city.ts and city-r3f.tsx); checked by scripts/options-coverage.mjs.
const surfaces = ['asphalt', 'cobblestone', 'gravel', 'dirt']
const unit: [number, number, number] = [0, 1, 0.01]

export const panels: PanelSpec = {
  'threejs-city': {
    City: {
      defaults: DEFAULT_CITY,
      arrays: true,
      skip: {
        center: 'set from the settlement site findSettlements picks for the size (keys 1–4 or `size`)',
        climate: 'null = read from the world at the centre; pick an `architecture` instead',
        'sizes.hamlet.oldTown': 'null = no old-town core; the panel cannot edit null',
        'sizes.city.oldTown': 'null = no old-town core; the panel cannot edit null',
      },
      choices: {
        size: ['hamlet', 'village', 'town', 'city'],
        style: ['auto', 'grid', 'radial', 'organic'],
        architecture: ['auto', ...Object.keys(ARCHITECTURES)],
        primary: surfaces, secondary: surfaces, minor: surfaces, oldTown: surfaces,
      },
      ranges: {
        seed: [0, 1000, 1], radius: [0, 2500, 1], siteResolution: [0, 50, 1], arms: [0, 8, 1], delay: [0, 20, 1], gridAngle: [-3.14, 3.14, 0.01],
        lotJitter: unit, night: unit, lit: unit, wear: unit, variation: unit, through: unit, branchChance: unit,
        wetness: unit, snow: unit, burn: unit, damage: unit, buildBudget: [1, 50, 1],
      },
    },
  },
}

/** The classes city-r3f.tsx shows (with `useSpec`, from this manifest); checked the same way. */
export const r3f = { 'city-r3f.tsx': ['City'] }
