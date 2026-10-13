import { Color, Group, Mesh, MeshBasicNodeMaterial, Vector3, type Camera, type InstancedBufferAttribute, type InstancedBufferGeometry, type Node } from 'three/webgpu'
import { abs, cos, float, floor, instancedBufferAttribute, length, normalize, positionGeometry, sin, smoothstep, uniform, uv, varying, vec3 } from 'three/tsl'
import { hash01, seedOf } from 'threejs-biomes'
import { createWeatherSample, type Weather, type WeatherSample } from './weather.ts'
import { axisBillboard, createQuadInstances, sphereBillboard } from './particles.ts'
import { merge, mod, resolve } from './util.ts'

/** Rain streaks. */
export interface RainLook {
  /** Fall speed, m/s (raindrops ≈ 6–9). */
  speed: number
  /** Streak width, metres. */
  width: number
  /** Motion-blur time: streak length = speed × shutter, seconds. */
  shutter: number
  /** Colour (`#rrggbb`). */
  color: string
  /** Opacity. */
  opacity: number
}

/** Snowflakes. */
export interface SnowLook {
  /** Fall speed, m/s (snow ≈ 1). */
  speed: number
  /** Flake size, metres. */
  size: number
  /** Side-to-side flutter, metres. */
  flutter: number
  /** Colour (`#rrggbb`). */
  color: string
  /** Opacity. */
  opacity: number
}

/** Splash rings where rain hits the ground (needs a ground height function). */
export interface SplashLook {
  /** Turn splashes on or off. */
  enabled: boolean
  /** Splashes alive at full rain. */
  count: number
  /** Radius around the camera with splashes, metres. */
  radius: number
  /** Ring size, metres. */
  size: number
  /** Life of one splash, seconds. */
  lifetime: number
  /** Opacity. */
  opacity: number
}

/** Every precipitation setting. Plain JSON. */
export interface PrecipitationOptions {
  /** Seed for particle placement. */
  seed: number | string
  /** Half-width of the particle box around the camera, metres. */
  radius: number
  /** Height of the particle box, metres. */
  height: number
  /** Raindrops at full rain. */
  maxRain: number
  /** Snowflakes at full snow. */
  maxSnow: number
  /** Precipitation rate (mm/h) that shows every particle. */
  heavyRate: number
  /** Rain look. */
  rain: RainLook
  /** Snow look. */
  snow: SnowLook
  /** Splash look. */
  splashes: SplashLook
  /**
   * Fixed conditions instead of the weather (demos, cutscenes): rate in mm/h, snow share 0…1 and wind
   * `[x, z]` m/s. `null` reads the weather at the camera.
   */
  override: PrecipitationOverride | null
}

/** Fixed precipitation conditions (see {@link PrecipitationOptions.override}). */
export interface PrecipitationOverride {
  /** Rate, mm/h. */
  precipitation: number
  /** Snow share 0 (rain) … 1 (snow). */
  snowFraction: number
  /** Wind `[x, z]`, m/s. */
  wind: [number, number]
}

/** Partial settings for {@link Precipitation}. */
export type PrecipitationInput = Partial<Omit<PrecipitationOptions, 'rain' | 'snow' | 'splashes'>> & {
  /** Rain look to change. */
  rain?: Partial<RainLook>
  /** Snow look to change. */
  snow?: Partial<SnowLook>
  /** Splash look to change. */
  splashes?: Partial<SplashLook>
}

/** Default precipitation: 24k drops / 16k flakes in an 80 × 30 × 80 m box. */
export const DEFAULT_PRECIPITATION: PrecipitationOptions = {
  seed: 1,
  radius: 40,
  height: 30,
  maxRain: 24_000,
  maxSnow: 16_000,
  heavyRate: 10,
  rain: { speed: 8.5, width: 0.012, shutter: 0.06, color: '#c9d3de', opacity: 0.32 },
  snow: { speed: 1.1, size: 0.035, flutter: 0.35, color: '#ffffff', opacity: 0.9 },
  splashes: { enabled: true, count: 700, radius: 16, size: 0.22, lifetime: 0.35, opacity: 0.45 },
  override: null,
}

/** Construction options for {@link Precipitation}: settings plus the objects it works with. */
export interface PrecipitationConfig extends PrecipitationInput {
  /** Weather to read (rate, rain/snow, wind). */
  weather: Weather
  /** Camera the particles surround. */
  camera: Camera
  /** Ground height `(x, z) => y` in frame coordinates for splashes. Default: the weather's world. */
  ground?: ((x: number, z: number) => number) | null
}

/** Seconds after which the particle animation clock wraps (keeps float32 shader maths precise). */
const PERIOD = 600

/**
 * GPU rain streaks, snowflakes and splash rings around the camera, driven by a {@link Weather}:
 * density from the precipitation rate, rain/sleet/snow from the snow fraction, slant and drift from
 * the wind. All particles of a kind are one instanced draw call, positioned entirely in the vertex
 * shader (wrapped in a box that follows the camera, so they never run out); only splashes are placed
 * on the CPU (they need the ground height).
 *
 * @example
 * ```ts
 * const rain = new Precipitation({ weather, camera })
 * scene.add(rain.object)
 * // each frame: rain.update(time)
 * ```
 */
export class Precipitation {
  /** Add this to your scene. */
  readonly object = new Group()
  /** Resolved settings. */
  options!: PrecipitationOptions
  /** Weather read at the camera on the last update. */
  readonly sample: WeatherSample = createWeatherSample()
  /** Weather to read. */
  weather: Weather
  /** Camera the particles surround. */
  camera: Camera
  /** Ground height for splashes (frame coordinates). */
  ground: ((x: number, z: number) => number) | null
  /** Shader uniforms, for advanced tweaks. */
  readonly uniforms = {
    /** Camera position, render space. */ camera: uniform(new Vector3()),
    /** Camera frame position modulo the box, so particles stay put in the world. */ anchor: uniform(new Vector3()),
    /** Accumulated wind drift modulo the box. */ drift: uniform(new Vector3()),
    /** Animation clock (time modulo 600 s). */ cycle: uniform(0),
    /** Current wind velocity (x, 0, z), m/s. */ wind: uniform(new Vector3()),
    /** Box size (2 radius, height, 2 radius). */ box: uniform(new Vector3(80, 30, 80)),
    /** Rain fall speed. */ rainSpeed: uniform(8.5),
    /** Rain width. */ rainWidth: uniform(0.012),
    /** Rain shutter. */ shutter: uniform(0.06),
    /** Rain colour. */ rainColor: uniform(new Color()),
    /** Rain opacity. */ rainOpacity: uniform(0.3),
    /** Snow fall speed. */ snowSpeed: uniform(1),
    /** Flake size. */ snowSize: uniform(0.03),
    /** Flutter. */ flutter: uniform(0.3),
    /** Snow colour. */ snowColor: uniform(new Color()),
    /** Snow opacity. */ snowOpacity: uniform(0.9),
    /** Splash size. */ splashSize: uniform(0.2),
    /** Splash opacity. */ splashOpacity: uniform(0.4),
  }

  private origin: [number, number, number] = [0, 0, 0]
  private rainMesh: Mesh<InstancedBufferGeometry, MeshBasicNodeMaterial> | null = null
  private snowMesh: Mesh<InstancedBufferGeometry, MeshBasicNodeMaterial> | null = null
  private splashMesh: Mesh<InstancedBufferGeometry, MeshBasicNodeMaterial> | null = null
  private layoutKey = ''
  private lastTime: number | null = null
  private driftX = 0
  private driftZ = 0
  private splashCycle = new Float64Array(0)
  private splashPos = new Float64Array(0)

  /** Creates precipitation; settings not given use {@link DEFAULT_PRECIPITATION}. */
  constructor({ weather, camera, ground, ...input }: PrecipitationConfig) {
    this.weather = weather
    this.camera = camera
    this.ground = ground !== undefined ? ground : weather.frame ? weather.frame.height : null
    this.object.name = 'Precipitation'
    this.reset(input)
  }

  /** Merges `input` into the settings. Counts rebuild the buffers; looks are live uniforms. */
  set(input: PrecipitationInput): this {
    this.options = merge(this.options ?? structuredClone(DEFAULT_PRECIPITATION), input)
    return this.apply()
  }

  /** Replaces all settings (anything not given goes back to defaults). */
  reset(input: PrecipitationInput = {}): this {
    this.options = resolve(DEFAULT_PRECIPITATION, input)
    return this.apply()
  }

  /** Sets the frame position at render-space zero (floating origin), `[x, y, z]`. */
  setOrigin(origin: readonly number[]): this {
    this.origin = [origin[0], origin[1] ?? 0, origin[2] ?? 0]
    return this
  }

  private apply(): this {
    const o = this.options
    const u = this.uniforms
    u.box.value.set(o.radius * 2, o.height, o.radius * 2)
    u.rainSpeed.value = o.rain.speed
    u.rainWidth.value = o.rain.width
    u.shutter.value = o.rain.shutter
    u.rainColor.value.set(o.rain.color)
    u.rainOpacity.value = o.rain.opacity
    u.snowSpeed.value = o.snow.speed
    u.snowSize.value = o.snow.size
    u.flutter.value = o.snow.flutter
    u.snowColor.value.set(o.snow.color)
    u.snowOpacity.value = o.snow.opacity
    u.splashSize.value = o.splashes.size
    u.splashOpacity.value = o.splashes.opacity
    const key = JSON.stringify([o.seed, o.maxRain, o.maxSnow, o.splashes.count])
    if (key !== this.layoutKey) {
      this.layoutKey = key
      this.disposeMeshes()
      const seed = seedOf(o.seed)
      const rain = createQuadInstances(o.maxRain, seed, -0.5)
      const snow = createQuadInstances(o.maxSnow, seed + 1, -0.5)
      const splash = createQuadInstances(o.splashes.count, seed + 2, -0.5, true)
      this.rainMesh = new Mesh(rain, this.rainMaterial(rain))
      this.snowMesh = new Mesh(snow, this.snowMaterial(snow))
      this.splashMesh = new Mesh(splash, this.splashMaterial(splash))
      for (const m of [this.rainMesh, this.snowMesh, this.splashMesh]) {
        m.frustumCulled = false // always around the camera
        m.renderOrder = 10
        this.object.add(m)
      }
      this.splashCycle = new Float64Array(o.splashes.count).fill(NaN)
      this.splashPos = new Float64Array(o.splashes.count * 3)
    }
    return this
  }

  /** Reads the weather at the camera and animates everything to `time` seconds. */
  update(time: number): void {
    const o = this.options
    const u = this.uniforms
    const cam = this.camera.getWorldPosition(_v)
    const fx = cam.x + this.origin[0], fy = cam.y + this.origin[1], fz = cam.z + this.origin[2]
    const s = this.sample
    if (o.override) {
      s.precipitation = o.override.precipitation
      s.snowFraction = o.override.snowFraction
      s.windX = o.override.wind[0]
      s.windZ = o.override.wind[1]
    } else this.weather.at(fx, fz, time, s)

    // Wind drift is integrated (so gusts don't make particles jump) and kept inside the box.
    const dt = this.lastTime === null ? 0 : Math.max(-1, Math.min(1, time - this.lastTime))
    this.lastTime = time
    this.driftX = mod(this.driftX + s.windX * dt, o.radius * 2)
    this.driftZ = mod(this.driftZ + s.windZ * dt, o.radius * 2)
    u.drift.value.set(this.driftX, 0, this.driftZ)
    u.wind.value.set(s.windX, 0, s.windZ)
    u.camera.value.copy(cam)
    u.anchor.value.set(mod(fx, o.radius * 2), mod(fy, o.height), mod(fz, o.radius * 2))
    u.cycle.value = mod(time, PERIOD)

    const density = Math.min(1, Math.max(0, s.precipitation / o.heavyRate)) ** 0.7
    this.rainMesh!.geometry.instanceCount = Math.round(o.maxRain * density * (1 - s.snowFraction))
    this.snowMesh!.geometry.instanceCount = Math.round(o.maxSnow * density * s.snowFraction)
    this.updateSplashes(time, fx, fz, density * (1 - s.snowFraction))
  }

  // Each slot replays a short splash with its own period; a new cycle puts it somewhere new.
  private updateSplashes(time: number, fx: number, fz: number, amount: number) {
    const o = this.options.splashes
    const mesh = this.splashMesh!
    const count = o.enabled && this.ground ? Math.round(o.count * amount) : 0
    mesh.geometry.instanceCount = count
    if (!count) return
    const rand = (mesh.geometry.getAttribute('aRand') as InstancedBufferAttribute).array as Float32Array
    const data = mesh.geometry.getAttribute('aData') as InstancedBufferAttribute
    const out = data.array as Float32Array
    const seed = seedOf(this.options.seed)
    for (let i = 0; i < count; i++) {
      const period = o.lifetime * (0.8 + 0.4 * rand[i * 4])
      const t = time + rand[i * 4 + 1] * period
      const cycle = Math.floor(t / period)
      if (this.splashCycle[i] !== cycle) {
        this.splashCycle[i] = cycle
        const a = hash01(i, cycle, seed, 1) * Math.PI * 2, r = Math.sqrt(hash01(i, cycle, seed, 2)) * o.radius
        const x = fx + Math.cos(a) * r, z = fz + Math.sin(a) * r
        this.splashPos[i * 3] = x
        this.splashPos[i * 3 + 1] = this.ground!(x, z)
        this.splashPos[i * 3 + 2] = z
      }
      out[i * 4] = this.splashPos[i * 3] - this.origin[0]
      out[i * 4 + 1] = this.splashPos[i * 3 + 1] - this.origin[1]
      out[i * 4 + 2] = this.splashPos[i * 3 + 2] - this.origin[2]
      out[i * 4 + 3] = t / period - cycle
    }
    data.clearUpdateRanges()
    data.addUpdateRange(0, count * 4)
    data.needsUpdate = true
  }

  // Box-wrapped particle position relative to the camera, and an edge fade.
  private particle(rand: Node<'vec4'>, velocity: Node<'vec3'>, extra: Node<'vec3'> = vec3(0)) {
    const u = this.uniforms
    const p = rand.xyz.mul(u.box).add(vec3(0, velocity.y, 0).mul(u.cycle)).add(u.drift).sub(u.anchor)
    const rel = p.sub(u.box.mul(floor(p.div(u.box)))).sub(u.box.mul(0.5)).add(extra)
    const fade = varying(smoothstep(u.box.x.mul(0.5), u.box.x.mul(0.3), length(rel.xz)).mul(smoothstep(u.box.y.mul(0.5), u.box.y.mul(0.35), abs(rel.y))))
    return { center: u.camera.add(rel), fade }
  }

  private rainMaterial(geometry: InstancedBufferGeometry) {
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    m.name = 'Rain'
    const u = this.uniforms
    const rand = instancedBufferAttribute(geometry.getAttribute('aRand') as InstancedBufferAttribute, 'vec4') as Node<'vec4'>
    const speed = u.rainSpeed.mul(rand.w.mul(0.3).add(0.85))
    const velocity = vec3(u.wind.x, speed.negate(), u.wind.z)
    const { center, fade } = this.particle(rand, velocity)
    m.positionNode = axisBillboard(center, normalize(velocity), positionGeometry, u.rainWidth, length(velocity).mul(u.shutter))
    const across = float(1).sub(abs(uv().x.mul(2).sub(1)))
    m.colorNode = u.rainColor
    m.opacityNode = u.rainOpacity.mul(fade).mul(across).mul(smoothstep(0, 0.4, uv().y)).mul(smoothstep(1, 0.6, uv().y))
    return m
  }

  private snowMaterial(geometry: InstancedBufferGeometry) {
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    m.name = 'Snow'
    const u = this.uniforms
    const rand = instancedBufferAttribute(geometry.getAttribute('aRand') as InstancedBufferAttribute, 'vec4') as Node<'vec4'>
    const velocity = vec3(u.wind.x, u.snowSpeed.mul(rand.w.mul(0.6).add(0.7)).negate(), u.wind.z)
    const flutter = vec3(sin(u.cycle.mul(1.3).add(rand.x.mul(40))), 0, cos(u.cycle.mul(1.1).add(rand.z.mul(40)))).mul(u.flutter)
    const { center, fade } = this.particle(rand, velocity, flutter)
    m.positionNode = sphereBillboard(center, positionGeometry, u.snowSize.mul(rand.y.mul(0.8).add(0.6)))
    m.colorNode = u.snowColor
    m.opacityNode = smoothstep(0.5, 0.15, length(uv().sub(0.5))).mul(u.snowOpacity).mul(fade)
    return m
  }

  private splashMaterial(geometry: InstancedBufferGeometry) {
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    m.name = 'Splashes'
    const u = this.uniforms
    const data = instancedBufferAttribute(geometry.getAttribute('aData') as InstancedBufferAttribute, 'vec4') as Node<'vec4'>
    const age = data.w
    const corner = positionGeometry
    m.positionNode = data.xyz.add(vec3(corner.x, 0, corner.y).mul(u.splashSize.mul(age.mul(0.8).add(0.3)))).add(vec3(0, 0.02, 0))
    const d = length(uv().sub(0.5)).mul(2)
    const ring = smoothstep(0.55, 0.85, d).mul(smoothstep(1, 0.85, d))
    m.colorNode = u.rainColor
    m.opacityNode = ring.mul(age.oneMinus()).mul(u.splashOpacity)
    return m
  }

  private disposeMeshes() {
    for (const m of [this.rainMesh, this.snowMesh, this.splashMesh]) {
      if (!m) continue
      m.removeFromParent()
      m.geometry.dispose()
      m.material.dispose()
    }
  }

  /** Removes everything from the scene and frees GPU resources. */
  dispose(): void {
    this.disposeMeshes()
    this.object.removeFromParent()
  }
}

const _v = new Vector3()
