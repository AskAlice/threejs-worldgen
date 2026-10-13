import { DEFAULT_MPM } from 'threejs-particles'
import type { PanelSpec } from './panel'

// Panel manifest of the MPM sandbox (mpm.ts); checked by scripts/options-coverage.mjs.
export const panels: PanelSpec = {
  'threejs-particles': {
    MPMSolver: {
      defaults: DEFAULT_MPM,
      arrays: true,
      skip: {
        capacity: 'fixed at construction; the sandbox sizes the pool to the block (`block` in the demo folder)',
        resolution: 'fixed at construction (grid buffers and compute passes)',
        cellSize: 'fixed at construction (particle spacing and mass)',
      },
      ranges: {
        seed: [0, 1000, 1], substeps: [1, 16, 1], maxSubsteps: [1, 64, 1], cfl: [0.05, 1, 0.01], maxSpeed: [1, 50, 0.5], friction: [0, 3, 0.01],
        density: [100, 3000, 10], youngs: [10000, 2000000, 1000], poisson: [0, 0.45, 0.01], viscosity: [0, 5000, 10],
        size: [0.5, 4, 0.05], strainScale: [0, 20, 0.1], opacity: [0, 1, 0.01],
      },
    },
  },
}
