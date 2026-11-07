/**
 * Volumetric clouds: a raymarched shell of cloud around the planet, drawn as one camera-pinned
 * far-dome mesh. The shell is seeded 3D noise shaped by a height profile (flat bases, rounded tops),
 * lit by a short march towards the sun through the same density field, so bases fall into shadow,
 * tops catch the sun and the edges glow when you look towards it. Clouds are composited over the
 * already-drawn sky, so the sun disc, the horizon haze and the atmosphere all show through.
 *
 * The weather field (coverage, feature size, wind) is shared with {@link cloudCover}, which you can
 * use to align rain, shadows or gameplay with the cloudy parts of the sky.
 */
import { BackSide, Matrix3, Mesh, NodeMaterial, SphereGeometry, Vector3 } from 'three/webgpu'
import {
  Break,
  Fn,
  If,
  Loop,
  cameraPosition,
  dot,
  exp,
  float,
  length,
  max,
  min,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalize,
  select,
  smoothstep,
  sqrt,
  uniform,
  vec3,
  vec4
} from 'three/tsl'
import { farDomePosition, domeDirection } from './atmosphere.ts'
import type { SkyState } from './observer.ts'
import { surfaceFrame } from './observer.ts'
import {
  hash3,
  hexToLinear,
  merge,
  mulberry32,
  seedOf,
  smoothstep as smooth,
  type DeepPartial,
  type Vec3
} from './util.ts'

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
  /** Seed for the weather field and the cloud noise. */
  seed: number | string
  /** Fraction of the sky covered, 0..1. */
  coverage: number
  /** Optical density multiplier. */
  density: number
  /** Size of weather systems (cloudy vs clear regions), metres. */
  featureSize: number
  /** Cumulus: puffy clusters with flat bases (sets the low deck's base altitude). */
  cumulus: CloudGenus
  /** Stratus: low flat sheets. When `amount > 0` it lowers the low deck's base (both share one slab). */
  stratus: CloudGenus
  /** Cirrus: thin, wind-stretched streaks, drawn as a separate high deck in the same march. */
  cirrus: CloudGenus
  /** Wind as [east, north] metres per second (simulation time). */
  wind: [number, number]
  /** Depth of the cloud layer above its base, metres. */
  depth: number
  /** Ray-march samples through the cloud layer (cost vs. quality). Default 24. */
  steps: number
  /** Samples towards the sun per cloud sample (self-shadowing). Default 4; 3 flattens bases. */
  lightSteps: number
  /** Cloud albedo colour (`#rrggbb`). */
  color: string
  /** Strength of the bright rim when looking towards the sun. */
  silverLining: number
  /** Multiplier on sky (ambient) light. */
  ambient: number
  /** Distance at which clouds fade about two thirds of the way into the horizon haze, metres. */
  haze: number
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
  depth: 2800,
  steps: 24,
  lightSteps: 4,
  color: '#ffffff',
  silverLining: 1,
  ambient: 1,
  haze: 70_000
}

/** Input for {@link Clouds}: any subset of {@link CloudOptions}. */
export type CloudInput = DeepPartial<CloudOptions>

// ---- Seeded value noise (CPU), for the weather field and the cover query ----

function valueNoise(seed: number, x: number, y: number, z: number): number {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    iz = Math.floor(z)
  const fx = x - ix,
    fy = y - iy,
    fz = z - iz
  const u = fx * fx * (3 - 2 * fx),
    v = fy * fy * (3 - 2 * fy),
    w = fz * fz * (3 - 2 * fz)
  const h = (a: number, b: number, c: number) => hash3(a ^ seed, b, c) / 4294967296
  const l = (a: number, b: number, t: number) => a + (b - a) * t
  return l(
    l(l(h(ix, iy, iz), h(ix + 1, iy, iz), u), l(h(ix, iy + 1, iz), h(ix + 1, iy + 1, iz), u), v),
    l(l(h(ix, iy, iz + 1), h(ix + 1, iy, iz + 1), u), l(h(ix, iy + 1, iz + 1), h(ix + 1, iy + 1, iz + 1), u), v),
    w
  )
}

function fbm(seed: number, x: number, y: number, z: number): number {
  let sum = 0,
    amp = 0.5,
    f = 1
  for (let o = 0; o < 5; o++) {
    sum += amp * valueNoise(seed + o * 1013, x * f, y * f, z * f)
    f *= 2.03
    amp *= 0.5
  }
  return sum / 0.97
}

/**
 * Cloud cover 0..1 of the weather field at a point on the planet (any frame, metres), for `genus` 0
 * (cumulus/stratus) or 1 (cirrus). Pure and deterministic; the GPU field is drawn from the same
 * coverage statistic, so this is the field to query for rain or cloud shadows.
 */
export function cloudCover(
  options: Pick<CloudOptions, 'coverage' | 'featureSize'>,
  seed: number,
  p: Vec3,
  genus = 0
): number {
  const s = 1 / Math.max(1, options.featureSize * (genus ? 1.8 : 1))
  const v = fbm(seed + genus * 7919, p[0] * s, p[1] * s, p[2] * s)
  // The fBm is roughly normal (median 0.52, sd 0.09): threshold at the (1 − coverage) quantile, so
  // `coverage` is the fraction of the sky covered.
  const c = Math.min(0.999, Math.max(0.001, options.coverage * (genus ? 0.8 : 1)))
  const t = 0.52 + (0.09 * Math.log((1 - c) / c)) / 1.702
  return smooth(t - 0.03, t + 0.03, v)
}

/**
 * Height signature of a cloud deck at fractional height `h` (0 = base, 1 = top): a hard flat base and a
 * rounded cap. Mirrors the shader's `shape`; keep the two in step.
 */
export function cloudShape(h: number, capFrom = 0.42): number {
  const cap = Math.max(1 - Math.max((h - capFrom) / (1 - capFrom), 0) ** 2, 0)
  return smooth(0, 0.05, h) * Math.sqrt(cap)
}

/** Weather-field threshold for a coverage fraction 0..1, for `genus` 0 (cumulus/stratus) or 1 (cirrus). */
export function coverageThreshold(coverage: number, genus = 0): number {
  const c = Math.min(1, Math.max(0, coverage))
  return genus ? 0.78 - 0.16 * c : 0.62 - 0.32 * c
}

/**
 * Low-deck density 0..1 at fractional height `h`, weather value `n` (0..1), coverage threshold `t` and
 * edge-erosion `bump` 0..1 (the cauliflower detail). Mirrors the shader's `lowDeck`; keep in step.
 */
export function cloudDensity(n: number, t: number, h: number, bump = 0.5): number {
  const cover = smooth(t, t + 0.2, n)
  const erode = Math.max(h, 0) ** 1.45 + (bump - 0.5) * 0.2
  return Math.min(Math.max(cover - erode, 0) * 3, 1) * cloudShape(h)
}

/** Henyey–Greenstein phase at cosine `mu`; forward-peaked for g > 0. */
export function cloudPhase(mu: number, g = 0.6): number {
  return (1 - g * g) / (4 * Math.PI * Math.max(1 + g * g - 2 * g * mu, 1e-4) ** 1.5)
}

/**
 * Sun transmittance through the low deck from fractional height `h`, mirroring the shader's light
 * march: `taps` samples spread over the slab left above the point, Beer–Lambert on each.
 */
export function sunTransmittance(
  h: number,
  density: (h: number) => number,
  { depth = 2800, extinction = 0.0035, sunUp = 1, taps = 4 } = {}
): number {
  const slant = Math.max(sunUp, 0.12)
  const remain = Math.max(1 - h, 0)
  const step = (depth * remain) / (taps * slant) // metres along the sun ray per tap
  let tau = 0
  for (let j = 0; j < taps; j++) tau += density(h + ((j + 0.5) * remain) / taps) * extinction * step
  return Math.exp(-tau)
}

/** Creates the uniforms shared by the cloud dome and the sky. */
export function createCloudUniforms() {
  return {
    /** Render-space planet centre. */
    planetCenter: uniform(new Vector3(0, -6.371e6, 0)),
    /** Planet radius, metres. */
    planetRadius: uniform(6.371e6),
    /** Render → body rotation, so the noise field is fixed to the planet. */
    rotation: uniform(new Matrix3()),
    /** Wind drift in noise units. */
    wind: uniform(new Vector3()),
    /** Seeded offset in noise units (different seeds = different weather). */
    offset: uniform(new Vector3()),
    /** Cloud layer base altitude, metres. */
    base: uniform(1200),
    /** Cloud layer top altitude, metres. */
    top: uniform(4000),
    /** Detail size of the noise (weather system size), metres. */
    feature: uniform(18_000),
    /** Noise threshold: lower = more cloud. */
    threshold: uniform(0.55),
    /** Cirrus deck: base altitude, metres (0 = no cirrus). */
    cirrusBottom: uniform(0),
    /** Cirrus deck: top altitude, metres. */
    cirrusTop: uniform(0),
    /** Cirrus deck: density multiplier (0 = none). */
    cirrusDensity: uniform(0),
    /** Cirrus deck: noise threshold. */
    cirrusThreshold: uniform(0.8),
    /** Detail size of the cirrus noise, metres. */
    cirrusFeature: uniform(32_000),
    /** Horizontal direction of the cirrus streaks in noise space (cos, sin of the wind's bearing). */
    cirrusOrientation: uniform(new Vector3(1, 0, 0)),
    /** Wind drift of the cirrus field in noise units. */
    cirrusWind: uniform(new Vector3()),
    /** Density multiplier. */
    density: uniform(1),
    /** Extinction per metre of density. */
    extinction: uniform(0.0035),
    /** With the sun below this (cosine of the local up), clouds are unlit: dark bases at dusk. */
    sunDirection: uniform(new Vector3(0, 1, 0)),
    /** Sun radiance on clouds. */
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
    /** Master opacity (0 hides the layer). */
    opacity: uniform(1)
  }
}

/** Cloud uniforms (`clouds.uniforms`). */
export type CloudUniforms = ReturnType<typeof createCloudUniforms>

/** Seeded 3D fBm in 0..1, the shape of the cloud field. */
const dense = Fn(([p]: [any]) => mx_fractal_noise_float(p, 3, 2.03, 0.5).mul(0.5).add(0.5))

/** One octave of 0..1 noise: the lobes that erode a cumulus top into cauliflower. */
const lobe = Fn(([p]: [any]) => mx_noise_float(p).mul(0.5).add(0.5))

/** Builds the cloud dome: one camera-pinned sphere, raymarched per pixel. */
function cloudMaterial(u: CloudUniforms, steps: number, lightSteps: number): NodeMaterial {
  const cloud = Fn(() => {
    const d = domeDirection()
    const o = cameraPosition.sub(u.planetCenter)
    const R = u.planetRadius
    // Closest-approach form: exact from the ground and from orbit.
    const b = dot(o, d)
    const p = o.sub(d.mul(b))
    const p2 = dot(p, p)
    const ceiling = max(u.top, u.cirrusTop)
    const rTop = R.add(ceiling),
      rBase = R.add(u.base)
    const hTop2 = rTop.mul(rTop).sub(p2)
    const hBase2 = rBase.mul(rBase).sub(p2)
    const hTop = sqrt(max(hTop2, 0)),
      hBase = sqrt(max(hBase2, 0))
    const tTopNear = b.negate().sub(hTop),
      tTopFar = b.negate().add(hTop)
    const tBaseNear = b.negate().sub(hBase),
      tBaseFar = b.negate().add(hBase)
    const alt = length(o).sub(R)
    const inside = alt.greaterThan(u.base).and(alt.lessThan(ceiling))
    // Below the layer the camera is inside the base sphere: enter the shell where that sphere is exited.
    const start = alt.lessThan(u.base).select(max(tBaseFar, 0), inside.select(float(0), max(tTopNear, 0)))
    const end = hBase2
      .greaterThan(0)
      .and(tBaseNear.greaterThan(start))
      .and(tBaseNear.lessThan(tTopFar))
      .select(tBaseNear, tTopFar)
    const len = min(end.sub(start), float(120_000))

    const trans = float(1).toVar()
    const col = vec3(0).toVar()
    const sunDir = u.sunDirection
    const mu = dot(d, sunDir)
    const g = 0.6
    // Henyey–Greenstein, scaled to cloud range: ~2.7 towards the sun, ~0.5 away from it, so rims are
    // bright but the deck no longer fans out into radiating streaks.
    const phase = float((1 - g * g) / (4 * Math.PI))
      .div(max(float(1 + g * g).sub(mu.mul(2 * g)), 1e-4).pow(1.5))
      .mul(2.8)
      .mul(u.silverLining)
      .add(0.5)
    const sunUp = dot(normalize(o), sunDir)
    const daylight = smoothstep(-0.1, 0.06, sunUp)
    const warm = mix(vec3(1, 0.5, 0.28), vec3(1), smoothstep(0.02, 0.35, sunUp))

    // Signature of a column: hard flat base, dense body, rounded cap.
    const shape = (hb: any) =>
      smoothstep(float(0), float(0.05), hb).mul(
        sqrt(
          max(
            float(1).sub(
              max(hb.sub(0.42), 0)
                .mul(1 / 0.58)
                .pow(2)
            ),
            0
          )
        )
      )
    // Low deck: coverage from the weather field, cut off higher up the column so each column ends at its
    // own rounded height instead of a flat slab. `bump` (0..1) erodes the top into cauliflower lobes.
    const lowDeck = (hb: any, n: any, bump: any) => {
      const cover = smoothstep(u.threshold, u.threshold.add(0.2), n)
      const erode = hb.pow(1.45).add(bump.sub(0.5).mul(0.2))
      return min(max(cover.sub(erode), 0).mul(3), float(1)).mul(shape(hb))
    }
    // Cirrus: wind-aligned streaks. Coordinates are compressed along the flow and expanded across it, so
    // the streaks lie along the wind instead of the render axes (which read as radiating bands).
    const cirrusField = (pos: any) => {
      const q = u.rotation.mul(vec3(pos)).div(u.cirrusFeature)
      const c = u.cirrusOrientation.x,
        s = u.cirrusOrientation.y
      return dense(
        vec3(q.x.mul(c).add(q.z.mul(s)).mul(0.3), q.y.mul(1.8), q.z.mul(c).sub(q.x.mul(s)).mul(2.4))
          .add(u.offset)
          .add(u.cirrusWind)
          .add(vec3(11.7))
      )
    }
    // Thin high sheet: a soft band across the middle of the cirrus deck.
    const cirrusSheet = (hb: any, n: any) =>
      smoothstep(u.cirrusThreshold, u.cirrusThreshold.add(0.14), n)
        .mul(smoothstep(0, 0.4, hb))
        .mul(float(1).sub(smoothstep(0.6, 1, hb)))
        .mul(u.cirrusDensity)
    // Low deck only, for the sun march (cirrus overhead must not shade the cumulus).
    const lowDensityAt = Fn(([pos]: [any]) => {
      const den = float(0).toVar()
      const h = length(pos).sub(R)
      const hb = h.sub(u.base).div(max(u.top.sub(u.base), float(1)))
      If(hb.greaterThan(0).and(hb.lessThan(1)), () => {
        const q = u.rotation.mul(vec3(pos)).div(u.feature).add(u.offset).add(u.wind)
        den.assign(lowDeck(hb, dense(q), lobe(q.mul(6.3).add(37.1))))
      })
      return den
    })
    // Both decks, for the view march.
    const densityAt = Fn(([pos]: [any]) => {
      const den = lowDensityAt(pos).toVar()
      If(u.cirrusDensity.greaterThan(0), () => {
        const h = length(pos).sub(R)
        If(h.greaterThan(u.cirrusBottom).and(h.lessThan(u.cirrusTop)), () => {
          const hb = h.sub(u.cirrusBottom).div(max(u.cirrusTop.sub(u.cirrusBottom), float(1)))
          den.addAssign(cirrusSheet(hb, cirrusField(pos)))
        })
      })
      return den.mul(u.density)
    })

    If(len.greaterThan(0).and(hTop2.greaterThan(0)).and(u.opacity.greaterThan(0)), () => {
      Loop(steps, ({ i }) => {
        const u0 = float(i).div(steps),
          u1 = float(i).add(1).div(steps)
        // Steps grow with distance: detail near the camera, haze far away.
        const t = start.add(len.mul(u0.pow(1.7)))
        const dt = len.mul(u1.pow(1.7).sub(u0.pow(1.7)))
        const pos = p.add(d.mul(t.add(b)))
        const den = densityAt(pos)
        If(den.greaterThan(0.001), () => {
          const h = length(pos).sub(R)
          const hb = min(max(h.sub(u.base).div(max(u.top.sub(u.base), float(1))), float(0)), float(1))
          // Sky shadow ray: the samples span the whole slab left above this point, so the darkness
          // reaches the top of the cloud even when the sun is low (the step grows, the span does not).
          const slant = max(dot(normalize(pos), sunDir), float(0.12))
          const remain = max(float(1).sub(hb), float(0))
          const lightStep = max(u.top.sub(u.base), float(1)).mul(remain).div(float(lightSteps).mul(slant))
          const tau = float(0).toVar()
          Loop(lightSteps, ({ i: j }) => {
            tau.addAssign(lowDensityAt(pos.add(sunDir.mul(lightStep.mul(float(j).add(0.5))))).mul(lightStep))
            If(tau.mul(u.extinction).greaterThan(6), () => {
              Break()
            })
          })
          // Beer–Lambert along the sun ray; the second, much weaker term stands in for multiple
          // scattering, so a shadowed base keeps a dim warm fill instead of going black.
          const sunT = exp(tau.mul(u.extinction).negate())
          const fill = exp(tau.mul(u.extinction).mul(-0.25)).mul(0.22)
          const sunLight = u.sunColor.mul(warm).mul(daylight).mul(phase).mul(sunT.add(fill))
          // Sky light is occluded lower down: a cloud's underside is blue-grey, its top near-white.
          const ambient = u.ambientColor.mul(mix(float(0.4), float(1), hb))
          const moon = u.moonColor.mul(mix(float(0.5), float(1), hb)).mul(0.4)
          const hazeMix = select(u.haze.greaterThan(0), float(1).sub(exp(t.negate().div(u.haze))), float(0)).mul(0.85)
          const lit = mix(u.color.mul(sunLight.add(ambient).add(moon)), u.hazeColor, hazeMix)
          const a = float(1).sub(exp(den.mul(u.extinction).mul(dt).negate()))
          col.addAssign(trans.mul(lit).mul(a))
          trans.mulAssign(float(1).sub(a))
        })
        If(trans.lessThan(0.02), () => {
          Break()
        })
      })
    })

    return vec4(col.mul(u.opacity), float(1).sub(trans).mul(u.opacity))
  })
  const m = new NodeMaterial()
  m.side = BackSide
  m.transparent = true
  m.premultipliedAlpha = true
  m.depthWrite = false
  m.fog = false
  m.vertexNode = farDomePosition()
  m.colorNode = cloud()
  return m
}

/**
 * Volumetric clouds. Created by `Sky` (`sky.clouds`), which drives them every frame; use
 * {@link Clouds.coverAt} to ask how cloudy it is anywhere (e.g. to make it rain under clouds).
 */
export class Clouds {
  /** The cloud dome. Added to the sky's group. */
  readonly object: Mesh
  /** Shared uniforms. */
  readonly uniforms: CloudUniforms = createCloudUniforms()
  /** Resolved settings. Change them with {@link Clouds.set} / {@link Clouds.reset}. */
  settings: CloudOptions = structuredClone(DEFAULT_CLOUDS)
  private seed = 0
  private scale = 1
  private radius = 6.371e6
  private anchor = { up: [0, 1, 0] as Vec3, east: [1, 0, 0] as Vec3, north: [0, 0, -1] as Vec3 }
  private frame: 'local' | 'planet' = 'local'
  private planetCenter: Vec3 = [0, 0, 0]
  private marchKey = ''
  private wind: [number, number] = [0, 0]

  /** Creates the cloud dome; anything not given uses {@link DEFAULT_CLOUDS}. */
  constructor(input: CloudInput = {}) {
    this.object = new Mesh(
      new SphereGeometry(1, 48, 24),
      cloudMaterial(this.uniforms, DEFAULT_CLOUDS.steps, DEFAULT_CLOUDS.lightSteps)
    )
    this.object.name = 'Clouds'
    this.object.frustumCulled = false
    this.object.renderOrder = -999
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
    const o = this.settings,
      u = this.uniforms
    this.seed = seedOf(o.seed)
    const rand = mulberry32(hash3(this.seed, 0xc10d))
    u.offset.value.set(rand() * 512, rand() * 512, rand() * 512)
    u.density.value = o.density
    u.extinction.value = 0.0035
    u.color.value.set(...hexToLinear(o.color))
    u.silverLining.value = o.silverLining
    // Higher coverage lowers the noise threshold (more cloud), the same statistic as `cloudCover`.
    u.threshold.value = coverageThreshold(o.coverage)
    u.cirrusThreshold.value = coverageThreshold(o.coverage, 1)
    u.cirrusDensity.value = o.cirrus.amount > 0 ? Math.min(1.5, o.cirrus.amount) * 0.35 : 0
    this.object.visible = o.enabled
    const marchKey = `${Math.round(o.steps)}|${Math.round(o.lightSteps)}`
    if (marchKey !== this.marchKey) {
      this.marchKey = marchKey
      const old = this.object.material as NodeMaterial
      this.object.material = cloudMaterial(u, Math.max(4, Math.round(o.steps)), Math.max(1, Math.round(o.lightSteps)))
      if (old) old.dispose()
    }
    return this
  }

  /** Point on the planet (body frame, metres) under tangent coordinates (x east, z south) of the anchor. */
  private bodyPoint(x: number, z: number): Vec3 {
    const { up, east, north } = this.anchor,
      R = this.radius
    const p: Vec3 = [
      up[0] * R + east[0] * x - north[0] * z,
      up[1] * R + east[1] * x - north[1] * z,
      up[2] * R + east[2] * x - north[2] * z
    ]
    const l = Math.hypot(p[0], p[1], p[2])
    return [(p[0] / l) * R, (p[1] / l) * R, (p[2] / l) * R]
  }

  /** Tangent coordinates of the anchor from a render-space position. */
  private toTangent(p: Vec3): [number, number] {
    if (this.frame === 'local') return [p[0], p[2]]
    const { up, east, north } = this.anchor,
      R = this.radius
    const r: Vec3 = [
      p[0] - this.planetCenter[0] - up[0] * R,
      p[1] - this.planetCenter[1] - up[1] * R,
      p[2] - this.planetCenter[2] - up[2] * R
    ]
    return [r[0] * east[0] + r[1] * east[1] + r[2] * east[2], -(r[0] * north[0] + r[1] * north[1] + r[2] * north[2])]
  }

  /**
   * Cloud cover 0..1 in the weather field at a render-space position right now (drifting with the
   * wind). Use it to align rain, shadows or gameplay with the clouds.
   */
  coverAt(x: number, y: number, z: number): number {
    const [tx, tz] = this.toTangent([x, y, z])
    return cloudCover(this.scaled(), this.seed, this.fieldPoint(tx - this.wind[0], tz - this.wind[1]))
  }

  private scaled() {
    return { coverage: this.settings.coverage, featureSize: this.settings.featureSize * this.scale }
  }

  /** Where the weather field is sampled for cloud-space tangent coordinates. */
  private fieldPoint(x: number, z: number): Vec3 {
    const { up, east, north } = this.anchor,
      R = this.radius
    return [
      up[0] * R + east[0] * x - north[0] * z,
      up[1] * R + east[1] * x - north[1] * z,
      up[2] * R + east[2] * x - north[2] * z
    ]
  }

  /**
   * Places and lights the clouds for this frame. Called by `Sky`.
   * @param state Sky state (frame, camera position relative to the planet, sun and moon).
   * @param camera Camera position, render space.
   * @param light Radiances (direct sun, moon, sky ambient, haze colour; linear RGB) and `hazeFade` 0..1 (0 above the Kármán line).
   * @param altitudeScale Atmosphere altitude scale (planet radius / Earth radius, or 1).
   */
  update(
    state: SkyState,
    camera: Vec3,
    light: { sun: Vec3; moon: Vec3; ambient: Vec3; haze: Vec3; hazeFade: number },
    altitudeScale: number
  ): void {
    const o = this.settings,
      u = this.uniforms
    if (!o.enabled) return
    this.frame = state.frame
    this.scale = altitudeScale
    this.radius = state.planetRadius
    this.planetCenter = [
      camera[0] - state.cameraToPlanet[0],
      camera[1] - state.cameraToPlanet[1],
      camera[2] - state.cameraToPlanet[2]
    ]
    this.anchor =
      state.frame === 'planet'
        ? surfaceFrame(state.latitude, state.longitude)
        : surfaceFrame(state.latitude, state.longitude)
    const s = altitudeScale
    u.planetCenter.value.set(...this.planetCenter)
    u.planetRadius.value = state.planetRadius
    u.rotation.value.fromArray(state.bodyMatrix)
    // Cumulus and stratus share the low deck; stratus lowers its base when present.
    const low = o.stratus.amount > 0 ? Math.min(o.cumulus.altitude[0], o.stratus.altitude[0]) : o.cumulus.altitude[0]
    u.base.value = low * s
    u.top.value = u.base.value + o.depth * s
    u.feature.value = Math.max(200, o.featureSize * s)
    const cirrus = o.cirrus.amount > 0
    u.cirrusBottom.value = cirrus ? o.cirrus.altitude[0] * s : 0
    u.cirrusTop.value = cirrus ? o.cirrus.altitude[1] * s : 0
    u.cirrusFeature.value = Math.max(200, o.featureSize * 1.6 * s)
    u.sunDirection.value.set(...state.sunDirection)
    u.sunColor.value.set(...light.sun)
    u.moonColor.value.set(...light.moon)
    u.ambientColor.value.set(...light.ambient).multiplyScalar(o.ambient)
    u.hazeColor.value.set(...light.haze)
    u.haze.value = light.hazeFade > 1e-3 ? (o.haze * s) / light.hazeFade : 0
    this.wind = [o.wind[0] * state.time, -o.wind[1] * state.time]
    const f = Math.max(200, o.featureSize * s)
    const fc = Math.max(200, o.featureSize * 1.6 * s)
    u.wind.value.set((this.wind[0] * s) / f, 0, (this.wind[1] * s) / f)
    u.cirrusWind.value.set((this.wind[0] * s) / fc, 0, (this.wind[1] * s) / fc)
    // Cirrus streaks run along the wind, not along the render axes.
    const drift = Math.hypot(this.wind[0], this.wind[1])
    u.cirrusOrientation.value.set(drift > 1e-6 ? this.wind[0] / drift : 1, drift > 1e-6 ? this.wind[1] / drift : 0, 0)
  }

  /** Frees GPU resources. */
  dispose(): void {
    this.object.removeFromParent()
    ;(this.object.material as NodeMaterial).dispose()
    this.object.geometry.dispose()
  }
}
