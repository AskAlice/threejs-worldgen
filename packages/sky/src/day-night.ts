/**
 * Day/night lighting from the sky state: a sun `DirectionalLight` whose colour and intensity come from
 * the same atmosphere the sky draws (red at sunset, gone after it), dim bluish moonlight scaled by the
 * moon's phase, image-based lighting re-rendered from the sky (time-sliced) when the sun moves, fog
 * colour, an exposure suggestion, and a `night` value 0..1 for other packages (lit windows, lamps).
 */
import { CubeCamera, CubeRenderTarget, DirectionalLight, FogExp2, HalfFloatType, HemisphereLight, Scene, Vector3, type Object3D, type WebGPURenderer } from 'three/webgpu'
import { createSkyDome, type SkyUniforms } from './atmosphere.ts'
import type { SkyState } from './observer.ts'
import { luminance, skyRadiance, transmittance, type AtmosphereOptions } from './scattering.ts'
import { DEG, hexToLinear, kelvinToRgb, smoothstep, type Vec3 } from './util.ts'

/** Lighting settings. Plain JSON. */
export interface LightingOptions {
  /** Sun light intensity with the sun overhead in clear air. */
  sunIntensity: number
  /** Moonlight intensity at full moon overhead. */
  moonIntensity: number
  /** Moonlight tint (`#rrggbb`); night vision looks blue. */
  moonColor: string
  /**
   * Minimum hemisphere fill light at night (starlight, airglow, light pollution), so nights are dark
   * but never pitch black. Scaled by `night`.
   */
  nightAmbient: number
  /** Night fill colours as [sky, ground] (`#rrggbb`). */
  nightAmbientColors: [string, string]
  /** Sun elevations (degrees) where night starts and where it is complete: `night` ramps 0 → 1 between them. */
  twilight: [number, number]
  /** The sun light casts shadows. */
  shadows: boolean
  /** The moon light casts shadows (costs a second shadow map). */
  moonShadows: boolean
  /** Distance of the lights from the point they follow, metres (keep it inside the shadow camera's far). */
  lightDistance: number
  /** Light the scene with an environment map rendered from the sky. */
  environment: boolean
  /** `scene.environmentIntensity` to use. */
  environmentIntensity: number
  /** Cube face size of the environment capture, pixels. */
  environmentResolution: number
  /** How far (degrees) the sun or moon must move before the environment is re-rendered. */
  environmentThreshold: number
  /** Cube faces rendered per frame while refreshing (6 = all at once; 1 spreads it over 6 frames). */
  environmentFacesPerFrame: number
  /** Drive `scene.fog`'s colour from the horizon sky. */
  fog: boolean
  /** Exponential fog density to set (creates `FogExp2` if needed); 0 leaves density alone. */
  fogDensity: number
  /** Multiplier on the fog colour. */
  fogBrightness: number
  /** Apply the exposure suggestion to `renderer.toneMappingExposure`. */
  autoExposure: boolean
  /** Target average sky luminance after exposure. */
  exposureKey: number
  /** Lowest and highest exposure suggested. */
  exposureRange: [number, number]
  /** How fast exposure adapts, 1/seconds. */
  exposureSpeed: number
}

/** Defaults, tuned for ACES tone mapping. */
export const DEFAULT_LIGHTING: LightingOptions = {
  sunIntensity: 3.4,
  moonIntensity: 0.35,
  moonColor: '#9fb6ff',
  nightAmbient: 0.12,
  nightAmbientColors: ['#5a6f9e', '#1b1f26'],
  twilight: [2, -12],
  shadows: true,
  moonShadows: false,
  lightDistance: 150,
  environment: true,
  environmentIntensity: 0.25,
  environmentResolution: 64,
  environmentThreshold: 0.5,
  environmentFacesPerFrame: 2,
  fog: true,
  fogDensity: 0,
  fogBrightness: 1,
  autoExposure: false,
  exposureKey: 0.35,
  exposureRange: [0.25, 8],
  exposureSpeed: 1.5,
}

/** Lighting derived from a sky state. All colours are linear RGB normalised to a max of 1. */
export interface Lighting {
  /** Sunlight colour after the atmosphere. */
  sunColor: Vec3
  /** Sunlight intensity (0 below the horizon). */
  sunIntensity: number
  /** Moonlight colour. */
  moonColor: Vec3
  /** Moonlight intensity. */
  moonIntensity: number
  /** Horizon sky radiance, averaged around the compass (use as fog colour). */
  fogColor: Vec3
  /** Zenith sky luminance. */
  skyLuminance: number
  /** 0 by day … 1 at night. */
  night: number
  /** Suggested `toneMappingExposure` (unsmoothed). */
  exposure: number
  /** Night fill (hemisphere) light intensity. */
  ambientIntensity: number
  /** Aerial perspective 0..1: 1 in the troposphere, fading to 0 at the Kármán line (space has no haze). */
  hazeFade: number
}

/** Extra inputs to {@link computeLighting}. */
export interface LightingContext {
  /** Star temperature, kelvin. */
  starTemperature: number
  /** Moon sky-glow factor relative to the sun (the sky option `moon.skyGlow`). */
  moonSkyIntensity: number
}

const norm = (c: Vec3): [Vec3, number] => {
  const m = Math.max(c[0], c[1], c[2])
  return m > 0 ? [[c[0] / m, c[1] / m, c[2] / m], m] : [[1, 1, 1], 0]
}

/** Computes light colours, fog colour, sky brightness, `night` and an exposure suggestion. Pure. */
export function computeLighting(state: SkyState, atmosphere: AtmosphereOptions, options: LightingOptions, ctx: LightingContext): Lighting {
  const R = state.planetRadius, o = state.cameraToPlanet
  const star = kelvinToRgb(ctx.starTemperature)
  // Sunlight: black-body colour × transmittance, faded as the disc sinks below the horizon.
  const Ts = transmittance(atmosphere, R, o, state.sunDirection)
  const sunR = state.sunAngularRadius / DEG
  const dip = Math.acos(Math.min(1, R / (R + Math.max(0, state.altitude)))) / DEG // the horizon drops as you climb
  const disc = smoothstep(-sunR, sunR, state.sunElevation + dip)
  const [sunColor, sunK] = norm([star[0] * Ts[0], star[1] * Ts[1], star[2] * Ts[2]])
  // Moonlight: phase × transmittance, tinted.
  const Tm = state.moonAngularRadius > 0 ? transmittance(atmosphere, R, o, state.moonDirection) : [0, 0, 0] as Vec3
  const tint = hexToLinear(options.moonColor)
  const [moonColor, moonK] = norm([tint[0] * (0.4 + 0.6 * Tm[0]), tint[1] * (0.4 + 0.6 * Tm[1]), tint[2] * (0.4 + 0.6 * Tm[2])])
  const moonUp = smoothstep(-0.5, 2, state.moonElevation)
  // Sky brightness: zenith and the horizon all round, from the sun, the moon and airglow.
  const moonI = atmosphere.sunIntensity * ctx.moonSkyIntensity * state.moonIllumination * (state.moonAngularRadius > 0 ? 1 : 0)
  const sky = (d: Vec3): Vec3 => {
    const a = skyRadiance(atmosphere, R, o, d, state.sunDirection)
    const b = moonI > 0 ? skyRadiance(atmosphere, R, o, d, state.moonDirection, moonI) : [0, 0, 0]
    return [a[0] + b[0] + atmosphere.airglow[0], a[1] + b[1] + atmosphere.airglow[1], a[2] + b[2] + atmosphere.airglow[2]]
  }
  const zenith = sky(state.up)
  const fog: Vec3 = [0, 0, 0]
  const e = 3 * DEG
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2, c = Math.cos(a) * Math.cos(e), s = Math.sin(a) * Math.cos(e), z = Math.sin(e)
    const h = sky([state.east[0] * c + state.north[0] * s + state.up[0] * z, state.east[1] * c + state.north[1] * s + state.up[1] * z, state.east[2] * c + state.north[2] * s + state.up[2] * z])
    fog[0] += h[0] / 4; fog[1] += h[1] / 4; fog[2] += h[2] / 4
  }
  // From high up, the sunlit planet below dominates the view, not the (black) sky.
  const below = 0.3 * (atmosphere.sunIntensity / Math.PI) * Math.max(0, Math.sin(state.sunElevation * DEG)) + luminance(atmosphere.airglow)
  const avg = 0.5 * luminance(zenith) + 0.5 * luminance(fog) + below * smoothstep(atmosphere.layers.troposphere, atmosphere.layers.karman, state.altitude)
  const [lo, hi] = options.exposureRange
  return {
    sunColor,
    sunIntensity: options.sunIntensity * sunK * disc,
    moonColor,
    moonIntensity: options.moonIntensity * moonK * state.moonIllumination * moonUp,
    fogColor: [fog[0] * options.fogBrightness, fog[1] * options.fogBrightness, fog[2] * options.fogBrightness],
    skyLuminance: luminance(zenith),
    night: smoothstep(options.twilight[0], options.twilight[1], state.sunElevation),
    exposure: Math.min(hi, Math.max(lo, options.exposureKey / Math.max(avg, 1e-7))),
    ambientIntensity: options.nightAmbient * smoothstep(options.twilight[0], options.twilight[1], state.sunElevation),
    hazeFade: 1 - smoothstep(atmosphere.layers.troposphere, atmosphere.layers.karman, state.altitude),
  }
}

/**
 * Drives the lights, environment, fog and exposure. Created by `Sky`; its lights are `sky.sun` and
 * `sky.moonLight`.
 */
export class DayNight {
  /** The sun. Its shadow camera is yours to size (`sun.shadow.camera`). */
  readonly sun = new DirectionalLight(0xffffff, 0)
  /** The moon. */
  readonly moon = new DirectionalLight(0x9fb6ff, 0)
  /** Night fill light (never pitch black). Its up follows the observer. */
  readonly fill = new HemisphereLight(0x5a6f9e, 0x1b1f26, 0)
  /** Resolved settings. */
  settings: LightingOptions = structuredClone(DEFAULT_LIGHTING)
  /** Last computed lighting. */
  lighting: Lighting | null = null
  /** Smoothed exposure suggestion. */
  exposure = 1
  /** Point the lights (and their shadow cameras) are centred on. */
  readonly target = new Vector3()

  private readonly envScene = new Scene()
  private readonly cubeCamera: CubeCamera
  private targets: CubeRenderTarget[] = []
  private face = -1
  private lastSun = new Vector3(0, -2, 0)
  private lastMoon = new Vector3(0, -2, 0)
  private lastNight = -1
  private forceEnv = true
  private adapted = false
  private readonly renderer?: WebGPURenderer
  private readonly scene?: Scene

  /**
   * @param uniforms Sky uniforms (the environment capture draws the sky from them).
   * @param renderer Needed for the environment map and auto exposure.
   * @param scene Receives `environment` and `fog`.
   */
  constructor(uniforms: SkyUniforms, renderer?: WebGPURenderer, scene?: Scene) {
    this.renderer = renderer
    this.scene = scene
    this.sun.name = 'Sun'
    this.moon.name = 'Moon light'
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.03
    Object.assign(this.sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 400 })
    this.envScene.add(createSkyDome(uniforms, { discs: false, steps: 10, lightSteps: 4 }))
    this.cubeCamera = new CubeCamera(0.1, 10, null as unknown as CubeRenderTarget)
  }

  /** Adds the lights (and their targets) to `parent`. */
  addTo(parent: Object3D): void {
    parent.add(this.sun, this.sun.target, this.moon, this.moon.target, this.fill)
  }

  /** Merges settings. */
  set(input: Partial<LightingOptions>): this {
    const prev = this.settings.environmentResolution
    for (const [k, v] of Object.entries(input)) if (v !== undefined) (this.settings as any)[k] = v
    if (prev !== this.settings.environmentResolution) this.disposeTargets()
    this.forceEnv = true
    return this
  }

  /** Replaces all settings. */
  reset(input: Partial<LightingOptions> = {}): this {
    const next = { ...structuredClone(DEFAULT_LIGHTING), ...input }
    if (JSON.stringify(next) === JSON.stringify(this.settings)) return this
    this.settings = structuredClone(DEFAULT_LIGHTING)
    return this.set(input)
  }

  /** Re-renders the environment map on the next update (e.g. after changing the atmosphere). */
  refreshEnvironment(): void {
    this.forceEnv = true
  }

  /**
   * Applies lighting for `state`.
   * @param dt Real seconds since the last frame (exposure adaptation).
   */
  update(state: SkyState, lighting: Lighting, dt: number): void {
    const s = this.settings
    this.lighting = lighting
    const place = (light: DirectionalLight, dir: Vec3, intensity: number, color: Vec3, shadows: boolean) => {
      light.color.setRGB(...color)
      light.intensity = intensity
      light.visible = intensity > 1e-4
      light.castShadow = shadows && light.visible
      // Snap to shadow-map texels so shadows don't shimmer as the target moves.
      const cam = light.shadow.camera
      const texel = (cam.right - cam.left) / light.shadow.mapSize.x || 1
      const t = this.target
      light.target.position.set(Math.round(t.x / texel) * texel, Math.round(t.y / texel) * texel, Math.round(t.z / texel) * texel)
      light.position.copy(light.target.position).addScaledVector(new Vector3(...dir), s.lightDistance)
      light.target.updateMatrixWorld()
    }
    place(this.sun, state.sunDirection, lighting.sunIntensity, lighting.sunColor, s.shadows)
    place(this.moon, state.moonDirection, lighting.moonIntensity, lighting.moonColor, s.moonShadows)
    this.fill.intensity = lighting.ambientIntensity
    this.fill.visible = lighting.ambientIntensity > 1e-4
    this.fill.color.setRGB(...hexToLinear(s.nightAmbientColors[0]))
    this.fill.groundColor.setRGB(...hexToLinear(s.nightAmbientColors[1]))
    this.fill.position.set(...state.up) // HemisphereLight's up is its position direction

    const k = 1 - Math.exp(-s.exposureSpeed * Math.max(dt, 0))
    this.exposure = Math.exp(Math.log(this.exposure) + (Math.log(lighting.exposure) - Math.log(this.exposure)) * (this.adapted ? k : 1))
    this.adapted = true
    if (s.autoExposure && this.renderer) this.renderer.toneMappingExposure = this.exposure

    const scene = this.scene
    if (scene && s.fog) {
      if (!scene.fog && s.fogDensity > 0) scene.fog = new FogExp2(0xffffff, s.fogDensity)
      if (scene.fog) {
        scene.fog.color.setRGB(...lighting.fogColor)
        // No aerial perspective above the Kármán line.
        if (s.fogDensity > 0 && scene.fog instanceof FogExp2) scene.fog.density = s.fogDensity * lighting.hazeFade
      }
    }
    if (scene && this.renderer && s.environment) this.updateEnvironment(state, lighting)
  }

  private updateEnvironment(state: SkyState, lighting: Lighting) {
    const s = this.settings, scene = this.scene!, renderer = this.renderer!
    scene.environmentIntensity = s.environmentIntensity
    if (this.face < 0) {
      const sun = new Vector3(...state.sunDirection), moon = new Vector3(...state.moonDirection)
      const moved = Math.max(sun.angleTo(this.lastSun), moon.angleTo(this.lastMoon)) / DEG > s.environmentThreshold
      if (!(this.forceEnv || moved || Math.abs(lighting.night - this.lastNight) > 0.05)) return
      this.lastSun.copy(sun); this.lastMoon.copy(moon); this.lastNight = lighting.night
      this.face = 0
    }
    if (this.targets.length === 0) {
      const res = Math.max(8, Math.round(s.environmentResolution))
      this.targets = [0, 1].map(() => new CubeRenderTarget(res, { type: HalfFloatType, generateMipmaps: false }))
    }
    const first = !this.targets.some((t) => t.texture === scene.environment) // nothing of ours shown yet: capture it all now
    this.forceEnv = false
    const target = this.targets[0]
    const cube = this.cubeCamera
    if (cube.coordinateSystem !== renderer.coordinateSystem) {
      cube.coordinateSystem = renderer.coordinateSystem
      cube.updateCoordinateSystem()
    }
    const prevTarget = renderer.getRenderTarget(), prevFace = renderer.getActiveCubeFace(), prevLevel = renderer.getActiveMipmapLevel()
    const faces = first ? 6 : Math.max(1, Math.round(s.environmentFacesPerFrame))
    for (let n = 0; n < faces && this.face < 6; n++, this.face++) {
      renderer.setRenderTarget(target, this.face)
      renderer.render(this.envScene, cube.children[this.face] as any)
    }
    renderer.setRenderTarget(prevTarget, prevFace, prevLevel)
    if (this.face >= 6) {
      target.texture.needsPMREMUpdate = true
      scene.environment = target.texture
      this.targets.reverse() // draw the next capture into the other target while this one is in use
      this.face = -1
    }
  }

  private disposeTargets() {
    if (this.scene && this.targets.some((t) => t.texture === this.scene!.environment)) this.scene.environment = null
    for (const t of this.targets) t.dispose()
    this.targets = []
    this.face = -1
  }

  /** Removes the lights, environment and render targets. */
  dispose(): void {
    this.disposeTargets()
    for (const o of [this.sun, this.sun.target, this.moon, this.moon.target, this.fill]) o.removeFromParent()
    this.sun.dispose()
    this.moon.dispose()
    this.fill.dispose()
    this.envScene.traverse((o: any) => { o.geometry?.dispose(); o.material?.dispose() })
  }
}
