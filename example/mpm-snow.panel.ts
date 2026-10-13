import { DEFAULT_MPM, DEFAULT_SNOW_SURFACE, SNOW } from 'threejs-particles'
import type { PanelSpec } from './panel'

// Panel manifest of the MPM snow sandboxes (mpm-snow.ts and mpm-snow-r3f.tsx); checked by scripts/options-coverage.mjs.
// The solver runs the `snow` material only, so its defaults are the core's with the snow parameters in place of the jelly.
export const panels: PanelSpec = {
  'threejs-particles': {
    MPMSolver: {
      defaults: { ...DEFAULT_MPM, materials: { snow: SNOW.defaults } },
      arrays: true,
      skip: {
        capacity: 'fixed at construction; sized to the scene\'s snow cover',
        resolution: 'fixed at construction (grid buffers and compute passes)',
        cellSize: 'fixed at construction (particle spacing and mass)',
        colors: 'the particles are hidden; MPMSnowSurface draws the snow',
        strainScale: 'the particles are hidden; MPMSnowSurface draws the snow',
        size: 'the particles are hidden; MPMSnowSurface draws the snow',
        opacity: 'the particles are hidden; MPMSnowSurface draws the snow',
      },
      ranges: {
        seed: [0, 1000, 1], substeps: [1, 16, 1], maxSubsteps: [1, 64, 1], cfl: [0.05, 1, 0.01], maxSpeed: [1, 30, 0.5], friction: [0, 3, 0.01],
        density: [50, 900, 10], youngs: [5000, 500000, 1000], poisson: [0, 0.45, 0.01], compression: [0.001, 0.2, 0.001], stretch: [0.001, 0.1, 0.0005],
        hardening: [0, 20, 0.1], maxHardening: [1, 20, 0.1], maxDensity: [100, 917, 1],
      },
    },
    MPMSnowSurface: {
      defaults: DEFAULT_SNOW_SURFACE,
      skip: { detail: 'fixed at construction (column grid and mesh)' },
      ranges: {
        edgeDepth: [0, 1.5, 0.01], debris: [0, 3, 0.05], relief: [0, 0.01, 0.0001], glints: [0, 0.2, 0.001], edgeCells: [0, 12, 0.5], minDepth: [0.001, 0.2, 0.001], packedJp: [0.2, 0.99, 0.01],
        roughness: [0, 1, 0.01], packedRoughness: [0, 1, 0.01], translucency: [0, 2, 0.01],
      },
    },
  },
}

/** The classes mpm-snow-r3f.tsx shows (with `useSpec`, from this manifest); checked the same way. */
export const r3f = { 'mpm-snow-r3f.tsx': ['MPMSolver', 'MPMSnowSurface'] }
