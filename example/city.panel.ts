import { ARCHITECTURES, DEFAULT_CITY, generatePopulation, planCities, SETTLEMENT_SIZES, type CitySite, type SettlementSize } from 'threejs-city'
import type { World } from 'threejs-biomes'
import type { PanelSpec } from './panel'

// Panel manifest of the city sandboxes (city.ts and city-r3f.tsx); checked by scripts/options-coverage.mjs.
const surfaces = ['asphalt', 'cobblestone', 'gravel', 'dirt']
const unit: [number, number, number] = [0, 1, 0.01]

/**
 * The settlements both sandboxes show, from a population with every class from hamlets to a metropolis: for a class,
 * the flattest of its eight largest settlements (else the smallest settlement of all).
 */
export function demoSites(world: World): (size: SettlementSize) => CitySite {
  const data = generatePopulation(world, { radius: 24_000, totalPopulation: 3_000_000, zipf: 1.5 })
  const sites = planCities(data) // largest first
  const slope = (s: CitySite) => data.cells[data.index.get(s.settlement.cell)!].slope
  return (size) => sites.filter((s) => s.size === size).slice(0, 8).sort((a, b) => slope(a) - slope(b))[0] ?? sites.at(-1)!
}

export const panels: PanelSpec = {
  'threejs-city': {
    City: {
      defaults: DEFAULT_CITY,
      arrays: true,
      skip: {
        center: 'set from a site of that class planCities finds (`demoSites`; keys 1–5 or `size`)',
        climate: 'null = read from the world at the centre; pick an `architecture` instead',
        oldTown: 'null (no old-town core) in every default size class; the panel cannot edit null',
      },
      choices: {
        size: [...SETTLEMENT_SIZES],
        style: ['auto', 'grid', 'radial', 'organic'],
        architecture: ['auto', ...Object.keys(ARCHITECTURES)],
        primary: surfaces, secondary: surfaces, minor: surfaces,
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
