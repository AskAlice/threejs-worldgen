import * as THREE from 'three/webgpu'
import { attribute, color, float, mix, normalWorld, smoothstep } from 'three/tsl'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { SkyMesh } from 'three/addons/objects/SkyMesh.js'
import {
  MPMReference, MPMSnowSurface, MPMSolver, SNOW_PRESETS, groundAt, snowMaterial, snowShading,
  type MPMCollider, type MPMEmit, type MPMInput, type SnowParams,
} from 'threejs-particles'

// The scenes of the MPM snow sandboxes (mpm-snow.ts and mpm-snow-r3f.tsx): the footprints and avalanche scenes, their
// static scenery, the snow cover, the walker, and the GPU vs CPU check behind `?check`.

export type SceneName = 'footprints' | 'avalanche'
export interface SceneSpec {
  cellSize: number
  resolution: [number, number, number]
  origin: [number, number, number]
  /** Terrain under the snow, world metres. */
  ground: (x: number, z: number) => number
  /** Far-field relief added beyond the near ring (0 near the domain). */
  hills: (x: number, z: number) => number
  /** Initial snow depth (vertical), metres. */
  depth: (x: number, z: number) => number
  /** Static snow depth outside the domain. */
  edgeDepth: number
  preset: SnowParams
  friction: number
  maxSpeed: number
  /** Near static-snow ring width around the domain, metres. */
  ring: number
  /** What is under the simulated snow: bare frozen ground, or an old, hard snow surface (the avalanche's bed). */
  bed: 'ground' | 'old snow'
  /** Static snow cover outside the domain, 0…1 (1 = `edgeDepth` of snow; 0 = bare grass or rock). */
  cover: (x: number, z: number, y: number) => number
  /** Mean size of the snowpack's blocks (Voronoi cells of the rest state, `buffers.state.z`), metres. */
  blockSize: number
  /** Block relief drawn on debris, in grid cells (MPMSnowSurface `debris`). */
  debris: number
  /** The slab that releases (on a weak layer), if any. */
  slab?: (x: number, z: number) => boolean
  sun: [number, number]
  exposure: number
  camera: [number, number, number]
  target: [number, number, number]
}

const DEG = Math.PI / 180
const softplus = (t: number) => (t > 30 ? t : Math.log1p(Math.exp(t)))
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
// Ridged value-noise mountains beyond `near` metres from the domain (0 close to it, so the static snow ring matches).
function hash2(i: number, k: number) {
  let h = Math.imul(i, 374761393) + Math.imul(k, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
function valueNoise(x: number, z: number) {
  const i = Math.floor(x), k = Math.floor(z), fx = x - i, fz = z - k
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz)
  const a = hash2(i, k), b = hash2(i + 1, k), c = hash2(i, k + 1), d = hash2(i + 1, k + 1)
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1
}
const mountains = (x: number, z: number, near: number) => {
  const r = Math.hypot(x, z)
  if (r < near) return 0
  let h = 0, amp = 1, f = 1 / 260, w = 1
  for (let o = 0; o < 6; o++) {
    const n = 1 - Math.abs(valueNoise(x * f + o * 17.1, z * f - o * 9.3))
    h += n * n * amp * w
    w = Math.min(1, n * n * 1.6) // ridged multifractal: detail where the ridges are
    amp *= 0.47
    f *= 2.03
  }
  return smooth(near, near + 90, r) * (6 * h + smooth(200, 700, r) * 260 * h)
}

// The avalanche's track on the runout below the slab, where earlier slides scoured the snow down to the hard bed.
export const avalancheTrack = (x: number, z: number) => x > 0.6 + 0.4 * valueNoise(z * 0.9, 9) && x < 9 + valueNoise(z * 0.5, 11) && Math.abs(z) < 3.4 + 0.4 * valueNoise(x * 0.6, 13)

// Edge of the snow left in the avalanche gully, |z| metres, wandering along x (always clear of the domain's sides).
const gullyEdge = (x: number) => 8 + 1.5 * valueNoise(x / 12, 3) + 0.4 * valueNoise(x / 3, 7)

export const SCENES: Record<SceneName, SceneSpec> = {
  footprints: {
    cellSize: 0.07, resolution: [64, 24, 46], origin: [-2.2, -0.6, -1.6],
    ground: (x, z) => 0.16 * Math.sin(0.5 * x + 0.3) * Math.cos(0.4 * z - 0.2) + 0.05 * Math.sin(1.2 * x - 0.8 * z + 1),
    hills: (x, z) => mountains(x, z, 12),
    depth: () => 0.35, edgeDepth: 0.35, preset: SNOW_PRESETS.powder, friction: 0.6, maxSpeed: 5, ring: 9, bed: 'ground',
    cover: () => 1, blockSize: 0.06, debris: 0.35,
    sun: [20, 125], exposure: 0.85, camera: [1.7, 1.05, 2.2], target: [-0.4, 0.1, 0],
  },
  avalanche: {
    cellSize: 0.2, resolution: [120, 64, 48], origin: [-12, -0.8, -4.8],
    // 38° above x = 0, flattening over ~2 m into a level runout and, 45 m up, into a shoulder; a shallow trough across
    // z (0.5 m up at the domain sides, levelling out 3.75 m up).
    ground: (x, z) => Math.tan(38 * DEG) * 2 * (softplus(-x / 2) - softplus((-x - 45) / 4)) + (0.6 * (z / 4.8) ** 2) / (1 + (z / 12) ** 2),
    hills: (x, z) => mountains(x, z, 45),
    // 0.55 m (as the static cover round the domain), none in the track below the slab (scoured down to hard old snow).
    depth: (x, z) => (avalancheTrack(x, z) ? 0 : 0.55), edgeDepth: 0.55, preset: SNOW_PRESETS.packed, friction: 1.2, maxSpeed: 15, ring: 26, bed: 'old snow',
    // Late season: snow left in the avalanche gully (its edge wanders along the slope) and high up; grass and rock
    // elsewhere.
    cover: (x, z, y) => Math.max(smooth(gullyEdge(x) + 1, gullyEdge(x) - 3, Math.abs(z)), smooth(48, 62, y + 8 * valueNoise(x / 37, z / 37))),
    blockSize: 0.35, debris: 0.9,
    // The slab: a noise-warped region well inside the domain, a jagged crown across the slope, ragged flanks.
    slab: (x, z) => x > -8.6 + 0.6 * valueNoise(z * 0.7, 2) + 0.22 * valueNoise(z * 2.9, 5) && x < 0.3 + 0.4 * valueNoise(z * 0.9, 9) &&
      Math.abs(z) < 3.1 + 0.45 * valueNoise(x * 0.5, 1) + 0.15 * valueNoise(x * 2.3, 4),
    sun: [17, 152], exposure: 0.85, camera: [13, 3.4, 9.5], target: [-3, 3.2, -0.5],
  },
}

/**
 * The static scenery of a scene: sky (also prefiltered into the environment light), fog, the sun with soft shadows
 * over the domain, the bed under the simulated snow, the static snow ring round it and the far mountains. Added to
 * `scene`; returns a function that removes it.
 */
export function snowStage(renderer: THREE.WebGPURenderer, scene: THREE.Scene, spec: SceneSpec): () => void {
  const { cellSize: DX, resolution: RES, origin } = spec
  const span = [(RES[0] - 1) * DX, (RES[2] - 1) * DX]
  const center = [origin[0] + span[0] / 2, origin[2] + span[1] / 2]
  const added: THREE.Object3D[] = []
  const add = (...objects: THREE.Object3D[]) => { added.push(...objects); scene.add(...objects) }
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, (90 - spec.sun[0]) * DEG, spec.sun[1] * DEG)
  const sky = new SkyMesh()
  sky.scale.setScalar(4500)
  sky.turbidity.value = 2
  sky.rayleigh.value = 2.4
  sky.mieCoefficient.value = 0.003
  sky.mieDirectionalG.value = 0.85
  sky.cloudCoverage.value = 0.15
  sky.sunPosition.value.copy(sunDir)
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envScene = new THREE.Scene()
  envScene.add(sky)
  scene.environment = pmrem.fromScene(envScene as any, 0.02).texture
  scene.environmentIntensity = 0.18
  add(sky)
  scene.fog = new THREE.FogExp2('#c5d3e2', 0.0016)

  const sun = new THREE.DirectionalLight('#fff4e6', 7)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  const reach = Math.max(span[0], span[1]) / 2 + 2
  Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: 200 })
  sun.shadow.bias = -0.0015
  sun.shadow.normalBias = 0.06
  sun.shadow.radius = 3
  const cy = spec.ground(center[0], center[1])
  sun.target.position.set(center[0], cy, center[1])
  sun.position.copy(sun.target.position).addScaledVector(sunDir, 80)
  add(sun, sun.target)

  // Static snow and ground around and under the simulated patch.
  const shading = snowShading()
  const domainRect: Rect = [origin[0], origin[0] + span[0], origin[2], origin[2] + span[1]]
  const ring = Math.round(spec.ring / DX) * DX // whole cells, so the ring's vertices meet the domain edge exactly
  const ringRect: Rect = [domainRect[0] - ring, domainRect[1] + ring, domainRect[2] - ring, domainRect[3] + ring]
  const bed = spec.bed === 'ground'
    ? new THREE.MeshStandardNodeMaterial({ color: '#4c463f', roughness: 0.95 })
    : snowMaterial(shading, float(0.62))
  add(terrainMesh(spec.ground, domainRect, DX, null, () => 0, () => 1, bed, true))
  // Land: snow where the scene's cover says and the slope holds it (< ~40°), else dry grass, or rock where steep.
  const land = snowMaterial(shading)
  const snowy = attribute('cover', 'float').mul(smoothstep(0.68, 0.78, normalWorld.y))
  const ground = mix(color('#4f4a45'), color('#6a5b41'), smoothstep(0.78, 0.92, normalWorld.y))
  land.colorNode = mix(ground, land.colorNode as any, snowy)
  land.roughnessNode = mix(float(0.95), land.roughnessNode as any, snowy)
  land.thicknessColorNode = (land.thicknessColorNode as any).mul(snowy)
  const farGround = (x: number, z: number) => spec.ground(x, z) + spec.hills(x - center[0], z - center[1])
  const cover = (x: number, z: number) => spec.cover(x, z, farGround(x, z))
  // The cover thins out towards its edge (depth ∝ cover²), so the snowline is a feathered edge, not a wall.
  add(terrainMesh(farGround, ringRect, DX, domainRect, (x, z) => spec.edgeDepth * cover(x, z) ** 2, cover, land, true))
  add(terrainMesh(farGround, [center[0] - 1500, center[0] + 1500, center[1] - 1500, center[1] + 1500], 6, [domainRect[0] - 1, domainRect[1] + 1, domainRect[2] - 1, domainRect[3] + 1], (x, z) => spec.edgeDepth * cover(x, z) ** 2 - 0.03, cover, land, false))

  return () => {
    scene.remove(...added)
    scene.environment = scene.fog = null
  }
}

/**
 * A scene's snow (`preset`: a SNOW_PRESETS name, default the scene's): the rest positions of the cover and each
 * particle's block (a Voronoi cell of the rest state), the solver settings, and what the sandboxes do with a solver:
 * `reset` lays the cover back down, `release` lets the avalanche slab go (bed friction `releaseFriction` under it).
 */
export function snowScene(name: SceneName, preset?: string | null) {
  const spec: SceneSpec = { ...SCENES[name], ...(preset && Object.hasOwn(SNOW_PRESETS, preset) ? { preset: SNOW_PRESETS[preset as keyof typeof SNOW_PRESETS] } : {}) }
  const DX = spec.cellSize
  const positions = snowCover(spec)
  const blocks = voronoiBlocks(positions, spec.blockSize)
  const config: MPMInput = {
    capacity: positions.length / 3, resolution: spec.resolution, cellSize: DX, origin: spec.origin, friction: spec.friction, maxSpeed: spec.maxSpeed, maxSubsteps: 12,
    materials: { snow: { ...spec.preset } },
  }
  const reset = (mpm: MPMSolver) => {
    mpm.clear()
    mpm.set({ friction: spec.friction })
    mpm.setFriction(null)
    mpm.emit({ positions, material: 'snow' })
    // Each particle's block (a Voronoi cell of the rest state) goes to state.z, where MPMSnowSurface reads it.
    const S = mpm.buffers.state.value.array as Float32Array
    for (let p = 0; p < blocks.length; p++) S[p * 4 + 2] = blocks[p] % 256
  }
  // Release: the weak layer under the slab collapses (its bed friction drops; the snow around it stays put) and the
  // crown and flank fracture opens round it: the snow within 1.5 cells of the slab's edge is removed, so the slab and
  // the snow around it no longer share grid nodes (MPM couples them through any shared node: a thinner crack would not
  // let go; the quadratic stencil reaches 1.5 cells either way). The velocity buffer is
  // re-uploaded from the CPU (zero: the snow is at rest before the release).
  const release = async (mpm: MPMSolver, releaseFriction: number) => {
    const slab = spec.slab
    if (!slab) return
    // The scoured track below it gets an ordinary snow-on-snow friction, 0.4: the debris runs out there and stops.
    mpm.setFriction((x, z) => (slab(x, z) ? releaseFriction / spec.friction : avalancheTrack(x, z) ? 0.4 / spec.friction : 1))
    const d = await mpm.read(), o = mpm.options.origin, gap = 1.5 * DX
    const V = mpm.buffers.velocity.value.array as Float32Array, S = mpm.buffers.state.value.array as Float32Array
    const h = DX / 2
    for (let p = 0; p < d.count; p++) {
      const x = d.position[p * 3] + o[0], z = d.position[p * 3 + 2] + o[2], inside = slab(x, z)
      const edge = slab(x + gap, z) !== inside || slab(x - gap, z) !== inside || slab(x, z + gap) !== inside || slab(x, z - gap) !== inside
      V.set([0, 0, 0, edge ? 0 : 1], p * 4)
      // Inside the slab, the seams between its blocks (rest-state Voronoi cells) lose their cohesion too, so the slab
      // breaks up into blocks of varied size as it moves.
      const q = p * 3, b = blocks[p]
      const seam = inside && [[h, 0, 0], [-h, 0, 0], [0, h, 0], [0, -h, 0], [0, 0, h], [0, 0, -h]].some(([a, c, e]) => voronoiAt(positions[q] + a, positions[q + 1] + c, positions[q + 2] + e, spec.blockSize) !== b)
      S[p * 4 + 1] = seam ? 4 : d.Jp[p]
    }
    mpm.buffers.velocity.value.needsUpdate = true
    mpm.buffers.state.value.needsUpdate = true
  }
  // Readback stats for checks: snow depth in and beside the walker's path, and how much snow reached the runout.
  const stats = async (renderer: THREE.WebGPURenderer, mpm: MPMSolver, surface: MPMSnowSurface, walker: Walker) => {
    const d = await mpm.read()
    const o = mpm.options.origin
    let runout = 0, cx = 0
    for (let p = 0; p < d.count; p++) {
      const x = d.position[p * 3] + o[0]
      if (x > 0.5) runout++
      cx += x / d.count
    }
    const heights = new Float32Array(await renderer.getArrayBufferAsync(surface.surface.value))
    const [ncx] = surface.columns, hs = DX / surface.options.detail
    const depthAt = (x: number, z: number) => heights[(Math.round((z - o[2]) / hs) * ncx + Math.round((x - o[0]) / hs)) * 4 + 1]
    const path = walker.prints.map(([x, z]) => depthAt(x, z)), beside = walker.prints.map(([x, z]) => depthAt(x, z + 0.6))
    return { time: mpm.time, runoutShare: runout / d.count, centroidX: cx, prints: walker.prints.length, printDepth: path.reduce((a, b) => a + b, 0) / Math.max(1, path.length), besideDepth: beside.reduce((a, b) => a + b, 0) / Math.max(1, beside.length) }
  }
  /** The surface's options for this scene: debris lumps only where avalanche debris forms (footprint rims are compact enough as simulated). */
  const surface = { edgeDepth: spec.edgeDepth, edgeCells: name === 'avalanche' ? 1 : 2, debris: spec.debris }
  return { spec, positions, blocks, config, surface, reset, release, stats }
}

export type Rect = [number, number, number, number] // x0, x1, z0, z1

// A terrain mesh over `rect` at `step`, y = ground + lift, skipping quads inside `hole`.
export function terrainMesh(ground: (x: number, z: number) => number, rect: Rect, step: number, hole: Rect | null, lift: (x: number, z: number) => number, cover: (x: number, z: number) => number, material: THREE.Material, shadows: boolean) {
  const nx = Math.round((rect[1] - rect[0]) / step) + 1, nz = Math.round((rect[3] - rect[2]) / step) + 1
  const pos = new Float32Array(nx * nz * 3), snow = new Float32Array(nx * nz)
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const x = rect[0] + i * step, z = rect[2] + k * step
    pos.set([x, ground(x, z) + lift(x, z), z], (k * nx + i) * 3)
    snow[k * nx + i] = cover(x, z)
  }
  const index: number[] = []
  const eps = 1e-6
  for (let k = 0; k < nz - 1; k++) for (let i = 0; i < nx - 1; i++) {
    const x0 = rect[0] + i * step, z0 = rect[2] + k * step
    if (hole && x0 + step > hole[0] + eps && x0 < hole[1] - eps && z0 + step > hole[2] + eps && z0 < hole[3] - eps) continue
    const a = k * nx + i
    index.push(a, a + nx, a + 1, a + 1, a + nx, a + nx + 1)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('cover', new THREE.BufferAttribute(snow, 1))
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(index), 1))
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(geo, material)
  mesh.receiveShadow = shadows
  mesh.castShadow = shadows
  return mesh
}

// The initial snow cover: a lattice of Δx/2 spacing from the ground up to the scene's depth, over the
// domain inside its walls.
export function snowCover(spec: SceneSpec): Float32Array {
  const { cellSize: dx, resolution: [nx, , nz], origin: o } = spec
  const h = dx / 2
  const out: number[] = []
  for (let x = o[0] + 2 * dx + h / 2; x < o[0] + (nx - 3) * dx; x += h) for (let z = o[2] + 2 * dx + h / 2; z < o[2] + (nz - 3) * dx; z += h) {
    const g = spec.ground(x, z), d = spec.depth(x, z)
    // A regular lattice: jitter would show as bumps in the splatted surface (fresh snow lies smooth).
    for (let y = h / 2; y < d; y += h) out.push(x, g + y, z)
  }
  return Float32Array.from(out)
}

// Block id of each particle (state.z takes it mod 256): the Voronoi cell of its rest position among seeds jittered on a `size` grid, so
// blocks have varied sizes and shapes. MPMSnowSurface draws debris as these blocks.
export function voronoiBlocks(positions: ArrayLike<number>, size: number): Float32Array {
  const n = Math.floor(positions.length / 3), out = new Float32Array(n)
  for (let p = 0; p < n; p++) out[p] = voronoiAt(positions[p * 3], positions[p * 3 + 1], positions[p * 3 + 2], size)
  return out
}
export function voronoiAt(px: number, py: number, pz: number, size: number): number {
  const seed = (i: number, j: number, k: number, a: number) => hash2(hash2(i, j) * 4294967296 + a, k)
  const x = px / size, y = py / size, z = pz / size
  const ci = Math.floor(x), cj = Math.floor(y), ck = Math.floor(z)
  let best = Infinity, id = 0
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
    const i = ci + a, j = cj + b, k = ck + c
    const d = (i + seed(i, j, k, 1) - x) ** 2 + (j + seed(i, j, k, 2) - y) ** 2 + (k + seed(i, j, k, 3) - z) ** 2
    if (d < best) { best = d; id = Math.floor(seed(i, j, k, 4) * 4096) }
  }
  return id
}

// A boot sole as 4 capsules: [u0, v0, u1, v1, radius], u along the heading, v across, metres (26 cm × 16 cm).
const SOLE: [number, number, number, number, number][] = [
  [0.075, -0.035, 0.075, 0.035, 0.045], // forefoot
  [-0.09, 0.025, 0.07, 0.025, 0.035], [-0.09, -0.025, 0.07, -0.025, 0.035], // waist
  [-0.1, -0.02, -0.1, 0.02, 0.045], // heel
]

// A walker crossing the footprints scene along a gentle curve: each boot sole is four capsules (SOLE), planted for
// 60 % of its cycle (pressed `sink` metres into the snow), lifted out and swung forward for the rest. Or a pair of
// wheels rolling through at the same depth. Positions are analytic in time, velocities by finite difference.
export class Walker {
  readonly object = new THREE.Group()
  /** Footprint (or track) centres planted so far, world x, z. */
  readonly prints: [number, number][] = []
  active = false
  private readonly boots: THREE.Mesh[]
  private readonly wheels: THREE.Mesh[]
  private readonly x0: number
  private readonly length: number
  private readonly z0: number

  constructor(private readonly spec: SceneSpec) {
    const o = spec.origin, dx = spec.cellSize
    // From 1.5 m outside the domain to 1.5 m past it: the first steps land outside the simulated snow.
    this.x0 = o[0] - 1.5
    this.length = (spec.resolution[0] - 1) * dx + 3
    this.z0 = o[2] + ((spec.resolution[2] - 1) * dx) / 2
    const leather = new THREE.MeshStandardNodeMaterial({ color: '#2b2420', roughness: 0.7 })
    this.boots = [0, 1].map(() => new THREE.Mesh(new RoundedBoxGeometry(0.28, 0.13, 0.14, 3, 0.04), leather))
    const rubber = new THREE.MeshStandardNodeMaterial({ color: '#1b1b1c', roughness: 0.85 })
    const tyre = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 32)
    tyre.rotateX(Math.PI / 2)
    this.wheels = [0, 1].map(() => new THREE.Mesh(tyre, rubber))
    for (const m of [...this.boots, ...this.wheels]) { m.castShadow = true; this.object.add(m) }
  }

  private path(arc: number): { p: [number, number]; t: [number, number] } {
    const x = this.x0 + arc, z = this.z0 + 0.35 * Math.sin(arc * 0.5)
    const tz = 0.175 * Math.cos(arc * 0.5), l = Math.hypot(1, tz)
    return { p: [x, z], t: [1 / l, tz / l] }
  }

  private top(x: number, z: number) {
    return this.spec.ground(x, z) + this.spec.depth(x, z)
  }

  // Sole centre (bottom of the sole, world) and heading of boot k at time t.
  private boot(k: number, t: number, speed: number, sink: number): { c: [number, number, number]; t: [number, number]; target: number } {
    const S = 1.3, T = S / speed
    const u = t / T + k / 2, n = Math.floor(u), phi = u - n
    const plant = (m: number) => this.path((m + 0.3 - k / 2) * S)
    const side = (q: { p: [number, number]; t: [number, number] }): [number, number] => [q.p[0] - q.t[1] * 0.11 * (k ? -1 : 1), q.p[1] + q.t[0] * 0.11 * (k ? -1 : 1)]
    let xz: [number, number], heading: [number, number], y: number
    if (phi < 0.6) {
      const q = plant(n)
      xz = side(q); heading = q.t
      y = this.top(xz[0], xz[1]) - sink * smooth(0, 0.1, phi)
    } else {
      const psi = (phi - 0.6) / 0.4, a = plant(n), b = plant(n + 1), f = smooth(0.15, 1, psi)
      const pa = side(a), pb = side(b)
      xz = [pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f]
      heading = [a.t[0] + (b.t[0] - a.t[0]) * f, a.t[1] + (b.t[1] - a.t[1]) * f]
      y = this.top(xz[0], xz[1]) - sink * (1 - smooth(0, 0.15, psi)) + 0.12 * Math.sin(Math.PI * psi)
    }
    return { c: [xz[0], y, xz[1]], t: heading, target: plant(phi < 0.6 ? n : n + 1).p[0] }
  }

  colliders(t: number, kind: 'boots' | 'wheels', speed: number, sink: number): MPMCollider[] {
    const arc = speed * t
    this.active = arc < this.length
    if (!this.active) return []
    const h = 1e-3
    const out: MPMCollider[] = []
    if (kind === 'boots') {
      for (let k = 0; k < 2; k++) {
        const now = this.boot(k, t, speed, sink), prev = this.boot(k, t - h, speed, sink)
        // A boot acts only on its way to (or standing on) a print well inside the domain: one planted across a domain
        // wall would push snow into the wall cells, where it freezes.
        const [tx, tz] = now.t
        const m = this.boots[k]
        m.position.set(now.c[0], now.c[1] + 0.065, now.c[2])
        m.rotation.set(0, -Math.atan2(tz, tx), 0)
        m.visible = true
        const o = this.spec.origin, end = o[0] + (this.spec.resolution[0] - 1) * this.spec.cellSize
        if (now.target < o[0] + 0.35 || now.target > end - 0.35) continue
        const vel: [number, number, number] = [(now.c[0] - prev.c[0]) / h, (now.c[1] - prev.c[1]) / h, (now.c[2] - prev.c[2]) / h]
        // The sole (heading u, lateral v, metres): a wide forefoot, two rails along a narrower waist, a round heel.
        const at = (u: number, v: number, y: number): [number, number, number] => [now.c[0] + tx * u - tz * v, y, now.c[2] + tz * u + tx * v]
        for (const [u0, v0, u1, v1, r] of SOLE) out.push({ a: at(u0, v0, now.c[1] + r), b: at(u1, v1, now.c[1] + r), radius: r, velocity: vel })
        const phi = (t * speed) / 1.3 + k / 2
        if (phi - Math.floor(phi) < 0.6 && phi - Math.floor(phi) > 0.1 && !this.prints.some(([x, z]) => Math.hypot(x - now.c[0], z - now.c[2]) < 0.3)) this.prints.push([now.c[0], now.c[2]])
      }
      for (const w of this.wheels) w.visible = false
    } else {
      const q = this.path(arc), R = 0.3
      for (let k = 0; k < 2; k++) {
        const off = k ? -0.75 : 0.75
        const x = q.p[0] - q.t[1] * off, z = q.p[1] + q.t[0] * off
        const y = this.top(x, z) - sink + R
        // Rolling: the contact patch is still, so only the vertical motion counts.
        out.push({ a: [x + q.t[1] * 0.08, y, z - q.t[0] * 0.08], b: [x - q.t[1] * 0.08, y, z + q.t[0] * 0.08], radius: R, velocity: [0, 0, 0] })
        const m = this.wheels[k]
        m.position.set(x, y, z)
        m.rotation.set(0, -Math.atan2(q.t[1], q.t[0]), -arc / R)
        m.visible = true
        if (!this.prints.some(([px, pz]) => Math.hypot(px - x, pz - z) < 0.3)) this.prints.push([x, z])
      }
      for (const b of this.boots) b.visible = false
    }
    return out
  }
}

// GPU vs CPU: a tiny scene (a 0.3 m block of packed snow thrown onto a slope, a capsule pressing into it) through one
// substep and 24 on both; the results go to `window.snowCheck` (recorded as
// packages/particles/test/fixtures/mpm-snow-gpu-step.json).
export async function check(renderer: THREE.WebGPURenderer): Promise<string> {
  const slope: [number, number, number] = [0.3, 0.25, 0.1]
  const height = (x: number, z: number) => slope[0] + slope[1] * x + slope[2] * z
  const dt = 1 / 600
  const options: MPMInput = {
    capacity: 512, resolution: [16, 16, 16], cellSize: 0.1, origin: [0, 0, 0], friction: 0.8, substeps: 1, maxSubsteps: 1,
    materials: { snow: { ...SNOW_PRESETS.packed } },
  }
  const emit: MPMEmit = { center: [0.8, height(0.95, 0.8) + 0.2, 0.8], size: [0.15, 0.15, 0.15], velocity: [0.5, -2, 0.3], material: 'snow' }
  const colliders: MPMCollider[] = [{ a: [0.7, 1.12, 0.75], b: [0.9, 1.12, 0.85], radius: 0.08, velocity: [0, -1.5, 0] }]
  const runs = []
  const report: string[] = []
  for (const substeps of [1, 24]) {
    const gpu = new MPMSolver(renderer, { ...options, height })
    gpu.emit(emit)
    gpu.setColliders(colliders)
    for (let s = 0; s < substeps; s++) gpu.step(dt)
    const g = await gpu.read()
    gpu.dispose()
    const cpu = new MPMReference(options, height)
    cpu.emit(emit)
    cpu.colliders = colliders
    for (let s = 0; s < substeps; s++) cpu.substep(dt)
    const err = (a: ArrayLike<number>, b: ArrayLike<number>) => { let e = 0; for (let i = 0; i < b.length; i++) e = Math.max(e, Math.abs(a[i] - b[i])); return e }
    let plastic = 0
    for (let p = 0; p < g.count; p++) if (g.Jp[p] !== 1) plastic++
    report.push(`${substeps} substep(s): max |Δ| position ${err(cpu.data.position, g.position).toExponential(2)}, velocity ${err(cpu.data.velocity, g.velocity).toExponential(2)}, ` +
      `F ${err(cpu.data.deformation, g.deformation).toExponential(2)}, Jp ${err(cpu.data.Jp, g.Jp).toExponential(2)} (${plastic} of ${g.count} particles plastic)`)
    const ground = Math.min(...Array.from({ length: g.count }, (_, p) => g.position[p * 3 + 1] - groundAt(cpu.heights, 16, 16, 0.1, g.position[p * 3], g.position[p * 3 + 2])[0]))
    report.push(`  GPU lowest particle vs ground ${ground.toExponential(2)} m`)
    const f32 = (a: ArrayLike<number>) => Array.from(a, (v) => Number(v.toPrecision(8)))
    runs.push({ substeps, count: g.count, position: f32(g.position), velocity: f32(g.velocity), affine: f32(g.affine), deformation: f32(g.deformation), Jp: f32(g.Jp) })
  }
  const result = { options, slope, emit, colliders, dt, runs }
  Object.assign(window, { snowCheck: result, snowCheckReport: report })
  return `MPM snow: GPU vs CPU reference\n${report.join('\n')}`
}
