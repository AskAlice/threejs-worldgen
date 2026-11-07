import { noise3, smoothstep } from './noise.ts'

/** Distances (× `detailDistance`) between which the mid detail band fades out. */
export const MID_DETAIL_BAND = { fadeStart: 3, fadeEnd: 14 } as const

/** Pixel footprint (fraction of a wavelength) below which a noise octave is drawn at full strength. */
export const OCTAVE_FULL = 0.25

/** Pixel footprint (fraction of a wavelength) at which a noise octave has faded to zero (Nyquist). */
export const OCTAVE_ZERO = 0.5

/** Far-detail octaves: wavelength in metres and relative amplitude (amplitudes sum to 1). */
export const FAR_DETAIL_OCTAVES = [
  { wavelength: 2400, amplitude: 0.5 },
  { wavelength: 760, amplitude: 0.3 },
  { wavelength: 240, amplitude: 0.2 }
] as const

/**
 * Period in metres of the far-detail coordinates. Chunk centres are reduced modulo it to stay in
 * float32 range, so the pattern repeats once per period; 256 km keeps the repeat out of an aerial
 * frame and is 64× the old 4 km detail period (which would have seamed every 4 km).
 */
export const FAR_DETAIL_PERIOD = 262_144

/** Seed of the CPU mirror of the far-detail field; the shader uses `mx_noise_float` instead. */
const FAR_DETAIL_SEED = 5171

/**
 * Weight of a noise octave of `wavelength` metres when one pixel covers `footprint` metres. Full
 * while the footprint is under a quarter wavelength, zero by half a wavelength, so octaves finer
 * than the pixels fade out instead of aliasing.
 */
export function octaveWeight(wavelength: number, footprint: number): number {
  return 1 - smoothstep(wavelength * OCTAVE_FULL, wavelength * OCTAVE_ZERO, footprint)
}

/** Opacity of the near (metre-scale) detail layer at `distance` metres from the camera. */
export function nearWeight(distance: number, detailDistance: number): number {
  return smoothstep(detailDistance, detailDistance * 0.25, distance)
}

/** Opacity of the mid (tens-to-hundreds of metres) detail layer at `distance` metres. */
export function midWeight(distance: number, detailDistance: number): number {
  return smoothstep(detailDistance * MID_DETAIL_BAND.fadeEnd, detailDistance * MID_DETAIL_BAND.fadeStart, distance)
}

/**
 * Opacity of the far (kilometre-scale) detail layer at `distance` metres: the complement of
 * {@link midWeight}, so the mid and far layers hand over without a gap or a double-strength overlap.
 */
export function farWeight(distance: number, detailDistance: number): number {
  return 1 - midWeight(distance, detailDistance)
}

/**
 * CPU mirror of the shader's far-detail field: the {@link FAR_DETAIL_OCTAVES} sum at a **world**
 * position, each octave attenuated by {@link octaveWeight} for the local pixel footprint. Takes
 * world coordinates only (never chunk-local ones), so the same point gives the same value from any
 * chunk. Returns roughly [-1, 1].
 */
export function farDetailAt(x: number, y: number, z: number, footprint: number): number {
  let sum = 0
  for (const o of FAR_DETAIL_OCTAVES) {
    const w = o.amplitude * octaveWeight(o.wavelength, footprint)
    if (w === 0) continue
    sum += w * noise3(FAR_DETAIL_SEED, x / o.wavelength, y / o.wavelength, z / o.wavelength)
  }
  return sum
}
