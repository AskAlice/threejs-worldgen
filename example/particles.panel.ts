import { DEFAULT_GRID, DEFAULT_PARTICLES, merge, resolveParticleOptions, type GridOptions, type ParticleInput } from 'threejs-particles'
import type { PanelClassSpec, PanelSpec } from './panel'

// Panel manifest of the particles sandbox (particles.ts); checked by scripts/options-coverage.mjs.
// A bonfire from three systems (blackbody flames, lit smoke with a plume grid, spark streaks); each system's settings
// are here so both sandboxes build the same fire, and each starts the panel at its own values (`target`).

/** Flames: blackbody tongues, additive. */
export const FLAMES: ParticleInput = {
  capacity: 1500, rate: 160, life: [0.6, 1.2],
  emitter: { shape: 'disc', size: [1.2, 0, 0], velocity: [0, 1.5, 0], spread: 0.5, temperature: [1750, 2100] },
  forces: { buoyancy: 0.3, ambientTemperature: 300, cooling: 1.2, wind: [2, 0, 0], drag: 2.5, turbulence: 6, turbulenceScale: 1.2, turbulenceSpeed: 1.5 },
  curves: { size: [0.6, 1, 0.8, 0.5], opacity: [0, 1, 0.8, 0], color: ['#ffffff'] },
  render: { shading: 'flame', blending: 'additive', size: 1.1, aspect: 2.6, stretch: 0.1, intensity: 0.45, blackbody: true, softness: 0.4 },
}
/** Smoke: lit, sorted, lifted by the grid's heat and shadowed by its density. */
export const SMOKE: ParticleInput = {
  capacity: 2500, rate: 45, life: [12, 20],
  emitter: { shape: 'disc', position: [0, 2, 0], size: [1, 0, 0], velocity: [0, 1.5, 0], spread: 0.4, temperature: [450, 520] },
  forces: { buoyancy: 0.25, ambientTemperature: 290, cooling: 0.08, wind: [2, 0, 0], windShear: 0.8, drag: 0.4, turbulence: 0.8, turbulenceScale: 6, turbulenceSpeed: 0.1, gridLift: 1.5 },
  curves: { size: [0.4, 1, 1.8, 2.6, 3.2], opacity: [0, 0.8, 0.7, 0.4, 0], color: ['#ffffff'] },
  render: { shading: 'smoke', blending: 'alpha', sort: true, size: 3.5, opacity: 0.7, softness: 1.5, albedo: ['#d6d3ce', '#3b322b'] },
}
/** Sparks: thin blackbody streaks. */
export const SPARKS: ParticleInput = {
  capacity: 1500, rate: 120, life: [1.5, 4],
  emitter: { shape: 'disc', size: [1, 0, 0], velocity: [0, 4, 0], spread: 3, temperature: [1300, 1600] },
  forces: { gravity: 3, buoyancy: 0.04, cooling: 0.4, wind: [2, 0, 0], drag: 0.8, turbulence: 8, turbulenceScale: 2, turbulenceSpeed: 0.8, gridLift: 1 },
  curves: { size: [1], opacity: [0, 1, 1, 0], color: ['#ffffff'] },
  render: { shading: 'spark', blending: 'additive', size: 0.03, stretch: 0.06, intensity: 5, blackbody: true },
}
/** The plume grid: heat (channel 0) rises and drifts with the wind; smoke density (channel 1) shadows the smoke. */
export const GRID: Partial<GridOptions> = { resolution: [24, 32, 24], min: [-30, 0, -30], size: [90, 120, 60], wind: [2, 0, 0], rise: 3 }

const fixed = 'fixed at construction (rebuilds the GPU buffers, passes or material); this fire is built around it'
const system = (input: ParticleInput): PanelClassSpec => ({
  defaults: DEFAULT_PARTICLES,
  target: resolveParticleOptions(input),
  arrays: true,
  skip: { capacity: fixed, shading: fixed, blending: fixed, sort: fixed, shadowSteps: fixed, lightSteps: fixed },
  choices: { shape: ['point', 'box', 'disc', 'sphere', 'sources'] },
  ranges: {
    seed: [0, 1000, 1], rate: [0, 1000, 1], maxPerFrame: [1, 4096, 1], life: [0.05, 30, 0.05], temperature: [250, 2500, 1], ambientTemperature: [250, 320, 1],
    detail: [0, 1, 0.01], anisotropy: [0, 0.95, 0.01], refraction: [0, 0.2, 0.001], opacity: [0, 1, 0.01], softness: [0, 4, 0.01],
  },
})

export const panels: PanelSpec = {
  'threejs-particles': {
    flames: system(FLAMES),
    smoke: system(SMOKE),
    sparks: system(SPARKS),
    grid: {
      defaults: DEFAULT_GRID,
      target: merge(structuredClone(DEFAULT_GRID), GRID),
      arrays: true,
      skip: { resolution: 'fixed at construction (a new resolution needs a new grid and new splat passes)' },
      ranges: { advect: [0, 1, 1], decay: [0, 2, 0.01], rise: [0, 20, 0.1] },
    },
  },
}

