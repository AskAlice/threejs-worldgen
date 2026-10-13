/** Makes every property optional, recursively (arrays are replaced whole). */
export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T

/** Where new particles appear. */
export type EmitterShape = 'point' | 'box' | 'disc' | 'sphere' | 'sources'

/** Built-in shading. */
export type ParticleShading = 'unlit' | 'flame' | 'smoke' | 'spark' | 'haze'

/** Every setting of a {@link ParticleSystem}. Plain JSON. */
export interface ParticleOptions {
  /** Seed for every per-particle random number (spawn position, velocity, size, life). */
  seed: number | string
  /** Pool size: the most particles alive at once. Changing it rebuilds the GPU buffers. */
  capacity: number
  /**
   * Particles per second. With `emitter.shape: 'sources'` this is per unit of source weight, so a
   * bigger fire front spawns more. Throttled so the pool never runs out (`capacity / mean life`).
   */
  rate: number
  /** Most particles spawned in one update (caps catch-up after a long frame). */
  maxPerFrame: number
  /** Life range, seconds. */
  life: [number, number]
  /** Spawn shape and initial state. */
  emitter: {
    /** `point`, `box` (half extents `size`), `disc` (radius `size[0]`, on XZ), `sphere` (radius `size[0]`) or `sources` (see {@link threejs-particles!ParticleSystem.setSources}). */
    shape: EmitterShape
    /** Centre, local space, metres. */
    position: [number, number, number]
    /** Box half extents / disc and sphere radius in `[0]`; for `sources`, the jitter half extents around each source. */
    size: [number, number, number]
    /** Initial velocity, m/s. */
    velocity: [number, number, number]
    /** Random extra speed in a random direction, m/s. */
    spread: number
    /** Initial temperature range, kelvin (drives buoyancy, cooling and blackbody colour). */
    temperature: [number, number]
  }
  /** What moves particles. */
  forces: {
    /** Gravity, m/s² (down). */
    gravity: number
    /** Buoyancy: up-acceleration = 9.81 × buoyancy × (T − ambient) / ambient (Boussinesq). */
    buoyancy: number
    /** Ambient air temperature, kelvin. */
    ambientTemperature: number
    /** Exponential cooling towards ambient, 1/s. */
    cooling: number
    /** Air velocity, m/s; drag pulls particles towards it. */
    wind: [number, number, number]
    /** Wind grows by this share per 100 m above `emitter.position.y` (wind shear). */
    windShear: number
    /** Drag towards the air velocity, 1/s. */
    drag: number
    /** Curl-noise turbulence, m/s². */
    turbulence: number
    /** Eddy size, metres. */
    turbulenceScale: number
    /** How fast the eddies change, 1/s. */
    turbulenceSpeed: number
    /** With a grid: up-acceleration from the grid's channel 0 (heat h), `gridLift × h / (1 + h)` m/s². */
    gridLift: number
  }
  /** Shape over life (0 → 1), each an evenly spaced list of 1 to 8 keys. */
  curves: {
    /** Size multiplier. */
    size: number[]
    /** Opacity multiplier. */
    opacity: number[]
    /** Colour (`#rrggbb`); multiplied by the blackbody colour when `render.blackbody`. */
    color: string[]
  }
  /** How particles are drawn. */
  render: {
    /** Built-in shading: `unlit` sprites, noise-shaped `flame` tongues, lit volumetric `smoke`, thin `spark` streaks, refracting `haze`. */
    shading: ParticleShading
    /** `additive` (sparks), `alpha` (smoke) or `premultiplied` (flames: emit light and partly hide what is behind). */
    blending: 'additive' | 'alpha' | 'premultiplied'
    /** Base size (width), metres. */
    size: number
    /** Random size multiplier range. */
    sizeRandom: [number, number]
    /** Height / width of each quad. */
    aspect: number
    /** Stretch along velocity: extra length = speed × stretch (seconds). 0 = camera-facing quads. */
    stretch: number
    /** Brightness multiplier (HDR; > 1 blooms). */
    intensity: number
    /** Opacity multiplier. */
    opacity: number
    /** Colour from temperature (blackbody) instead of only the colour curve. */
    blackbody: boolean
    /** Soft depth fade against opaque geometry, metres (0 = hard). */
    softness: number
    /** Back-to-front GPU sort (alpha blending). */
    sort: boolean
    /** Per-pixel noise detail 0…1 (0 = flat sprites, cheapest). */
    detail: number
    /** Beyond this camera distance (metres) the per-pixel detail and self-shadow taps fade out. */
    detailDistance: number
    /** Smoke: per-pixel density taps towards the sun (0…4). Rebuilds the material. */
    shadowSteps: number
    /** Smoke with a grid: per-particle density steps towards the sun through the grid (0…8). Rebuilds the compute pass. */
    lightSteps: number
    /** Smoke: light absorbed per unit of density. */
    absorption: number
    /** Smoke: Henyey-Greenstein anisotropy (0 isotropic … 0.9 strongly forward). */
    anisotropy: number
    /** Smoke: extra forward-scattered light on thin edges when back-lit (silver lining). */
    silverLining: number
    /** Smoke albedo for clean (white) smoke and dirty (dark) smoke; particles mix by their source tint. */
    albedo: [string, string]
    /** Smoke: warm light from below (`#rrggbb`), scaled by how hot the particle still is. */
    glow: string
    /** Smoke: glow strength. */
    glowStrength: number
    /** Haze: screen-space refraction strength (fraction of the screen). */
    refraction: number
    /**
     * Smoke: height above the emitter (metres) where the plume caps into bright, dense, sharply billowing
     * pyrocumulus-like cloud. 0 = off.
     */
    capHeight: number
  }
}

/** Partial settings for {@link ParticleSystem}. */
export type ParticleInput = DeepPartial<ParticleOptions>

/** Default system: a soft column of warm smoke from a point. */
export const DEFAULT_PARTICLES: ParticleOptions = {
  seed: 1,
  capacity: 4096,
  rate: 200,
  maxPerFrame: 1024,
  life: [3, 6],
  emitter: { shape: 'point', position: [0, 0, 0], size: [1, 1, 1], velocity: [0, 1, 0], spread: 0.5, temperature: [600, 700] },
  forces: {
    gravity: 0, buoyancy: 0.15, ambientTemperature: 293, cooling: 0.3, wind: [1, 0, 0], windShear: 0.3, drag: 0.8,
    turbulence: 2, turbulenceScale: 6, turbulenceSpeed: 0.2, gridLift: 0,
  },
  curves: { size: [0.4, 1, 1.6], opacity: [0, 1, 0.6, 0], color: ['#ffffff'] },
  render: {
    shading: 'unlit', blending: 'alpha', size: 1, sizeRandom: [0.7, 1.3], aspect: 1, stretch: 0, intensity: 1, opacity: 1, blackbody: false,
    softness: 1, sort: false, detail: 1, detailDistance: 600, shadowSteps: 2, lightSteps: 4, absorption: 2.5, anisotropy: 0.4,
    silverLining: 0.5, albedo: ['#d8d6d2', '#2a2420'], glow: '#ff7a30', glowStrength: 3, refraction: 0.01, capHeight: 0,
  },
}

/** Curve keys used on the GPU (curves are resampled to this many evenly spaced keys). */
export const CURVE_KEYS = 8

const SHAPES: readonly EmitterShape[] = ['point', 'box', 'disc', 'sphere', 'sources']
const SHADINGS: readonly ParticleShading[] = ['unlit', 'flame', 'smoke', 'spark', 'haze']
const HEX = /^#[0-9a-f]{6}$/i

/** Deep-merges plain-JSON `input` into `target` (objects merge, arrays and everything else replace). */
export function merge<T>(target: T, input: unknown): T {
  if (!input || typeof input !== 'object') return target
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === undefined || k === '__proto__' || k === 'constructor' || k === 'prototype') continue
    const t = target as Record<string, unknown>
    const cur = t[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) t[k] = merge({ ...(cur as object) }, v)
    else t[k] = Array.isArray(v) ? structuredClone(v) : v
  }
  return target
}

/**
 * Fixes anything out of range in place and returns it: counts become positive integers, ranges are
 * ordered, enums fall back to their defaults, curves keep 1…8 finite keys and colours valid hex.
 * Called by {@link ParticleSystem} on every `set` and `reset`, so options straight from a GUI or a
 * URL are safe.
 */
export function sanitizeParticleOptions(o: ParticleOptions): ParticleOptions {
  const d = DEFAULT_PARTICLES
  const num = (v: unknown, def: number, lo = -Infinity, hi = Infinity) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def)
  const int = (v: unknown, def: number, lo: number, hi: number) => Math.round(num(v, def, lo, hi))
  const vec = (v: unknown, def: number[], lo = -Infinity, hi = Infinity) => def.map((x, i) => num(Array.isArray(v) ? v[i] : undefined, x, lo, hi))
  const range = (v: unknown, def: [number, number], lo = 0, hi = Infinity): [number, number] => {
    const [a, b] = vec(v, def, lo, hi)
    return a <= b ? [a, b] : [b, a]
  }
  const keys = (v: unknown, def: number[], lo = 0) => {
    const k = Array.isArray(v) ? v.filter((x) => typeof x === 'number' && Number.isFinite(x)).slice(0, CURVE_KEYS).map((x) => Math.max(lo, x)) : []
    return k.length ? k : [...def]
  }
  if (typeof o.seed !== 'number' && typeof o.seed !== 'string') o.seed = d.seed
  o.capacity = int(o.capacity, d.capacity, 1, 1 << 21)
  o.rate = num(o.rate, d.rate, 0)
  o.maxPerFrame = int(o.maxPerFrame, d.maxPerFrame, 1, o.capacity)
  o.life = range(o.life, d.life, 0.01)
  const e = (o.emitter ??= structuredClone(d.emitter))
  if (!SHAPES.includes(e.shape)) e.shape = d.emitter.shape
  e.position = vec(e.position, d.emitter.position) as [number, number, number]
  e.size = vec(e.size, d.emitter.size, 0) as [number, number, number]
  e.velocity = vec(e.velocity, d.emitter.velocity) as [number, number, number]
  e.spread = num(e.spread, d.emitter.spread, 0)
  e.temperature = range(e.temperature, d.emitter.temperature, 1)
  const f = (o.forces ??= structuredClone(d.forces))
  f.gravity = num(f.gravity, d.forces.gravity)
  f.buoyancy = num(f.buoyancy, d.forces.buoyancy)
  f.ambientTemperature = num(f.ambientTemperature, d.forces.ambientTemperature, 1)
  f.cooling = num(f.cooling, d.forces.cooling, 0)
  f.wind = vec(f.wind, d.forces.wind) as [number, number, number]
  f.windShear = num(f.windShear, d.forces.windShear, 0)
  f.drag = num(f.drag, d.forces.drag, 0)
  f.turbulence = num(f.turbulence, d.forces.turbulence, 0)
  f.turbulenceScale = num(f.turbulenceScale, d.forces.turbulenceScale, 0.01)
  f.turbulenceSpeed = num(f.turbulenceSpeed, d.forces.turbulenceSpeed, 0)
  f.gridLift = num(f.gridLift, d.forces.gridLift)
  const c = (o.curves ??= structuredClone(d.curves))
  c.size = keys(c.size, d.curves.size)
  c.opacity = keys(c.opacity, d.curves.opacity)
  const colors = Array.isArray(c.color) ? c.color.filter((x) => typeof x === 'string' && HEX.test(x)).slice(0, CURVE_KEYS) : []
  c.color = colors.length ? colors : [...d.curves.color]
  const r = (o.render ??= structuredClone(d.render))
  if (!SHADINGS.includes(r.shading)) r.shading = d.render.shading
  if (r.blending !== 'additive' && r.blending !== 'alpha' && r.blending !== 'premultiplied') r.blending = d.render.blending
  r.size = num(r.size, d.render.size, 0)
  r.sizeRandom = range(r.sizeRandom, d.render.sizeRandom, 0)
  r.aspect = num(r.aspect, d.render.aspect, 0.05, 100)
  r.stretch = num(r.stretch, d.render.stretch, 0)
  r.intensity = num(r.intensity, d.render.intensity, 0)
  r.opacity = num(r.opacity, d.render.opacity, 0)
  r.blackbody = typeof r.blackbody === 'boolean' ? r.blackbody : d.render.blackbody
  r.softness = num(r.softness, d.render.softness, 0)
  r.sort = typeof r.sort === 'boolean' ? r.sort : d.render.sort
  r.detail = num(r.detail, d.render.detail, 0, 1)
  r.detailDistance = num(r.detailDistance, d.render.detailDistance, 1)
  r.shadowSteps = int(r.shadowSteps, d.render.shadowSteps, 0, 4)
  r.lightSteps = int(r.lightSteps, d.render.lightSteps, 0, 8)
  r.absorption = num(r.absorption, d.render.absorption, 0)
  r.anisotropy = num(r.anisotropy, d.render.anisotropy, 0, 0.95)
  r.silverLining = num(r.silverLining, d.render.silverLining, 0)
  r.albedo = [0, 1].map((i) => (Array.isArray(r.albedo) && HEX.test(String(r.albedo[i])) ? r.albedo[i] : d.render.albedo[i])) as [string, string]
  if (typeof r.glow !== 'string' || !HEX.test(r.glow)) r.glow = d.render.glow
  r.glowStrength = num(r.glowStrength, d.render.glowStrength, 0)
  r.refraction = num(r.refraction, d.render.refraction, 0, 0.2)
  r.capHeight = num(r.capHeight, d.render.capHeight, 0)
  return o
}

/** `structuredClone(DEFAULT_PARTICLES)` merged with `input`, sanitized. */
export function resolveParticleOptions(input: unknown, defaults: ParticleOptions = DEFAULT_PARTICLES): ParticleOptions {
  return sanitizeParticleOptions(merge(structuredClone(defaults), input))
}

/** A string or number seed as a 32-bit unsigned integer (FNV-1a for strings). */
export function seedOf(seed: number | string): number {
  if (typeof seed === 'number') return (Math.floor(seed) >>> 0) ^ 0x9e3779b9
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193)
  return h >>> 0
}
