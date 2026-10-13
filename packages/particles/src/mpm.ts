import { StorageBufferAttribute, Vector3, Vector4, type ComputeNode, type Renderer } from 'three/webgpu'
import {
  Fn, If, Loop, atomicAdd, atomicLoad, atomicStore, clamp, determinant, dot, float, floor, instanceIndex, instancedArray, int, ivec2, ivec3, length,
  mat3, max, min, select, storage, uniform, uniformArray, vec2, vec3, vec4,
} from 'three/tsl'
import { particleRandom } from './emitter.ts'
import { mpmMaterial, type MPMMaterial } from './mpm-materials.ts'
import {
  MPM_CONTACT_SKIN, MPM_DENSITY_UNIT, MPM_FIXED, MPM_MAX_COLLIDERS, MPM_PPC_AXIS, bakeMPMFriction, bakeMPMHeights, mpmEmitPositions, mpmTimeStep, packMPMColliders, resolveMPMOptions,
  type MPMCollider, type MPMEmit, type MPMFrictionFn, type MPMHeightFn, type MPMInput, type MPMOptions, type MPMParticleData,
} from './mpm-reference.ts'
import { merge, seedOf } from './options.ts'
import { ParticleSystem } from './system.ts'

/** Construction options of an {@link MPMSolver}: settings plus the terrain (not JSON). */
export interface MPMSolverConfig extends MPMInput {
  /** Terrain height under the domain, world metres (e.g. `(x, z) => world.height(x, z)`). None: no ground. */
  height?: MPMHeightFn | null
}

/** GPU buffers of a solver (the particle pool's own plus the MPM state), for custom passes. */
export interface MPMBuffers {
  /** xyz position (local to `origin`), w render value (0…1, the colour ramp key). The pool's `position`. */
  position: any
  /** xyz velocity (m/s), w 1 alive / 0 empty slot. The pool's `velocity`. */
  velocity: any
  /** x temperature (K), y size scale, z random 0…1, w free. The pool's `props`. */
  props: any
  /** APIC affine matrix C: 3 vec4 columns per particle (xyz used). */
  affine: any
  /** Deformation gradient F: 3 vec4 columns per particle (xyz used). */
  deformation: any
  /** x material index, y Jp, z and w free for materials. */
  state: any
  /** Grid after the last substep: xyz velocity (m/s), w mass (normalised units), one vec4 per node. */
  grid: any
  /** Terrain height per node column (x + z·nx), metres above `origin[1]`; then (from nx·nz) the friction multiplier per column. */
  heights: any
}

/**
 * A real-time MLS-MPM solver (moving least squares material point method, Hu et al. 2018) on WebGPU compute:
 * APIC transfers with quadratic B-splines over 3×3×3 nodes, fixed-point atomic P2G (deterministic), a grid
 * update with gravity, domain walls and a terrain height-function boundary with Coulomb friction, and G2P
 * advection with a per-material stress and plasticity hook. Several substeps per frame at a stable time
 * step. The domain is a fixed-size grid placed anywhere (`origin`, or {@link MPMSolver.center} to follow
 * the camera); particles outside it freeze.
 *
 * Particles live in a {@link ParticleSystem} pool and draw through its unlit shading, coloured by volume
 * change. Materials come from the registry ({@link registerMPMMaterial}); the core ships `jelly`.
 *
 * @example
 * ```ts
 * const mpm = new MPMSolver(renderer, { origin: [-8, 0, -8], height: (x, z) => world.height(x, z) })
 * scene.add(mpm.object)
 * mpm.emit({ center: [0, 6, 0], size: [1, 1, 1] })
 * renderer.setAnimationLoop(() => { mpm.step(dt); renderer.render(scene, camera) })
 * ```
 */
export class MPMSolver {
  /** Resolved settings. */
  options: MPMOptions
  /** The particle pool (its buffers hold position, velocity and props; it draws them). */
  readonly particles: ParticleSystem
  /** Add this to your scene. It sits at `origin`; particle positions are local to it. */
  readonly object: ParticleSystem['object']
  /** Most particles. */
  readonly capacity: number
  /** Grid nodes along x, y, z. */
  readonly resolution: [number, number, number]
  /** Material names compiled in, by index. */
  readonly materials: string[]
  /** GPU buffers. */
  readonly buffers: MPMBuffers
  /** Live particles (at most `capacity`; the oldest are overwritten when full). */
  count = 0
  /** Simulated seconds. */
  time = 0
  /** Substeps of the last {@link MPMSolver.step}. */
  substeps = 0
  /** Shader uniforms. */
  readonly uniforms = {
    /** Substep, seconds. */ dt: uniform(0),
    /** Gravity. */ gravity: uniform(new Vector3()),
    /** −dt / (2000·Δx²): P2G stress factor in normalised momentum units. */ stressScale: uniform(0),
    /** Δx. */ dx: uniform(1),
    /** 1/Δx. */ invDx: uniform(1),
    /** Speed limit. */ maxSpeed: uniform(10),
    /** Coulomb friction. */ friction: uniform(0.5),
    /** Domain walls on (1) or off (0). */ walls: uniform(1),
    /** Domain move, metres (applied by the shift pass). */ shift: uniform(new Vector3()),
    /** Colour ramp: key = 0.5 + (J − 1) × strainScale. */ strainScale: uniform(4),
    /** Colliders in use (see {@link MPMSolver.setColliders}). */ colliders: uniform(0, 'int'),
  }
  /** Per material: its parameters as uniforms, and particle mass in normalised units. */
  readonly params: { values: Record<string, any>; mass: any }[]

  private readonly renderer: Renderer
  private readonly gridAtomic: any
  private readonly heightData: Float32Array<ArrayBuffer>
  private readonly p2gNode: ComputeNode
  private readonly gridNode: ComputeNode
  private readonly g2pNode: ComputeNode
  private readonly shiftNode: ComputeNode
  private height: MPMHeightFn | null
  private frictionFn: MPMFrictionFn | null = null
  private colliderList: MPMCollider[] = []
  private readonly colliderData = new Float32Array(MPM_MAX_COLLIDERS * 12)
  // A uniform array, not a storage buffer: G2P already binds 8 storage buffers, WebGPU's default per-stage limit.
  private readonly colliderNode = uniformArray(Array.from({ length: MPM_MAX_COLLIDERS * 3 }, () => new Vector4()), 'vec4')
  private head = 0
  private serial = 0
  private shiftPending = false
  private warned = false

  /**
   * Creates a solver. Settings not given use `DEFAULT_MPM`. `capacity`, `resolution`, `cellSize` and which
   * `materials` are compiled in are fixed at construction; everything else is live through `set`.
   */
  constructor(renderer: Renderer, { height = null, ...input }: MPMSolverConfig = {}) {
    this.renderer = renderer
    this.options = resolveMPMOptions(input)
    const o = this.options
    this.capacity = o.capacity
    this.resolution = [...o.resolution]
    this.height = height
    this.materials = Object.keys(o.materials)
    const mats = this.materials.map((name) => mpmMaterial(name) as MPMMaterial)
    this.params = mats.map((m) => ({ values: Object.fromEntries(Object.keys(m.defaults).map((k) => [k, uniform(0)])), mass: uniform(0) }))

    this.particles = new ParticleSystem({
      capacity: o.capacity, rate: 0, life: [1, 1], seed: o.seed,
      curves: { size: [1], opacity: [1], color: o.render.colors },
      render: { shading: 'unlit', blending: 'alpha', sizeRandom: [1, 1], detail: 0, softness: o.cellSize / 4 },
    })
    this.object = this.particles.object
    this.object.name = 'MPM particles'

    const [nx, ny, nz] = this.resolution
    const cells = nx * ny * nz
    const n = this.capacity
    this.heightData = new Float32Array(nx * nz * 2) // heights, then friction multipliers (one binding: G2P is at 8)
    const pb = this.particles.buffers
    this.buffers = {
      position: pb.position, velocity: pb.velocity, props: pb.props,
      affine: instancedArray(n * 3, 'vec4'), deformation: instancedArray(n * 3, 'vec4'), state: instancedArray(n, 'vec4'),
      grid: instancedArray(cells, 'vec4'), heights: instancedArray(this.heightData, 'float'),
    }
    this.gridAtomic = storage(new StorageBufferAttribute(new Int32Array(cells * 4), 1), 'int', cells * 4).toAtomic()
    this.p2gNode = this.buildP2G(mats)
    this.gridNode = this.buildGrid()
    this.g2pNode = this.buildG2P(mats)
    this.shiftNode = this.buildShift()
    this.applyOptions(null)
  }

  /** Merges `input` into the settings. Structural settings (see the constructor) are kept, with a warning. */
  set(input: MPMInput): this {
    const prev = this.options
    const next = resolveMPMOptions(merge(structuredClone(prev), input), prev)
    const keys = Object.keys(next.materials)
    if (next.capacity !== prev.capacity || next.cellSize !== prev.cellSize || String(next.resolution) !== String(prev.resolution) || String(keys) !== String(this.materials)) {
      console.warn('threejs-particles: MPM capacity, resolution, cellSize and the set of materials are fixed at construction')
    }
    next.capacity = prev.capacity
    next.cellSize = prev.cellSize
    next.resolution = [...this.resolution]
    next.materials = Object.fromEntries(this.materials.map((m) => [m, next.materials[m] ?? prev.materials[m]]))
    this.options = next
    return this.applyOptions(prev)
  }

  /** Replaces the terrain height function (re-baked at the node columns); `null` removes the ground. */
  setHeight(height: MPMHeightFn | null): this {
    this.height = height
    return this.bakeHeights()
  }

  /**
   * Scales the terrain `friction` by `friction(x, z)` (world metres, ≥ 0) per node column, e.g. a weak layer under a
   * slab that releases while the snow around it holds. Re-baked when the domain moves; `null` for 1 everywhere.
   */
  setFriction(friction: MPMFrictionFn | null): this {
    this.frictionFn = friction
    return this.bakeHeights()
  }

  /**
   * Sets the kinematic colliders (spheres or capsules, world metres; at most `MPM_MAX_COLLIDERS`), e.g. feet or
   * wheels, each frame as they move. Give them their `velocity` so they push material along (footprints, tracks).
   */
  setColliders(colliders: readonly MPMCollider[]): this {
    this.colliderList = [...colliders]
    return this
  }

  /**
   * Moves the domain so it is centred on a world position (e.g. the camera), by whole cells and only once the
   * position is more than a quarter of the domain off centre. Particles keep their world positions.
   */
  center(x: number, y: number, z: number): this {
    const o = this.options
    const target = [x, y, z].map((v, a) => v - (this.resolution[a] * o.cellSize) / 2)
    const off = target.some((v, a) => Math.abs(v - o.origin[a]) > (this.resolution[a] * o.cellSize) / 4)
    return off ? this.set({ origin: target as [number, number, number] }) : this
  }

  /**
   * Adds a block of particles (a seeded `Δx/2` lattice in a box or sphere, or explicit world positions; see
   * {@link MPMEmit}) with F = I, C = 0, Jp = 1. Returns how many. When the pool is full the oldest are replaced.
   */
  emit(spec: MPMEmit): number {
    const o = this.options
    const pos = mpmEmitPositions(spec, o.cellSize, o.seed, this.serial, this.capacity)
    const k = pos.length / 3
    if (!k) return 0
    const id = Math.max(0, this.materials.indexOf(spec.material ?? this.materials[0]))
    if (spec.material && !this.materials.includes(spec.material)) console.warn(`threejs-particles: MPM material '${spec.material}' is not compiled in; using '${this.materials[id]}'`)
    const b = this.buffers
    const P = b.position.value.array as Float32Array, V = b.velocity.value.array as Float32Array, Q = b.props.value.array as Float32Array
    const A = b.affine.value.array as Float32Array, F = b.deformation.value.array as Float32Array, S = b.state.value.array as Float32Array
    const seed = seedOf(o.seed)
    const vel = spec.velocity ?? [0, 0, 0]
    for (let p = 0; p < k; p++) {
      const s = (this.head + p) % this.capacity
      P.set([pos[p * 3] - o.origin[0], pos[p * 3 + 1] - o.origin[1], pos[p * 3 + 2] - o.origin[2], 0.5], s * 4)
      const pv = spec.velocities, q = p * 3
      V.set(pv ? [pv[q] ?? 0, pv[q + 1] ?? 0, pv[q + 2] ?? 0, 1] : [vel[0], vel[1], vel[2], 1], s * 4)
      Q.set([spec.temperature ?? 293, 1, particleRandom(this.serial + p, 15, seed), 0], s * 4)
      A.fill(0, s * 12, s * 12 + 12)
      F.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], s * 12)
      S.set([id, 1, spec.tag ?? 0, 0], s * 4)
    }
    // Upload only the slots written (one or two runs around the ring).
    const runs: [number, number][] = [[this.head, Math.min(k, this.capacity - this.head)]]
    if (runs[0][1] < k) runs.push([0, k - runs[0][1]])
    for (const [node, stride] of [[b.position, 4], [b.velocity, 4], [b.props, 4], [b.affine, 12], [b.deformation, 12], [b.state, 4]] as const) {
      for (const [start, count] of runs) node.value.addUpdateRange(start * stride, count * stride)
      node.value.needsUpdate = true
    }
    this.head = (this.head + k) % this.capacity
    this.count = Math.min(this.capacity, this.count + k)
    this.serial += k
    return k
  }

  /**
   * Advances `dt` seconds (capped at 0.1) on the GPU in substeps: P2G, grid update (which also clears the
   * accumulators) and G2P each. Needs the WebGPU backend; on WebGL the particles hide themselves.
   */
  step(dt: number): this {
    const nodes = this.prepare(dt)
    if (nodes.length) this.renderer.compute(nodes)
    return this
  }

  /** {@link MPMSolver.step}'s compute passes for `dt`, to batch with other work in one `renderer.compute([...])`. */
  prepare(dt: number): ComputeNode[] {
    const backend = (this.renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend
    if (!backend?.isWebGPUBackend) {
      this.object.visible = false
      if (!this.warned) console.warn('threejs-particles: MPM needs the WebGPU backend; particles are hidden.')
      this.warned = true
      return []
    }
    const nodes: ComputeNode[] = []
    if (this.shiftPending) nodes.push(this.shiftNode)
    this.shiftPending = false
    const { substeps, dt: sub } = mpmTimeStep(this.options, dt)
    this.substeps = sub > 0 ? substeps : 0
    if (!this.substeps || !this.count) return nodes
    this.uniforms.dt.value = sub
    this.uniforms.stressScale.value = -sub / ((MPM_DENSITY_UNIT * MPM_PPC_AXIS ** 3 / 4) * this.options.cellSize ** 2)
    const colliders = packMPMColliders(this.colliderList, this.options.origin, this.options.friction, this.colliderData)
    for (let k = 0; k < colliders * 3; k++) (this.colliderNode.array[k] as Vector4).fromArray(this.colliderData, k * 4)
    this.uniforms.colliders.value = colliders
    for (let s = 0; s < substeps; s++) nodes.push(this.p2gNode, this.gridNode, this.g2pNode)
    this.time += sub * substeps
    return nodes
  }

  /** Reads the particle state back from the GPU (slow; for tests, debugging and tools). */
  async read(): Promise<MPMParticleData> {
    const b = this.buffers, r = this.renderer
    const get = async (node: any) => new Float32Array(await r.getArrayBufferAsync(node.value))
    const [P, V, Q, A, F, S] = await Promise.all([b.position, b.velocity, b.props, b.affine, b.deformation, b.state].map(get))
    const n = this.count
    const out: MPMParticleData = {
      count: n, position: new Float32Array(n * 3), velocity: new Float32Array(n * 3), affine: new Float32Array(n * 9), deformation: new Float32Array(n * 9),
      Jp: new Float32Array(n), temperature: new Float32Array(n), material: new Int32Array(n),
    }
    for (let p = 0; p < n; p++) {
      for (let a = 0; a < 3; a++) {
        out.position[p * 3 + a] = P[p * 4 + a]
        out.velocity[p * 3 + a] = V[p * 4 + a]
        for (let c = 0; c < 3; c++) {
          out.affine[p * 9 + c * 3 + a] = A[p * 12 + c * 4 + a]
          out.deformation[p * 9 + c * 3 + a] = F[p * 12 + c * 4 + a]
        }
      }
      out.material[p] = S[p * 4]
      out.Jp[p] = S[p * 4 + 1]
      out.temperature[p] = Q[p * 4]
    }
    return out
  }

  /** Removes every particle. */
  clear(): this {
    const kill = Fn(() => { this.buffers.velocity.element(instanceIndex).assign(vec4(0)) })().compute(this.capacity, [64])
    this.renderer.compute(kill)
    kill.dispose()
    this.count = this.head = 0
    return this
  }

  /** Removes the mesh and frees the GPU passes. */
  dispose(): void {
    this.particles.dispose()
    for (const n of [this.p2gNode, this.gridNode, this.g2pNode, this.shiftNode]) n.dispose()
  }

  private applyOptions(prev: MPMOptions | null): this {
    const o = this.options, u = this.uniforms
    u.gravity.value.fromArray(o.gravity)
    u.dx.value = o.cellSize
    u.invDx.value = 1 / o.cellSize
    u.maxSpeed.value = o.maxSpeed
    u.friction.value = o.friction
    u.walls.value = o.walls ? 1 : 0
    u.strainScale.value = o.render.strainScale
    this.materials.forEach((name, i) => {
      const p = o.materials[name]
      for (const [k, node] of Object.entries(this.params[i].values)) node.value = p[k]
      this.params[i].mass.value = p.density / (MPM_DENSITY_UNIT * MPM_PPC_AXIS ** 3)
    })
    this.particles.set({ curves: { color: o.render.colors }, render: { size: (o.render.size * o.cellSize) / MPM_PPC_AXIS, opacity: o.render.opacity } })
    if (!prev || String(prev.origin) !== String(o.origin)) {
      // Snap the move to whole cells so the grid and the particles stay aligned.
      const from = prev?.origin ?? o.origin
      const d = o.origin.map((v, a) => Math.round((v - from[a]) / o.cellSize) * o.cellSize)
      o.origin = from.map((v, a) => v + d[a]) as [number, number, number]
      if (prev && d.some((v) => v !== 0)) {
        if (!this.shiftPending) u.shift.value.set(0, 0, 0)
        u.shift.value.add(new Vector3(d[0], d[1], d[2])) // moves before the next step add up
        this.shiftPending = true
      }
      this.object.position.fromArray(o.origin)
      this.bakeHeights()
    }
    return this
  }

  private bakeHeights(): this {
    bakeMPMHeights(this.height, this.options, this.heightData)
    bakeMPMFriction(this.frictionFn, this.options, this.heightData, this.resolution[0] * this.resolution[2])
    this.buffers.heights.value.needsUpdate = true
    return this
  }

  // ---- compute ----

  // Quadratic B-spline stencil of local position x: base node, fractional offset, weights per axis, and whether
  // the 3×3×3 stencil fits in the grid (else the particle is frozen).
  private kernel(x: any) {
    const [nx, ny, nz] = this.resolution
    const xg: any = x.mul(this.uniforms.invDx).toVar()
    const base: any = floor(xg.sub(0.5)).toVar()
    const fx: any = xg.sub(base).toVar()
    const w = [fx.sub(1.5).mul(fx.sub(1.5)).mul(0.5).toVar(), float(0.75).sub(fx.sub(1).mul(fx.sub(1))).toVar(), fx.sub(0.5).mul(fx.sub(0.5)).mul(0.5).toVar()]
    const active = base.x.greaterThanEqual(0).and(base.y.greaterThanEqual(0)).and(base.z.greaterThanEqual(0))
      .and(base.x.lessThanEqual(nx - 3)).and(base.y.lessThanEqual(ny - 3)).and(base.z.lessThanEqual(nz - 3))
    const ib: any = ivec3(base).toVar()
    const node = (i: number, j: number, k: number) => ib.z.add(k).mul(nx * ny).add(ib.y.add(j).mul(nx)).add(ib.x.add(i))
    const weight = (i: number, j: number, k: number) => w[i].x.mul(w[j].y).mul(w[k].z)
    const dpos = (i: number, j: number, k: number) => vec3(i, j, k).sub(fx).mul(this.uniforms.dx)
    return { active, node, weight, dpos }
  }

  private matrix(buffer: any, i: any): any {
    const col = (c: number) => buffer.element(int(i).mul(3).add(c)).xyz
    return (mat3 as any)(col(0), col(1), col(2)).toVar()
  }

  private buildP2G(mats: MPMMaterial[]): ComputeNode {
    const u = this.uniforms, b = this.buffers, acc = this.gridAtomic
    const fixed = (v: any) => int(floor(v.mul(MPM_FIXED).add(0.5))) // saturating i32 conversion in WGSL
    return Fn(() => {
      const i = instanceIndex
      const V = b.velocity.element(i).toVar()
      If(V.w.greaterThan(0), () => {
        const P = b.position.element(i).toVar()
        const k = this.kernel(P.xyz)
        If(k.active, () => {
          const S = b.state.element(i).toVar()
          const F = this.matrix(b.deformation, i), C = this.matrix(b.affine, i)
          const T = b.props.element(i).x.toVar()
          const J = determinant(F).toVar()
          const tau: any = (mat3 as any)(vec3(0), vec3(0), vec3(0)).toVar()
          const mass = float(0).toVar()
          mats.forEach((m, id) => {
            const run = () => {
              tau.assign(m.stress({ F, J, Jp: S.y, C, temperature: T, dt: u.dt, params: this.params[id].values }))
              mass.assign(this.params[id].mass)
            }
            if (mats.length === 1) run()
            else If(int(S.x).equal(id), run)
          })
          const A = tau.mul(u.stressScale).add(C.mul(mass)).toVar()
          const mv = V.xyz.mul(mass).toVar()
          for (let z = 0; z < 3; z++) for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
            const weight = k.weight(x, y, z).toVar()
            const val = mv.add(A.mul(k.dpos(x, y, z))).mul(weight).toVar()
            const n = k.node(x, y, z).mul(4).toVar()
            atomicAdd(acc.element(n), fixed(val.x))
            atomicAdd(acc.element(n.add(1)), fixed(val.y))
            atomicAdd(acc.element(n.add(2)), fixed(val.z))
            atomicAdd(acc.element(n.add(3)), fixed(weight.mul(mass)))
          }
        })
      })
    })().compute(this.capacity, [64])
  }

  private buildGrid(): ComputeNode {
    const u = this.uniforms, acc = this.gridAtomic, H = this.buffers.heights
    const [nx, ny, nz] = this.resolution
    return Fn(() => {
      const n: any = int(instanceIndex).toVar()
      const x: any = n.mod(nx).toVar(), y: any = n.div(nx).mod(ny).toVar(), z: any = n.div(nx * ny).toVar()
      const load = (c: number): any => float(atomicLoad(acc.element(n.mul(4).add(c))) as any)
      const m: any = load(3).toVar()
      const p: any = vec3(load(0), load(1), load(2)).toVar()
      for (let c = 0; c < 4; c++) atomicStore(acc.element(n.mul(4).add(c)), int(0)) // the grid clear, every substep
      const v = vec3(0).toVar()
      If(m.greaterThan(0), () => {
        v.assign(p.div(m).add(u.gravity.mul(u.dt)))
        // Domain walls: no velocity out through the 2-node border.
        const wall = u.walls.greaterThan(0)
        const lo = (i: any) => wall.and(i.lessThan(int(2))), hi = (i: any, size: number) => wall.and(i.greaterThan(int(size - 3)))
        v.assign(vec3(
          select(lo(x).and(v.x.lessThan(0)).or(hi(x, nx).and(v.x.greaterThan(0))), float(0), v.x),
          select(lo(y).and(v.y.lessThan(0)).or(hi(y, ny).and(v.y.greaterThan(0))), float(0), v.y),
          select(lo(z).and(v.z.lessThan(0)).or(hi(z, nz).and(v.z.greaterThan(0))), float(0), v.z),
        ))
        // Terrain: nodes in the ground lose their inward velocity, with Coulomb friction.
        const h = H.element(z.mul(nx).add(x))
        If(float(y).mul(u.dx).lessThanEqual(h), () => {
          const imax = max as any, imin = min as any
          const x0 = imax(x.sub(1), int(0)), x1 = imin(x.add(1), int(nx - 1)), z0 = imax(z.sub(1), int(0)), z1 = imin(z.add(1), int(nz - 1))
          const hx = H.element(z.mul(nx).add(x1)).sub(H.element(z.mul(nx).add(x0))).div(float(x1.sub(x0)).mul(u.dx))
          const hz = H.element(z1.mul(nx).add(x)).sub(H.element(z0.mul(nx).add(x))).div(float(z1.sub(z0)).mul(u.dx))
          v.assign(friction(v, vec3(hx.negate(), 1, hz.negate()).normalize(), u.friction.mul(H.element(z.mul(nx).add(x).add(nx * nz))), false))
        })
        this.collide(vec3(float(x), float(y), float(z)).mul(u.dx), v, false)
      })
      this.buffers.grid.element(n).assign(vec4(v, m.div(MPM_FIXED)))
    })().compute(this.resolution[0] * this.resolution[1] * this.resolution[2], [64])
  }

  private buildG2P(mats: MPMMaterial[]): ComputeNode {
    const u = this.uniforms, b = this.buffers, G = b.grid
    return Fn(() => {
      const i = instanceIndex
      const V = b.velocity.element(i).toVar()
      If(V.w.greaterThan(0), () => {
        const P = b.position.element(i).toVar()
        const k = this.kernel(P.xyz)
        If(k.active, () => {
          const v = vec3(0).toVar(), c0 = vec3(0).toVar(), c1 = vec3(0).toVar(), c2 = vec3(0).toVar()
          for (let z = 0; z < 3; z++) for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
            const wv = G.element(k.node(x, y, z)).xyz.mul(k.weight(x, y, z)).toVar()
            const d = k.dpos(x, y, z)
            v.addAssign(wv)
            c0.addAssign(wv.mul(d.x))
            c1.addAssign(wv.mul(d.y))
            c2.addAssign(wv.mul(d.z))
          }
          const s4 = u.invDx.mul(u.invDx).mul(4)
          const C: any = (mat3 as any)(c0.mul(s4), c1.mul(s4), c2.mul(s4)).toVar()
          // F ← (I + dt·C)·F, column by column.
          const F0 = this.matrix(b.deformation, i)
          const col = (c: number) => F0.element(c).add(C.mul(F0.element(c)).mul(u.dt))
          const F: any = (mat3 as any)(col(0), col(1), col(2)).toVar()
          const S = b.state.element(i).toVar(), Q = b.props.element(i).toVar()
          const Jp = S.y.toVar(), T = Q.x.toVar()
          mats.forEach((m, id) => {
            if (!m.plasticity) return
            const run = () => {
              const r = m.plasticity!({ F, J: determinant(F), Jp, C, temperature: T, dt: u.dt, params: this.params[id].values })
              if (r.F) F.assign(r.F)
              if (r.Jp) Jp.assign(r.Jp)
              if (r.temperature) T.assign(r.temperature)
            }
            if (mats.length === 1) run()
            else If(int(S.x).equal(id), run)
          })
          v.mulAssign(min(float(1), u.maxSpeed.div(max(length(v), 1e-9))))
          // Particle contact on top of the grid boundary: friction within the skin, never below the ground.
          const g0 = this.ground(P.xz)
          const mu = u.friction.mul(this.frictionAt(P.xz)).toVar()
          If(P.y.lessThan(g0.x.add(u.dx.mul(MPM_CONTACT_SKIN))), () => {
            v.assign(friction(v, vec3(g0.y.negate(), 1, g0.z.negate()).normalize(), mu, true))
          })
          this.collide(P.xyz, v, false)
          const pos = P.xyz.add(v.mul(u.dt)).toVar()
          this.collide(pos, v, true) // out of the colliders, then never under the ground
          const g1: any = this.ground(pos.xz).toVar()
          If(pos.y.lessThan(g1.x), () => {
            // Out along the ground normal (exact for a plane), not straight up.
            const nrm = vec3(g1.y.negate(), 1, g1.z.negate()).toVar()
            pos.addAssign(nrm.mul(g1.x.sub(pos.y).div(dot(nrm, nrm))))
            v.assign(friction(v, nrm.normalize(), mu, false))
          })
          const J = determinant(F)
          b.position.element(i).assign(vec4(pos, clamp(J.sub(1).mul(u.strainScale).add(0.5), 0, 1)))
          b.velocity.element(i).assign(vec4(v, 1))
          b.props.element(i).assign(vec4(T, Q.y, Q.z, Q.w))
          b.state.element(i).assign(vec4(S.x, Jp, S.z, S.w))
          const cols = [c0.mul(s4), c1.mul(s4), c2.mul(s4)]
          for (let c = 0; c < 3; c++) {
            b.affine.element(int(i).mul(3).add(c)).assign(vec4(cols[c], 0))
            b.deformation.element(int(i).mul(3).add(c)).assign(vec4(F.element(c), 0))
          }
        })
      })
    })().compute(this.capacity, [64])
  }

  // Friction multiplier of the node column nearest local (x, z), as `nearestColumn` on the CPU.
  private frictionAt(xz: any): any {
    const [nx, , nz] = this.resolution
    const c: any = (clamp as any)(ivec2(floor(xz.mul(this.uniforms.invDx).add(0.5)) as any), ivec2(0, 0), ivec2(nx - 1, nz - 1)).toVar()
    return this.buffers.heights.element(c.y.mul(nx).add(c.x).add(nx * nz))
  }

  // Bilinear ground under local (x, z): vec3(height, dh/dx, dh/dz), as `groundAt` on the CPU.
  private ground(xz: any): any {
    const [nx, , nz] = this.resolution
    const H = this.buffers.heights, u = this.uniforms
    const g: any = clamp(xz.mul(u.invDx), vec2(0), vec2(nx - 1, nz - 1)).toVar()
    const i0: any = (min as any)(ivec2(floor(g) as any), ivec2(nx - 2, nz - 2)).toVar()
    const f: any = g.sub(vec2(i0)).toVar()
    const at = (di: number, dk: number) => H.element(i0.y.add(dk).mul(nx).add(i0.x.add(di)))
    const h00 = at(0, 0).toVar(), h10 = at(1, 0).toVar(), h01 = at(0, 1).toVar(), h11 = at(1, 1).toVar()
    const h = h00.mul(f.x.oneMinus()).add(h10.mul(f.x)).mul(f.y.oneMinus()).add(h01.mul(f.x.oneMinus()).add(h11.mul(f.x)).mul(f.y))
    const hx = h10.sub(h00).mul(f.y.oneMinus()).add(h11.sub(h01).mul(f.y)).mul(u.invDx)
    const hz = h01.sub(h00).mul(f.x.oneMinus()).add(h11.sub(h10).mul(f.x)).mul(u.invDx)
    return vec3(h, hx, hz)
  }

  // The colliders (as `collideMPM` on the CPU): Coulomb projection of the velocity var `v` relative to each collider
  // containing local point `x`; with `push`, the var `x` also moves out to the surface.
  private collide(x: any, v: any, push: boolean): void {
    const K: any = this.colliderNode
    Loop(this.uniforms.colliders, ({ i }: { i: any }) => {
      const A = K.element(i.mul(3)).toVar(), B = K.element(i.mul(3).add(1)).toVar(), vc = K.element(i.mul(3).add(2)).xyz.toVar()
      const ab = B.xyz.sub(A.xyz).toVar(), ax = x.sub(A.xyz).toVar()
      const t = clamp(dot(ax, ab).div(max(dot(ab, ab), 1e-12)), 0, 1)
      const d = ax.sub(ab.mul(t)).toVar()
      const len = length(d).toVar()
      If(len.lessThan(A.w), () => {
        const n = select(len.greaterThan(1e-9), d.div(max(len, 1e-9)), vec3(0, 1, 0)).toVar()
        v.assign(friction(v.sub(vc), n, B.w, false).add(vc))
        if (push) x.addAssign(n.mul(A.w.sub(len)))
      })
    })
  }

  private buildShift(): ComputeNode {
    const b = this.buffers
    return Fn(() => {
      const P = b.position.element(instanceIndex)
      P.assign(vec4(P.xyz.sub(this.uniforms.shift), P.w))
    })().compute(this.capacity, [64])
  }
}

/** Coulomb friction projection (TSL), as `projectFriction` on the CPU: only when moving into the surface. */
function friction(v: any, n: any, mu: any, keepNormal: boolean): any {
  const vn = dot(v, n).toVar()
  const t = v.sub(n.mul(vn)).toVar()
  const lt = length(t)
  const s = select(lt.lessThanEqual(mu.mul(vn).negate()), float(0), float(1).add(mu.mul(vn).div(max(lt, 1e-12))))
  const out = keepNormal ? t.mul(s).add(n.mul(vn)) : t.mul(s)
  return select(vn.lessThan(0), out, v)
}
