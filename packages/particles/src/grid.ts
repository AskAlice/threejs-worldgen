import { StorageBufferAttribute, Vector3, Vector4, type ComputeNode } from 'three/webgpu'
import { Fn, If, atomicAdd, atomicLoad, atomicStore, clamp, exp, float, floor, int, instanceIndex, ivec3, mix, storage, uniform, vec3, vec4 } from 'three/tsl'
import type { DeepPartial } from './options.ts'
import { merge } from './options.ts'

/** Settings of a {@link ParticleGrid}. Plain JSON. */
export interface GridOptions {
  /** Cells along x, y, z. Changing it rebuilds the buffers. */
  resolution: [number, number, number]
  /** Minimum corner, local space of the systems that use it, metres. */
  min: [number, number, number]
  /** Extent, metres. */
  size: [number, number, number]
  /**
   * Per channel: 1 = the channel persists and is advected (semi-Lagrangian) by `wind` + `rise` each
   * resolve, decaying at `decay`, and splats are rates (added × dt); 0 = the channel is just this
   * frame's splats (e.g. density).
   */
  advect: [number, number, number, number]
  /** Per channel exponential decay of advected values, 1/s. */
  decay: [number, number, number, number]
  /** Advection velocity: air wind, m/s. */
  wind: [number, number, number]
  /** Advection velocity: extra updraft, m/s. */
  rise: number
}

/** Default grid: 32×24×32 cells over a 512 × 384 × 512 m box, channel 0 advected heat, channel 1 instant density. */
export const DEFAULT_GRID: GridOptions = {
  resolution: [32, 24, 32],
  min: [-256, 0, -256],
  size: [512, 384, 512],
  advect: [1, 0, 0, 0],
  decay: [0.02, 0, 0, 0],
  wind: [0, 0, 0],
  rise: 6,
}

const FIXED = 4096 // fixed-point scale of the atomic accumulators

/**
 * An optional coarse 3D grid that particles write to and read from: four float channels per cell,
 * built for particle-to-grid (P2G) and grid-to-particle (G2P) passes. Systems splat into it with
 * {@link ParticleGrid.splat} (atomic adds, any value per particle), {@link ParticleGrid.resolve} turns
 * the splats into the field (and advects persistent channels), and any shader samples it with
 * {@link ParticleGrid.sample} (trilinear).
 *
 * Today it carries a fire's heat (lifting the smoke into a column that leans downwind) and the smoke's
 * own density (self-shadowing). It is also the skeleton an MPM solver needs: momentum + mass splats, a
 * grid update and a gather; see the package README.
 */
export class ParticleGrid {
  /** Resolved settings. */
  options: GridOptions
  /** Cells along x, y, z. */
  readonly resolution: [number, number, number]
  /** Number of cells. */
  readonly cells: number
  /** Uniforms: bounds, advection and per-channel settings. */
  readonly uniforms = {
    /** Minimum corner. */ min: uniform(new Vector3()),
    /** Extent. */ size: uniform(new Vector3()),
    /** Advection velocity (wind + rise). */ velocity: uniform(new Vector3()),
    /** Per-channel advect flags. */ advect: uniform(new Vector4()),
    /** Per-channel decay. */ decay: uniform(new Vector4()),
    /** Seconds since the last resolve. */ dt: uniform(0),
  }
  /** Atomic fixed-point accumulators, 4 ints per cell (written by splats, cleared by resolve). */
  readonly accumulator: StorageBufferAttribute
  /** The field, one vec4 per cell, read by {@link ParticleGrid.sample}. */
  readonly field: StorageBufferAttribute
  private readonly next: StorageBufferAttribute
  private readonly fieldNode: any
  private readonly nextNode: any
  private readonly accAtomic: any
  private readonly resolveNode: ComputeNode
  private readonly commitNode: ComputeNode
  private splats = new WeakMap<object, ComputeNode>()

  /** Creates a grid; anything not given uses {@link DEFAULT_GRID}. */
  constructor(input: DeepPartial<GridOptions> = {}) {
    this.options = merge(structuredClone(DEFAULT_GRID), input)
    this.resolution = this.options.resolution.map((v) => Math.max(2, Math.round(v))) as [number, number, number]
    const [nx, ny, nz] = this.resolution
    this.cells = nx * ny * nz
    this.accumulator = new StorageBufferAttribute(new Int32Array(this.cells * 4), 1)
    this.field = new StorageBufferAttribute(new Float32Array(this.cells * 4), 4)
    this.next = new StorageBufferAttribute(new Float32Array(this.cells * 4), 4)
    this.fieldNode = storage(this.field, 'vec4', this.cells)
    this.nextNode = storage(this.next, 'vec4', this.cells)
    this.accAtomic = storage(this.accumulator, 'int', this.cells * 4).toAtomic()
    this.applyOptions()

    const u = this.uniforms
    const cell = u.size.div(vec3(nx, ny, nz))
    this.resolveNode = Fn(() => {
      const i = instanceIndex
      const x = int(i).mod(nx), y = int(i).div(nx).mod(ny), z = int(i).div(nx * ny)
      const center = u.min.add(vec3(float(x).add(0.5), float(y).add(0.5), float(z).add(0.5)).mul(cell))
      const prev = this.sampleFrom(this.fieldNode, center.sub(u.velocity.mul(u.dt)))
      const keep = exp(u.decay.mul(u.dt).negate()).mul(u.advect)
      const splat = vec4(
        float(atomicLoad(this.accAtomic.element(int(i).mul(4))) as any),
        float(atomicLoad(this.accAtomic.element(int(i).mul(4).add(1))) as any),
        float(atomicLoad(this.accAtomic.element(int(i).mul(4).add(2))) as any),
        float(atomicLoad(this.accAtomic.element(int(i).mul(4).add(3))) as any),
      ).div(FIXED)
      for (let c = 0; c < 4; c++) atomicStore(this.accAtomic.element(int(i).mul(4).add(c)), int(0))
      // Persistent channels integrate splats as rates (per second); instant channels are just this frame's splats.
      this.nextNode.element(i).assign(prev.mul(keep).add(splat.mul(mix(vec4(1), vec4(u.dt), u.advect))))
    })().compute(this.cells, [64])
    this.commitNode = Fn(() => {
      this.fieldNode.element(instanceIndex).assign(this.nextNode.element(instanceIndex))
    })().compute(this.cells, [64])
  }

  /** Merges `input`; bounds, advection and decay are live, a new `resolution` needs a new grid. */
  set(input: DeepPartial<GridOptions>): this {
    this.options = merge(this.options, input)
    return this.applyOptions()
  }

  /** Cell size along x, y, z, metres. */
  cellSize(): Vector3 {
    const [nx, ny, nz] = this.resolution
    const s = this.options.size
    return new Vector3(s[0] / nx, s[1] / ny, s[2] / nz)
  }

  /** Trilinear sample of the field at local position `p` (vec4; zero outside the grid). Any shader stage. */
  sample(p: any): any {
    return this.sampleFrom(this.fieldNode, p)
  }

  /**
   * A compute pass adding `value(particle)` into `channel` of the cell each live particle is in (P2G,
   * nearest cell, atomic). Built once per system; run it with `renderer.compute` after the system's
   * update and before {@link ParticleGrid.resolve}.
   */
  splat(system: { capacity: number; particle: (index: any) => SplatParticle }, channel: number, value: (p: SplatParticle) => any): ComputeNode {
    const [nx, ny, nz] = this.resolution
    const u = this.uniforms
    return Fn(() => {
      const p = system.particle(instanceIndex)
      If(p.alive.greaterThan(0), () => {
        const g = p.position.toVar().sub(u.min).div(u.size).mul(vec3(nx, ny, nz)).floor()
        const inside = g.x.greaterThanEqual(0).and(g.y.greaterThanEqual(0)).and(g.z.greaterThanEqual(0)).and(g.x.lessThan(nx)).and(g.y.lessThan(ny)).and(g.z.lessThan(nz))
        If(inside, () => {
          const cellIndex = int(g.z).mul(nx * ny).add(int(g.y).mul(nx)).add(int(g.x))
          atomicAdd(this.accAtomic.element(cellIndex.mul(4).add(channel)), int(value(p).mul(FIXED)))
        })
      })
    })().compute(system.capacity, [64])
  }

  /** A cached {@link ParticleGrid.splat} pass per (system, channel) key object. */
  splatFor(key: object, build: () => ComputeNode): ComputeNode {
    let node = this.splats.get(key)
    if (!node) this.splats.set(key, (node = build()))
    return node
  }

  /** Turns this frame's splats into the field: advects persistent channels, adds splats, clears the accumulators. */
  resolve(renderer: { compute: (nodes: ComputeNode[]) => unknown }, dt: number): void {
    renderer.compute(this.resolvePasses(dt))
  }

  /** The two resolve passes for `dt`, to batch with other compute work in one `renderer.compute([...])`. */
  resolvePasses(dt: number): ComputeNode[] {
    this.uniforms.dt.value = Math.min(0.1, Math.max(0, dt))
    return [this.resolveNode, this.commitNode]
  }

  /** Frees the GPU buffers' compute pipelines. */
  dispose(): void {
    this.resolveNode.dispose()
    this.commitNode.dispose()
  }

  private applyOptions(): this {
    const o = this.options, u = this.uniforms
    u.min.value.fromArray(o.min)
    u.size.value.fromArray(o.size)
    u.velocity.value.set(o.wind[0], o.wind[1] + o.rise, o.wind[2])
    u.advect.value.fromArray(o.advect)
    u.decay.value.fromArray(o.decay)
    return this
  }

  private sampleFrom(buffer: any, p: any): any {
    const [nx, ny, nz] = this.resolution
    const u = this.uniforms
    const g = p.sub(u.min).div(u.size).mul(vec3(nx, ny, nz)).sub(0.5)
    const inside = clamp(g.x.add(1), 0, 1).mul(clamp(float(nx).sub(g.x), 0, 1))
      .mul(clamp(g.y.add(1), 0, 1)).mul(clamp(float(ny).sub(g.y), 0, 1))
      .mul(clamp(g.z.add(1), 0, 1)).mul(clamp(float(nz).sub(g.z), 0, 1))
    const c = clamp(g, vec3(0), vec3(nx - 1, ny - 1, nz - 1))
    const i0 = (ivec3(floor(c)) as any).min(ivec3(nx - 2, ny - 2, nz - 2))
    const f = c.sub(vec3(i0))
    const at = (dx: number, dy: number, dz: number) => buffer.element(i0.z.add(dz).mul(nx * ny).add(i0.y.add(dy).mul(nx)).add(i0.x.add(dx)))
    const x00 = mix(at(0, 0, 0), at(1, 0, 0), f.x), x10 = mix(at(0, 1, 0), at(1, 1, 0), f.x)
    const x01 = mix(at(0, 0, 1), at(1, 0, 1), f.x), x11 = mix(at(0, 1, 1), at(1, 1, 1), f.x)
    return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z).mul(inside)
  }
}

/** What a splat sees of each particle (see {@link ParticleSystem.particle}). */
export interface SplatParticle {
  /** Local position (vec3). */
  position: any
  /** 1 alive, 0 dead (float). */
  alive: any
  /** Life fraction 0…1. */
  t: any
  /** Temperature, kelvin. */
  temperature: any
  /** Current size, metres. */
  size: any
  /** Source tint. */
  tint: any
}
