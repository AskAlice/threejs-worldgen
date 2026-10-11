import {
  AdditiveBlending, ClampToEdgeWrapping, Color, DataTexture, Group, LinearFilter, Mesh, MeshBasicNodeMaterial, PointLight, RGBAFormat,
  UnsignedByteType, Vector3, Vector4, type InstancedBufferAttribute, type InstancedBufferGeometry, type Node,
} from 'three/webgpu'
import { abs, fract, instancedBufferAttribute, length, max, mix, mx_noise_float, normalize, positionGeometry, positionWorld, sin, smoothstep, step, texture, uniform, uv, vec2, vec3 } from 'three/tsl'
import { hash01, seedOf, type DeepPartial } from 'threejs-biomes'
import { FIRE_STATE, FireSim, type FireEnvironment, type FireInput, type FireOptions } from './fire-sim.ts'
import { axisBillboard, createQuadInstances, sphereBillboard } from './particles.ts'
import type { StateField } from './state-field.ts'
import { merge, mod, resolve } from './util.ts'

/** Look of a {@link Wildfire}. Plain JSON. */
export interface WildfireLook {
  /** Flame billboards on burning cells. */
  flames: {
    /** Most flames drawn. */
    max: number
    /** Flames per burning cell at full heat. */
    perCell: number
    /** Flame height at full heat, metres. */
    height: number
    /** Flame width, metres. */
    width: number
    /** Outer colour (`#rrggbb`). */
    color: string
    /** Core colour (`#rrggbb`). */
    core: string
    /** Brightness (additive; > 1 blooms). */
    intensity: number
  }
  /** Smoke puffs rising from burning and freshly burnt cells. */
  smoke: {
    /** Most puffs drawn. */
    max: number
    /** Puffs per burning cell. */
    perCell: number
    /** Puff size when fully grown, metres. */
    size: number
    /** Rise speed, m/s. */
    rise: number
    /** Life of a puff, seconds (also how long burnt cells keep smoking). */
    life: number
    /** Colour (`#rrggbb`). */
    color: string
    /** Opacity. */
    opacity: number
  }
  /** Glowing embers lofted by the fire. */
  embers: {
    /** Most embers drawn. */
    max: number
    /** Embers per burning cell at full heat. */
    perCell: number
    /** Ember size, metres. */
    size: number
    /** Rise speed, m/s. */
    rise: number
    /** Life of an ember, seconds. */
    life: number
    /** Colour (`#rrggbb`). */
    color: string
    /** Brightness. */
    intensity: number
  }
  /** A point light at the fire's heart. */
  light: {
    /** Intensity per unit of total heat (square-rooted). */
    intensity: number
    /** Colour (`#rrggbb`). */
    color: string
    /** Range, metres (0 = infinite). */
    distance: number
  }
}

/** Default wildfire look. */
export const DEFAULT_WILDFIRE_LOOK: WildfireLook = {
  flames: { max: 6000, perCell: 4, height: 3, width: 2.2, color: '#ff5a10', core: '#ffd27a', intensity: 3 },
  smoke: { max: 3000, perCell: 1, size: 16, rise: 2.5, life: 40, color: '#45403b', opacity: 0.4 },
  embers: { max: 4000, perCell: 3, size: 0.09, rise: 3.5, life: 6, color: '#ff8a2a', intensity: 8 },
  light: { intensity: 60, color: '#ff8a3a', distance: 400 },
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
}

/** A wildfire's material-state nodes (see {@link Wildfire.node}). */
export interface FireNodes {
  /** Burn scar 0…1 (the `burn` state). */
  burn: Node<'float'>
  /** Fire intensity 0…1 (the `heat` input: ember glow). */
  heat: Node<'float'>
}

/** Seconds after which the particle animation clock wraps (float32 precision). */
const PERIOD = 3600

/**
 * A rendered wildfire: a {@link FireSim} plus instanced flames, smoke and embers (three draw calls in
 * total), a light at the fire's heart, a data texture of heat and burn scars for other materials
 * ({@link Wildfire.node}), and burn scars written into a {@link StateField}.
 *
 * @example
 * ```ts
 * const fire = new Wildfire({ world, weather, field, center: [0, 0], size: 1024 })
 * scene.add(fire.object)
 * fire.ignite(30, -10)
 * // each frame: fire.update(time); field.update()
 * applyMaterialStatesTo(terrainMaterial, { ...field.node(), heat: fire.node().heat })
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
  /** Light at the fire's heart. */
  readonly light = new PointLight('#ff8a3a', 0, 400, 1)
  /** Per-cell data (R heat, G burn scar, B fuel share, A state / 3), linear filtered. */
  readonly texture: DataTexture
  /** Shader uniforms. */
  readonly uniforms = {
    /** Animation clock (time modulo 3600 s). */ time: uniform(0),
    /** Mean wind over the fire, (x, 0, z) m/s. */ wind: uniform(new Vector3()),
    /** Grid minimum relative to render zero (xy) and size (zw). */ bounds: uniform(new Vector4()),
    /** Flame height. */ flameHeight: uniform(3),
    /** Flame width. */ flameWidth: uniform(2),
    /** Flame colour. */ flameColor: uniform(new Color()),
    /** Flame core colour. */ flameCore: uniform(new Color()),
    /** Flame brightness. */ flameIntensity: uniform(3),
    /** Smoke size. */ smokeSize: uniform(16),
    /** Smoke rise. */ smokeRise: uniform(2.5),
    /** Smoke life. */ smokeLife: uniform(40),
    /** Smoke colour. */ smokeColor: uniform(new Color()),
    /** Smoke opacity. */ smokeOpacity: uniform(0.4),
    /** Ember size. */ emberSize: uniform(0.1),
    /** Ember rise. */ emberRise: uniform(3.5),
    /** Ember life. */ emberLife: uniform(6),
    /** Ember colour. */ emberColor: uniform(new Color()),
    /** Ember brightness. */ emberIntensity: uniform(8),
  }

  private origin: [number, number, number] = [0, 0, 0]
  private flames!: Mesh<InstancedBufferGeometry, MeshBasicNodeMaterial>
  private smoke!: Mesh<InstancedBufferGeometry, MeshBasicNodeMaterial>
  private embers!: Mesh<InstancedBufferGeometry, MeshBasicNodeMaterial>
  private countsKey = ''
  private builtVersion = -1
  private gridKey = ''

  /** Creates a wildfire. Simulation settings not given use `DEFAULT_FIRE`, the look {@link DEFAULT_WILDFIRE_LOOK}. */
  constructor({ world, frame, weather, landscape, field, look, ...fire }: WildfireConfig) {
    this.sim = new FireSim(fire, { world, frame, weather, landscape })
    this.field = field ?? null
    this.look = resolve(DEFAULT_WILDFIRE_LOOK, look)
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

  /** Fire intensity 0…1 at (x, z) (CPU). */
  heatAt(x: number, z: number): number {
    const i = this.sim.index(x, z)
    return i < 0 ? 0 : this.sim.heat(i)
  }

  /** `burn` (scar) and `heat` as TSL nodes at a render-space XZ position (default `positionWorld.xz`). Zero outside the grid. */
  node(xz: Node<'vec2'> = positionWorld.xz): FireNodes {
    const b = this.uniforms.bounds
    const p = xz.sub(b.xy).div(b.zw)
    const inside = step(0, p.x).mul(step(p.x, 1)).mul(step(0, p.y)).mul(step(p.y, 1))
    const s = texture(this.texture, vec2(p.x, p.y))
    return { burn: s.y.mul(inside), heat: s.x.mul(inside) }
  }

  /**
   * Runs the simulation towards `time` seconds and refreshes the particles, texture, light and field.
   * Spends at most `budget` milliseconds simulating per call; a big fire or a fast clock catches up over
   * the next frames instead of stalling one.
   */
  update(time: number, budget = 8): void {
    const sim = this.sim
    sim.runTo(time, budget)
    this.uniforms.time.value = mod(time, PERIOD)
    const gridKey = `${sim.cols}|${sim.minX}|${sim.minZ}|${sim.options.cellSize}`
    if (gridKey !== this.gridKey) {
      this.gridKey = gridKey
      this.texture.image = { data: new Uint8Array(sim.cols * sim.rows * 4), width: sim.cols, height: sim.rows }
      this.texture.dispose()
      this.placeGroup()
      this.builtVersion = -1
    }
    if (sim.version === this.builtVersion) return
    this.builtVersion = sim.version
    this.rebuild()
  }

  private rebuild() {
    const sim = this.sim
    const L = this.look
    const n = sim.cols * sim.rows
    const c = sim.options.cellSize
    const seed = seedOf(sim.options.seed)
    const tex = this.texture.image.data as Uint8Array
    const f = this.writer(this.flames), s = this.writer(this.smoke), e = this.writer(this.embers)
    let heatSum = 0, hx = 0, hz = 0, hy = 0, wx = 0, wz = 0
    for (let i = 0; i < n; i++) {
      const heat = sim.heat(i)
      const scar = sim.scar(i)
      let cap = 0, fuel = 0
      for (let k = 0; k < 3; k++) { cap += sim.capacity[i * 3 + k]; fuel += sim.fuel[i * 3 + k] }
      tex[i * 4] = Math.round(heat * 255)
      tex[i * 4 + 1] = Math.round(scar * 255)
      tex[i * 4 + 2] = Math.round((cap > 0 ? fuel / cap : 0) * 255)
      tex[i * 4 + 3] = sim.state[i] * 85
      const age = sim.burntAge(i)
      const smoke = heat > 0 ? heat : age < L.smoke.life ? 0.6 * (1 - age / L.smoke.life) : 0
      if (heat <= 0 && smoke <= 0) continue
      const [x0, z0] = sim.center(i)
      const lx = x0 - sim.minX, lz = z0 - sim.minZ
      const place = (w: ReturnType<Wildfire['writer']>, k: number, value: number, salt: number) => {
        const x = lx + (hash01(i, k, seed, salt) - 0.5) * c, z = lz + (hash01(i, k, seed, salt + 1) - 0.5) * c
        w.push(x, sim.elevationAt(x + sim.minX, z + sim.minZ), z, value)
      }
      if (heat > 0) {
        const [vx, vz] = sim.windAt(i)
        heatSum += heat; hx += lx * heat; hz += lz * heat; hy += sim.elevation[i] * heat; wx += vx * heat; wz += vz * heat
        for (let k = 0; k < Math.max(1, Math.ceil(L.flames.perCell * heat)); k++) place(f, k, heat, 10)
        for (let k = 0; k < Math.ceil(L.embers.perCell * heat); k++) place(e, k, heat, 20)
      }
      if (sim.state[i] === FIRE_STATE.burning || smoke > 0.05) for (let k = 0; k < L.smoke.perCell; k++) place(s, k, smoke, 30)
    }
    f.done(); s.done(); e.done()
    this.texture.needsUpdate = true
    if (heatSum > 0) {
      this.light.position.set(hx / heatSum, hy / heatSum + 4, hz / heatSum)
      this.uniforms.wind.value.set(wx / heatSum, 0, wz / heatSum)
    }
    this.light.intensity = L.light.intensity * Math.sqrt(heatSum)
    if (this.field) this.writeField()
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

  private writer(mesh: Mesh<InstancedBufferGeometry, MeshBasicNodeMaterial>) {
    const attr = mesh.geometry.getAttribute('aData') as InstancedBufferAttribute
    const out = attr.array as Float32Array
    const max = out.length / 4
    let count = 0
    return {
      push(x: number, y: number, z: number, w: number) {
        if (count >= max) return
        out[count * 4] = x; out[count * 4 + 1] = y; out[count * 4 + 2] = z; out[count * 4 + 3] = w
        count++
      },
      done() {
        mesh.geometry.instanceCount = count
        attr.clearUpdateRanges()
        attr.addUpdateRange(0, count * 4)
        attr.needsUpdate = true
      },
    }
  }

  private placeGroup() {
    this.object.position.set(this.sim.minX - this.origin[0], -this.origin[1], this.sim.minZ - this.origin[2])
    this.uniforms.bounds.value.set(this.sim.minX - this.origin[0], this.sim.minZ - this.origin[2], this.sim.cols * this.sim.options.cellSize, this.sim.rows * this.sim.options.cellSize)
  }

  private applyLook(): this {
    const L = this.look, u = this.uniforms
    u.flameHeight.value = L.flames.height
    u.flameWidth.value = L.flames.width
    u.flameColor.value.set(L.flames.color)
    u.flameCore.value.set(L.flames.core)
    u.flameIntensity.value = L.flames.intensity
    u.smokeSize.value = L.smoke.size
    u.smokeRise.value = L.smoke.rise
    u.smokeLife.value = L.smoke.life
    u.smokeColor.value.set(L.smoke.color)
    u.smokeOpacity.value = L.smoke.opacity
    u.emberSize.value = L.embers.size
    u.emberRise.value = L.embers.rise
    u.emberLife.value = L.embers.life
    u.emberColor.value.set(L.embers.color)
    u.emberIntensity.value = L.embers.intensity
    this.light.color.set(L.light.color)
    this.light.distance = L.light.distance
    const key = JSON.stringify([L.flames.max, L.smoke.max, L.embers.max, this.sim.options.seed])
    if (key !== this.countsKey) {
      this.countsKey = key
      this.disposeMeshes()
      const seed = seedOf(this.sim.options.seed)
      this.flames = this.particleMesh(L.flames.max, seed + 1, 0, (g) => this.flameMaterial(g))
      this.smoke = this.particleMesh(L.smoke.max, seed + 2, -0.5, (g) => this.smokeMaterial(g))
      this.embers = this.particleMesh(L.embers.max, seed + 3, -0.5, (g) => this.emberMaterial(g))
      this.builtVersion = -1
    }
    this.placeGroup()
    return this
  }

  private particleMesh(max: number, seed: number, y0: number, material: (g: InstancedBufferGeometry) => MeshBasicNodeMaterial) {
    const g = createQuadInstances(max, seed, y0, true)
    const mesh = new Mesh(g, material(g))
    mesh.frustumCulled = false // spread over the whole grid; drawn only while something burns
    this.object.add(mesh)
    return mesh
  }

  private attributes(g: InstancedBufferGeometry) {
    return {
      data: instancedBufferAttribute(g.getAttribute('aData') as InstancedBufferAttribute, 'vec4') as Node<'vec4'>,
      rand: instancedBufferAttribute(g.getAttribute('aRand') as InstancedBufferAttribute, 'vec4') as Node<'vec4'>,
    }
  }

  private flameMaterial(g: InstancedBufferGeometry) {
    const u = this.uniforms
    const { data, rand } = this.attributes(g)
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending })
    m.name = 'Flames'
    const heat = data.w
    const lean = normalize(vec3(u.wind.x.mul(0.08), 1, u.wind.z.mul(0.08)))
    m.positionNode = axisBillboard(data.xyz, lean, positionGeometry, u.flameWidth.mul(rand.y.mul(0.6).add(0.7)), u.flameHeight.mul(heat).mul(rand.x.mul(0.8).add(0.6)))
    const p = uv()
    const n = mx_noise_float(vec3(p.x.mul(2.5).add(rand.z.mul(10)), p.y.mul(2).sub(u.time.mul(rand.w.mul(1.2).add(2))), rand.w.mul(7)))
    const across = abs(p.x.sub(0.5).add(n.mul(0.15).mul(p.y))).mul(2)
    const profile = max(p.y.oneMinus().pow(0.6), 0.01)
    const shape = smoothstep(1, 0.55, across.div(profile)).mul(smoothstep(0, 0.08, p.y)).mul(smoothstep(1, 0.7, p.y.add(n.mul(0.25))))
    m.colorNode = mix(u.flameColor, u.flameCore, smoothstep(0.35, 1, shape.mul(p.y.oneMinus()))).mul(u.flameIntensity)
    m.opacityNode = shape
    return m
  }

  private smokeMaterial(g: InstancedBufferGeometry) {
    const u = this.uniforms
    const { data, rand } = this.attributes(g)
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    m.name = 'Smoke'
    const age = fract(u.time.div(u.smokeLife.mul(rand.x.mul(0.4).add(0.8))).add(rand.y))
    const travel = age.mul(u.smokeLife)
    const center = data.xyz.add(vec3(u.wind.x, u.smokeRise, u.wind.z).mul(travel)).add(vec3(rand.z.sub(0.5), 0, rand.w.sub(0.5)).mul(travel).mul(0.3))
    m.positionNode = sphereBillboard(center, positionGeometry, u.smokeSize.mul(age.mul(1.1).add(0.25)))
    const d = length(uv().sub(0.5))
    const puff = smoothstep(0.5, 0.1, d.add(mx_noise_float(vec3(uv().mul(3), rand.x.mul(9).add(age))).mul(0.12)))
    m.colorNode = mix(u.flameColor.mul(0.6), u.smokeColor, smoothstep(0, 0.15, age))
    m.opacityNode = puff.mul(smoothstep(0, 0.08, age)).mul(age.oneMinus()).mul(u.smokeOpacity).mul(data.w)
    return m
  }

  private emberMaterial(g: InstancedBufferGeometry) {
    const u = this.uniforms
    const { data, rand } = this.attributes(g)
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending })
    m.name = 'Embers'
    const age = fract(u.time.div(u.emberLife.mul(rand.x.mul(0.6).add(0.7))).add(rand.y))
    const travel = age.mul(u.emberLife)
    const swirl = vec3(sin(travel.mul(1.7).add(rand.z.mul(30))), 0, sin(travel.mul(1.3).add(rand.w.mul(30)))).mul(1.5)
    const center = data.xyz.add(vec3(u.wind.x, u.emberRise.mul(rand.w.mul(0.8).add(0.6)), u.wind.z).mul(travel)).add(swirl)
    m.positionNode = sphereBillboard(center, positionGeometry, u.emberSize)
    m.colorNode = u.emberColor.mul(u.emberIntensity).mul(age.oneMinus())
    m.opacityNode = smoothstep(0.5, 0.2, length(uv().sub(0.5))).mul(data.w)
    return m
  }

  private disposeMeshes() {
    for (const m of [this.flames, this.smoke, this.embers]) {
      if (!m) continue
      m.removeFromParent()
      m.geometry.dispose()
      m.material.dispose()
    }
  }

  /** Removes the fire from the scene and frees GPU resources. */
  dispose(): void {
    this.disposeMeshes()
    this.texture.dispose()
    this.object.removeFromParent()
  }
}
