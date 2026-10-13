import { DEFAULT_LAVA, DEFAULT_MPM, LAVA_DEFAULTS } from 'threejs-particles'
import type { PanelSpec } from './panel'

// Panel manifest of the MPM lava sandbox (mpm-lava.ts); checked by scripts/options-coverage.mjs.
export const panels: PanelSpec = {
  'threejs-particles': {
    MPMSolver: {
      defaults: { ...DEFAULT_MPM, materials: { lava: LAVA_DEFAULTS } },
      arrays: true,
      skip: {
        capacity: 'fixed at construction (the pool)',
        resolution: 'fixed at construction (grid buffers and compute passes)',
        cellSize: 'fixed at construction (particle spacing and mass)',
        origin: 'set by the sandbox to the volcanic site it finds',
        render: 'the solver\'s own drawing is hidden; MPMLava draws the lava',
      },
      ranges: {
        seed: [0, 1000, 1], substeps: [1, 16, 1], maxSubsteps: [1, 64, 1], cfl: [0.05, 1, 0.01], maxSpeed: [1, 20, 0.5], friction: [0, 3, 0.01],
        density: [1500, 3000, 10], youngs: [1e5, 5e6, 1e4], poisson: [0, 0.45, 0.01], viscosity: [10, 5000, 10], viscosityMax: [500, 10000, 100],
        activation: [0, 100000, 1000], eruption: [1300, 1500, 1], solidus: [1100, 1400, 1], crustRange: [5, 150, 1], yieldStress: [0, 50000, 100], meltYield: [0, 20000, 100],
        crackStrain: [0, 0.1, 0.001], emissivity: [0, 1, 0.01], convection: [0, 200, 1], groundConductance: [0, 2000, 10], airTemperature: [200, 400, 1],
        groundTemperature: [250, 800, 1], heatCapacity: [500, 2000, 10], skin: [0.001, 0.1, 0.001], diffusivity: [0, 0.01, 0.0001],
      },
    },
    MPMLava: {
      defaults: DEFAULT_LAVA,
      skip: { material: 'fixed at construction (the solver material that is lava)' },
      ranges: {
        radius: [0.5, 4, 0.05], smoothing: [0, 8, 0.1], iterations: [0, 4, 1], resolution: [0.25, 1, 0.05], intensity: [0, 10, 0.05], roughness: [0.02, 1, 0.01],
        ropes: [0, 1, 0.01], ropeLength: [0.01, 0.5, 0.005], cracks: [0, 1, 0.01], crackSize: [0.02, 1, 0.01], crackWidth: [0, 0.03, 0.001], clasts: [0, 1, 0.01],
      },
    },
  },
}
