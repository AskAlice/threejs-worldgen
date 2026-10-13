import { DEFAULT_CORN } from 'threejs-grass'
import type { PanelSpec } from './panel'

// Panel manifest of the corn sandboxes (corn.ts and corn-r3f.tsx); checked by scripts/options-coverage.mjs.
export const panels: PanelSpec = {
  'threejs-grass': {
    Corn: {
      defaults: DEFAULT_CORN,
      arrays: true,
      skip: {
        fields: 'field polygons come from the farm planner (threejs-city, #77); the sandbox edits row direction and spacing in its Field folder',
        interactors: 'objects (the sandbox tractor), not JSON',
        sun: 'a DirectionalLight (found in the scene), not JSON',
      },
      ranges: {
        plantSpacing: [0.1, 0.4, 0.01], seed: [1, 100, 1], growth: [0, 1, 0.01], stubbleHeight: [0.05, 0.6, 0.01], height: [1.5, 3.2, 0.01],
        heightVariation: [0, 0.4, 0.01], colorVariation: [0, 0.3, 0.01], patchiness: [0, 1, 0.01], translucency: [0, 1.5, 0.01], stiffness: [0.2, 3, 0.01],
        strength: [0, 1.5, 0.01], scale: [0.005, 0.2, 0.001], speed: [0, 3, 0.01], direction: [-1, 1, 0.01], interactionStrength: [0, 2, 0.01],
        flattenResolution: [0.2, 2, 0.05], chunkSize: [8, 48, 1], canopyResolution: [0.5, 4, 0.25], distance: [0, 300, 1], density: [0, 1, 0.01],
        shadowDistance: [0, 80, 1], buildBudget: [0.5, 16, 0.5],
      },
    },
  },
}

/** The classes corn-r3f.tsx shows (with `useSpec`, from this manifest); checked the same way. */
export const r3f = { 'corn-r3f.tsx': ['Corn'] }
