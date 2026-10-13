import { DEFAULT_FLUID_SURFACE, DEFAULT_MPM, DEFAULT_PUDDLES, DEFAULT_SPLASHES } from 'threejs-particles'
import type { PanelSpec } from './panel'

// Panel manifest of the MPM water sandbox (mpm-water.ts); checked by scripts/options-coverage.mjs.
export const panels: PanelSpec = {
  'threejs-particles': {
    MPMSolver: {
      defaults: DEFAULT_MPM,
      arrays: true,
      skip: {
        capacity: 'fixed at construction (the pool for the dam break, the waterfall and the splashes)',
        resolution: 'fixed at construction (grid buffers and compute passes)',
        cellSize: 'fixed at construction (particle spacing and mass)',
        render: 'the particles are drawn by the FluidSurface (the solver\'s own sprites are hidden)',
      },
      ranges: {
        seed: [0, 1000, 1], substeps: [1, 16, 1], maxSubsteps: [1, 64, 1], cfl: [0.05, 1, 0.01], maxSpeed: [1, 20, 0.5], friction: [0, 2, 0.01],
        density: [500, 2000, 10], bulk: [2000, 100000, 500], gamma: [1, 7, 0.5], viscosity: [0, 5, 0.01], youngs: [10000, 2000000, 1000], poisson: [0, 0.45, 0.01],
      },
    },
    FluidSurface: {
      defaults: DEFAULT_FLUID_SURFACE,
      arrays: true,
      ranges: {
        radius: [0.5, 2, 0.05], tagRadius: [0.05, 1, 0.01], resolution: [0.25, 1, 0.05], smoothing: [0, 8, 0.1], iterations: [0, 4, 1], absorption: [0, 10, 0.01], turbidity: [0, 100, 0.1],
        foamSpeed: [0, 8, 0.1], foam: [0, 1, 0.01], foamDensity: [0, 200, 1], streaks: [0, 1, 0.01], spray: [0, 1, 0.01], mist: [0, 1, 0.005], mistSize: [0.5, 8, 0.1], shutter: [0, 0.1, 0.001], ior: [1, 2, 0.001], refraction: [0, 0.3, 0.005], roughness: [0.01, 0.5, 0.005], edge: [0.0005, 0.03, 0.0005],
      },
    },
    SplashEmitter: {
      defaults: DEFAULT_SPLASHES,
      arrays: true,
      skip: {
        center: 'follows the camera target (the near field)',
        material: 'the solver compiles only `water` here',
      },
      ranges: {
        seed: [0, 1000, 1], rain: [0, 100, 0.5], splashes: [0, 20, 0.1], radius: [0.2, 3, 0.05], particles: [1, 12, 1], speed: [0, 4, 0.05], puddleDepth: [0, 0.02, 0.0005], maxPerFrame: [0, 256, 1], soak: [0, 0.5, 0.005],
      },
    },
    PuddleField: {
      defaults: DEFAULT_PUDDLES,
      arrays: true,
      skip: {
        resolution: 'fixed at construction (sized to the solver domain)',
        cellSize: 'fixed at construction',
        origin: 'placed on the solver domain',
      },
      ranges: { flowSpeed: [0.005, 0.5, 0.005], infiltration: [0, 50, 0.1], evaporation: [0, 20, 0.1], wetTime: [1, 600, 1], dryTime: [1, 7200, 1] },
    },
  },
}
