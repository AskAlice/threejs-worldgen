/**
 * The layers of an atmosphere — troposphere (weather and clouds), stratosphere (ozone), mesosphere,
 * thermosphere/ionosphere (airglow), exosphere — and the Kármán line that marks where space begins.
 * Altitudes are Earth's by default and can scale with the planet radius, so a small planet gets a
 * proportionally thin atmosphere that still looks Earth-like. Pure, no three.js.
 */
import type { AtmosphereOptions } from './scattering.ts'

/** Top altitude of each layer above the surface, metres (Earth values by default). Plain JSON. */
export interface AtmosphereLayers {
  /** Top of the troposphere (tropopause): weather and clouds live below. Earth ≈ 12 km. */
  troposphere: number
  /** Top of the stratosphere (stratopause), with the ozone layer. Earth ≈ 50 km. */
  stratosphere: number
  /** Top of the mesosphere (mesopause), where meteors burn up. Earth ≈ 85 km. */
  mesosphere: number
  /** The Kármán line: the edge of space. Above it the sky is black, stars are at full brightness and there is no haze. Earth = 100 km. */
  karman: number
  /** Top of the thermosphere / ionosphere (aurora and airglow live in its lower part). Earth ≈ 600 km. */
  thermosphere: number
  /** Outer edge of the exosphere. Earth ≈ 10 000 km. */
  exosphere: number
}

/** Earth's layers. */
export const DEFAULT_LAYERS: AtmosphereLayers = {
  troposphere: 12_000,
  stratosphere: 50_000,
  mesosphere: 85_000,
  karman: 100_000,
  thermosphere: 600_000,
  exosphere: 10_000_000,
}

/** Name of an atmosphere layer (or `'space'` beyond the exosphere, `'ground'` below the surface). */
export type LayerName = 'ground' | 'troposphere' | 'stratosphere' | 'mesosphere' | 'thermosphere' | 'exosphere' | 'space'

/** Earth's radius, metres: the reference for `scaleWithRadius`. */
export const EARTH_RADIUS = 6.371e6

/** Which layer an altitude (metres above the surface) is in. */
export function layerAt(altitude: number, layers: AtmosphereLayers = DEFAULT_LAYERS): LayerName {
  if (altitude < 0) return 'ground'
  if (altitude < layers.troposphere) return 'troposphere'
  if (altitude < layers.stratosphere) return 'stratosphere'
  if (altitude < layers.mesosphere) return 'mesosphere'
  if (altitude < layers.thermosphere) return 'thermosphere'
  if (altitude < layers.exosphere) return 'exosphere'
  return 'space'
}

/** Whether an altitude is above the Kármán line (in space). */
export const inSpace = (altitude: number, layers: AtmosphereLayers = DEFAULT_LAYERS) => altitude >= layers.karman

/**
 * Near and far clip planes for a camera `height` metres above the ground below it, on a planet of
 * `radius`, from an ant on a leaf to deep space. Near shrinks with height (never below `minNear`); far
 * reaches over the horizon to the top of the atmosphere, and out to `reach` metres from the planet
 * centre when that is farther (e.g. the moon's apogee). Pair it with `reversedDepthBuffer: true`.
 * @returns `[near, far]`.
 */
export function clipPlanes(height: number, radius: number, atmosphereHeight = 100_000, reach = 0, minNear = 0.001): [number, number] {
  const h = Math.max(0, height)
  const near = Math.max(minNear, h * 0.1)
  const horizon = Math.sqrt(h * (2 * radius + h)) + Math.sqrt(atmosphereHeight * (2 * radius + atmosphereHeight))
  const far = Math.max(near * 1e4, horizon, reach > 0 ? radius + h + reach : 0)
  return [near, far]
}

/** Altitude multiplier for a planet radius: R / Earth's radius when `scaleWithRadius`, else 1. */
export function altitudeScale(atmosphere: Pick<AtmosphereOptions, 'scaleWithRadius'>, planetRadius: number): number {
  return atmosphere.scaleWithRadius ? planetRadius / EARTH_RADIUS : 1
}

/**
 * The atmosphere as used for a planet of `planetRadius`: with `scaleWithRadius`, every altitude
 * (shell height, scale heights, ozone, layers) is scaled by R / Earth's radius and the scattering
 * coefficients by the inverse, so optical depths — and so the colours — stay Earth-like.
 */
export function resolveAtmosphere(a: AtmosphereOptions, planetRadius: number): AtmosphereOptions {
  const s = altitudeScale(a, planetRadius)
  if (s === 1) return a
  const L = a.layers
  return {
    ...a,
    height: a.height * s,
    rayleighScaleHeight: a.rayleighScaleHeight * s,
    mieScaleHeight: a.mieScaleHeight * s,
    ozoneCenter: a.ozoneCenter * s,
    ozoneWidth: a.ozoneWidth * s,
    rayleigh: [a.rayleigh[0] / s, a.rayleigh[1] / s, a.rayleigh[2] / s],
    mie: a.mie / s,
    mieAbsorption: a.mieAbsorption / s,
    ozone: [a.ozone[0] / s, a.ozone[1] / s, a.ozone[2] / s],
    layers: {
      troposphere: L.troposphere * s, stratosphere: L.stratosphere * s, mesosphere: L.mesosphere * s,
      karman: L.karman * s, thermosphere: L.thermosphere * s, exosphere: L.exosphere * s,
    },
  }
}
