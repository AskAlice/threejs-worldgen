import { DEFAULT_LAKES, DEFAULT_OCEAN, DEFAULT_RIVERS } from 'threejs-water'
import type { PanelSpec } from './panel'

// Panel manifest of the water sandbox (water.ts); checked by scripts/options-coverage.mjs.
const unit: [number, number, number] = [0, 1, 0.01]
const absorption: [number, number, number] = [0, 2, 0.01]
const speed: [number, number, number] = [0, 8, 0.1]
/** The transform and inputs the sandbox owns rather than the panel; the rest of `WaterAppearance` is editable. */
const shared = {
  sun: "the scene's DirectionalLight (an Object input)",
  environment: 'a texture (an Object input); the sandbox reflects the sky colours',
  origin: 'the floating origin, kept at the demo coast so float32 stays small'
}
const oceanSkip = { ...shared, seaLevel: 'read from the world every frame', radius: 'read from the world every frame' }

export const panels: PanelSpec = {
  'threejs-water': {
    Ocean: {
      defaults: DEFAULT_OCEAN,
      arrays: true,
      skip: oceanSkip,
      ranges: {
        absorption,
        refraction: [0, 0.2, 0.001],
        roughness: [0.01, 1, 0.01],
        reflectivity: unit,
        environmentIntensity: [0, 3, 0.01],
        specular: [0, 4, 0.01],
        foamWidth: [0, 3, 0.01],
        foam: unit,
        detail: [0, 1.5, 0.01],
        detailScale: [0.05, 10, 0.05],
        detailSpeed: [0, 4, 0.01],
        count: [0, 16, 1],
        amplitude: [0, 4, 0.01],
        wavelength: [0.1, 200, 0.1],
        direction: [-1, 1, 0.01],
        spread: unit,
        choppiness: unit,
        speed: [0, 4, 0.01],
        seed: [0, 1000, 1],
        whitecaps: unit,
        segments: [16, 256, 1],
        range: [1e3, 1e8, 1e3],
        innerRadius: [0.001, 1, 0.001],
        altitudeFactor: [0.001, 0.2, 0.001],
        reanchorDistance: [100, 100_000, 100]
      }
    },
    Rivers: {
      defaults: DEFAULT_RIVERS,
      arrays: true,
      skip: shared,
      ranges: {
        absorption,
        refraction: [0, 0.2, 0.001],
        roughness: [0.01, 1, 0.01],
        reflectivity: unit,
        environmentIntensity: [0, 3, 0.01],
        specular: [0, 4, 0.01],
        foamWidth: [0, 3, 0.01],
        foam: unit,
        detail: [0, 1.5, 0.01],
        detailScale: [0.05, 10, 0.05],
        detailSpeed: [0, 4, 0.01],
        tileSize: [32, 512, 1],
        resolution: [8, 96, 1],
        maxDistance: [100, 20_000, 100],
        buildBudget: [0, 30, 0.5],
        expand: [0, 6, 1],
        surfaceOffset: [-2, 2, 0.01],
        flowPeriod: [0.2, 20, 0.1],
        rapids: [0, 10, 0.1],
        reframeDistance: [100, 100_000, 100],
        minStrength: unit,
        flowSpeed: speed,
        minFlowSpeed: speed,
        maxFlowSpeed: speed
      }
    },
    Lakes: {
      defaults: DEFAULT_LAKES,
      arrays: true,
      skip: shared,
      ranges: {
        absorption,
        refraction: [0, 0.2, 0.001],
        roughness: [0.01, 1, 0.01],
        reflectivity: unit,
        environmentIntensity: [0, 3, 0.01],
        specular: [0, 4, 0.01],
        foamWidth: [0, 3, 0.01],
        foam: unit,
        detail: [0, 1.5, 0.01],
        detailScale: [0.05, 10, 0.05],
        detailSpeed: [0, 4, 0.01],
        count: [0, 16, 1],
        amplitude: [0, 4, 0.01],
        wavelength: [0.1, 200, 0.1],
        direction: [-1, 1, 0.01],
        spread: unit,
        choppiness: unit,
        speed: [0, 4, 0.01],
        seed: [0, 1000, 1],
        whitecaps: unit,
        expand: [0, 6, 1],
        flowPeriod: [0.2, 20, 0.1],
        rapids: [0, 10, 0.1],
        flowSpeed: speed,
        minFlowSpeed: speed,
        maxFlowSpeed: speed
      }
    }
  }
}
