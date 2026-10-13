/**
 * Sparse Gaussian clouds: volumetric-looking clouds made of a few thousand anisotropic 3D Gaussians
 * ("splats"), seeded and placed in the troposphere by a weather field — cumulus clusters with flat
 * bases and puffy tops, stratus sheets, cirrus streaks up high — drifting with the wind.
 *
 * Each splat is one instance of a camera-facing quad. Its fragment shader integrates the 3D Gaussian
 * analytically along the view ray (so overlapping splats read as volume, not cards), lights it with a
 * cheap single-scattering model (dark bases, bright tops, a forward-scattering silver lining, the
 * planet's shadow at dusk) and fades it into the haze. Splats are depth-sorted on the CPU every few
 * frames and blended back to front.
 *
 * Two layers share one material: a local layer of detailed clusters around the camera (in the tangent
 * plane at the observer, following the planet's curvature) and a global layer of big, flat splats over
 * the whole planet for orbital views. They cross-fade with altitude.
 */
import { DoubleSide, InstancedBufferAttribute, InstancedBufferGeometry, Matrix3, Mesh, NodeMaterial, PlaneGeometry, Sphere, Vector3 } from 'three/webgpu'
import {
  abs, attribute, cameraFar, cameraPosition, cameraProjectionMatrix, cameraViewMatrix, cos, cross, dot, exp, float, length, max, min, mix, normalize,
  positionLocal, select, sin, smoothstep, sqrt, uniform, varying, vec3, vec4,
} from 'three/tsl'
import type { SkyState } from './observer.ts'
import { surfaceFrame } from './observer.ts'
import { hash3, hexToLinear, identity, merge, mulberry32, mulMat, mulVec, rotationY, seedOf, smoothstep as smooth, transpose, type DeepPartial, type Vec3 } from './util.ts'

/** One cloud genus. Plain JSON. */
export interface CloudGenus {
  /** How much of this genus to place, 0..2 (0 = none). */
  amount: number
  /** Base altitude range, metres (Earth scale; scaled with the atmosphere). */
  altitude: [number, number]
  /** Horizontal size range of a cluster, metres. */
  size: [number, number]
}

/** Cloud settings. Plain JSON. */
export interface CloudOptions {
  /** Draw clouds. */
  enabled: boolean
  /** Seed for the weather field and the splats. */
  seed: number | string
  /** Fraction of the sky covered, 0..1. */
  coverage: number
  /** Optical density multiplier. */
  density: number
  /** Size of weather systems (cloudy vs clear regions), metres. */
  featureSize: number
  /** Cumulus: puffy clusters with flat bases. */
  cumulus: CloudGenus
  /** Stratus: low flat sheets where coverage is high. */
  stratus: CloudGenus
  /** Cirrus: thin, wind-stretched streaks high in the troposphere. */
  cirrus: CloudGenus
  /** Wind as [east, north] metres per second (simulation time). */
  wind: [number, number]
  /** Radius around the camera with detailed clouds, metres. */
  range: number
  /** Edge of a placement cell, metres. One cell holds at most one cluster per genus. */
  cellSize: number
  /** Most splats in the detailed layer. */
  maxSplats: number
  /** Splats in the planet-wide layer seen from orbit. */
  globalSplats: number
  /** Cloud albedo colour (`#rrggbb`). */
  color: string
  /** Strength of the bright rim when looking towards the sun. */
  silverLining: number
  /** Multiplier on sky (ambient) light. */
  ambient: number
  /** Distance at which clouds have faded about two thirds of the way into the horizon haze, metres. */
  haze: number
  /** Re-sort splats every this many updates (sorting is what makes the blending right). */
  sortInterval: number
}

/** Fair-weather defaults. */
export const DEFAULT_CLOUDS: CloudOptions = {
  enabled: true,
  seed: 1,
  coverage: 0.35,
  density: 1,
  featureSize: 18_000,
  cumulus: { amount: 1, altitude: [1200, 2200], size: [700, 2200] },
  stratus: { amount: 0.5, altitude: [700, 1500], size: [2500, 5000] },
  cirrus: { amount: 0.6, altitude: [7000, 10_000], size: [3000, 8000] },
  wind: [6, 1.5],
  range: 40_000,
  cellSize: 2500,
  maxSplats: 16_000,
  globalSplats: 20_000,
  color: '#ffffff',
  silverLining: 1,
  ambient: 1,
  haze: 70_000,
  sortInterval: 4,
}

/** Input for {@link Clouds}: any subset of {@link CloudOptions}. */
export type CloudInput = DeepPartial<CloudOptions>

// ---- Seeded value noise (CPU), shared by placement and the cover query ----

function valueNoise(seed: number, x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
  const fx = x - ix, fy = y - iy, fz = z - iz
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz)
  const h = (a: number, b: number, c: number) => hash3(a ^ seed, b, c) / 4294967296
  const l = (a: number, b: number, t: number) => a + (b - a) * t
  return l(
    l(l(h(ix, iy, iz), h(ix + 1, iy, iz), u), l(h(ix, iy + 1, iz), h(ix + 1, iy + 1, iz), u), v),
    l(l(h(ix, iy, iz + 1), h(ix + 1, iy, iz + 1), u), l(h(ix, iy + 1, iz + 1), h(ix + 1, iy + 1, iz + 1), u), v),
    w,
  )
}

function fbm(seed: number, x: number, y: number, z: number): number {
  let sum = 0, amp = 0.5, f = 1
  for (let o = 0; o < 5; o++) {
    sum += amp * valueNoise(seed + o * 1013, x * f, y * f, z * f)
    f *= 2.03; amp *= 0.5
  }
  return sum / 0.97
}

/**
 * Cloud cover 0..1 of a weather field at a point on the planet (body-frame metres, any radius), for
 * `genus` 0 (cumulus/stratus) or 1 (cirrus). Pure and deterministic.
 */
export function cloudCover(options: Pick<CloudOptions, 'coverage' | 'featureSize'>, seed: number, p: Vec3, genus = 0): number {
  const s = 1 / Math.max(1, options.featureSize * (genus ? 1.8 : 1))
  const v = fbm(seed + genus * 7919, p[0] * s, p[1] * s, p[2] * s)
  // The fBm is roughly normal (median 0.52, sd 0.09): threshold at the (1 − coverage) quantile, so
  // `coverage` is the fraction of the sky covered.
  const c = Math.min(0.999, Math.max(0.001, options.coverage * (genus ? 0.8 : 1)))
  const t = 0.52 + (0.09 * Math.log((1 - c) / c)) / 1.702
  return smooth(t - 0.03, t + 0.03, v)
}

/** A placed splat, in tangent coordinates (x east, y altitude, z south) or body coordinates. */
interface Splat { x: number; y: number; z: number; sx: number; sy: number; sz: number; yaw: number; rho: number; h: number }

const SQRT_2PI = Math.sqrt(2 * Math.PI)

/** Splats of one cell (deterministic). `lod` 0 = full detail, 1 = fewer, bigger splats. */
function cellSplats(o: CloudOptions, seed: number, s: number, cx: number, cz: number, lod: number, cover: (x: number, z: number, genus: number) => number): Splat[] {
  const cell = o.cellSize * s
  const rand = mulberry32(hash3(seed, cx, cz))
  const out: Splat[] = []
  const lodK = lod ? 0.4 : 1
  const genera: [CloudGenus, number][] = [[o.cumulus, 0], [o.stratus, 1], [o.cirrus, 2]]
  for (const [g, kind] of genera) {
    const r0 = rand(), r1 = rand(), r2 = rand(), r3 = rand(), r4 = rand()
    if (g.amount <= 0) continue
    const x0 = (cx + 0.15 + 0.7 * r1) * cell, z0 = (cz + 0.15 + 0.7 * r2) * cell
    const c = cover(x0, z0, kind === 2 ? 1 : 0)
    const need = kind === 1 ? smooth(0.55, 0.9, c) : c
    if (r0 > need * Math.min(1, g.amount)) continue
    const size = (g.size[0] + (g.size[1] - g.size[0]) * r3) * s * (kind === 0 ? 0.6 + 0.6 * c : 1)
    const base = (g.altitude[0] + (g.altitude[1] - g.altitude[0]) * r4) * s
    if (kind === 0) {
      // Cumulus: splats filling a dome over a flat base; the base is darker (h = 0), tops bright (h = 1).
      const H = size * (0.45 + 0.4 * c)
      const n = Math.max(4, Math.round((16 + 40 * c) * lodK * Math.max(0.5, g.amount)))
      for (let i = 0; i < n; i++) {
        const a = rand() * 2 * Math.PI, rr = Math.sqrt(rand()) * 0.5 * size
        const top = 1 - (rr / (0.5 * size)) ** 2
        const y = rand() * top
        const sig = size * (0.08 + 0.1 * rand()) / Math.sqrt(lodK)
        out.push({
          x: x0 + Math.cos(a) * rr, y: base + sig * 0.6 + y * H, z: z0 + Math.sin(a) * rr,
          sx: sig, sy: sig * (0.55 + 0.35 * y), sz: sig * (0.8 + 0.4 * rand()), yaw: rand() * Math.PI,
          rho: (1.6 * (0.7 + 0.6 * rand())) / (SQRT_2PI * sig * 0.6), h: y,
        })
      }
    } else if (kind === 1) {
      // Stratus: a few wide, thin sheets.
      const n = Math.max(2, Math.round(5 * lodK * g.amount))
      for (let i = 0; i < n; i++) {
        const sig = size * (0.25 + 0.2 * rand()), sy = (60 + 120 * rand()) * s
        out.push({
          x: x0 + (rand() - 0.5) * size, y: base + rand() * 150 * s, z: z0 + (rand() - 0.5) * size,
          sx: sig, sy, sz: sig * (0.6 + 0.5 * rand()), yaw: rand() * Math.PI, rho: (0.9 * c) / (SQRT_2PI * sy), h: 0.4 + 0.3 * rand(),
        })
      }
    } else {
      // Cirrus: streaks stretched along the wind.
      const yaw = Math.atan2(-o.wind[1], o.wind[0]) + (rand() - 0.5) * 0.5
      const n = Math.max(1, Math.round(4 * lodK * g.amount))
      for (let i = 0; i < n; i++) {
        const sy = (50 + 80 * rand()) * s, sz = (120 + 250 * rand()) * s
        out.push({
          x: x0 + (rand() - 0.5) * size * 0.5, y: base + rand() * 600 * s, z: z0 + (rand() - 0.5) * size * 0.5,
          sx: size * (0.25 + 0.2 * rand()), sy, sz, yaw: yaw + (rand() - 0.5) * 0.3, rho: (0.35 * c) / (SQRT_2PI * Math.min(sy, sz)), h: 0.8,
        })
      }
    }
  }
  return out
}

/** Instanced splat buffers for one layer (sorted copies are what the GPU sees). */
class SplatBuffers {
  readonly geometry = new InstancedBufferGeometry()
  count = 0
  src = { center: new Float32Array(0), axes: new Float32Array(0), params: new Float32Array(0) }
  private dst = { center: new Float32Array(0), axes: new Float32Array(0), params: new Float32Array(0) }
  private order = new Uint32Array(0)
  private keys = new Float32Array(0)

  constructor(quad: PlaneGeometry) {
    this.geometry.index = quad.index
    this.geometry.setAttribute('position', quad.getAttribute('position'))
    this.geometry.boundingSphere = new Sphere(new Vector3(), Infinity)
    this.resize(1)
  }

  resize(n: number) {
    if (n <= this.order.length) return
    const cap = Math.max(n, 256)
    this.src = { center: new Float32Array(cap * 3), axes: new Float32Array(cap * 3), params: new Float32Array(cap * 4) }
    this.dst = { center: new Float32Array(cap * 3), axes: new Float32Array(cap * 3), params: new Float32Array(cap * 4) }
    this.order = new Uint32Array(cap)
    this.keys = new Float32Array(cap)
    this.geometry.setAttribute('aCenter', new InstancedBufferAttribute(this.dst.center, 3))
    this.geometry.setAttribute('aAxes', new InstancedBufferAttribute(this.dst.axes, 3))
    this.geometry.setAttribute('aParams', new InstancedBufferAttribute(this.dst.params, 4))
  }

  /** Sorts back to front by distance from `eye` (positions transformed by `place`) and uploads. */
  sort(eye: Vec3, place: (i: number, out: Vec3) => Vec3) {
    const n = this.count, p: Vec3 = [0, 0, 0]
    for (let i = 0; i < n; i++) {
      place(i, p)
      this.keys[i] = (p[0] - eye[0]) ** 2 + (p[1] - eye[1]) ** 2 + (p[2] - eye[2]) ** 2
      this.order[i] = i
    }
    const keys = this.keys
    this.order.subarray(0, n).sort((a, b) => keys[b] - keys[a])
    const { src, dst } = this
    for (let k = 0; k < n; k++) {
      const i = this.order[k]
      dst.center[k * 3] = src.center[i * 3]; dst.center[k * 3 + 1] = src.center[i * 3 + 1]; dst.center[k * 3 + 2] = src.center[i * 3 + 2]
      dst.axes[k * 3] = src.axes[i * 3]; dst.axes[k * 3 + 1] = src.axes[i * 3 + 1]; dst.axes[k * 3 + 2] = src.axes[i * 3 + 2]
      for (let j = 0; j < 4; j++) dst.params[k * 4 + j] = src.params[i * 4 + j]
    }
    this.geometry.instanceCount = n
    for (const name of ['aCenter', 'aAxes', 'aParams']) (this.geometry.getAttribute(name) as InstancedBufferAttribute).needsUpdate = true
  }

  set(i: number, c: Vec3, s: Splat) {
    this.src.center.set(c, i * 3)
    this.src.axes[i * 3] = s.sx; this.src.axes[i * 3 + 1] = s.sy; this.src.axes[i * 3 + 2] = s.sz
    this.src.params[i * 4] = s.yaw; this.src.params[i * 4 + 1] = s.rho; this.src.params[i * 4 + 2] = s.h; this.src.params[i * 4 + 3] = 0
  }
}

/** Creates the uniforms shared by both cloud layers. */
export function createCloudUniforms() {
  return {
    /** Local layer: render-space drift since the last rebuild. */
    shift: uniform(new Vector3()),
    /** Global layer: body → render rotation including wind drift. */
    rotation: uniform(new Matrix3()),
    /** Render-space planet centre. */
    planetCenter: uniform(new Vector3(0, -6.371e6, 0)),
    /** Planet radius, metres. */
    planetRadius: uniform(6.371e6),
    /** 1 = bend local-layer clouds down with distance (flat local frame). */
    curvature: uniform(1),
    /** Density multiplier. */
    density: uniform(1),
    /** Towards the sun. */
    sunDirection: uniform(new Vector3(0, 1, 0)),
    /** Direct sunlight radiance on clouds. */
    sunColor: uniform(new Vector3(5, 5, 5)),
    /** Moonlight radiance on clouds. */
    moonColor: uniform(new Vector3()),
    /** Sky light radiance on clouds. */
    ambientColor: uniform(new Vector3(0.5, 0.6, 0.8)),
    /** Haze colour (horizon sky). */
    hazeColor: uniform(new Vector3(0.6, 0.7, 0.8)),
    /** Haze distance, metres (0 = none, e.g. in space). */
    haze: uniform(70_000),
    /** Cloud albedo colour. */
    color: uniform(new Vector3(1, 1, 1)),
    /** Silver-lining strength. */
    silverLining: uniform(1),
  }
}

/** Cloud uniforms (`clouds.uniforms`). */
export type CloudUniforms = ReturnType<typeof createCloudUniforms>

/** Builds the splat material; `global` picks the planet-wide layer's placement. */
function splatMaterial(u: CloudUniforms, opacity: any, global: boolean): NodeMaterial {
  const aCenter = attribute('aCenter', 'vec3'), aAxes = attribute('aAxes', 'vec3'), aParams = attribute('aParams', 'vec4')
  let center: any = global ? u.rotation.mul(aCenter).add(u.planetCenter) : aCenter.add(u.shift)
  if (!global) {
    const d = center.xz.sub(cameraPosition.xz)
    center = center.sub(vec3(0, dot(d, d).div(u.planetRadius.mul(2)).mul(u.curvature), 0))
  }
  const up: any = normalize(center.sub(u.planetCenter))
  const ref: any = select(abs(up.y).greaterThan(0.99), vec3(1, 0, 0), vec3(0, 1, 0))
  const t1 = normalize(cross(ref, up)), t2 = cross(up, t1)
  const c = cos(aParams.x), s = sin(aParams.x)
  const e1 = t1.mul(c).add(t2.mul(s)), e3 = t2.mul(c).sub(t1.mul(s))
  // Pull far splats in along the view ray (scaled to match) so they stay inside the far plane.
  const rel = center.sub(cameraPosition)
  const dist = max(length(rel), 1e-3)
  const k = min(float(1), cameraFar.mul(0.9).div(dist))
  const placed = cameraPosition.add(rel.mul(k))
  const axes = aAxes.mul(k)
  const f = rel.div(dist)
  const ref2: any = select(abs(f.y).greaterThan(0.99), vec3(1, 0, 0), vec3(0, 1, 0))
  const right = normalize(cross(f, ref2)), billUp = cross(right, f)
  const size = max(axes.x, max(axes.y, axes.z)).mul(3)
  const world = placed.add(right.mul(positionLocal.x).add(billUp.mul(positionLocal.y)).mul(size.mul(2)))

  const v = (x: any): any => varying(x)
  const vWorld = v(world), vCenter = v(placed), vE1 = v(e1), vUp = v(up), vE3 = v(e3)
  const vAxes = v(axes), vRho = v(aParams.y.div(k)), vH = v(aParams.z), vDist = v(dist), vSize = v(size)

  const dir = normalize(vWorld.sub(cameraPosition))
  const o = cameraPosition.sub(vCenter)
  const oL = vec3(dot(o, vE1).div(vAxes.x), dot(o, vUp).div(vAxes.y), dot(o, vE3).div(vAxes.z))
  const dL = vec3(dot(dir, vE1).div(vAxes.x), dot(dir, vUp).div(vAxes.y), dot(dir, vE3).div(vAxes.z))
  const dd = max(dot(dL, dL), 1e-20), od = dot(oL, dL)
  const perp = oL.sub(dL.mul(od.div(dd))) // closest approach in splat space: stable even from orbit
  const m2 = dot(perp, perp)
  // ∫ exp(-½|o' + t d'|²) dt = √(2π)/|d'| · exp(-½ m²): the splat's optical depth along this pixel's ray.
  const tau = vRho.mul(u.density).mul(SQRT_2PI).div(sqrt(dd)).mul(exp(m2.mul(-0.5)))
  const near = smoothstep(vSize.mul(0.25), vSize.mul(0.9), length(o)) // fade splats the camera flies through
  // The planet may be drawn analytically by the sky dome (no depth): hide splats behind it ourselves.
  const tSplat = od.negate().div(dd)
  const op = cameraPosition.sub(u.planetCenter)
  const pb = dot(op, dir)
  const pp = op.sub(dir.mul(pb))
  const ph2 = u.planetRadius.mul(u.planetRadius).sub(dot(pp, pp))
  const tPlanet = pb.negate().sub(sqrt(max(ph2, 0)))
  const hidden = ph2.greaterThan(0).and(tPlanet.greaterThan(0)).and(tPlanet.lessThan(tSplat))
  const alpha = float(1).sub(exp(tau.negate())).mul(near).mul(opacity).mul(hidden.select(0, 1)).clamp(0, 1)

  const p = cameraPosition.add(dir.mul(tSplat))
  const n = normalize(p.sub(vCenter))
  const sunUp = dot(vUp, u.sunDirection)
  const daylight = smoothstep(-0.12, 0.03, sunUp)
  const dusk = mix(vec3(1, 0.42, 0.18), vec3(1), smoothstep(0, 0.3, sunUp))
  const direct = u.sunColor.mul(dusk).mul(daylight).mul(vH.mul(0.7).add(0.3)).mul(dot(n, u.sunDirection).mul(0.18).add(0.82))
  const g = 0.75, mu = dot(dir, u.sunDirection)
  const hg = float((1 - g * g) / (4 * Math.PI)).div(max(float(1 + g * g).sub(mu.mul(2 * g)), 1e-4).pow(1.5))
  const silver = u.sunColor.mul(dusk).mul(daylight).mul(hg).mul(u.silverLining).mul(float(1).sub(alpha).mul(1.5).add(0.15))
  const lit = u.color.mul(direct.add(u.ambientColor.mul(vH.mul(0.45).add(0.55))).add(u.moonColor.mul(vH.mul(0.6).add(0.4)))).add(silver)
  const hz = select(u.haze.greaterThan(0), float(1).sub(exp(vDist.negate().div(max(u.haze, 1)))), float(0))
  const col: any = mix(lit, u.hazeColor, hz)

  const m = new NodeMaterial()
  m.transparent = true
  m.premultipliedAlpha = true
  m.depthWrite = false
  m.side = DoubleSide
  m.fog = false
  m.vertexNode = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(world, 1))
  m.colorNode = vec4(col.mul(alpha), alpha)
  return m
}

/**
 * Sparse Gaussian clouds. Created by `Sky` (`sky.clouds`), which drives them every frame; use
 * {@link Clouds.coverAt} to ask how cloudy it is anywhere (e.g. to make it rain under clouds).
 */
export class Clouds {
  /** Both layers. Added to the sky's group. */
  readonly object: Mesh[]
  /** Shared uniforms. */
  readonly uniforms: CloudUniforms = createCloudUniforms()
  /** Resolved settings. Change them with {@link Clouds.set} / {@link Clouds.reset}. */
  settings: CloudOptions = structuredClone(DEFAULT_CLOUDS)
  private readonly quad = new PlaneGeometry(1, 1)
  private readonly local = new SplatBuffers(this.quad)
  private readonly global = new SplatBuffers(this.quad)
  private readonly localOpacity = uniform(1)
  private readonly globalOpacity = uniform(0)
  private seed = 0
  private scale = 1
  private radius = 6.371e6
  private anchor = { up: [0, 1, 0] as Vec3, east: [1, 0, 0] as Vec3, north: [0, 0, -1] as Vec3 }
  private frame: 'local' | 'planet' = 'local'
  private planetCenter: Vec3 = [0, 0, 0]
  private builtKey = ''
  private settingsKey = ''
  private globalKey = ''
  private base: [number, number] = [0, 0] // wind drift (tangent metres) the local layer was built at
  private wind: [number, number] = [0, 0]
  private frameCount = 0
  private time = 0

  /** Creates both layers; anything not given uses {@link DEFAULT_CLOUDS}. */
  constructor(input: CloudInput = {}) {
    const local = new Mesh(this.local.geometry, splatMaterial(this.uniforms, this.localOpacity, false))
    const global = new Mesh(this.global.geometry, splatMaterial(this.uniforms, this.globalOpacity, true))
    local.name = 'CloudsLocal'
    global.name = 'CloudsGlobal'
    for (const m of [local, global]) { m.frustumCulled = false; m.renderOrder = 10 }
    global.renderOrder = 9
    this.object = [global, local]
    this.set(input)
  }

  /** Merges settings. */
  set(input: CloudInput): this {
    merge(this.settings, input)
    return this.apply()
  }

  /** Replaces all settings; anything not given goes back to {@link DEFAULT_CLOUDS}. */
  reset(input: CloudInput = {}): this {
    this.settings = merge(structuredClone(DEFAULT_CLOUDS), input)
    return this.apply()
  }

  private apply(): this {
    const o = this.settings, u = this.uniforms
    this.seed = seedOf(o.seed)
    u.density.value = o.density
    u.color.value.set(...hexToLinear(o.color))
    u.silverLining.value = o.silverLining
    for (const m of this.object) m.visible = o.enabled
    const key = JSON.stringify(o)
    if (key !== this.settingsKey) {
      this.settingsKey = key
      this.builtKey = this.globalKey = '' // rebuild on the next update
    }
    return this
  }

  /** Point on the planet (body frame, metres) under tangent coordinates (x east, z south) of the anchor. */
  private bodyPoint(x: number, z: number): Vec3 {
    const { up, east, north } = this.anchor, R = this.radius
    const p: Vec3 = [up[0] * R + east[0] * x - north[0] * z, up[1] * R + east[1] * x - north[1] * z, up[2] * R + east[2] * x - north[2] * z]
    const l = Math.hypot(p[0], p[1], p[2])
    return [(p[0] / l) * R, (p[1] / l) * R, (p[2] / l) * R]
  }

  /**
   * Where the weather field is sampled for cloud-space tangent coordinates: the tangent plane itself
   * (not projected onto the sphere), so wind drift of any size stays exact.
   */
  private fieldPoint(x: number, z: number): Vec3 {
    const { up, east, north } = this.anchor, R = this.radius
    return [up[0] * R + east[0] * x - north[0] * z, up[1] * R + east[1] * x - north[1] * z, up[2] * R + east[2] * x - north[2] * z]
  }

  /** Tangent coordinates → render space (on the planet's curve in the planet frame). */
  private toRender(x: number, y: number, z: number, out: Vec3): Vec3 {
    if (this.frame === 'local') { out[0] = x; out[1] = y; out[2] = z; return out }
    const b = this.bodyPoint(x, z), k = (this.radius + y) / this.radius
    out[0] = b[0] * k + this.planetCenter[0]; out[1] = b[1] * k + this.planetCenter[1]; out[2] = b[2] * k + this.planetCenter[2]
    return out
  }

  /** Render position → tangent coordinates of the anchor. */
  private toTangent(p: Vec3): [number, number] {
    if (this.frame === 'local') return [p[0], p[2]]
    const { up, east, north } = this.anchor, R = this.radius
    const r: Vec3 = [p[0] - this.planetCenter[0] - up[0] * R, p[1] - this.planetCenter[1] - up[1] * R, p[2] - this.planetCenter[2] - up[2] * R]
    return [r[0] * east[0] + r[1] * east[1] + r[2] * east[2], -(r[0] * north[0] + r[1] * north[1] + r[2] * north[2])]
  }

  /**
   * Cloud cover 0..1 at a render-space position right now (low clouds; the same field the splats are
   * placed from, drifting with the wind). Use it to align rain, shadows or gameplay with the clouds.
   */
  coverAt(x: number, y: number, z: number): number {
    const [tx, tz] = this.toTangent([x, y, z])
    return cloudCover(this.scaled(), this.seed, this.fieldPoint(tx - this.wind[0], tz - this.wind[1]))
  }

  private scaled() {
    return { coverage: this.settings.coverage, featureSize: this.settings.featureSize * this.scale }
  }

  /**
   * Places and lights the clouds for this frame. Called by `Sky`.
   * @param state Sky state (frame, camera position relative to the planet, sun and moon).
   * @param camera Camera position, render space.
   * @param light Radiances (direct sun, moon, sky ambient, haze colour; linear RGB) and `hazeFade` 0..1 (0 above the Kármán line).
   * @param altitudeScale Atmosphere altitude scale (planet radius / Earth radius, or 1).
   * @param troposphere Tropopause altitude (for the orbital cross-fade), metres.
   * @param anchor Latitude/longitude the detailed layer's tangent plane is anchored at (planet frame).
   */
  update(state: SkyState, camera: Vec3, light: { sun: Vec3; moon: Vec3; ambient: Vec3; haze: Vec3; hazeFade: number }, altitudeScale: number, troposphere: number, anchor: [number, number]): void {
    const o = this.settings, u = this.uniforms
    if (!o.enabled) return
    this.time = state.time
    this.frame = state.frame
    this.scale = altitudeScale
    this.radius = state.planetRadius
    const pc: Vec3 = [camera[0] - state.cameraToPlanet[0], camera[1] - state.cameraToPlanet[1], camera[2] - state.cameraToPlanet[2]]
    this.planetCenter = pc
    this.anchor = state.frame === 'planet' ? surfaceFrame(anchor[0], anchor[1]) : surfaceFrame(state.latitude, state.longitude)
    u.planetCenter.value.set(...pc)
    u.planetRadius.value = state.planetRadius
    u.curvature.value = state.frame === 'local' ? 1 : 0
    u.sunDirection.value.set(...state.sunDirection)
    u.sunColor.value.set(...light.sun)
    u.moonColor.value.set(...light.moon)
    u.ambientColor.value.set(...light.ambient).multiplyScalar(o.ambient)
    u.hazeColor.value.set(...light.haze)
    u.haze.value = light.hazeFade > 1e-3 ? (o.haze * altitudeScale) / light.hazeFade : 0
    this.wind = [o.wind[0] * state.time, -o.wind[1] * state.time] // tangent metres; north wind moves towards −z

    const alt = state.altitude
    this.localOpacity.value = 1 - smooth(troposphere * 2, troposphere * 6, alt)
    this.globalOpacity.value = smooth(troposphere * 1.5, troposphere * 5, alt)
    this.object[1].visible = this.localOpacity.value > 0
    this.object[0].visible = this.globalOpacity.value > 0

    if (this.object[1].visible) this.updateLocal(camera)
    if (this.object[0].visible) this.updateGlobal(state, camera)
    this.frameCount++
  }

  private updateLocal(camera: Vec3) {
    const o = this.settings, s = this.scale
    const cell = o.cellSize * s
    const [tx, tz] = this.toTangent(camera)
    const cx = Math.floor((tx - this.wind[0]) / cell), cz = Math.floor((tz - this.wind[1]) / cell)
    const drift = Math.hypot(this.wind[0] - this.base[0], this.wind[1] - this.base[1])
    const key = `${cx},${cz},${this.frame},${this.radius},${s},${this.anchor.up.join()}`
    if (key !== this.builtKey || drift > cell * 0.5) {
      this.builtKey = key
      this.base = [this.wind[0], this.wind[1]]
      const range = o.range * s, rc = Math.ceil(range / cell)
      const cover = (x: number, z: number, g: number) => cloudCover(this.scaled(), this.seed, this.fieldPoint(x, z), g)
      const splats: Splat[] = []
      for (let j = -rc; j <= rc; j++) for (let i = -rc; i <= rc; i++) {
        const d = Math.hypot(i, j) * cell
        if (d > range) continue
        for (const sp of cellSplats(o, this.seed, s, cx + i, cz + j, d > range * 0.45 ? 1 : 0, cover)) splats.push(sp)
      }
      const n = Math.min(splats.length, o.maxSplats)
      this.local.resize(n)
      const p: Vec3 = [0, 0, 0]
      for (let i = 0; i < n; i++) {
        const sp = splats[i]
        this.local.set(i, this.toRender(sp.x + this.base[0], sp.y, sp.z + this.base[1], p), sp)
      }
      this.local.count = n
      this.sortLocal(camera)
    } else if (this.frameCount % Math.max(1, o.sortInterval) === 0) this.sortLocal(camera)
    // Drift since the build, as a render-space offset.
    const dx = this.wind[0] - this.base[0], dz = this.wind[1] - this.base[1]
    const { east, north } = this.frame === 'local' ? { east: [1, 0, 0], north: [0, 0, -1] } : this.anchor
    this.uniforms.shift.value.set(east[0] * dx - north[0] * dz, east[1] * dx - north[1] * dz, east[2] * dx - north[2] * dz)
  }

  private sortLocal(camera: Vec3) {
    const c = this.local.src.center, sh = this.uniforms.shift.value
    this.local.sort(camera, (i, out) => { out[0] = c[i * 3] + sh.x; out[1] = c[i * 3 + 1] + sh.y; out[2] = c[i * 3 + 2] + sh.z; return out })
  }

  private updateGlobal(state: SkyState, camera: Vec3) {
    const o = this.settings, s = this.scale, R = this.radius
    const key = `${this.seed},${R},${s},${o.globalSplats},${o.coverage},${o.featureSize},${o.cumulus.altitude}`
    if (key !== this.globalKey) {
      this.globalKey = key
      const rand = mulberry32(hash3(this.seed, 0x6106a1))
      const n = Math.max(0, Math.round(o.globalSplats))
      this.global.resize(n)
      const alt = ((o.cumulus.altitude[0] + o.cumulus.altitude[1]) / 2) * s
      let count = 0
      for (let tries = 0; count < n && tries < n * 30; tries++) {
        const y = rand() * 2 - 1, a = rand() * 2 * Math.PI, c = Math.sqrt(1 - y * y)
        const dir: Vec3 = [c * Math.sin(a), y, c * Math.cos(a)]
        const cover = cloudCover(this.scaled(), this.seed, [dir[0] * R, dir[1] * R, dir[2] * R])
        if (rand() > cover * cover) continue
        const sig = R * (0.0014 + 0.0036 * rand()), sy = 1500 * s
        // Zonal winds stretch weather systems east–west: yaw 0 puts the long axis along the local east.
        this.global.set(count++, [dir[0] * (R + alt), dir[1] * (R + alt), dir[2] * (R + alt)], {
          x: 0, y: 0, z: 0, sx: sig * (1.2 + 0.8 * rand()), sy, sz: sig, yaw: (rand() - 0.5) * 0.6, rho: (1.4 * cover) / (SQRT_2PI * sy), h: 0.5 + 0.5 * rand(),
        })
      }
      this.global.count = count
    }
    // Body → render, with the zonal wind turning the layer about the pole.
    const toRender = state.frame === 'planet' ? identity() : transpose(state.bodyMatrix)
    const theta = (o.wind[0] * state.time) / Math.max(1, R)
    const rot = mulMat(toRender, rotationY(theta))
    this.uniforms.rotation.value.fromArray(rot)
    if (this.frameCount % Math.max(1, o.sortInterval * 2) === 0 || this.global.geometry.instanceCount !== this.global.count) {
      const c = this.global.src.center, pc = this.planetCenter
      this.global.sort(camera, (i, out) => {
        mulVec(rot, [c[i * 3], c[i * 3 + 1], c[i * 3 + 2]], out)
        out[0] += pc[0]; out[1] += pc[1]; out[2] += pc[2]
        return out
      })
    }
  }

  /** Frees GPU resources. */
  dispose(): void {
    for (const m of this.object) { m.removeFromParent(); (m.material as NodeMaterial).dispose() }
    this.local.geometry.dispose()
    this.global.geometry.dispose()
    this.quad.dispose()
  }
}
