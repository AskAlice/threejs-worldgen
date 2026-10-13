import * as THREE from 'three/webgpu'
import { World, createSample } from 'threejs-biomes'
import { MPMReference, MPMSolver, bakeMPMHeights, groundAt, type MPMEmit, type MPMInput } from 'threejs-particles'

// The scene of the MPM jelly sandboxes (mpm.ts and mpm-r3f.tsx): the site, the terrain under the solver, and the
// GPU vs CPU check behind `?check`.

/**
 * The sandbox's world and solver: a gently sloped patch of land in a biomes world under a 96 × 64 × 96 grid at
 * Δx = 0.3 m, and a pool of 46³ ≈ 97k particles. `dropAt(block, dropHeight)` is where a block of `block` particles
 * per edge starts, `dropHeight` m above the ground.
 */
export function jellyScene() {
  const world = new World({ seed: 7 })
  const DX = 0.3, RES: [number, number, number] = [96, 64, 96]
  const span = RES[0] * DX
  const site = findSite(world, span)
  const lowest = Math.min(...[0, 0.5, 1].flatMap((a) => [0, 0.5, 1].map((b) => world.height(site[0] + (a - 0.5) * span, site[1] + (b - 0.5) * span))))
  const origin: [number, number, number] = [Math.round((site[0] - span / 2) / DX) * DX, Math.floor(lowest - 1), Math.round((site[1] - span / 2) / DX) * DX]
  const config: MPMInput = {
    capacity: 46 ** 3, resolution: RES, cellSize: DX, origin,
    // Stiffer than the default jelly: a 7 m block sags ~20 % under its own weight (g·L/c²), still 2 substeps at 60 fps.
    materials: { jelly: { density: 1000, youngs: 250000, poisson: 0.3, viscosity: 1000 } },
    friction: 0.8,
  }
  const dropAt = (block: number, dropHeight: number): [number, number, number] => {
    const c = [origin[0] + span / 2, 0, origin[2] + span / 2]
    const half = (block * DX) / 4
    let top = -Infinity
    for (const a of [-1, 0, 1]) for (const b of [-1, 0, 1]) top = Math.max(top, world.height(c[0] + a * half, c[2] + b * half))
    return [c[0], top + half + dropHeight, c[2]]
  }
  return { world, DX, RES, span, origin, config, dropAt }
}

/**
 * Read-back statistics of the jelly: the lowest particle above the collider surface (bilinear between node columns,
 * what the solver guarantees and the terrain mesh draws) and above the exact world height, the centroid and the top
 * speed. `measure()` reads them back (every 2 s in the sandboxes); `hud(fps)` is the sandboxes' status text.
 */
export function jellyStats(mpm: MPMSolver, world: World) {
  const [nx, , nz] = mpm.resolution, DX = mpm.options.cellSize
  const stats = { collider: NaN, terrain: NaN, speed: NaN, mean: NaN, fastGap: NaN, centroid: [0, 0, 0] }
  const heights = new Float32Array(nx * nz)
  const measure = async () => {
    const d = await mpm.read()
    const o = mpm.options.origin
    bakeMPMHeights(world.height, mpm.options, heights)
    let collider = Infinity, terrain = Infinity, speed = 0, mean = 0, fastGap = 0
    const c = [0, 0, 0]
    for (let p = 0; p < d.count; p++) {
      const x = d.position[p * 3], y = d.position[p * 3 + 1], z = d.position[p * 3 + 2]
      const gap = y - groundAt(heights, nx, nz, DX, x, z)[0]
      collider = Math.min(collider, gap)
      terrain = Math.min(terrain, y + o[1] - world.height(x + o[0], z + o[2]))
      const v = Math.hypot(d.velocity[p * 3], d.velocity[p * 3 + 1], d.velocity[p * 3 + 2])
      if (v > speed) { speed = v; fastGap = gap }
      mean += v / d.count
      c[0] += (x + o[0]) / d.count; c[1] += (y + o[1]) / d.count; c[2] += (z + o[2]) / d.count
    }
    Object.assign(stats, { collider, terrain, speed, mean, fastGap, centroid: c })
  }
  const m = (v: number) => (Number.isFinite(v) ? ((Math.round(v * 1000) / 1000 || 0) >= 0 ? '+' : '') + (Math.round(v * 1000) / 1000 || 0).toFixed(3) + ' m' : '…')
  const hud = (fps: number) => `${fps.toFixed(0)} fps · ${mpm.count.toLocaleString()} particles · ${mpm.substeps} substeps · t ${mpm.time.toFixed(1)} s\n` +
    `lowest particle: ${m(stats.collider)} above the collider surface, ${m(stats.terrain)} vs exact terrain\n` +
    `speed: mean ${Number.isFinite(stats.mean) ? stats.mean.toFixed(2) : '…'} m/s, fastest ${Number.isFinite(stats.speed) ? stats.speed.toFixed(2) : '…'} m/s`
  return { stats, measure, hud }
}

// A land site within 3 km whose relief over the domain is 3–8 m (sloped, not a cliff, no water).
export function findSite(world: World, span: number): [number, number] {
  for (let r = 0; r < 3000; r += 40) for (let a = 0; a < 8; a++) {
    const x = r * Math.cos((a * Math.PI) / 4), z = r * Math.sin((a * Math.PI) / 4)
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i <= 6; i++) for (let k = 0; k <= 6; k++) {
      const h = world.height(x + (i / 6 - 0.5) * span, z + (k / 6 - 0.5) * span)
      lo = Math.min(lo, h)
      hi = Math.max(hi, h)
    }
    if (lo > world.options.seaLevel + 2 && hi - lo > 3 && hi - lo < 8) return [x, z]
  }
  return [0, 0]
}

// Terrain mesh with vertices on the solver's node columns (so the drawn ground is the surface the particles
// collide with), extended `pad` cells beyond the domain, coloured by the biomes ground colour.
export function buildTerrain(world: World, origin: [number, number, number], dx: number, cells: number, pad: number) {
  const n = cells + 2 * pad
  const pos = new Float32Array(n * n * 3), col = new Float32Array(n * n * 3)
  const s = createSample(8)
  const c = new THREE.Color()
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
    const x = origin[0] + (i - pad) * dx, z = origin[2] + (k - pad) * dx
    const h = world.height(x, z)
    const slope = Math.hypot(world.height(x + 1, z) - world.height(x - 1, z), world.height(x, z + 1) - world.height(x, z - 1)) / 2
    const g = world.ground(world.sample(x, z, s), slope).color
    c.setRGB(g[0], g[1], g[2], THREE.SRGBColorSpace)
    pos.set([x, h, z], (k * n + i) * 3)
    col.set([c.r, c.g, c.b], (k * n + i) * 3)
  }
  const index = new Uint32Array((n - 1) * (n - 1) * 6)
  let q = 0
  for (let k = 0; k < n - 1; k++) for (let i = 0; i < n - 1; i++) {
    const a = k * n + i
    index.set([a, a + n, a + 1, a + 1, a + n, a + n + 1], q)
    q += 6
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  geo.setIndex(new THREE.BufferAttribute(index, 1))
  geo.computeVertexNormals()
  return new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.95 }))
}

// GPU vs CPU: the same tiny scene (a 0.75 m block thrown onto a slope) through one substep and 24 substeps on
// both; the results go to `window.mpmCheck` (recorded as packages/particles/test/fixtures/mpm-gpu-step.json).
export async function check(renderer: THREE.WebGPURenderer): Promise<string> {
  const slope: [number, number, number] = [0.6, 0.25, 0.1]
  const height = (x: number, z: number) => slope[0] + slope[1] * x + slope[2] * z
  const dt = 1 / 120
  const options: MPMInput = { capacity: 512, resolution: [16, 16, 16], cellSize: 0.25, origin: [0, 0, 0], friction: 0.8, substeps: 1, maxSubsteps: 1 }
  const emit: MPMEmit = { center: [2, height(2.375, 2) + 0.425, 2], size: [0.375, 0.375, 0.375], velocity: [0.5, -2, 0.3] }
  const runs = []
  const report: string[] = []
  for (const substeps of [1, 24]) {
    const gpu = new MPMSolver(renderer, { ...options, height })
    gpu.emit(emit)
    for (let s = 0; s < substeps; s++) gpu.step(dt)
    const g = await gpu.read()
    gpu.dispose()
    const cpu = new MPMReference(options, height)
    cpu.emit(emit)
    for (let s = 0; s < substeps; s++) cpu.substep(dt)
    const err = (a: ArrayLike<number>, b: ArrayLike<number>) => { let e = 0; for (let i = 0; i < b.length; i++) e = Math.max(e, Math.abs(a[i] - b[i])); return e }
    report.push(`${substeps} substep(s): max |Δ| position ${err(cpu.data.position, g.position).toExponential(2)}, velocity ${err(cpu.data.velocity, g.velocity).toExponential(2)}, ` +
      `C ${err(cpu.data.affine, g.affine).toExponential(2)}, F ${err(cpu.data.deformation, g.deformation).toExponential(2)}`)
    const ground = Math.min(...Array.from({ length: g.count }, (_, p) => g.position[p * 3 + 1] - groundAt(cpu.heights, 16, 16, 0.25, g.position[p * 3], g.position[p * 3 + 2])[0]))
    report.push(`  GPU lowest particle vs ground ${ground.toExponential(2)} m`)
    const f32 = (a: ArrayLike<number>) => Array.from(a, (v) => Number(v.toPrecision(8))) // enough digits for float32
    runs.push({ substeps, count: g.count, position: f32(g.position), velocity: f32(g.velocity), affine: f32(g.affine), deformation: f32(g.deformation) })
  }
  const result = { options, slope, emit, dt, runs }
  Object.assign(window, { mpmCheck: result, mpmCheckReport: report })
  return `MPM GPU vs CPU reference\n${report.join('\n')}`
}
