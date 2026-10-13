import { bakeHeightfield, createHeightSampler, raycastHeight, slopeAt } from 'threejs-heightfield'
import type { PanelSpec } from './panel'

// Panel manifest of the heightfield sandbox (heightfield.ts); checked by scripts/options-coverage.mjs.
// threejs-heightfield has no options object: its options are its functions' parameter defaults, so the check reads
// those from the functions and the sandbox edits `target` (starting at the same values).
export const panels: PanelSpec = {
  'threejs-heightfield': {
    createHeightSampler: {
      defaults: (params) => ({ ...params(createHeightSampler), ...params(bakeHeightfield) }),
      target: { maxResolution: 1024 },
      ranges: { maxResolution: [16, 2048, 1] },
    },
    slopeAt: { defaults: (params) => params(slopeAt), target: { e: 0.25 }, ranges: { e: [0.01, 4, 0.01] } },
    raycastHeight: { defaults: (params) => params(raycastHeight), target: { maxDistance: 2000, step: 0.5 }, ranges: { maxDistance: [10, 5000, 1], step: [0.05, 10, 0.05] } },
  },
}
