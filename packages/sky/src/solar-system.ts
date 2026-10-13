/**
 * The orbital view: the star (with glow and light), planets and moons with seeded procedural surfaces
 * (or your own materials), rings, atmosphere glows, orbit lines and apsis markers (periapsis/apoapsis,
 * e.g. the moon's perigee and apogee).
 *
 * Draw calls stay flat however many bodies there are: all procedural bodies are one instanced sphere,
 * all rings one instanced ring, all glows one instanced shell, all orbit lines one `LineSegments` and
 * all apsis markers one instanced quad. Per-body data lives in instance attributes.
 *
 * Floating origin: positions are computed in float64 metres in the star frame, then made relative to an
 * origin body (`origin`, plus `originOffset`) before anything reaches the GPU, so the bodies near you
 * are exact. Bodies farther than `maxDistance` from the camera are pulled in along their true direction
 * with their size scaled to match, so they keep their apparent size and stay inside the depth range.
 */
import {
  AdditiveBlending, BufferGeometry, DoubleSide, Float32BufferAttribute, Group, InstancedBufferAttribute, InstancedBufferGeometry,
  LineBasicNodeMaterial, LineSegments, Matrix4, Mesh, MeshBasicNodeMaterial, NodeMaterial, PlaneGeometry, PointLight, Quaternion, RingGeometry,
  Sphere, SphereGeometry, Sprite, SpriteNodeMaterial, Vector3, type Camera, type Material,
} from 'three/webgpu'
import {
  Fn, If, abs, attribute, cameraPosition, cameraProjectionMatrix, cameraViewMatrix, cross, dot, exp, float, length, max, mix, mx_fractal_noise_float,
  mx_worley_noise_float, normalize, positionLocal, pow, sin, smoothstep, uniform, uv, varying, vec3, vec4,
} from 'three/tsl'
import { StarSystem, type Body, type SystemInput } from './bodies.ts'
import { orbitPath } from './kepler.ts'
import { moonAlbedo } from './moon.ts'
import { DEG, hash3, hexToLinear, kelvinToRgb, seedOf, type Vec3 } from './util.ts'

/** Solar-system view settings. Plain JSON. */
export interface SolarSystemSettings {
  /** The star system (ignored when a `StarSystem` instance is passed in). */
  system: SystemInput
  /** Body at the floating origin (render-space 0,0,0). */
  origin: string
  /** Extra offset of the origin from that body, metres (e.g. a spacecraft's position). */
  originOffset: [number, number, number]
  /** Render units per metre (1e-6 = one unit per 1000 km). */
  scale: number
  /** Radius multiplier for planets and moons, so they're visible at system scale. Moon orbits widen by its square root. */
  exaggerateSizes: number
  /** Radius multiplier for the star. */
  exaggerateStar: number
  /** Draw orbit lines. */
  orbitLines: boolean
  /** Orbit line colour (`#rrggbb`). */
  orbitColor: string
  /** Orbit line opacity. */
  orbitOpacity: number
  /** Mark each orbit's periapsis and apoapsis (perigee/apogee, perihelion/aphelion). */
  apsides: boolean
  /** Marker colours for [periapsis, apoapsis] (`#rrggbb`). */
  apsisColors: [string, string]
  /** Marker size, as a fraction of the distance to the camera. */
  apsisSize: number
  /** Beyond this distance from the camera (render units), bodies are pulled in, keeping their apparent size. */
  maxDistance: number
  /** Star glow strength. */
  starGlow: number
  /** Starlight intensity on bodies (and on your own materials, through `light`). */
  starLight: number
  /** Light on the night sides of bodies, 0..1. */
  ambient: number
  /** Names of bodies not to draw (e.g. `'home'` when a planet `World` draws it). */
  hidden: string[]
  /** Sphere segments for bodies. */
  segments: number
}

/** Defaults: one unit per 1000 km, sizes ×200 so planets show up. */
export const DEFAULT_SOLAR_SYSTEM: SolarSystemSettings = {
  system: {},
  origin: 'home',
  originOffset: [0, 0, 0],
  scale: 1e-6,
  exaggerateSizes: 200,
  exaggerateStar: 10,
  orbitLines: true,
  orbitColor: '#8aa4c8',
  orbitOpacity: 0.35,
  apsides: true,
  apsisColors: ['#5ee0ff', '#ffb35e'],
  apsisSize: 0.006,
  maxDistance: 5e6,
  starGlow: 1,
  starLight: 2.5,
  ambient: 0.03,
  hidden: [],
  segments: 64,
}

/** Input for {@link SolarSystem}: any subset of {@link SolarSystemSettings}. */
export type SolarSystemInput = Partial<SolarSystemSettings>

/** Options for the {@link SolarSystem} constructor. */
export interface SolarSystemOptions extends SolarSystemInput {
  /** Share a star system model (e.g. `sky.system`) instead of building one from `system`. */
  model?: StarSystem
  /** Your own materials per body name (instead of the procedural ones; these bodies get their own mesh). */
  materials?: Record<string, Material>
}

/** Where a body is drawn. */
export interface BodyTransform {
  /** Render-space centre. */
  position: Vector3
  /** Body-frame → render rotation (tilt and spin). */
  quaternion: Quaternion
  /** Drawn radius, render units (after exaggeration and distance compression). */
  radius: number
  /** True distance from the camera, render units (before compression). */
  distance: number
}

const STYLES = ['ocean', 'rocky', 'desert', 'gas', 'ice', 'moon'] as const

/** Rotates `v` by quaternion `q` (xyz, w). */
const rotate = (q: any, v: any) => v.add(cross(q.xyz, cross(q.xyz, v).add(v.mul(q.w))).mul(2))

/** Procedural surface colour, chosen per instance by `style` (one branch runs per body). */
function surfaceColor(n: any, style: any, c0: any, c1: any, c2: any, off: any) {
  return Fn(() => {
    const out = vec3(0).toVar()
    const fbm = (p: any, oct = 4) => mx_fractal_noise_float(p, oct, 2, 0.5)
    If(style.lessThan(0.5), () => { // ocean world
      const land = smoothstep(0.02, 0.08, fbm(n.mul(1.8).add(off), 5))
      const ground = mix(c1, c2, smoothstep(-0.1, 0.25, fbm(n.mul(5).add(off.yzx))))
      const ice = smoothstep(0.78, 0.86, abs(n.y).add(fbm(n.mul(6).add(off.zxy)).mul(0.08)))
      out.assign(mix(mix(c0, ground, land), vec3(0.9, 0.93, 0.97), ice))
    }).ElseIf(style.lessThan(2.5), () => { // rocky / desert
      const base = mix(c0, c1, smoothstep(-0.25, 0.3, fbm(n.mul(3).add(off), 5)))
      const craters = smoothstep(0.08, 0.0, mx_worley_noise_float(n.mul(10).add(off)))
      const ice = smoothstep(0.88, 0.95, abs(n.y)).mul(style.greaterThan(1.5).select(0.2, 0.6))
      out.assign(mix(mix(base, c2, craters.mul(0.5)), vec3(0.85), ice))
    }).ElseIf(style.lessThan(4.5), () => { // gas / ice giant bands
      const gas = style.lessThan(3.5)
      const y = n.y.add(fbm(n.mul(vec3(2, 7, 2)).add(off), 4).mul(0.07))
      const bands = sin(y.mul(gas.select(22, 9)).add(off.x)).mul(0.5).add(0.5)
      const fine = sin(y.mul(gas.select(68, 28)).add(off.y)).mul(0.5).add(0.5)
      out.assign(mix(mix(c0, c2, bands), c1, fine.mul(gas.select(0.35, 0.14))))
    }).Else(() => { // moon
      out.assign(vec3(moonAlbedo(n).mul(5.5)).mul(mix(c1, c0, 0.7)))
    })
    return out
  })()
}

/** Instanced attribute helper: `n` items of `size` floats. */
function instanced(geometry: InstancedBufferGeometry, name: string, n: number, size: number) {
  const a = new InstancedBufferAttribute(new Float32Array(Math.max(1, n) * size), size)
  geometry.setAttribute(name, a)
  return a
}

/** Instanced geometry sharing `base`'s index and vertex attributes. */
function instancedFrom(base: BufferGeometry, count: number): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry()
  g.index = base.index
  for (const [k, v] of Object.entries(base.attributes)) g.setAttribute(k, v)
  g.instanceCount = count
  g.boundingSphere = new Sphere(new Vector3(), Infinity)
  return g
}

interface Slot { body: Body; transform: BodyTransform; custom?: Mesh; instance: number; ring: number; glow: number; drawn: Vec3 }

/**
 * Renders a star system for orbital views.
 *
 * @example
 * ```ts
 * const solar = new SolarSystem({ model: sky.system, exaggerateSizes: 300 })
 * scene.add(solar.object)
 * // each frame:
 * solar.update(sky.clock.time, camera)
 * solar.bodyMatrix('home', planetTerrain.matrix) // place a planet World on the home planet
 * ```
 */
export class SolarSystem {
  /** Root group. Add it to your scene. */
  readonly object = new Group()
  /** The star's light (no falloff), placed at the star; lights your own body materials. */
  readonly light = new PointLight(0xffffff, 2.5, 0, 0)
  /** The system being drawn. */
  system: StarSystem
  /** Resolved settings. Change them with {@link SolarSystem.set} / {@link SolarSystem.reset}. */
  settings: SolarSystemSettings = structuredClone(DEFAULT_SOLAR_SYSTEM)
  /** Simulation time of the last update, seconds since J2000. */
  time = 0
  private slots: Slot[] = []
  private readonly sharedModel: boolean
  private readonly materials: Record<string, Material>
  private buildKey = ''
  private systemKey = ''
  private readonly origin: Vec3 = [0, 0, 0]
  private readonly u = {
    starPosition: uniform(new Vector3()),
    starColor: uniform(new Vector3(1, 1, 1)),
    starLight: uniform(2.5),
    ambient: uniform(0.03),
    apsisSize: uniform(0.006),
  }
  private parts: { bodies?: Mesh; rings?: Mesh; glows?: Mesh; star?: Mesh; glow?: Sprite; orbits?: LineSegments; markers?: Mesh } = {}
  private orbitPaths: { slot: Slot; path: Float64Array }[] = []

  /** Creates the view; anything not given uses {@link DEFAULT_SOLAR_SYSTEM}. */
  constructor({ model, materials = {}, ...input }: SolarSystemOptions = {}) {
    this.object.name = 'SolarSystem'
    this.sharedModel = !!model
    this.system = model ?? new StarSystem(input.system)
    this.materials = materials
    this.object.add(this.light)
    this.set(input)
  }

  /** Merges settings. */
  set(input: SolarSystemInput): this {
    for (const [k, v] of Object.entries(input)) if (v !== undefined) (this.settings as any)[k] = structuredClone(v)
    return this.apply()
  }

  /** Replaces all settings; anything not given goes back to {@link DEFAULT_SOLAR_SYSTEM}. */
  reset(input: SolarSystemInput = {}): this {
    this.settings = structuredClone(DEFAULT_SOLAR_SYSTEM)
    return this.set(input)
  }

  /** Swaps the system model (e.g. after `sky.system` was rebuilt). */
  setModel(model: StarSystem): this {
    this.system = model
    this.buildKey = ''
    return this.apply()
  }

  private apply(): this {
    const s = this.settings
    const systemKey = JSON.stringify(s.system)
    if (!this.sharedModel && systemKey !== this.systemKey) {
      if (this.systemKey) this.system = new StarSystem(s.system)
      this.systemKey = systemKey
    }
    const key = `${s.segments}#${JSON.stringify(this.system.bodies)}`
    if (key !== this.buildKey) {
      this.buildKey = key
      this.build()
    }
    const p = this.parts
    if (p.orbits) {
      p.orbits.visible = s.orbitLines
      const m = p.orbits.material as LineBasicNodeMaterial
      m.color.setRGB(...hexToLinear(s.orbitColor))
      m.opacity = s.orbitOpacity
    }
    if (p.markers) p.markers.visible = s.apsides && s.orbitLines
    if (p.glow) (p.glow.material as SpriteNodeMaterial).opacity = s.starGlow
    const star = kelvinToRgb(this.system.star.temperature)
    this.light.color.setRGB(...star)
    this.light.intensity = s.starLight
    this.u.starColor.value.set(...star)
    this.u.starLight.value = s.starLight
    this.u.ambient.value = s.ambient
    this.u.apsisSize.value = s.apsisSize
    this.update(this.time)
    return this
  }

  private build() {
    this.disposeParts()
    const s = this.settings, u = this.u
    const seed = seedOf(this.system.options.seed)
    const sphere = new SphereGeometry(1, s.segments, Math.max(8, s.segments / 2))
    const bodies = this.system.bodies
    const procedural = bodies.filter((b) => b.kind !== 'star' && !this.materials[b.name])
    const ringed = procedural.filter((b) => b.rings)
    const glowing = bodies.filter((b) => b.kind !== 'star' && b.atmosphere)
    this.slots = bodies.map((body) => ({
      body, transform: { position: new Vector3(), quaternion: new Quaternion(), radius: 0, distance: 0 },
      instance: procedural.indexOf(body), ring: ringed.indexOf(body), glow: glowing.indexOf(body), drawn: [0, 0, 0],
    }))

    // Star: emissive sphere + glow sprite.
    const starBody = bodies[0]
    const starMat = new MeshBasicNodeMaterial()
    const tint = vec3(...kelvinToRgb(starBody.temperature))
    starMat.colorNode = tint.mul(mx_fractal_noise_float(normalize(positionLocal).mul(14), 3, 2, 0.5).mul(0.12).add(1)).mul(8)
    const custom = this.materials[starBody.name]
    this.parts.star = new Mesh(sphere, custom ?? starMat)
    const glowMat = new SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending })
    const d = length(uv().sub(0.5)).mul(2)
    glowMat.colorNode = tint.mul(exp(d.mul(-6)).mul(1.5).add(exp(d.mul(-2.2)).mul(0.25))).mul(smoothstep(1, 0.6, d))
    this.parts.glow = new Sprite(glowMat)
    this.object.add(this.parts.star!, this.parts.glow!)

    // Bodies with your own materials: one mesh each.
    for (const slot of this.slots) {
      const m = this.materials[slot.body.name]
      if (m && slot.body.kind !== 'star') {
        slot.custom = new Mesh(sphere, m)
        this.object.add(slot.custom)
      }
    }

    // Every procedural body: one instanced sphere.
    if (procedural.length) {
      const g = instancedFrom(sphere, procedural.length)
      for (const [name, size] of [['aPos', 3], ['aQuat', 4], ['aRadius', 1]] as const) instanced(g, name, procedural.length, size)
      const c0 = instanced(g, 'aColor0', procedural.length, 3), c1 = instanced(g, 'aColor1', procedural.length, 3), c2 = instanced(g, 'aColor2', procedural.length, 3)
      // Style rides in aSeed.w: WebGPU allows at most 8 vertex buffers per pipeline.
      const off = instanced(g, 'aSeed', procedural.length, 4)
      procedural.forEach((b, i) => {
        c0.array.set(hexToLinear(b.colors[0]), i * 3); c1.array.set(hexToLinear(b.colors[1]), i * 3); c2.array.set(hexToLinear(b.colors[2]), i * 3)
        off.array[i * 4 + 3] = Math.max(0, STYLES.indexOf(b.surface as any))
        for (let k = 0; k < 3; k++) off.array[i * 4 + k] = (hash3(seed, b.index, k + 1) / 4294967296) * 100
      })
      const aPos = attribute('aPos', 'vec3'), aQuat = attribute('aQuat', 'vec4'), aRadius = attribute('aRadius', 'float')
      const world = rotate(aQuat, positionLocal.mul(aRadius)).add(aPos)
      const vNormal: any = varying(rotate(aQuat, normalize(positionLocal)))
      const vWorld: any = varying(world)
      const n = normalize(positionLocal) // body frame: features stay put as it spins
      const aSeed = attribute('aSeed', 'vec4')
      const albedo = surfaceColor(n, aSeed.w, attribute('aColor0', 'vec3'), attribute('aColor1', 'vec3'), attribute('aColor2', 'vec3'), aSeed.xyz)
      const toStar: any = normalize(u.starPosition.sub(vWorld))
      const lambert = max(dot(normalize(vNormal), toStar), 0)
      const m = new NodeMaterial()
      m.fog = false
      m.vertexNode = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(world, 1))
      m.colorNode = vec4(albedo.mul(u.starColor.mul(lambert.mul(u.starLight)).add(u.ambient)), 1)
      this.parts.bodies = new Mesh(g, m)
    }

    // Rings: one instanced ring; the unit ring (radius 1..2) is remapped per instance to inner..outer.
    if (ringed.length) {
      const base = new RingGeometry(1, 2, 128, 1).rotateX(-Math.PI / 2)
      const g = instancedFrom(base, ringed.length)
      for (const [name, size] of [['aPos', 3], ['aQuat', 4], ['aRadius', 1], ['aBand', 3], ['aRingColor', 3]] as const) instanced(g, name, ringed.length, size)
      ringed.forEach((b, i) => {
        const r = b.rings!
        g.getAttribute('aBand').array.set([r.inner, r.outer, r.opacity], i * 3)
        g.getAttribute('aRingColor').array.set(hexToLinear(r.color), i * 3)
      })
      const aBand = attribute('aBand', 'vec3')
      const t = length(positionLocal.xz).sub(1) // 0 inner … 1 outer
      const radial = normalize(positionLocal.xz).mul(mix(aBand.x, aBand.y, t)).mul(attribute('aRadius', 'float'))
      const world = rotate(attribute('aQuat', 'vec4'), vec3(radial.x, 0, radial.y)).add(attribute('aPos', 'vec3'))
      const vT = varying(t)
      const rings = mx_fractal_noise_float(vec3(vT.mul(38), float(seed % 997), 0.5), 4, 2.3, 0.6).mul(0.5).add(0.5)
      const gaps = smoothstep(0.08, 0.2, abs(sin(vT.mul(9.3).add(1.7))))
      const lit = u.starLight.mul(0.5).add(u.ambient) // thin rings scatter light about evenly
      const m = new NodeMaterial()
      m.side = DoubleSide; m.transparent = true; m.depthWrite = false; m.fog = false
      m.vertexNode = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(world, 1))
      const alpha = rings.mul(gaps).mul(aBand.z).mul(smoothstep(0, 0.04, vT)).mul(smoothstep(1, 0.95, vT))
      m.colorNode = vec4(attribute('aRingColor', 'vec3').mul(rings.mul(0.5).add(0.6)).mul(lit), alpha)
      this.parts.rings = new Mesh(g, m)
      base.dispose() // its attributes live on in the instanced geometry
    }

    // Atmosphere glows: one instanced shell, rim-lit towards the star.
    if (glowing.length) {
      const g = instancedFrom(sphere, glowing.length)
      for (const [name, size] of [['aPos', 3], ['aRadius', 1], ['aGlow', 4]] as const) instanced(g, name, glowing.length, size)
      glowing.forEach((b, i) => g.getAttribute('aGlow').array.set([...hexToLinear(b.atmosphere!.color), b.atmosphere!.density], i * 4))
      const nrm = normalize(positionLocal)
      const world = nrm.mul(attribute('aRadius', 'float').mul(1.04)).add(attribute('aPos', 'vec3'))
      const vWorld = varying(world), vN = varying(nrm)
      const viewDir = normalize(cameraPosition.sub(vWorld))
      const rim = pow(float(1).sub(max(dot(vN, viewDir), 0)), 3)
      const lit = smoothstep(-0.25, 0.5, dot(vN, normalize(u.starPosition.sub(vWorld))))
      const glow = attribute('aGlow', 'vec4')
      const m = new NodeMaterial()
      m.transparent = true; m.depthWrite = false; m.blending = AdditiveBlending; m.fog = false
      m.vertexNode = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(world, 1))
      m.colorNode = vec4(glow.xyz.mul(rim.mul(lit).mul(glow.w).mul(1.6)), 1)
      this.parts.glows = new Mesh(g, m)
    }

    // Orbit lines: every orbit in one LineSegments buffer, rewritten as parents move.
    this.orbitPaths = this.slots.filter((sl) => sl.body.orbit).map((slot) => ({ slot, path: orbitPath(slot.body.orbit!, 256) }))
    if (this.orbitPaths.length) {
      const segs = this.orbitPaths.length * 256
      const g = new BufferGeometry()
      g.setAttribute('position', new Float32BufferAttribute(new Float32Array(segs * 2 * 3), 3))
      g.boundingSphere = new Sphere(new Vector3(), Infinity)
      this.parts.orbits = new LineSegments(g, new LineBasicNodeMaterial({ transparent: true, depthWrite: false }))
      this.parts.orbits!.frustumCulled = false

      // Apsis markers: one instanced quad, two per orbit, sized to a fraction of their distance.
      const quad = new PlaneGeometry(1, 1)
      const mg = instancedFrom(quad, this.orbitPaths.length * 2)
      instanced(mg, 'aPos', this.orbitPaths.length * 2, 3)
      const kind = instanced(mg, 'aKind', this.orbitPaths.length * 2, 1)
      for (let i = 0; i < this.orbitPaths.length * 2; i++) kind.array[i] = i % 2
      const aPos = attribute('aPos', 'vec3')
      const f = normalize(aPos.sub(cameraPosition))
      const right = normalize(cross(f, vec3(0, 1, 0).add(vec3(1e-4, 0, 0)))), up = cross(right, f)
      const size = length(aPos.sub(cameraPosition)).mul(u.apsisSize)
      const world = aPos.add(right.mul(positionLocal.x).add(up.mul(positionLocal.y)).mul(size))
      const r = length(positionLocal.xy).mul(2)
      const ringShape = smoothstep(1, 0.85, r).mul(smoothstep(0.45, 0.6, r)).add(smoothstep(0.25, 0.1, r))
      const [pc, ac] = s.apsisColors.map((c) => vec3(...hexToLinear(c)))
      const m = new NodeMaterial()
      m.transparent = true; m.depthWrite = false; m.fog = false
      m.vertexNode = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(world, 1))
      m.colorNode = vec4(mix(pc, ac, attribute('aKind', 'float')).mul(2), ringShape)
      this.parts.markers = new Mesh(mg, m)
      quad.dispose()
    }
    for (const part of [this.parts.bodies, this.parts.rings, this.parts.glows, this.parts.orbits, this.parts.markers]) {
      if (part) { part.frustumCulled = false; this.object.add(part) }
    }
  }

  /** Floating-origin position of the origin body (plus offset) at the last update, star frame, metres. */
  get originPosition(): Vec3 {
    return [this.origin[0], this.origin[1], this.origin[2]]
  }

  /** Converts a star-frame position (metres) to render space (no distance compression). */
  toRender(p: Vec3, out = new Vector3()): Vector3 {
    const k = this.settings.scale
    return out.set((p[0] - this.origin[0]) * k, (p[1] - this.origin[1]) * k, (p[2] - this.origin[2]) * k)
  }

  /**
   * Moves everything to `time` (seconds since J2000).
   * @param camera Used for distance compression; omit to draw everything at true distance.
   */
  update(time: number, camera?: Camera): void {
    this.time = time
    const s = this.settings, sys = this.system, parts = this.parts
    const o = sys.position(s.origin, time, this.origin)
    o[0] += s.originOffset[0]; o[1] += s.originOffset[1]; o[2] += s.originOffset[2]
    const cam = camera ? new Vector3().setFromMatrixPosition(camera.matrixWorld) : null
    const spread = Math.sqrt(Math.max(1, s.exaggerateSizes)) // satellites move out so exaggerated planets don't swallow them
    const rot = new Matrix4(), tmp = new Vector3(), q = new Quaternion()
    const bodies = parts.bodies?.geometry as InstancedBufferGeometry | undefined
    const rings = parts.rings?.geometry as InstancedBufferGeometry | undefined
    const glows = parts.glows?.geometry as InstancedBufferGeometry | undefined
    const truePos: Vec3[] = []
    for (const slot of this.slots) {
      const b = slot.body, v = slot.transform
      const t = sys.position(b.index, time)
      const p: Vec3 = [t[0], t[1], t[2]]
      if (b.parentIndex > 0) {
        const pt = truePos[b.parentIndex], pd = this.slots[b.parentIndex].drawn
        for (let k = 0; k < 3; k++) p[k] = pd[k] + (t[k] - pt[k]) * spread
      }
      truePos.push(t)
      slot.drawn = p
      const pos = this.toRender(p, v.position)
      let radius = b.radius * s.scale * (b.kind === 'star' ? s.exaggerateStar : s.exaggerateSizes)
      v.distance = cam ? pos.distanceTo(cam) : pos.length()
      if (cam && v.distance > s.maxDistance) {
        const d = v.distance
        const k = (s.maxDistance * (1 + Math.log(d / s.maxDistance))) / d
        pos.sub(cam).multiplyScalar(k).add(cam)
        radius *= k
      }
      const hidden = s.hidden.includes(b.name)
      v.radius = radius
      const m = sys.orientation(b.index, time)
      rot.set(m[0], m[3], m[6], 0, m[1], m[4], m[7], 0, m[2], m[5], m[8], 0, 0, 0, 0, 1)
      v.quaternion.setFromRotationMatrix(rot)
      const shown = hidden ? 0 : radius
      if (b.kind === 'star') {
        parts.star!.position.copy(pos); parts.star!.scale.setScalar(shown); parts.star!.quaternion.copy(v.quaternion)
        parts.glow!.position.copy(pos); parts.glow!.scale.setScalar(shown * 9)
        this.light.position.copy(pos)
        this.u.starPosition.value.copy(pos)
      }
      if (slot.custom) { slot.custom.position.copy(pos); slot.custom.quaternion.copy(v.quaternion); slot.custom.scale.setScalar(shown); slot.custom.visible = !hidden }
      if (bodies && slot.instance >= 0) {
        bodies.getAttribute('aPos').array.set([pos.x, pos.y, pos.z], slot.instance * 3)
        bodies.getAttribute('aQuat').array.set([v.quaternion.x, v.quaternion.y, v.quaternion.z, v.quaternion.w], slot.instance * 4)
        bodies.getAttribute('aRadius').array[slot.instance] = shown
      }
      if (rings && slot.ring >= 0) {
        // Rings lie in the equator: tilt, but no spin.
        q.setFromRotationMatrix(rot.makeRotationX(-b.axialTilt * DEG))
        rings.getAttribute('aPos').array.set([pos.x, pos.y, pos.z], slot.ring * 3)
        rings.getAttribute('aQuat').array.set([q.x, q.y, q.z, q.w], slot.ring * 4)
        rings.getAttribute('aRadius').array[slot.ring] = shown
      }
      if (glows && slot.glow >= 0) {
        glows.getAttribute('aPos').array.set([pos.x, pos.y, pos.z], slot.glow * 3)
        glows.getAttribute('aRadius').array[slot.glow] = shown
      }
    }
    for (const g of [bodies, rings, glows]) if (g) for (const a of Object.values(g.attributes)) if ((a as any).isInstancedBufferAttribute) (a as InstancedBufferAttribute).needsUpdate = true

    // Orbit lines and apsis markers, around each parent's drawn (uncompressed) position.
    if (parts.orbits) {
      const lines = parts.orbits.geometry.getAttribute('position') as Float32BufferAttribute
      const arr = lines.array as Float32Array
      const marks = (parts.markers!.geometry as InstancedBufferGeometry).getAttribute('aPos') as InstancedBufferAttribute
      this.orbitPaths.forEach(({ slot, path }, i) => {
        const b = slot.body, parent = this.toRender(this.slots[b.parentIndex].drawn, tmp)
        const k = s.scale * (b.parentIndex > 0 ? spread : 1)
        const n = path.length / 3, base = i * n * 6
        for (let j = 0; j < n; j++) {
          const a = j * 3, c = ((j + 1) % n) * 3, w = base + j * 6
          arr[w] = parent.x + path[a] * k; arr[w + 1] = parent.y + path[a + 1] * k; arr[w + 2] = parent.z + path[a + 2] * k
          arr[w + 3] = parent.x + path[c] * k; arr[w + 4] = parent.y + path[c + 1] * k; arr[w + 5] = parent.z + path[c + 2] * k
        }
        // Periapsis is the first path point (E = 0), apoapsis the middle one (E = π).
        const h = (n / 2) * 3
        marks.array.set([parent.x + path[0] * k, parent.y + path[1] * k, parent.z + path[2] * k], i * 6)
        marks.array.set([parent.x + path[h] * k, parent.y + path[h + 1] * k, parent.z + path[h + 2] * k], i * 6 + 3)
      })
      lines.needsUpdate = true
      marks.needsUpdate = true
    }
  }

  /** Where a body is drawn after the last update. @throws If there is no such body. */
  bodyTransform(name: string): BodyTransform {
    const v = this.slots.find((x) => x.body.name === name)
    if (!v) throw new Error(`threejs-sky: no body "${name}"`)
    return v.transform
  }

  /**
   * Matrix placing a body's frame in render space at true scale (`settings.scale`, no exaggeration):
   * body-frame metres → render units. Use it as the matrix of a planet `World` terrain so it sits on
   * (and spins with) the home planet: `terrain.matrixAutoUpdate = false; solar.bodyMatrix('home', terrain.matrix)`.
   */
  bodyMatrix(name: string, target = new Matrix4()): Matrix4 {
    const t = this.bodyTransform(name)
    const s = this.settings.scale
    return target.compose(t.position, t.quaternion, new Vector3(s, s, s))
  }

  private disposeParts() {
    const geometries = new Set<BufferGeometry>()
    const own = (m: Material) => !Object.values(this.materials).includes(m)
    for (const part of [...Object.values(this.parts), ...this.slots.map((s) => s.custom)]) {
      if (!part) continue
      part.removeFromParent()
      geometries.add((part as Mesh).geometry)
      const m = (part as Mesh).material as Material
      if (m && own(m)) m.dispose()
    }
    for (const g of geometries) g?.dispose()
    this.parts = {}
    this.slots = []
  }

  /** Frees GPU resources (your own materials are left alone). */
  dispose(): void {
    this.disposeParts()
    this.light.dispose()
    this.object.removeFromParent()
  }
}
