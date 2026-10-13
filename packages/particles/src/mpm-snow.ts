// MPM snow (Stomakhin et al. 2013, "A material point method for snow simulation"): fixed-corotated elasticity,
// plasticity that clamps the singular values of the elastic deformation gradient, and hardening of the Lamé
// parameters with compaction. Registered as the `snow` material, with presets, and a surface renderer that turns
// the particles into a lit, compacting snow cover.
import { BufferAttribute, BufferGeometry, Color, Mesh, MeshSSSNodeMaterial, StorageBufferAttribute, type ComputeNode, type Renderer } from 'three/webgpu'
import {
  Fn, If, abs, atomicAdd, atomicLoad, atomicMax, atomicStore, bool, clamp, determinant, float, floor, instanceIndex, instancedArray, int, ivec2, mat3, max, min, mix,
  positionGeometry, positionWorld, select, smoothstep, length, fwidth, normalize, dot, normalWorld, mx_noise_float, sqrt, cos, sin, fract, hash, step, storage, transformNormalToView, uniform, varying, vec2, vec3, vec4, vertexIndex,
} from 'three/tsl'
import { registerMPMMaterial, type Mat3, type MPMMaterial } from './mpm-materials.ts'
import { MPM_FIXED } from './mpm-reference.ts'
import type { MPMSolver } from './mpm.ts'
import { NODE_OPS, NUMBER_OPS, mat3Scalars, scalarsMat3, svd3Generic, usvGeneric, type MPMOps } from './mpm-svd.ts'

/** Parameters of the {@link SNOW} material (plain JSON numbers; live uniforms in a solver). */
export interface SnowParams extends Record<string, number> {
  /** Density at rest, kg/m³ (sets the particle mass): fresh powder 50–200, settled 200–400, wet or packed 400–600. */
  density: number
  /** Young's modulus E₀ of uncompacted snow, pascals. */
  youngs: number
  /** Poisson's ratio ν. */
  poisson: number
  /** Critical compression θc: singular values of F below 1 − θc turn into plastic compaction. */
  compression: number
  /** Critical stretch θs: singular values above 1 + θs turn into plastic stretch (fracture). */
  stretch: number
  /** Hardening ξ: the Lamé parameters scale by exp(ξ(1 − Jp)), so compacted snow stiffens and stretched snow crumbles. */
  hardening: number
  /**
   * Cap on that hardening factor. Real-time bound: the stable time step shrinks with the square root of the stiffness,
   * so {@link SNOW}'s sound speed (and the solver's substeps) assume this much hardening. Not in the paper (which had
   * no cap); it keeps heavily compacted snow from forcing tiny steps.
   */
  maxHardening: number
  /**
   * Densest the snow compacts to, kg/m³ (at most ice, {@link ICE_DENSITY}): Jp never drops below density / maxDensity;
   * past it the snow stays elastic and pushes back. Footprints in powder reach ~350–450, avalanche debris ~500–650.
   */
  maxDensity: number
}

/**
 * Snow presets. `packed` is the paper's reference snow (E₀ = 140 kPa, ν = 0.2, θc = 2.5 %, θs = 0.75 %, ξ = 10,
 * ρ = 400 kg/m³). `powder` is light, soft and compacts readily (it yields in compression before it tears, so a boot
 * packs a clean print instead of shoving the snow aside; holds a 0.4 m layer elastically). `wet` is heavy, more ductile and sticky (a larger θs keeps clumps together), with less hardening.
 */
export const SNOW_PRESETS: Record<'powder' | 'packed' | 'wet', SnowParams> = {
  powder: { density: 150, youngs: 35000, poisson: 0.2, compression: 0.015, stretch: 0.01, hardening: 6, maxHardening: 4, maxDensity: 550 },
  packed: { density: 400, youngs: 140000, poisson: 0.2, compression: 0.025, stretch: 0.0075, hardening: 10, maxHardening: 3, maxDensity: 650 },
  wet: { density: 500, youngs: 80000, poisson: 0.3, compression: 0.045, stretch: 0.015, hardening: 5, maxHardening: 3, maxDensity: 700 },
}

/** Jp stays in this range (finite and positive; stretched snow at 10 is loose powder). The lower end is also at least density / maxDensity. */
export const SNOW_JP_RANGE: [number, number] = [0.1, 10]

/** Hardening factor exp(ξ(1 − Jp)), capped at `maxHardening` (at least 1). */
export function snowHardeningGeneric<T>(o: MPMOps<T>, Jp: T, p: Record<keyof SnowParams, T>): T {
  return o.min(o.exp(o.mul(p.hardening, o.sub(o.num(1), Jp))), o.max(p.maxHardening, o.num(1)))
}

/**
 * Fixed-corotated Kirchhoff stress τ = 2μ(F − R)Fᵀ + λ(J − 1)J·I with R the rotation of F (polar decomposition
 * through the SVD) and μ, λ hardened by Jp. Column-major scalars, on any {@link MPMOps}.
 */
export function snowStressGeneric<T>(o: MPMOps<T>, F: T[], J: T, Jp: T, p: Record<keyof SnowParams, T>): T[] {
  const { U, V } = svd3Generic(o, F)
  const one = o.num(1)
  const R = usvGeneric(o, U, [one, one, one], V)
  const h = o.v(snowHardeningGeneric(o, Jp, p))
  const nu1 = o.add(p.poisson, one)
  const mu2 = o.v(o.mul(o.div(p.youngs, nu1), h)) // 2μ
  const lambda = o.div(o.mul(p.youngs, p.poisson), o.mul(nu1, o.sub(one, o.mul(o.num(2), p.poisson))))
  const iso = o.v(o.mul(o.mul(lambda, h), o.mul(o.sub(J, one), J)))
  const M = F.map((f, k) => o.v(o.sub(f, R[k])))
  const tau: T[] = []
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) {
    // ((F − R)·Fᵀ)[r][c] = Σk M[r][k]·F[c][k]
    let sum = o.mul(M[r], F[c])
    for (let k = 1; k < 3; k++) sum = o.add(sum, o.mul(M[k * 3 + r], F[k * 3 + c]))
    tau.push(o.v(r === c ? o.add(o.mul(mu2, sum), iso) : o.mul(mu2, sum)))
  }
  return tau
}

/**
 * The plastic return mapping: F = U·Σ·Vᵀ, Σ clamped to [1 − θc, 1 + θs], and the plastic volume ratio Jp takes
 * what the clamp removed (Jp ← Jp·det Σ / det Σclamped). Compaction stops at `maxDensity` (Jp ≥ ρ / maxDensity):
 * past it the clamped values are scaled back so Jp lands on that floor and the rest stays elastic (and pushes back),
 * since the hardening cap alone would let impacts crush snow to nothing. Jp also stays at most
 * {@link SNOW_JP_RANGE}`[1]`. On any {@link MPMOps}.
 */
export function snowPlasticityGeneric<T>(o: MPMOps<T>, F: T[], Jp: T, p: Record<keyof SnowParams, T>): { F: T[]; Jp: T } {
  const { U, S, V } = svd3Generic(o, F)
  const lo = o.sub(o.num(1), p.compression), hi = o.add(o.num(1), p.stretch)
  const Sc = S.map((s) => o.v(o.min(o.max(s, lo), hi)))
  const ratio = o.div(o.mul(o.mul(S[0], S[1]), S[2]), o.mul(o.mul(Sc[0], Sc[1]), Sc[2]))
  const floor = o.v(o.max(o.div(p.density, o.min(p.maxDensity, o.num(ICE_DENSITY))), o.num(SNOW_JP_RANGE[0])))
  const free = o.v(o.mul(Jp, ratio))
  // k³ = Jp·ratio / floor below the floor (k < 1 scales Σclamped down, i.e. less plastic compaction), else 1.
  const k = o.v(o.min(o.num(1), o.exp(o.div(o.log(o.max(o.div(free, floor), o.num(1e-30))), o.num(3)))))
  const jp = o.min(o.max(free, floor), o.num(SNOW_JP_RANGE[1]))
  return { F: usvGeneric(o, U, Sc.map((s) => o.mul(s, k)), V), Jp: o.v(jp) }
}

/** Density of ice, kg/m³: the most any `maxDensity` means. */
export const ICE_DENSITY = 917

/** Lamé (μ, λ) of snow parameters at a hardening factor. */
export function snowLame(p: SnowParams, h = 1): { mu: number; lambda: number } {
  return { mu: (h * p.youngs) / (2 * (1 + p.poisson)), lambda: (h * p.youngs * p.poisson) / ((1 + p.poisson) * (1 - 2 * p.poisson)) }
}

/**
 * The `snow` MPM material (Stomakhin et al. 2013). Defaults: the paper's reference snow plus a hardening cap
 * ({@link SNOW_PRESETS}`.packed`). Its sound speed assumes fully hardened snow, so the time step stays stable.
 *
 * @example
 * ```ts
 * const mpm = new MPMSolver(renderer, { materials: { snow: SNOW_PRESETS.powder }, cellSize: 0.1, height })
 * mpm.emit({ center: [0, 0.2, 0], size: [3, 0.2, 3], material: 'snow' })
 * ```
 */
export const SNOW: MPMMaterial<SnowParams> = registerMPMMaterial<SnowParams>({
  name: 'snow',
  defaults: { ...SNOW_PRESETS.packed },
  stress: ({ F, J, Jp, params }) => scalarsMat3(snowStressGeneric(NODE_OPS, mat3Scalars(F), J, Jp, params as Record<keyof SnowParams, any>)),
  plasticity: ({ F, Jp, params }) => {
    const r = snowPlasticityGeneric(NODE_OPS, mat3Scalars(F), Jp, params as Record<keyof SnowParams, any>)
    return { F: scalarsMat3(r.F), Jp: r.Jp }
  },
  cpu: {
    stress: ({ F, J, Jp, params }) => snowStressGeneric(NUMBER_OPS, F, J, Jp, params as SnowParams),
    plasticity: ({ F, Jp, params }) => snowPlasticityGeneric(NUMBER_OPS, F, Jp, params as SnowParams) as { F: Mat3; Jp: number },
  },
  soundSpeed: (p) => {
    const { mu, lambda } = snowLame(p, Math.max(1, p.maxHardening))
    return Math.sqrt((lambda + 2 * mu) / p.density)
  },
})

// ---- Rendering: the particles as a snow cover ----

const iclamp = (v: any, lo: number, hi: number): any => (clamp as any)(v, int(lo), int(hi))
/** Fixed-point scale of the column-top atomics, per metre (×256 more for the block id in the low bits; 8 km of range). */
const TOP_SCALE = 1024

/** Settings of an {@link MPMSnowSurface} (plain JSON; everything but `detail` is live through `set`). */
export interface SnowSurfaceOptions {
  /** Surface samples per grid cell along x and z. 2 (one per particle spacing) is best: other values beat against the particle lattice. Fixed at construction. */
  detail: number
  /** Static snow depth just outside the domain, metres: the surface blends to it at the domain edge (0: bare ground). */
  edgeDepth: number
  /** Width of that blend, in grid cells, starting where the particle cover reaches full depth (~2.5 cells in from the walls). */
  edgeCells: number
  /** Depth below which the cover thins out under the terrain, metres (a soft, patchy snow line rather than a seam). */
  minDepth: number
  /**
   * Relief of the blocks drawn on debris, in grid cells: debris blocks are about the size of the simulation's cells,
   * so where a column's particles disagree on Jp (chunks of compacted snow among fractured snow) each particle block
   * (`buffers.state.z`, e.g. Voronoi clusters assigned at emission; 0…255) is drawn at its own height. 0 off.
   */
  debris: number
  /** Height of the faint wind texture (normal detail only, faded by distance), metres. */
  relief: number
  /** Share of ~6 mm ice grains that glint (glossy, tilted facets catching the sun; faded with distance). 0 off. */
  glints: number
  /** Albedo of fresh snow (`#rrggbb`, sRGB). */
  color: string
  /** Albedo of fully compacted snow (footprints, tracks, debris). */
  packedColor: string
  /** Plastic volume ratio Jp at which snow looks fully compacted (1 is fresh). */
  packedJp: number
  /** Roughness of fresh snow. */
  roughness: number
  /** Roughness of fully compacted snow (smoother, a soft sheen). */
  packedRoughness: number
  /** Light scattered through the snow (translucency; 0 off): lights faces turned from the sun, strongest at grazing light. */
  translucency: number
  /** Colour of light that has travelled through snow (ice absorbs red: blue-cyan). */
  translucencyColor: string
}

/** Default snow look: albedo ~0.85 fresh, slightly grey-blue when packed, faint blue translucency. */
export const DEFAULT_SNOW_SURFACE: SnowSurfaceOptions = {
  detail: 2,
  edgeDepth: 0,
  edgeCells: 2,
  minDepth: 0.03,
  debris: 0.9,
  relief: 0.001,
  glints: 0.035,
  color: '#eef2f7',
  packedColor: '#d3dbe5',
  packedJp: 0.7,
  roughness: 0.85,
  packedRoughness: 0.6,
  translucency: 0.35,
  translucencyColor: '#7fb4ff',
}

/** The snow shading uniforms {@link snowMaterial} builds on. */
export interface SnowShading {
  relief: any
  glints: any
  color: any
  packedColor: any
  packedJp: any
  roughness: any
  packedRoughness: any
  translucency: any
  translucencyColor: any
}

/** Snow shading uniforms set from options. */
export function snowShading(o: SnowSurfaceOptions = DEFAULT_SNOW_SURFACE): SnowShading {
  const s: SnowShading = {
    relief: uniform(0), glints: uniform(0), color: uniform(new Color()), packedColor: uniform(new Color()), packedJp: uniform(0), roughness: uniform(0), packedRoughness: uniform(0),
    translucency: uniform(0), translucencyColor: uniform(new Color()),
  }
  return setSnowShading(s, o)
}

/** Updates {@link SnowShading} uniforms from options. */
export function setSnowShading(s: SnowShading, o: SnowSurfaceOptions): SnowShading {
  s.relief.value = o.relief
  s.glints.value = o.glints
  s.color.value.set(o.color)
  s.packedColor.value.set(o.packedColor)
  s.translucencyColor.value.set(o.translucencyColor)
  s.packedJp.value = o.packedJp
  s.roughness.value = o.roughness
  s.packedRoughness.value = o.packedRoughness
  s.translucency.value = o.translucency
  return s
}

/**
 * A lit snow material (three.js `MeshSSSNodeMaterial`): white, rough, faintly translucent, greyer and smoother where
 * compacted. `Jp` is a float node (the plastic volume ratio; 1 = fresh, e.g. a varying from the particles). Use it for
 * static snow cover around a simulated patch so the two match.
 */
export function snowMaterial(s: SnowShading, Jp: any = float(1), normal: any = normalWorld): MeshSSSNodeMaterial {
  const m = new MeshSSSNodeMaterial()
  m.name = 'Snow'
  const packed = smoothstep(1, s.packedJp, Jp)
  // Fine surface detail, in the normal only (never albedo), every scale faded out by fwidth before it gets smaller than
  // about two pixels, so nothing aliases or crawls:
  // - wind texture: faint streaks stretched across a wind direction that wanders over metres (domain-warped, so no
  //   rows or repeats), ~1 mm high;
  // - glints: a sparse few ice grains (~6 mm cells) with tilted, glossy facets (a clearcoat) that catch the sun through
  //   the normal lighting, so they are shadowed like everything else. Compacted snow is smoother and glints less.
  const p = positionWorld, fw = length(fwidth(p)).toVar()
  const fresh = packed.mul(-0.7).add(1)
  const theta = mx_noise_float(p.mul(0.13)).mul(2.2).add(mx_noise_float(p.mul(0.47).add(5.1)).mul(0.6))
  const ct = cos(theta), st = sin(theta)
  const wind = (q: any) => {
    const u = vec2(q.x.mul(ct).sub(q.z.mul(st)), q.x.mul(st).add(q.z.mul(ct)))
    return mx_noise_float(vec3(u.x.mul(1 / 0.05), u.y.mul(1 / 0.32), q.y.mul(1 / 0.2))).mul(smoothstep(0.5, 0.2, fw.mul(1 / 0.05)))
      .add(mx_noise_float(q.mul(1 / 0.018)).mul(0.35).mul(smoothstep(0.5, 0.2, fw.mul(1 / 0.018))))
  }
  const e = 0.004
  const h0 = wind(p)
  const grad = vec3(wind(p.add(vec3(e, 0, 0))).sub(h0), 0, wind(p.add(vec3(0, 0, e))).sub(h0)).mul(s.relief.mul(fresh).div(e)).toVar()
  const cellSize = 0.006
  // Cell indices wrapped to [0, 4096) (the hash reads a uint, and float seeds must stay exact); repeats every 25 m.
  const cell = fract(floor(p.div(cellSize)).div(4096)).mul(4096).toVar(), local = fract(p.div(cellSize)).sub(0.5).toVar()
  const r1 = fract(hash(cell.x.add(cell.z.mul(4096))).add(hash(cell.y.add(7)).mul(0.618))).toVar()
  const r2 = fract(hash(cell.z.add(cell.x.mul(4096)).add(1)).add(hash(cell.y.add(19)).mul(0.382))).toVar()
  const glint = step(r1, s.glints.mul(fresh)).mul(smoothstep(0.45, 0.2, length(local))).mul(smoothstep(0.6, 0.25, fw.div(cellSize))).toVar()
  const tilt = vec3(r2.sub(0.5), 0, hash(r2.mul(1048576)).sub(0.5)).mul(0.9)
  const n = normalize(normal).toVar()
  const tangential = (v: any) => v.sub(n.mul(dot(n, v)))
  m.normalNode = transformNormalToView(normalize(n.sub(tangential(grad))))
  // The glints are a clear, glossy coat on those grains with its own tilted normal: only their specular sparkles,
  // the snow's diffuse shading keeps the grain-free normal (a tilt there would darken them into specks).
  m.clearcoat = 1
  m.clearcoatNode = glint
  m.clearcoatRoughnessNode = float(0.1)
  m.clearcoatNormalNode = transformNormalToView(normalize(n.sub(tangential(grad.sub(tilt)))))
  m.colorNode = mix(s.color, s.packedColor, packed)
  m.roughnessNode = mix(s.roughness, s.packedRoughness, packed)
  m.metalnessNode = float(0)
  m.thicknessColorNode = s.translucencyColor.mul(s.translucency)
  m.thicknessDistortionNode = float(0.4)
  m.thicknessPowerNode = float(3)
  m.thicknessScaleNode = float(1.5)
  m.thicknessAttenuationNode = float(1)
  m.thicknessAmbientNode = float(0.15)
  return m
}

/**
 * Draws an {@link MPMSolver}'s snow as a continuous snow cover: each frame the snow particles splat their current
 * volume (rest volume × det F × Jp, so compaction shows as a depression) into a column grid over the domain with
 * quadratic B-spline weights, a pass smooths it, and a heightfield mesh on the terrain is displaced by it and shaded
 * with {@link snowMaterial} (compacted snow by its mean Jp). Footprints, tracks, slumps and avalanche debris all read
 * as one surface; airborne snow lands in the column below it. Hide the solver's particles (`object.visible = false`).
 *
 * @example
 * ```ts
 * const snow = new MPMSnowSurface(renderer, mpm, { edgeDepth: 0.3 })
 * scene.add(snow.object)
 * renderer.setAnimationLoop(() => { mpm.step(1 / 60); snow.update(); renderer.render(scene, camera) })
 * ```
 */
export class MPMSnowSurface {
  /** Resolved settings. */
  options: SnowSurfaceOptions
  /** The surface mesh (add it to the scene; it follows the solver's origin). */
  readonly object: Mesh<BufferGeometry, MeshSSSNodeMaterial>
  /** Column samples along x and z. */
  readonly columns: [number, number]
  /** Per column: x surface height (local to the solver's origin), y snow depth, z mean Jp, w debris (0…1). */
  readonly surface: any
  /** Shading uniforms. */
  readonly shading: SnowShading
  private readonly renderer: Renderer
  private readonly solver: MPMSolver
  private readonly uniforms = { edgeDepth: uniform(0), edgeStart: uniform(0), edgeWidth: uniform(1), minDepth: uniform(0.03), debris: uniform(0) }
  private readonly passes: ComputeNode[]

  constructor(renderer: Renderer, solver: MPMSolver, input: Partial<SnowSurfaceOptions> = {}) {
    this.renderer = renderer
    this.solver = solver
    this.options = { ...DEFAULT_SNOW_SURFACE, ...input }
    const detail = Math.max(1, Math.round(this.options.detail))
    this.options.detail = detail
    const [nx, , nz] = solver.resolution
    const cx = (nx - 1) * detail + 1, cz = (nz - 1) * detail + 1
    this.columns = [cx, cz]
    const cols = cx * cz
    const hs = solver.options.cellSize / detail
    this.surface = instancedArray(cols, 'vec4')
    const raw = instancedArray(cols, 'vec4')
    // Per column: volume, Σw·Jp, Σw, top (a max), Σw·Jp².
    const acc = storage(new StorageBufferAttribute(new Int32Array(cols * 5), 1), 'int', cols * 5).toAtomic()
    const b = solver.buffers, u = this.uniforms
    const snowId = solver.materials.indexOf('snow')
    const fixed = (v: any) => int(floor(v.mul(MPM_FIXED).add(0.5)))
    const restVolume = (solver.options.cellSize / 2) ** 3
    const radius = solver.options.cellSize / 4 // half the particle spacing
    const H = b.heights
    // Ground under column (i, k): bilinear between the solver's node-column heights (what the particles rest on).
    const groundAt = (i: any, k: any) => {
      const gx = float(i).div(detail), gz = float(k).div(detail)
      const i0 = (min as any)(int(floor(gx)), int(nx - 2)).toVar(), k0 = (min as any)(int(floor(gz)), int(nz - 2)).toVar()
      const fx = gx.sub(float(i0)), fz = gz.sub(float(k0))
      const h = (a: number, c: number) => H.element(k0.add(c).mul(nx).add(i0.add(a)))
      return mix(mix(h(0, 0), h(1, 0), fx), mix(h(0, 1), h(1, 1), fx), fz)
    }

    // Splat: each snow particle adds its volume (as depth over a column's area), its Jp and its weight to 3×3 columns,
    // and its top to the columns around it (a max).
    const splat = Fn(() => {
      const i = instanceIndex
      const S = b.state.element(i).toVar()
      If(b.velocity.element(i).w.greaterThan(0).and(snowId < 0 ? bool(true) : int(S.x).equal(snowId)), () => {
        const P = b.position.element(i).xz.toVar(), y = b.position.element(i).y
        const F0 = b.deformation.element(int(i).mul(3)).xyz, F1 = b.deformation.element(int(i).mul(3).add(1)).xyz, F2 = b.deformation.element(int(i).mul(3).add(2)).xyz
        const J = determinant((mat3 as any)(F0, F1, F2)).mul(S.y).max(0).toVar()
        const g = P.div(hs).toVar()
        const base = floor(g.sub(0.5)).toVar()
        const f = g.sub(base).toVar()
        const w = [f.sub(1.5).mul(f.sub(1.5)).mul(0.5).toVar(), float(0.75).sub(f.sub(1).mul(f.sub(1))).toVar(), f.sub(0.5).mul(f.sub(0.5)).mul(0.5).toVar()]
        const ib = ivec2(base as any).toVar()
        for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) {
          const c = ib.add(ivec2(j, k)).toVar()
          If(c.x.greaterThanEqual(0).and(c.y.greaterThanEqual(0)).and(c.x.lessThan(cx)).and(c.y.lessThan(cz)), () => {
            const weight = w[j].x.mul(w[k].y).toVar()
            const n = c.y.mul(cx).add(c.x).mul(5).toVar()
            atomicAdd(acc.element(n), fixed(weight.mul(J).mul(restVolume / (hs * hs))))
            atomicAdd(acc.element(n.add(1)), fixed(weight.mul(S.y)))
            atomicAdd(acc.element(n.add(2)), fixed(weight))
            atomicAdd(acc.element(n.add(4)), fixed(weight.mul(S.y).mul(S.y)))
          })
        }
        // The top goes to the columns within 0.75 spacing of the particle (1 or 2 per axis: a particle sits between
        // columns as often as on one, and must not leave a column uncovered or widen a footprint's rim much).
        const lo = ivec2(floor(g) as any).toVar(), fr = g.sub(floor(g)).toVar()
        // Packed: height in the high bits, the particle's block id (state.z, low 8 bits) in the low ones, so the max
        // also says which block the surface belongs to.
        const block = int(floor(S.z)).bitAnd(255)
        const top = (max as any)(int(floor(max(y.add(radius), 0).mul(TOP_SCALE))).mul(256).add(block), int(1)).toVar()
        for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) {
          const c = lo.add(ivec2(j, k)).toVar()
          const near = (j ? fr.x.greaterThan(0.25) : fr.x.lessThan(0.75)).and(k ? fr.y.greaterThan(0.25) : fr.y.lessThan(0.75))
          If(near.and(c.x.greaterThanEqual(0)).and(c.y.greaterThanEqual(0)).and(c.x.lessThan(cx)).and(c.y.lessThan(cz)), () => {
            atomicMax(acc.element(c.y.mul(cx).add(c.x).mul(5).add(3)), top)
          })
        }
      })
    })().compute(solver.capacity, [64])

    // Resolve (and clear): depth and mean Jp per column, blended to the static depth at the domain edge. The depth is
    // the snow volume over the column, capped by its top particle: particles pushed into a footprint's floor by a
    // collider keep their volume (F does not see the push), and a lone airborne one must not raise a spike.
    const resolve = Fn(() => {
      const n = int(instanceIndex).toVar()
      const load = (c: number): any => float(atomicLoad(acc.element(n.mul(5).add(c))) as any).div(MPM_FIXED)
      const vol = load(0).toVar(), jw = load(1).toVar(), wsum = load(2).toVar(), j2w = load(4).toVar()
      const topInt = atomicLoad(acc.element(n.mul(5).add(3))).toVar()
      for (let c = 0; c < 5; c++) atomicStore(acc.element(n.mul(5).add(c)), int(0))
      const top = float(topInt.div(256)).div(TOP_SCALE).sub(groundAt(n.mod(cx), n.div(cx)))
      // The top only caps the volume where it is clearly lower (a footprint): on undisturbed snow the volume is smoother.
      const depth = select(topInt.greaterThan(0), min(vol, max(top, 0).add(radius)), vol)
      const blockId = select(topInt.greaterThan(0), float(topInt.bitAnd(255)), float(-1))
      const x = float(n.mod(cx)).mul(hs), z = float(n.div(cx)).mul(hs)
      const edge = min(min(x, float((cx - 1) * hs).sub(x)), min(z, float((cz - 1) * hs).sub(z)))
      // Particles stay 2 cells inside the walls and their splat thins over ~1.5 columns: blend beyond that.
      const blend = smoothstep(u.edgeStart, u.edgeStart.add(u.edgeWidth), edge)
      const Jp = select(wsum.greaterThan(1e-4), jw.div(max(wsum, 1e-4)), float(1)).toVar()
      // Debris: snow whose particles disagree on Jp (compacted chunks among fractured, loosened snow). Intact slabs,
      // undisturbed cover and evenly compacted footprints have little spread.
      const spread = sqrt(max(j2w.div(max(wsum, 1e-4)).sub(Jp.mul(Jp)), 0))
      const debris = select(wsum.greaterThan(1e-4), smoothstep(0.05, 0.15, spread), float(0))
      raw.element(n).assign(vec4(mix(u.edgeDepth, depth, blend), mix(float(1), Jp, blend), debris.mul(blend), blockId))
    })().compute(cols, [64])

    // Smooth (3×3, weights 1-4-1 per axis: light, so footprints keep their walls; 5×5 where flat) and add the ground.
    const smooth = Fn(() => {
      const n = int(instanceIndex).toVar()
      const i = n.mod(cx).toVar(), k = n.div(cx).toVar()
      const sum = vec4(0).toVar(), wide = float(0).toVar()
      for (let dk = -4; dk <= 4; dk++) for (let di = -4; di <= 4; di++) {
        const ii = iclamp(i.add(di), 0, cx - 1), kk = iclamp(k.add(dk), 0, cz - 1)
        const r = raw.element(kk.mul(cx).add(ii))
        if (Math.abs(di) <= 1 && Math.abs(dk) <= 1) sum.addAssign(r.mul(((di ? 1 : 4) * (dk ? 1 : 4)) / 36))
        wide.addAssign(r.x.mul(1 / 81))
      }
      // Where the snow is nearly flat (the light and the wide average agree within a centimetre), take the wide one:
      // millimetre settling ripples of the particles would otherwise mottle low-sun shading. Footprints keep their walls.
      sum.x.assign(mix(wide, sum.x, smoothstep(0.004, 0.012, abs(sum.x.sub(wide)))))
      const ground = groundAt(i, k).toVar()
      const depth = sum.x.toVar()
      const sink = smoothstep(0, u.minDepth, depth).oneMinus().mul(u.minDepth.mul(2))
      // Debris below the grid's resolution: each column takes its top particle's block (state.z, e.g. Voronoi clusters
      // of the snowpack at emission), and in debris each block sits at its own height, so the surface breaks into
      // angular blocks of varied size that travel with the snow. Never deeper than the snow.
      const id = raw.element(n).w.toVar()
      const lift = hash(id.add(17)).sub(0.45).add(hash(id.add(53)).mul(0.5)).mul(select(id.greaterThanEqual(0), float(1), float(0)))
      const lumps = lift.mul(sum.z).mul(u.debris).max(depth.negate())
      this.surface.element(n).assign(vec4(ground.add(depth).add(lumps).sub(sink), depth, sum.y, sum.z))
    })().compute(cols, [64])
    this.passes = [splat, resolve, smooth]

    // Mesh: one vertex per column, displaced on the GPU; normals from the neighbouring columns.
    const pos = new Float32Array(cols * 3)
    for (let k = 0; k < cz; k++) for (let i = 0; i < cx; i++) pos.set([i * hs, 0, k * hs], (k * cx + i) * 3)
    const index = new Uint32Array((cx - 1) * (cz - 1) * 6)
    let q = 0
    for (let k = 0; k < cz - 1; k++) for (let i = 0; i < cx - 1; i++) {
      const a = k * cx + i
      index.set([a, a + cx, a + 1, a + 1, a + cx, a + cx + 1], q)
      q += 6
    }
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(pos, 3))
    geo.setIndex(new BufferAttribute(index, 1))
    const surf = this.surface
    const vi = int(vertexIndex)
    const at = (di: number, dk: number) => {
      const ii = iclamp(vi.mod(cx).add(di), 0, cx - 1), kk = iclamp(vi.div(cx).add(dk), 0, cz - 1)
      return surf.element(kk.mul(cx).add(ii)).x
    }
    const normal = vec3(at(-1, 0).sub(at(1, 0)), 2 * hs, at(0, -1).sub(at(0, 1))).normalize()
    this.shading = snowShading(this.options)
    const material = snowMaterial(this.shading, varying(surf.element(vi).z), varying(normal))
    material.positionNode = vec3(positionGeometry.x, surf.element(vi).x, positionGeometry.z)
    this.object = new Mesh(geo, material)
    this.object.name = 'MPM snow surface'
    this.object.frustumCulled = false
    this.object.castShadow = this.object.receiveShadow = true
    this.set({})
  }

  /** Merges `input` into the settings (`detail` is fixed at construction). */
  set(input: Partial<SnowSurfaceOptions>): this {
    const o = (this.options = { ...this.options, ...input, detail: this.options.detail })
    this.uniforms.edgeDepth.value = o.edgeDepth
    this.uniforms.edgeStart.value = (2 + 1.5 / o.detail) * this.solver.options.cellSize
    this.uniforms.edgeWidth.value = Math.max(1e-3, o.edgeCells * this.solver.options.cellSize)
    this.uniforms.minDepth.value = Math.max(1e-3, o.minDepth)
    this.uniforms.debris.value = o.debris * this.solver.options.cellSize
    setSnowShading(this.shading, o)
    return this
  }

  /** The surface's compute passes for this frame (splat, resolve, smooth), to batch in one `renderer.compute([...])`. */
  prepare(): ComputeNode[] {
    this.object.position.fromArray(this.solver.options.origin)
    return this.passes
  }

  /** Rebuilds the surface from the particles (after {@link MPMSolver.step}). */
  update(): this {
    const backend = (this.renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend
    if (backend?.isWebGPUBackend) this.renderer.compute(this.prepare())
    else this.object.visible = false
    return this
  }

  /** Frees the GPU passes and the mesh. */
  dispose(): void {
    for (const p of this.passes) p.dispose()
    this.object.geometry.dispose()
    this.object.material.dispose()
  }
}

export * from './mpm-svd.ts'
