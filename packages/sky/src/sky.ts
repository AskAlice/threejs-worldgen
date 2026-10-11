/**
 * `Sky`: one object that runs the whole sky — clock, star system, observer, atmosphere dome with sun
 * and moon, stars and Milky Way, shooting stars, and the day/night lighting (sun, moonlight, IBL, fog,
 * exposure, `night`).
 */
import { Group, Vector3, type Camera, type Scene, type Texture, type WebGPURenderer } from 'three/webgpu'
import { applyAtmosphere, applySkyState, createSkyDome, createSkyUniforms, type SkyUniforms } from './atmosphere.ts'
import { StarSystem, type SystemInput } from './bodies.ts'
import { DEFAULT_LIGHTING, DayNight, computeLighting, type Lighting, type LightingOptions } from './day-night.ts'
import { DEFAULT_OBSERVER, defaultSkyState, observe, sunTimes, type ObserverOptions, type SkyState, type SunTimes } from './observer.ts'
import { DEFAULT_ATMOSPHERE, type AtmosphereOptions } from './scattering.ts'
import { Clouds, DEFAULT_CLOUDS, type CloudOptions } from './clouds.ts'
import { altitudeScale, clipPlanes, layerAt, resolveAtmosphere, type AtmosphereLayers, type LayerName } from './layers.ts'
import { DEFAULT_NIGHT_LIGHTS, applyNightLights, bakeNightLights, setNightLightsTexture, type LightsField, type NightLightsOptions } from './night-lights.ts'
import { DEFAULT_SHOOTING_STARS, ShootingStars, type ShootingStarsOptions } from './shooting-stars.ts'
import { AltitudeShells, DEFAULT_SHELLS, resolveShells, type ResolvedShell, type ShellsOptions } from './shells.ts'
import { DEFAULT_STARS, Stars, type StarsOptions } from './stars.ts'
import { DEFAULT_CLOCK, SkyClock, toDate, type ClockOptions } from './time.ts'
import { kelvinToRgb, merge, type DeepPartial, type Vec3 } from './util.ts'

/** Sun disc settings. Plain JSON. */
export interface SunDiscOptions {
  /** Disc radiance (HDR; what bloom picks up). */
  discIntensity: number
  /** Multiplier on the disc's true angular size (1 = real). */
  discScale: number
}

/** Moon settings. Plain JSON. */
export interface MoonDiscOptions {
  /** Multiplier on the sunlit disc's brightness. */
  brightness: number
  /** Multiplier on the disc's true angular size (1 = real). */
  discScale: number
  /** Earthshine on the dark side, relative (0 = none). */
  earthshine: number
  /** How much moonlight brightens the night sky, relative to the sun (physically ~2e-6; artistic default 0.02). */
  skyGlow: number
}

/** Every `Sky` setting. Plain JSON: save it, send it to a worker, bind it to a GUI. */
export interface SkySettings {
  /** Seeds the stars, meteors and procedural planets (unless they set their own `seed`). */
  seed: number | string
  /** Time: date, time scale, day length, pause. */
  clock: ClockOptions
  /** The star system (star, home planet, moon, procedural planets). */
  system: SystemInput
  /** Where the observer is and how render space maps onto the planet. */
  observer: ObserverOptions
  /** Atmosphere physics. */
  atmosphere: AtmosphereOptions
  /** Sun disc. */
  sun: SunDiscOptions
  /** Moon disc and moonlit sky. */
  moon: MoonDiscOptions
  /** Star field and Milky Way. */
  stars: StarsOptions
  /** Meteors. */
  shootingStars: ShootingStarsOptions
  /** Lights, environment, fog and exposure. */
  lighting: LightingOptions
  /** Sparse Gaussian clouds. */
  clouds: CloudOptions
  /** City lights on the night side, seen from altitude. */
  nightLights: NightLightsOptions
  /** Labelled altitude shells (troposphere, ionosphere, Kármán line, apogee). Off by default. */
  shells: ShellsOptions
}

/** Partial settings accepted by {@link Sky.create}, {@link Sky.set} and `<Sky>`. Nested objects merge. */
export type SkyInput = DeepPartial<Omit<SkySettings, 'system'>> & {
  /** Star system overrides. */
  system?: SystemInput
}

/** Default settings. */
export const DEFAULT_SKY: SkySettings = {
  seed: 1,
  clock: DEFAULT_CLOCK,
  system: {},
  observer: DEFAULT_OBSERVER,
  atmosphere: DEFAULT_ATMOSPHERE,
  sun: { discIntensity: 60, discScale: 1 },
  moon: { brightness: 1, discScale: 1, earthshine: 0.3, skyGlow: 0.02 },
  stars: DEFAULT_STARS,
  shootingStars: DEFAULT_SHOOTING_STARS,
  lighting: DEFAULT_LIGHTING,
  clouds: DEFAULT_CLOUDS,
  nightLights: DEFAULT_NIGHT_LIGHTS,
  shells: DEFAULT_SHELLS,
}

/**
 * The parts of a `threejs-biomes` `World` the sky reads (duck-typed, so there is no dependency). A
 * planet world sets the home planet's radius and, in the local frame, the observer's latitude/longitude.
 */
export interface WorldLike {
  /** World options. */
  options: {
    /** `'sphere'` for planets. */
    surface: string
    /** Planet radius, metres. */
    radius: number
    /** [latitude, longitude] of the local frame origin, degrees. */
    origin: [number, number]
  }
  /** Change subscription; returns an unsubscribe function. */
  onChange?: (listener: () => void) => () => void
}

/** Options for {@link Sky.create}: settings plus the objects it works with. */
export interface SkyOptions extends SkyInput {
  /** WebGPURenderer: needed for the environment map and auto exposure. Initialised if needed. */
  renderer?: WebGPURenderer
  /** Scene: the sky is added to it and drives its `environment` and `fog`. */
  scene?: Scene
  /** Camera whose position places the observer (planet frame) and the lights. */
  camera?: Camera
  /** A `threejs-biomes` World (or anything shaped like {@link WorldLike}). */
  world?: WorldLike
}

/**
 * A complete, physically based sky from the ground to orbit: Keplerian sun and moon, single-scattering
 * atmosphere, moon phases, stars and Milky Way turning with sidereal time, shooting stars, and the
 * lights, environment and fog that go with them.
 *
 * @example
 * ```ts
 * const sky = await Sky.create({ renderer, scene, camera, clock: { date: '2026-08-12T21:30:00Z', dayLength: 600 } })
 * renderer.setAnimationLoop(() => { sky.update(); renderer.render(scene, camera) })
 * sky.setTimeOfDay(6.5)          // jump to 06:30 local solar time
 * sky.uniforms.night             // TSL uniform 0..1 for your own materials
 * ```
 */
export class Sky {
  /** Root of the dome, stars, meteors and lights. Added to `scene` for you when one is given. */
  readonly object = new Group()
  /** Shared TSL uniforms (`night`, `sunDirection`, …) for use in your own materials. */
  readonly uniforms: SkyUniforms = createSkyUniforms()
  /** Simulation clock. */
  readonly clock = new SkyClock()
  /** The star system model. Rebuilt when `system` settings change. */
  system!: StarSystem
  /** Everything about the current instant (sun/moon directions, phase, night…). Refreshed by {@link Sky.update}. */
  readonly state: SkyState = defaultSkyState()
  /** Lighting derived from the last update. */
  lighting: Lighting | null = null
  /** The atmosphere dome. */
  readonly dome = createSkyDome(this.uniforms, { discs: true, steps: DEFAULT_ATMOSPHERE.steps, lightSteps: DEFAULT_ATMOSPHERE.lightSteps })
  /** Stars and Milky Way. */
  readonly stars: Stars
  /** Meteors. */
  readonly shootingStars = new ShootingStars()
  /** Lights, environment, fog and exposure. */
  readonly dayNight: DayNight
  /** Sparse Gaussian clouds. */
  readonly clouds = new Clouds()
  /** Labelled altitude shells around the home planet. */
  readonly shells = new AltitudeShells()
  /** The atmosphere as used for the home planet (altitudes scaled to its radius when `scaleWithRadius`). */
  atmosphere: AtmosphereOptions = DEFAULT_ATMOSPHERE
  /** Resolved settings. Change them with {@link Sky.set} / {@link Sky.reset}. */
  settings: SkySettings = structuredClone(DEFAULT_SKY)
  /** Camera the observer follows. Can be swapped at any time. */
  camera: Camera | undefined
  /** Point the lights centre their shadows on; `null` = the camera position. */
  followTarget: Vector3 | null = null

  private input: SkyInput = {}
  private world?: WorldLike
  private systemKey = ''
  private marchKey = `${DEFAULT_ATMOSPHERE.steps}|${DEFAULT_ATMOSPHERE.lightSteps}`
  private atmosphereKey = ''
  private clockKey = ''
  private lastCamera: Vec3 = [0, 0, 0]
  private lightsTexture: Texture | null = null
  private resolvedShells: ResolvedShell[] = []
  private unsubscribe = () => {}

  /**
   * Creates a sky and computes the first frame (lights and environment included).
   * @throws If `renderer` is not a WebGPURenderer.
   */
  static async create(options: SkyOptions = {}): Promise<Sky> {
    const { renderer } = options
    if (renderer && !(renderer as any).isWebGPURenderer) throw new Error('Sky requires WebGPURenderer from "three/webgpu".')
    if (renderer && (renderer as any).hasInitialized?.() === false) await renderer.init()
    const sky = new Sky(options)
    sky.update(0)
    return sky
  }

  /** Prefer {@link Sky.create}, which also initialises the renderer. Call {@link Sky.update} every frame. */
  constructor({ renderer, scene, camera, world, ...input }: SkyOptions = {}) {
    this.camera = camera
    this.world = world
    this.object.name = 'Sky'
    this.stars = new Stars({}, this.uniforms)
    this.dayNight = new DayNight(this.uniforms, renderer, scene)
    this.object.add(this.dome, this.stars.object, this.shootingStars.object, ...this.clouds.object, this.shells.object)
    this.dayNight.addTo(this.object)
    if (world?.onChange) this.unsubscribe = world.onChange(() => this.apply())
    this.set(input)
    scene?.add(this.object)
  }

  /** Merges settings (nested objects merge; arrays replace). The clock only jumps if `clock.date` changes. */
  set(input: SkyInput): this {
    merge(this.input, structuredClone(input))
    return this.apply()
  }

  /** Replaces all settings: anything not in `input` goes back to {@link DEFAULT_SKY}. */
  reset(input: SkyInput = {}): this {
    this.input = structuredClone(input)
    return this.apply()
  }

  private apply(): this {
    const input = this.input
    const s: SkySettings = merge(structuredClone(DEFAULT_SKY), input)
    const w = this.world?.options
    const planet = w?.surface === 'sphere'
    // A planet World sets the home radius and, in the local frame, where the observer stands.
    if (planet && input.system?.home?.radius === undefined) s.system = merge(s.system, { home: { radius: w.radius } })
    if (planet && s.observer.frame === 'local' && input.observer?.latitude === undefined && input.observer?.longitude === undefined) {
      s.observer.latitude = w.origin[0]
      s.observer.longitude = w.origin[1]
    }
    if (s.system.seed === undefined) s.system.seed = s.seed
    this.settings = s

    const key = JSON.stringify(s.system)
    if (key !== this.systemKey) {
      this.systemKey = key
      this.system = new StarSystem(s.system)
    }
    this.clock.solarDay = this.system.solarDay()
    // Only touch the clock when its settings change, so runtime controls (pause, setDate…) stick.
    const clockKey = JSON.stringify(s.clock)
    if (clockKey !== this.clockKey) {
      this.clockKey = clockKey
      this.clock.reset(s.clock)
    }

    const u = this.uniforms
    this.atmosphere = resolveAtmosphere(s.atmosphere, this.system.home.radius)
    applyAtmosphere(u, this.atmosphere)
    applyNightLights(u.nightLights, s.nightLights)
    this.clouds.reset({ ...s.clouds, seed: input.clouds?.seed ?? s.seed })
    const marchKey = `${s.atmosphere.steps}|${s.atmosphere.lightSteps}`
    if (marchKey !== this.marchKey) {
      this.marchKey = marchKey
      this.rebuildDome()
    }
    u.sunColor.value.setRGB(...kelvinToRgb(this.system.star.temperature))
    u.sunDiscIntensity.value = s.sun.discIntensity
    u.moonBrightness.value = s.moon.brightness
    u.moonAlbedoScale.value = (this.system.moon?.albedo ?? 0.12) / 0.12
    u.earthshine.value = s.moon.earthshine
    u.moonSkyIntensity.value = s.moon.skyGlow
    this.stars.reset({ ...s.stars, seed: input.stars?.seed ?? s.seed })
    this.shootingStars.reset({ ...s.shootingStars, seed: input.shootingStars?.seed ?? s.seed })
    this.dayNight.reset(s.lighting)
    this.shells.reset(s.shells)
    this.resolvedShells = resolveShells(s.shells.shells, this.atmosphere.layers, this.system, altitudeScale(s.atmosphere, this.system.home.radius))
    const atmosphereKey = JSON.stringify([s.atmosphere, s.moon.skyGlow, key, s.nightLights])
    if (atmosphereKey !== this.atmosphereKey) {
      this.atmosphereKey = atmosphereKey
      this.dayNight.refreshEnvironment()
    }
    return this
  }

  private rebuildDome() {
    const a = this.settings.atmosphere
    const next = createSkyDome(this.uniforms, { discs: true, steps: Math.max(1, Math.round(a.steps)), lightSteps: Math.max(1, Math.round(a.lightSteps)) })
    this.object.remove(this.dome)
    this.dome.geometry.dispose()
    this.dome.material.dispose()
    ;(this as { dome: typeof next }).dome = next
    this.object.add(next)
  }

  /** Lights. The sun `DirectionalLight` (size its `shadow.camera` to taste). */
  get sun() { return this.dayNight.sun }
  /** The moonlight `DirectionalLight`. */
  get moonLight() { return this.dayNight.moon }
  /** 0 by day … 1 at night, as a number (the TSL version is `uniforms.night`). */
  get night(): number { return this.state.night }
  /** Suggested `renderer.toneMappingExposure` (smoothed); applied for you with `lighting.autoExposure`. */
  get exposure(): number { return this.dayNight.exposure }

  /**
   * Advances time and refreshes everything. Call once per frame, before rendering.
   * @param dt Real seconds since the last frame. Omit to measure it.
   */
  update(dt?: number): void {
    this.clock.update(dt)
    const realDt = this.clock.frameDelta
    const cam = this.lastCamera
    if (this.camera) {
      this.camera.updateMatrixWorld()
      const e = this.camera.matrixWorld.elements
      cam[0] = e[12]; cam[1] = e[13]; cam[2] = e[14]
    }
    const s = this.settings
    observe(this.system, this.clock.time, s.observer, cam, this.state)
    const lighting = computeLighting(this.state, this.atmosphere, s.lighting, { starTemperature: this.system.star.temperature, moonSkyIntensity: s.moon.skyGlow })
    this.lighting = lighting
    this.state.night = lighting.night
    this.state.skyLuminance = lighting.skyLuminance
    this.state.layer = layerAt(this.state.altitude, this.atmosphere.layers)
    const u = this.uniforms
    applySkyState(u, this.state)
    u.sunAngularRadius.value *= s.sun.discScale
    u.moonAngularRadius.value *= s.moon.discScale
    this.stars.update(this.state)
    this.shootingStars.update(this.clock.realDelta, this.state)
    const sunI = this.atmosphere.sunIntensity / Math.PI
    const sunK = (lighting.sunIntensity / Math.max(s.lighting.sunIntensity, 1e-6)) * sunI
    const moonK = (lighting.moonIntensity / Math.max(s.lighting.moonIntensity, 1e-6)) * sunI * 0.004
    const floor = lighting.ambientIntensity * 0.01
    this.clouds.update(this.state, cam, {
      sun: [lighting.sunColor[0] * sunK, lighting.sunColor[1] * sunK, lighting.sunColor[2] * sunK],
      moon: [lighting.moonColor[0] * moonK, lighting.moonColor[1] * moonK, lighting.moonColor[2] * moonK],
      ambient: [lighting.fogColor[0] * 1.2 + floor, lighting.fogColor[1] * 1.2 + floor, lighting.fogColor[2] * 1.2 + floor * 1.3],
      haze: lighting.fogColor,
      hazeFade: lighting.hazeFade,
    }, altitudeScale(s.atmosphere, this.system.home.radius), this.atmosphere.layers.troposphere, [s.observer.latitude, s.observer.longitude])
    if (this.camera) {
      const c = this.state.cameraToPlanet
      this.shells.update(this.camera, [cam[0] - c[0], cam[1] - c[1], cam[2] - c[2]], this.state.planetRadius, this.resolvedShells)
    }
    this.dayNight.target.copy(this.followTarget ?? new Vector3(...cam))
    this.dayNight.update(this.state, lighting, realDt)
  }

  /** Altitudes of the atmosphere's layers for the home planet (scaled with its radius when `scaleWithRadius`). */
  get layers(): AtmosphereLayers {
    return this.atmosphere.layers
  }

  /**
   * Near and far planes for the camera right now (see {@link clipPlanes}): pass the camera's height above
   * the ground under it. With shells on, far reaches the outermost shell.
   */
  clipPlanes(height = this.state.altitude): [number, number] {
    const R = this.system.home.radius
    const reach = this.settings.shells.enabled ? Math.max(0, ...this.resolvedShells.map((s) => R + s.altitude)) : 0
    return clipPlanes(height, R, this.atmosphere.height, reach)
  }

  /** Which atmosphere layer an altitude (metres; default: the camera's) is in. */
  layerAt(altitude = this.state.altitude): LayerName {
    return layerAt(altitude, this.atmosphere.layers)
  }

  /** Cloud cover 0..1 at a render-space position right now (the same field the clouds are placed from). */
  cloudCover(x: number, y: number, z: number): number {
    return this.clouds.coverAt(x, y, z)
  }

  /**
   * Sets the city-lights field: a `(latitude, longitude) => 0..1` callback (baked at
   * `nightLights.resolution`), an equirectangular texture (longitude 0 at the centre, south at the bottom),
   * or `null` for the procedural field.
   */
  setNightLights(field: LightsField | Texture | null): this {
    this.lightsTexture?.dispose()
    this.lightsTexture = null
    if (typeof field === 'function') {
      const [w, h] = this.settings.nightLights.resolution
      field = this.lightsTexture = bakeNightLights(field, w, h)
    }
    setNightLightsTexture(this.uniforms.nightLights, field)
    return this
  }

  /** Centres the lights' shadow cameras on `target` (e.g. your orbit-controls target); `null` follows the camera. */
  follow(target: Vector3 | null): void {
    this.followTarget = target
  }

  /** Jumps to a local apparent solar time (hours, 12 = noon) on the current day, at the observer. */
  setTimeOfDay(hours: number): this {
    const day = this.system.solarDay()
    for (let i = 0; i < 3; i++) {
      const st = observe(this.system, this.clock.time, this.settings.observer, this.lastCamera).solarTime
      const diff = ((((hours - st) % 24) + 36) % 24) - 12
      this.clock.advance((diff / 24) * day)
    }
    return this
  }

  /** Next sunrise and sunset after now at the observer, as Dates (null in polar day/night). */
  sunTimes(): { sunrise: Date | null; sunset: Date | null } {
    const t: SunTimes = sunTimes(this.system, this.clock.time, this.state.latitude, this.state.longitude)
    return { sunrise: t.sunrise === null ? null : toDate(t.sunrise), sunset: t.sunset === null ? null : toDate(t.sunset) }
  }

  /** Removes everything from the scene and frees GPU resources. */
  dispose(): void {
    this.unsubscribe()
    this.object.removeFromParent()
    this.dome.geometry.dispose()
    this.dome.material.dispose()
    this.stars.dispose()
    this.shootingStars.dispose()
    this.clouds.dispose()
    this.shells.dispose()
    this.lightsTexture?.dispose()
    this.dayNight.dispose()
  }
}
