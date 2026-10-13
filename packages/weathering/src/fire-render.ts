import { ClampToEdgeWrapping, DataTexture, Group, LinearFilter, PointLight, RGBAFormat, UnsignedByteType, Vector3, Vector4, type Camera, type ComputeNode, type Node, type Object3D, type Renderer } from 'three/webgpu'
import { positionWorld, step, uniform } from 'three/tsl'
import { bloom as bloomNode } from 'three/addons/tsl/display/BloomNode.js'
import { ParticleGrid, ParticleLighting, ParticleSystem, blackbodyColor, type ParticleInput } from 'threejs-particles'
import type { DeepPartial } from 'threejs-biomes'
import { FireSim, type FireEnvironment, type FireInput, type FireOptions } from './fire-sim.ts'
import { collectFireSources, createFireSources, plumeOcclusion, smokeTransmittance, type FireSources } from './fire-front.ts'
import { smoothSample } from './sampling.ts'
import type { StateField } from './state-field.ts'
import { merge, resolve } from './util.ts'

/** Look of a {@link Wildfire}. Plain JSON. Particle counts, quality steps, `haze.enabled` and `grid` rebuild the particle systems. */
export interface WildfireLook {
  /** Flame tongues from the active front: velocity-stretched, noise-shaped, blackbody-coloured. */
  flames: {
    /** Most flame particles alive (GPU pool). */
    max: number
    /** Flames per second per unit of front intensity. */
    rate: number
    /** Flame width in grass, metres (shrubs and trees scale it up). */
    size: number
    /** Height / width of a flame tongue. */
    height: number
    /** Life range, seconds (short: flames lick and vanish). */
    life: [number, number]
    /** Temperature range at the base, kelvin (≈ 1100 K deep red … 1800 K orange-yellow; radiance ∝ T⁴, hotter is whiter). */
    temperature: [number, number]
    /** HDR brightness multiplier. */
    intensity: number
    /** Flaming time scale, seconds, for 1 kg/m² of fuel (heavier fuel flames longer; Gaussian fall-off). */
    flaming: number
    /** Tree flames spawn up to this high: crown fire, metres. */
    crownHeight: number
    /** Curl-noise turbulence, m/s² (licking and flicker). */
    turbulence: number
  }
  /** The smoke plume: lit, alpha-blended, depth-sorted volumetric puffs that rise and bend downwind. */
  smoke: {
    /** Most smoke particles alive. */
    max: number
    /** Puffs per second per unit of smoke weight. */
    rate: number
    /** Puff size at birth, metres (grows over life). */
    size: number
    /** Life range, seconds. */
    life: [number, number]
    /** Buoyancy (how hard hot smoke rises). */
    rise: number
    /** Opacity multiplier. */
    opacity: number
    /** Albedo of clean smoke: wet, fresh or light fuel (`#rrggbb`). */
    clean: string
    /** Albedo of dirty smoke: heavy, dry, woody fuel (`#rrggbb`). */
    dirty: string
    /** Seconds burnt-out cells keep giving off faint wisps. */
    linger: number
    /** Per-pixel self-shadow taps towards the sun (0…4). */
    shadowSteps: number
    /** Per-particle shadow steps through the plume's density grid (0…8). */
    lightSteps: number
    /** Per-pixel noise detail 0…1. */
    detail: number
    /** Height above the front (metres) where an intense fire's plume caps into bright pyrocumulus. 0 = never. */
    capHeight: number
    /** Front intensity (sum over cells) above which the plume caps. */
    capIntensity: number
  }
  /** Embers: thin bright streaks lofted by the plume and carried downwind, cooling as they go. */
  embers: {
    /** Most embers alive. */
    max: number
    /** Embers per second per unit of front intensity (woody fuel throws more). */
    rate: number
    /** Ember width, metres. */
    size: number
    /** Life range, seconds. */
    life: [number, number]
    /** HDR brightness. */
    intensity: number
  }
  /** Screen-space heat haze above the front (refraction). Off by default. */
  haze: {
    /** Draw it. */
    enabled: boolean
    /** Most haze particles. */
    max: number
    /** Refraction strength (fraction of the screen). */
    strength: number
  }
  /** Ground glow, written into the `heat` texture channel other materials read. */
  glow: {
    /** At the flaming front, 0…1. */
    front: number
    /** Sparse smouldering spots inside the burn, 0…1. */
    smoulder: number
  }
  /** A flickering point light at the front. Colour follows the flames' blackbody temperature. */
  light: {
    /** Intensity per unit of front intensity (square-rooted). */
    intensity: number
    /** Range, metres (0 = infinite). */
    distance: number
    /** Flicker depth 0…1. */
    flicker: number
  }
  /** The coarse plume grid: heat lifts the smoke into a column; density self-shadows it. */
  grid: {
    /** Use a grid (costs three small compute passes per frame). */
    enabled: boolean
    /** Cells along x, y, z. */
    resolution: [number, number, number]
    /** Height above the fire's highest ground, metres. */
    height: number
  }
  /** Optional bloom for your post pipeline (see {@link Wildfire.bloom}). Off by default. */
  bloom: {
    /** Add bloom in {@link Wildfire.bloom}. */
    enabled: boolean
    /** Strength. */
    strength: number
    /** Radius 0…1. */
    radius: number
    /** HDR threshold (only flames and embers bloom). */
    threshold: number
  }
}

/** Default wildfire look (about 30k GPU particles in total). */
export const DEFAULT_WILDFIRE_LOOK: WildfireLook = {
  flames: { max: 10000, rate: 10, size: 1.6, height: 2.6, life: [0.5, 1.2], temperature: [1750, 2100], intensity: 0.45, flaming: 25, crownHeight: 10, turbulence: 7 },
  smoke: { max: 10000, rate: 2.5, size: 40, life: [45, 90], rise: 0.4, opacity: 0.6, clean: '#e6e3de', dirty: '#5a4d42', linger: 240, shadowSteps: 2, lightSteps: 4, detail: 1, capHeight: 300, capIntensity: 40 },
  embers: { max: 5000, rate: 6, size: 0.05, life: [2, 7], intensity: 5 },
  haze: { enabled: false, max: 1500, strength: 0.006 },
  glow: { front: 0.9, smoulder: 0.35 },
  light: { intensity: 40, distance: 500, flicker: 0.35 },
  grid: { enabled: true, resolution: [40, 24, 40], height: 900 },
  bloom: { enabled: false, strength: 0.35, radius: 0.4, threshold: 1.2 },
}

/** Partial settings for {@link Wildfire}: simulation settings plus the look. */
export type WildfireInput = FireInput & {
  /** Look to change. */
  look?: DeepPartial<WildfireLook>
}

/** Construction options for {@link Wildfire}. */
export interface WildfireConfig extends WildfireInput, FireEnvironment {
  /** A state field to write burn scars into (its `burn` channel, inside the fire region). */
  field?: StateField | null
  /** The WebGPU renderer for the particle compute passes. Default: picked up from the first render. */
  renderer?: Renderer | null
  /** Camera for particle sorting and smoke occlusion. Default: picked up from the first render. */
  camera?: Camera | null
}

/** A wildfire's material-state nodes (see {@link Wildfire.node}). */
export interface FireNodes {
  /** Burn scar 0…1 (the `burn` state). */
  burn: Node<'float'>
  /** Ground glow 0…1: a band at the flaming front, sparse spots in the smouldering interior (the `heat` input). */
  heat: Node<'float'>
  /** Share 0…1 of white ash vs black char (heavy fuel burnt right through; the `ash` input). */
  ash: Node<'float'>
}

/** The fire's particle systems. */
export interface WildfireSystems {
  /** Flame tongues. */
  flames: ParticleSystem
  /** Smoke plume. */
  smoke: ParticleSystem
  /** Embers. */
  embers: ParticleSystem
  /** Heat haze (when `look.haze.enabled`). */
  haze: ParticleSystem | null
}

/**
 * A rendered wildfire: a {@link FireSim} drawn with `threejs-particles` GPU systems. Flames and embers
 * come only from the active front (recently ignited cells, weighted by intensity), smoke from the front
 * plus wisps from smouldering and freshly burnt ground; a coarse grid carries the fire's heat up into a
 * plume that bends downwind and self-shadows. Also a flickering light at the front, a data texture of
 * ground glow, burn scars and ash for other materials ({@link Wildfire.node}), burn scars written into a
 * {@link StateField}, and a smoke-occlusion estimate for sky and lighting.
 *
 * @example
 * ```ts
 * const fire = new Wildfire({ world, weather, field, renderer, camera, center: [0, 0], size: 1024 })
 * scene.add(fire.object)
 * fire.ignite(30, -10)
 * // each frame: fire.update(time); field.update()
 * applyMaterialStatesTo(terrainMaterial, { ...field.node(), ...fire.node() })
 * pipeline.outputNode = fire.bloom(pass(scene, camera))        // with look.bloom.enabled
 * ```
 */
export class Wildfire {
  /** Add this to your scene. */
  readonly object = new Group()
  /** The simulation. */
  readonly sim: FireSim
  /** Resolved look. */
  look: WildfireLook
  /** State field receiving burn scars, if any. */
  field: StateField | null
  /** Light at the front. */
  readonly light = new PointLight('#ff8a3a', 0, 500, 1.6)
  /** Per-cell data (R ground glow, G burn scar, B ash share, A front intensity), linear filtered. */
  readonly texture: DataTexture
  /** Sun and sky light the smoke is lit by (filled from the scene every update). */
  readonly lighting = new ParticleLighting()
  /** Shader uniforms. */
  readonly uniforms = {
    /** Grid minimum relative to render zero (xy) and size (zw). */ bounds: uniform(new Vector4()),
    /** Mean wind over the front, (x, 0, z) m/s. */ wind: uniform(new Vector3()),
    /** How much the plume dims the sun at the camera, 0…1 (see {@link Wildfire.smokeOcclusionAt}). */ smokeOcclusion: uniform(0),
  }
  /** The particle systems (rebuilt when counts or quality change). */
  systems!: WildfireSystems
  /** The plume grid, if `look.grid.enabled`. */
  grid: ParticleGrid | null = null

  private renderer: Renderer | null
  private camera: Camera | null
  private root: Object3D | null = null
  private origin: [number, number, number] = [0, 0, 0]
  private sources: FireSources
  private splats: ComputeNode[] = []
  private structureKey = ''
  private builtVersion = -1
  private gridKey = ''
  private lastNow = -1
  private clock = 0
  private bloomPass: ReturnType<typeof bloomNode> | null = null

  /** Creates a wildfire. Simulation settings not given use `DEFAULT_FIRE`, the look {@link DEFAULT_WILDFIRE_LOOK}. */
  constructor({ world, frame, weather, landscape, field, look, renderer, camera, ...fire }: WildfireConfig) {
    this.sim = new FireSim(fire, { world, frame, weather, landscape })
    this.field = field ?? null
    this.renderer = renderer ?? null
    this.camera = camera ?? null
    this.look = resolve(DEFAULT_WILDFIRE_LOOK, look)
    this.sources = createFireSources(0)
    this.texture = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat, UnsignedByteType)
    this.texture.magFilter = this.texture.minFilter = LinearFilter
    this.texture.wrapS = this.texture.wrapT = ClampToEdgeWrapping
    this.object.name = 'Wildfire'
    this.object.add(this.light)
    this.applyLook()
  }

  /** Simulation settings (see `FireSim.options`). */
  get options(): FireOptions {
    return this.sim.options
  }

  /** Merges `input` (simulation settings and/or `look`) into the current settings. */
  set(input: WildfireInput): this {
    const { look, ...fire } = input
    if (Object.keys(fire).length) this.sim.set(fire)
    if (look) this.look = merge(this.look, look)
    return this.applyLook()
  }

  /** Replaces all settings (anything not given goes back to defaults). Scheduled ignitions are kept unless given. */
  reset(input: WildfireInput = {}): this {
    const { look, ...fire } = input
    this.sim.reset({ ignitions: this.sim.options.ignitions, ...fire })
    this.look = resolve(DEFAULT_WILDFIRE_LOOK, look)
    return this.applyLook()
  }

  /** Starts a fire at (x, z) (frame coordinates); see `FireSim.ignite`. */
  ignite(x: number, z: number, radius?: number, time?: number): this {
    this.sim.ignite(x, z, radius, time)
    return this
  }

  /** Sets the frame position at render-space zero (floating origin), `[x, y, z]`. */
  setOrigin(origin: readonly number[]): this {
    this.origin = [origin[0], origin[1] ?? 0, origin[2] ?? 0]
    this.placeGroup()
    return this
  }

  /** Uses this renderer and camera for the particle passes (otherwise they are picked up from the first render). */
  attach(renderer: Renderer | null, camera?: Camera | null): this {
    this.renderer = renderer
    if (camera !== undefined) this.camera = camera
    return this
  }

  /** Ground glow 0…1 at (x, z) (CPU). */
  heatAt(x: number, z: number): number {
    const i = this.sim.index(x, z)
    return i < 0 ? 0 : (this.sources.texture[i * 4] ?? 0) / 255
  }

  /**
   * How much the smoke plume dims the sun at frame position (x, z), 0…1 (a Gaussian plume from the
   * front, bent downwind). Sky and lighting can read it, or the live {@link Wildfire.uniforms}
   * `smokeOcclusion` at the camera.
   */
  smokeOcclusionAt(x: number, z: number): number {
    const s = this.sources
    if (s.front <= 0) return 0
    return plumeOcclusion(x, z, s.center[0] + this.sim.minX, s.center[2] + this.sim.minZ, s.wind[0], s.wind[1], s.smokeTotal)
  }

  /** Sunlight transmittance (linear RGB) through the plume at (x, z): dims and reddens. */
  sunTransmittance(x: number, z: number, out: [number, number, number] = [1, 1, 1]): [number, number, number] {
    return smokeTransmittance(this.smokeOcclusionAt(x, z), out)
  }

  /**
   * `burn`, `heat` and `ash` as TSL nodes at a render-space XZ position (default `positionWorld.xz`),
   * zero outside the grid. Sampled with a smooth, slightly warped filter so cell edges never show.
   */
  node(xz: Node<'vec2'> = positionWorld.xz): FireNodes {
    const b = this.uniforms.bounds
    const p = xz.sub(b.xy).div(b.zw)
    const inside = step(0, p.x).mul(step(p.x, 1)).mul(step(0, p.y)).mul(step(p.y, 1))
    const s = smoothSample(this.texture, p, b.zw, xz, this.sim.options.cellSize) as Node<'vec4'>
    return { burn: s.y.mul(inside), heat: s.x.mul(inside), ash: s.z.mul(inside) }
  }

  /**
   * Adds bloom to a post-processing colour node when `look.bloom.enabled` (else returns it unchanged).
   * Rebuild your pipeline's output node after toggling `enabled`; strength, radius and threshold are live.
   */
  bloom(color: Node<'vec4'>): Node<'vec4'> {
    const L = this.look.bloom
    if (!L.enabled) return color
    this.bloomPass = bloomNode(color, L.strength, L.radius, L.threshold)
    return color.add(this.bloomPass) as Node<'vec4'>
  }

  /**
   * Runs the simulation towards `time` seconds, refreshes the sources, texture, light and field, and
   * advances the GPU particles by `dt` real seconds (default: measured). Spends at most `budget`
   * milliseconds simulating per call; a big fire or a fast clock catches up over the next frames.
   */
  update(time: number, budget = 8, dt?: number): void {
    const sim = this.sim
    sim.runTo(time, budget)
    const now = performance.now()
    const step = dt ?? (this.lastNow < 0 ? 0 : Math.min(0.1, (now - this.lastNow) / 1000))
    this.lastNow = now
    this.clock = (this.clock + step) % 3600
    const gridKey = `${sim.cols}|${sim.minX}|${sim.minZ}|${sim.options.cellSize}`
    if (gridKey !== this.gridKey) {
      this.gridKey = gridKey
      this.sources = createFireSources(sim.cols * sim.rows)
      this.texture.image = { data: this.sources.texture, width: sim.cols, height: sim.rows }
      this.texture.dispose()
      this.placeGroup()
      this.structureKey = '' // grid bounds follow the sim
      this.applyLook()
      this.builtVersion = -1
    }
    if (sim.version !== this.builtVersion) {
      this.builtVersion = sim.version
      this.rebuild()
    }
    this.animate(step)
  }

  private rebuild() {
    const s = collectFireSources(this.sim, { flaming: this.look.flames.flaming, crownHeight: this.look.flames.crownHeight, linger: this.look.smoke.linger, frontGlow: this.look.glow.front, smoulderGlow: this.look.glow.smoulder }, this.sources)
    this.texture.needsUpdate = true
    const sys = this.systems
    sys.flames.setSources(s.flames, s.flameCount)
    sys.embers.setSources(s.flames === s.embers ? s.flames : s.embers, s.emberCount)
    sys.smoke.setSources(s.smoke, s.smokeCount)
    sys.haze?.setSources(s.flames, s.flameCount)
    this.uniforms.wind.value.set(s.wind[0], 0, s.wind[1])
    for (const p of [sys.flames, sys.smoke, sys.embers, sys.haze]) p?.uniforms.wind.value.set(s.wind[0], 0, s.wind[1])
    for (const p of [sys.flames, sys.smoke, sys.embers]) p.uniforms.emitPosition.value.y = s.center[1]
    sys.smoke.uniforms.capHeight.value = s.front >= this.look.smoke.capIntensity ? this.look.smoke.capHeight : 0
    if (this.grid) this.grid.uniforms.velocity.value.set(s.wind[0], this.grid.options.rise, s.wind[1])
    if (this.field) this.writeField()
  }

  private animate(dt: number) {
    const s = this.sources, L = this.look
    // Flickering light at the front, coloured by the flames' mean blackbody temperature.
    const t = this.clock
    const flicker = 1 + L.light.flicker * (0.5 * Math.sin(t * 11.3) + 0.3 * Math.sin(t * 17.9 + 1.3) + 0.2 * Math.sin(t * 29.1 + 2.1)) * 0.6
    if (s.front > 0) this.light.position.set(s.center[0], s.center[1] + 6, s.center[2])
    const kelvin = L.flames.temperature[0] + (L.flames.temperature[1] - L.flames.temperature[0]) * Math.min(1, s.front / Math.max(1, this.sources.flameCount) * 1.5)
    const [r, g, b] = blackbodyColor(kelvin * 0.85)
    this.light.color.setRGB(r, g, b)
    this.light.intensity = L.light.intensity * Math.sqrt(s.front) * flicker

    const renderer = this.renderer
    if (!renderer) return
    if (!this.root) {
      let root: Object3D = this.object
      while (root.parent) root = root.parent
      if (root !== this.object) this.root = root
    }
    if (this.root) this.lighting.fromScene(this.root)
    if (this.camera) {
      this.camera.updateMatrixWorld()
      const e = this.camera.matrixWorld.elements
      this.uniforms.smokeOcclusion.value = this.smokeOcclusionAt(e[12] + this.origin[0], e[14] + this.origin[2])
    }
    // One batched compute submission: every system's emit + update, then the grid's splats and resolve.
    const sys = this.systems
    const nodes: ComputeNode[] = []
    for (const p of [sys.haze, sys.smoke, sys.flames, sys.embers]) if (p) nodes.push(...p.prepare(renderer, dt, this.camera))
    if (this.grid) nodes.push(...this.splats, ...this.grid.resolvePasses(dt))
    if (nodes.length) renderer.compute(nodes)
    sys.smoke.sort(renderer)
  }

  // Burn scars into the field's `burn` channel wherever the fire grid covers it.
  private writeField() {
    const field = this.field!
    const sim = this.sim
    const fn = field.options.resolution, t = field.texel
    const x1 = sim.minX + sim.cols * sim.options.cellSize, z1 = sim.minZ + sim.rows * sim.options.cellSize
    const i0 = Math.max(0, Math.floor((sim.minX - field.minX) / t)), i1 = Math.min(fn - 1, Math.floor((x1 - field.minX) / t))
    const j0 = Math.max(0, Math.floor((sim.minZ - field.minZ) / t)), j1 = Math.min(fn - 1, Math.floor((z1 - field.minZ) / t))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = sim.index(field.minX + (i + 0.5) * t, field.minZ + (j + 0.5) * t)
      if (k >= 0) field.data[(j * fn + i) * 4 + 2] = sim.scar(k)
    }
    field.touch()
  }

  private placeGroup() {
    this.object.position.set(this.sim.minX - this.origin[0], -this.origin[1], this.sim.minZ - this.origin[2])
    this.uniforms.bounds.value.set(this.sim.minX - this.origin[0], this.sim.minZ - this.origin[2], this.sim.cols * this.sim.options.cellSize, this.sim.rows * this.sim.options.cellSize)
  }

  private applyLook(): this {
    const L = this.look
    this.light.distance = L.light.distance
    const key = JSON.stringify([L.flames.max, L.smoke.max, L.embers.max, L.haze.enabled, L.haze.max, L.smoke.shadowSteps, L.smoke.lightSteps, L.grid, this.sim.options.seed, this.sim.cols])
    if (key !== this.structureKey) {
      this.structureKey = key
      this.build()
      this.builtVersion = -1
    }
    const s = this.systems
    s.flames.set(this.flameOptions())
    s.smoke.set(this.smokeOptions())
    s.embers.set(this.emberOptions())
    s.haze?.set(this.hazeOptions())
    if (this.bloomPass) {
      this.bloomPass.strength.value = L.bloom.strength
      this.bloomPass.radius.value = L.bloom.radius
      this.bloomPass.threshold.value = L.bloom.threshold
    }
    this.placeGroup()
    return this
  }

  private build() {
    this.disposeSystems()
    const L = this.look, sim = this.sim
    const span = sim.cols * sim.options.cellSize
    this.grid = null
    if (L.grid.enabled) {
      let lo = Infinity, hi = -Infinity
      for (let i = 0; i < sim.elevation.length; i++) { lo = Math.min(lo, sim.elevation[i]); hi = Math.max(hi, sim.elevation[i]) }
      if (!Number.isFinite(lo)) lo = hi = 0
      const pad = span * 0.6
      this.grid = new ParticleGrid({
        resolution: L.grid.resolution, min: [-pad, lo - 10, -pad], size: [span + pad * 2, hi - lo + 10 + L.grid.height, span + pad * 2],
        advect: [1, 0, 0, 0], decay: [0.012, 0, 0, 0], rise: 5,
      })
    }
    const base = { seed: sim.options.seed, grid: this.grid, lighting: this.lighting, maxSources: Math.min(8192, sim.cols * sim.rows) }
    const sys: WildfireSystems = {
      flames: new ParticleSystem({ ...base, ...this.flameOptions(), capacity: L.flames.max, render: { ...this.flameOptions().render, shading: 'flame', blending: 'premultiplied' } }),
      smoke: new ParticleSystem({ ...base, ...this.smokeOptions(), capacity: L.smoke.max, render: { ...this.smokeOptions().render, shading: 'smoke', blending: 'alpha', sort: true, shadowSteps: L.smoke.shadowSteps, lightSteps: L.smoke.lightSteps } }),
      embers: new ParticleSystem({ ...base, ...this.emberOptions(), capacity: L.embers.max, render: { ...this.emberOptions().render, shading: 'spark', blending: 'additive' } }),
      haze: L.haze.enabled ? new ParticleSystem({ ...base, grid: null, ...this.hazeOptions(), capacity: L.haze.max, render: { ...this.hazeOptions().render, shading: 'haze', blending: 'alpha' } }) : null,
    }
    // Draw order: haze refracts the opaque scene, then smoke, then additive flames and embers on top.
    sys.haze && (sys.haze.object.renderOrder = 1)
    sys.smoke.object.renderOrder = 2
    sys.flames.object.renderOrder = 3
    sys.embers.object.renderOrder = 4
    for (const p of [sys.haze, sys.smoke, sys.flames, sys.embers]) if (p) this.object.add(p.object)
    // Capture the renderer and camera from the first render if they weren't given.
    sys.flames.object.onBeforeRender = (renderer, _scene, camera) => {
      this.renderer ??= renderer as unknown as Renderer
      this.camera ??= camera
    }
    this.systems = sys
    this.splats = []
    if (this.grid) {
      const g = this.grid
      this.splats.push(g.splat(sys.flames, 0, (p) => p.temperature.sub(400).max(0).div(1200).mul(0.0015))) // heat per second
      const cell = g.cellSize()
      const cellVolume = cell.x * cell.y * cell.z
      this.splats.push(g.splat(sys.smoke, 1, (p) => p.size.mul(p.size).mul(p.size).mul(0.12 / cellVolume).mul(p.t.oneMinus())))
    }
  }

  private flameOptions(): ParticleInput {
    const F = this.look.flames, c = this.sim.options.cellSize
    return {
      seed: this.sim.options.seed, rate: F.rate, maxPerFrame: 4096, life: F.life,
      emitter: { shape: 'sources', size: [c * 0.5, 0.2, c * 0.5], velocity: [0, 1.5, 0], spread: 0.8, temperature: F.temperature },
      forces: { gravity: 0, buoyancy: 0.32, ambientTemperature: 300, cooling: 1.1, windShear: 0.2, drag: 2.4, turbulence: F.turbulence, turbulenceScale: 2.5, turbulenceSpeed: 1.4, gridLift: 0 },
      curves: { size: [0.55, 1, 0.9, 0.6], opacity: [0, 1, 0.9, 0.5, 0], color: ['#ffffff'] },
      render: { size: F.size, sizeRandom: [0.45, 1.7], aspect: F.height, stretch: 0.12, intensity: F.intensity, blackbody: true, softness: 1.5, detail: 1, detailDistance: 900 },
    }
  }

  private smokeOptions(): ParticleInput {
    const S = this.look.smoke, c = this.sim.options.cellSize
    return {
      seed: `${this.sim.options.seed}-smoke`, rate: S.rate, maxPerFrame: 1024, life: S.life,
      emitter: { shape: 'sources', size: [c * 0.5, 1, c * 0.5], velocity: [0, 2.5, 0], spread: 0.8, temperature: [520, 620] },
      forces: { gravity: 0, buoyancy: S.rise, ambientTemperature: 290, cooling: 0.018, windShear: 0.5, drag: 0.18, turbulence: 2.2, turbulenceScale: 45, turbulenceSpeed: 0.05, gridLift: 3 },
      curves: { size: [0.5, 0.9, 1.4, 2, 2.7, 3.4], opacity: [0, 0.75, 0.9, 0.8, 0.5, 0], color: ['#ffffff'] },
      render: {
        size: S.size, sizeRandom: [0.75, 1.3], aspect: 1, stretch: 0, opacity: S.opacity, softness: 6, detail: S.detail, detailDistance: 1600,
        absorption: 1.6, anisotropy: 0.5, silverLining: 0.35, albedo: [S.clean, S.dirty], glow: '#ff6420', glowStrength: 1.6,
      },
    }
  }

  private emberOptions(): ParticleInput {
    const E = this.look.embers, c = this.sim.options.cellSize
    return {
      seed: `${this.sim.options.seed}-embers`, rate: E.rate, maxPerFrame: 2048, life: E.life,
      emitter: { shape: 'sources', size: [c * 0.5, 1, c * 0.5], velocity: [0, 5, 0], spread: 4.5, temperature: [1500, 1900] },
      forces: { gravity: 3.2, buoyancy: 0.05, ambientTemperature: 300, cooling: 0.32, windShear: 0.7, drag: 0.9, turbulence: 10, turbulenceScale: 7, turbulenceSpeed: 0.6, gridLift: 2.5 },
      curves: { size: [1], opacity: [0, 1, 1, 0.7, 0], color: ['#ffffff'] },
      render: { size: E.size, sizeRandom: [0.6, 1.4], aspect: 1, stretch: 0.07, intensity: E.intensity, blackbody: true, softness: 0.3, detail: 0 },
    }
  }

  private hazeOptions(): ParticleInput {
    const H = this.look.haze, c = this.sim.options.cellSize
    return {
      seed: `${this.sim.options.seed}-haze`, rate: 0.8, maxPerFrame: 512, life: [0.8, 1.8],
      emitter: { shape: 'sources', size: [c * 0.5, 0, c * 0.5], velocity: [0, 3, 0], spread: 0.5, temperature: [300, 300] },
      forces: { gravity: 0, buoyancy: 0, drag: 0.5, turbulence: 2, turbulenceScale: 4, turbulenceSpeed: 0.5, gridLift: 0 },
      curves: { size: [0.8, 1.2], opacity: [0, 1, 0.8, 0], color: ['#ffffff'] },
      render: { size: 7, sizeRandom: [0.8, 1.2], aspect: 1.6, stretch: 0, refraction: H.strength, softness: 2, detail: 1, detailDistance: 250 },
    }
  }

  private disposeSystems() {
    const s = this.systems
    if (!s) return
    for (const p of [s.flames, s.smoke, s.embers, s.haze]) p?.dispose()
    for (const n of this.splats) n.dispose()
    this.grid?.dispose()
  }

  /** Removes the fire from the scene and frees GPU resources. */
  dispose(): void {
    this.disposeSystems()
    this.texture.dispose()
    this.object.removeFromParent()
  }
}
