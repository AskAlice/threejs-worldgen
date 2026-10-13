import {
  AdditiveBlending, BufferAttribute, Color, CustomBlending, OneFactor, OneMinusSrcAlphaFactor, Data3DTexture, InstancedBufferGeometry, Mesh, MeshBasicNodeMaterial, NormalBlending, Sphere, Vector3,
  type Camera, type ComputeNode, type DirectionalLight, type HemisphereLight, type AmbientLight, type Object3D, type PerspectiveCamera, type Renderer,
} from 'three/webgpu'
import {
  Fn, If, Loop, abs, cameraPosition, clamp, cross, dot, exp, float, hash, instanceIndex, instancedArray, int, length, max, mix, modelWorldMatrix,
  normalize, perspectiveDepthToViewZ, logarithmicDepthToViewZ, cameraNear, cameraFar, positionGeometry, positionView, pow, screenUV, select, smoothstep, sqrt,
  storage, uint, uniform, uv, varying, vec2, vec3, vec4, viewportDepthTexture, viewportSharedTexture,
} from 'three/tsl'
import { CountingSort } from 'three/addons/gpgpu/CountingSort.js'
import { blackbodyNode } from './blackbody.ts'
import { CurveUniforms } from './curves.ts'
import { EmitterClock, createSourceTable, fillSourceTable, spawnRate, type SourceTable } from './emitter.ts'
import type { ParticleGrid, SplatParticle } from './grid.ts'
import { curlNoise, noiseVolume, sampleNoise } from './noise.ts'
import { merge, resolveParticleOptions, seedOf, type ParticleInput, type ParticleOptions } from './options.ts'

/** Sun and sky light for lit particles, shared by any number of systems. Fill it from your scene with {@link ParticleLighting.fromScene}. */
export class ParticleLighting {
  /** Uniforms read by the smoke shading. */
  readonly uniforms = {
    /** Unit vector towards the sun (world). */ sunDirection: uniform(new Vector3(0.3, 0.8, 0.2).normalize()),
    /** Sun colour × intensity (linear). */ sunColor: uniform(new Color(3, 3, 3)),
    /** Ambient sky light colour × intensity (linear). */ ambient: uniform(new Color(0.45, 0.5, 0.6)),
  }
  private found: { root: Object3D; sun: DirectionalLight | null; sky: (HemisphereLight | AmbientLight)[] } | null = null

  /** Copies the first directional light (sun) and the hemisphere/ambient lights under `root`. The lights are looked up once per root. */
  fromScene(root: Object3D): this {
    if (this.found?.root !== root) {
      const f = { root, sun: null as DirectionalLight | null, sky: [] as (HemisphereLight | AmbientLight)[] }
      root.traverse((o) => {
        if (!f.sun && (o as DirectionalLight).isDirectionalLight) f.sun = o as DirectionalLight
        if ((o as HemisphereLight).isHemisphereLight || (o as AmbientLight).isAmbientLight) f.sky.push(o as HemisphereLight)
      })
      this.found = f
    }
    const { sun, sky } = this.found
    const u = this.uniforms
    if (sun) {
      sun.updateWorldMatrix(true, false)
      sun.target.updateWorldMatrix(true, false)
      u.sunDirection.value.setFromMatrixPosition(sun.matrixWorld).sub(_v.setFromMatrixPosition(sun.target.matrixWorld)).normalize()
      u.sunColor.value.copy(sun.color).multiplyScalar(sun.visible ? sun.intensity : 0)
    }
    if (sky.length) {
      u.ambient.value.setRGB(0, 0, 0)
      for (const l of sky) {
        if (!l.visible) continue
        const g = (l as HemisphereLight).groundColor
        _c.copy(l.color)
        if (g) _c.add(g).multiplyScalar(0.5)
        u.ambient.value.add(_c.multiplyScalar(l.intensity))
      }
    }
    return this
  }

  /** Sets the light directly: direction towards the sun, sun colour × intensity, ambient colour × intensity. */
  set(sunDirection: readonly number[], sunColor: Color, ambient: Color): this {
    this.uniforms.sunDirection.value.fromArray(sunDirection).normalize()
    this.uniforms.sunColor.value.copy(sunColor)
    this.uniforms.ambient.value.copy(ambient)
    return this
  }
}

/** Construction options of a {@link ParticleSystem}: settings plus object inputs (not JSON). */
export interface ParticleSystemConfig extends ParticleInput {
  /** Grid to read heat and density from (lift, smoke self-shadowing). */
  grid?: ParticleGrid | null
  /** Shared sun/sky light (default: a new one; call `lighting.fromScene(scene)`). */
  lighting?: ParticleLighting
  /** Most `sources` (see {@link ParticleSystem.setSources}). Default 4096. */
  maxSources?: number
  /** Noise volume for turbulence and per-pixel detail (default: the shared 64³ volume). */
  noise?: Data3DTexture
}

/** GPU buffers of a system, for custom passes (see the README on extending for MPM). */
export interface ParticleBuffers {
  /** xyz position (local), w age (s). */
  position: any
  /** xyz velocity (m/s), w life (s; 0 = dead slot). */
  velocity: any
  /** x temperature (K), y size scale, z random 0…1, w tint (from the source). */
  props: any
  /** x sun transmittance (smoke lighting from the grid), y grid heat, z opacity (from the source). */
  light: any
}

const SHAPE_ID = { point: 0, box: 1, disc: 2, sphere: 3, sources: 4 } as const
const SORT_BINS = 1024
const TIME_WRAP = 1000

/**
 * A fixed-capacity pool of GPU particles: emit, update and (optionally) depth-sort run as TSL compute
 * passes; one instanced draw renders them as camera-facing or velocity-stretched billboards with soft
 * depth fade. Nothing is read back to the CPU.
 *
 * Emission is a ring buffer: each update spawns `rate × dt` particles (fractions carry over) from a
 * point, box, disc, sphere or a weighted list of sources the CPU refreshes cheaply. Every particle's
 * random numbers come from its serial number and `seed`, so a run is reproducible. Forces: gravity,
 * temperature-driven buoyancy with cooling, wind with shear and drag, curl-noise turbulence and, with
 * a {@link ParticleGrid}, lift from the grid's heat. Size, colour and opacity follow lifetime curves.
 *
 * @example
 * ```ts
 * const smoke = new ParticleSystem({ capacity: 8000, rate: 300, render: { shading: 'smoke', sort: true } })
 * scene.add(smoke.object)
 * // each frame:
 * smoke.lighting.fromScene(scene)
 * smoke.update(renderer, dt, camera)
 * ```
 */
export class ParticleSystem {
  /** Add this to your scene (one instanced mesh). Particle positions are in its local space. */
  readonly object: Mesh<InstancedBufferGeometry, MeshBasicNodeMaterial>
  /** Resolved settings. */
  options: ParticleOptions
  /** Pool size. */
  readonly capacity: number
  /** Spawn scheduling (serials and ring slots). */
  readonly clock: EmitterClock
  /** Weighted spawn sources (for `emitter.shape: 'sources'`). */
  readonly sources: SourceTable
  /** Sun and sky light. */
  readonly lighting: ParticleLighting
  /** Grid read by the forces and lighting, if any. */
  readonly grid: ParticleGrid | null
  /** Lifetime curves. */
  readonly curves = new CurveUniforms()
  /** GPU buffers. */
  readonly buffers: ParticleBuffers
  /** Seconds simulated (wraps every 1000 s for float precision). */
  time = 0
  /** Shader uniforms. */
  readonly uniforms = {
    /** Animation clock. */ time: uniform(0),
    /** Step, seconds. */ dt: uniform(0),
    /** Seed. */ seed: uniform(0, 'uint'),
    /** First serial of this frame's batch. */ spawnFirst: uniform(0, 'uint'),
    /** Ring slot of this frame's batch. */ spawnSlot: uniform(0, 'uint'),
    /** Particles in this frame's batch. */ spawnCount: uniform(0, 'uint'),
    /** Sources in use. */ sourceCount: uniform(0, 'int'),
    /** Sum of source weights. */ sourceTotal: uniform(0),
    /** Emitter shape id. */ shape: uniform(0, 'int'),
    /** Emitter centre. */ emitPosition: uniform(new Vector3()),
    /** Emitter size. */ emitSize: uniform(new Vector3()),
    /** Initial velocity. */ emitVelocity: uniform(new Vector3()),
    /** Random speed. */ spread: uniform(0),
    /** Life range. */ life: uniform(new Vector3()),
    /** Temperature range. */ temperature: uniform(new Vector3()),
    /** Size random range. */ sizeRandom: uniform(new Vector3()),
    /** Gravity. */ gravity: uniform(0),
    /** Buoyancy. */ buoyancy: uniform(0),
    /** Ambient temperature. */ ambientTemperature: uniform(293),
    /** Cooling rate. */ cooling: uniform(0),
    /** Wind. */ wind: uniform(new Vector3()),
    /** Wind shear per 100 m. */ windShear: uniform(0),
    /** Drag. */ drag: uniform(0),
    /** Turbulence strength. */ turbulence: uniform(0),
    /** Turbulence scale. */ turbulenceScale: uniform(1),
    /** Turbulence speed. */ turbulenceSpeed: uniform(0),
    /** Grid lift. */ gridLift: uniform(0),
    /** Base size. */ size: uniform(1),
    /** Aspect. */ aspect: uniform(1),
    /** Stretch. */ stretch: uniform(0),
    /** Brightness. */ intensity: uniform(1),
    /** Opacity. */ opacity: uniform(1),
    /** Blackbody on/off (0/1). */ blackbody: uniform(0),
    /** Soft fade distance. */ softness: uniform(1),
    /** Detail. */ detail: uniform(1),
    /** Detail distance. */ detailDistance: uniform(600),
    /** Absorption. */ absorption: uniform(2),
    /** HG anisotropy. */ anisotropy: uniform(0.5),
    /** Silver lining. */ silverLining: uniform(0.5),
    /** Clean smoke albedo. */ albedoClean: uniform(new Color()),
    /** Dirty smoke albedo. */ albedoDirty: uniform(new Color()),
    /** Glow colour. */ glow: uniform(new Color()),
    /** Glow strength. */ glowStrength: uniform(1),
    /** Haze refraction. */ refraction: uniform(0.01),
    /** Smoke cap height (0 = off). */ capHeight: uniform(0),
    /** Camera position in this system's local space. */ camera: uniform(new Vector3()),
    /** Radians per pixel (for minimum on-screen width of sparks). */ pixelAngle: uniform(0.001),
    /** Farthest sort distance. */ sortRange: uniform(20000),
  }

  private readonly noise: Data3DTexture
  private readonly emitNode: ComputeNode
  private readonly updateNode: ComputeNode
  private readonly sorter: CountingSort | null
  private readonly sourceNodes: { positions: any; data: any; motion: any; cdf: any }
  private readonly structureKey: string
  private warned = false
  private camera: Camera | null = null

  /**
   * Creates a system. Settings not given use `DEFAULT_PARTICLES`. `capacity`, `render.shading`,
   * `render.blending`, `render.sort`, `render.shadowSteps` and `render.lightSteps` are fixed at
   * construction (make a new system to change them); everything else is live through `set`.
   */
  constructor({ grid = null, lighting, maxSources = 4096, noise, ...input }: ParticleSystemConfig = {}) {
    this.options = resolveParticleOptions(input)
    this.capacity = this.options.capacity
    this.grid = grid
    this.lighting = lighting ?? new ParticleLighting()
    this.noise = noise ?? noiseVolume()
    this.clock = new EmitterClock(this.capacity)
    this.sources = createSourceTable(maxSources)
    const r = this.options.render
    this.structureKey = JSON.stringify([this.capacity, r.shading, r.blending, r.sort, r.shadowSteps, r.lightSteps])

    const n = this.capacity
    this.buffers = { position: instancedArray(n, 'vec4'), velocity: instancedArray(n, 'vec4'), props: instancedArray(n, 'vec4'), light: instancedArray(n, 'vec4') }
    this.sourceNodes = { positions: instancedArray(this.sources.positions, 'vec4'), data: instancedArray(this.sources.data, 'vec4'), motion: instancedArray(this.sources.motion, 'vec4'), cdf: instancedArray(this.sources.cdf, 'float') }
    this.emitNode = this.buildEmit()
    this.updateNode = this.buildUpdate()
    this.sorter = r.sort ? this.buildSort() : null

    const g = new InstancedBufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3))
    g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2))
    g.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1))
    g.instanceCount = n
    g.boundingSphere = new Sphere(new Vector3(), 1e9) // placed in the shader
    this.object = new Mesh(g, this.buildMaterial())
    this.object.frustumCulled = false
    this.object.name = `Particles (${r.shading})`
    this.applyOptions()
  }

  /** Merges `input` into the settings. Structural settings (see the constructor) are ignored with a warning. */
  set(input: ParticleInput): this {
    this.options = resolveParticleOptions(merge(structuredClone(this.options), input), this.options)
    return this.applyOptions()
  }

  /** Replaces all settings (anything not given goes back to defaults); structural ones stay. */
  reset(input: ParticleInput = {}): this {
    this.options = resolveParticleOptions(input)
    return this.applyOptions()
  }

  /**
   * Replaces the weighted spawn sources: `SOURCE_STRIDE` (8) floats each, x, y, z (local), weight,
   * then `data`: size scale, lift (spawn up to this many metres above the source), tint (0 clean …
   * 1 dirty smoke), temperature scale. Optional `motion`, `MOTION_STRIDE` (4) floats per source: a
   * velocity (m/s, added to the emitter's: particles inherit a moving source's speed) and an opacity
   * multiplier. Zero-weight sources are skipped; past `maxSources` the heaviest are kept. Uploads only
   * the used part.
   */
  setSources(sources: ArrayLike<number>, count?: number, motion?: ArrayLike<number> | null): this {
    fillSourceTable(this.sources, sources, count, motion)
    const k = this.sources.count
    for (const [node, size] of [[this.sourceNodes.positions, 4], [this.sourceNodes.data, 4], [this.sourceNodes.motion, 4], [this.sourceNodes.cdf, 1]] as const) {
      const attr = node.value
      attr.clearUpdateRanges()
      attr.addUpdateRange(0, Math.max(1, k * size))
      attr.needsUpdate = true
    }
    this.uniforms.sourceCount.value = k
    this.uniforms.sourceTotal.value = this.sources.total
    return this
  }

  /** Total weight of the sources (0 without sources). */
  get sourceWeight(): number {
    return this.sources.total
  }

  /**
   * Advances the particles by `dt` seconds on the GPU: emits, integrates, and sorts if enabled.
   * `camera` (default: none) is used for sorting and spark sizing. Needs a WebGPU renderer; on the
   * WebGL backend the system hides itself.
   */
  update(renderer: Renderer, dt: number, camera?: Camera | null): this {
    const nodes = this.prepare(renderer, dt, camera)
    if (nodes.length) renderer.compute(nodes)
    this.sort(renderer)
    return this
  }

  /**
   * Advances the clock and uniforms by `dt` and returns this frame's compute passes (emit, update)
   * without running them, so several systems (and grid passes) can go to the GPU in one
   * `renderer.compute([...])`. Call {@link ParticleSystem.sort} after them if sorting.
   */
  prepare(renderer: Renderer, dt: number, camera?: Camera | null): ComputeNode[] {
    const backend = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend
    if (!backend?.isWebGPUBackend) {
      this.object.visible = false
      if (!this.warned) console.warn('threejs-particles: compute needs the WebGPU backend; particles are hidden.')
      this.warned = true
      return []
    }
    const step = Math.min(0.1, Math.max(0, dt))
    const o = this.options, u = this.uniforms
    this.time = (this.time + step) % TIME_WRAP
    u.time.value = this.time
    u.dt.value = step
    this.camera = camera ?? null
    if (camera) {
      camera.updateMatrixWorld()
      this.object.updateWorldMatrix(true, false)
      u.camera.value.setFromMatrixPosition(camera.matrixWorld).sub(_v.setFromMatrixPosition(this.object.matrixWorld))
      const pc = camera as PerspectiveCamera
      if (pc.isPerspectiveCamera) u.pixelAngle.value = (2 * Math.tan(((pc.fov * Math.PI) / 180) / 2)) / Math.max(1, renderer.domElement?.height ?? 720)
      u.sortRange.value = Math.min(20000, (pc as { far?: number }).far ?? 20000)
    }
    const weight = o.emitter.shape === 'sources' ? this.sources.total : 1
    const batch = this.clock.step(spawnRate(o.rate, weight, this.capacity, (o.life[0] + o.life[1]) / 2), step, o.maxPerFrame)
    const nodes: ComputeNode[] = []
    u.spawnCount.value = 0
    if (batch.count > 0 && (o.emitter.shape !== 'sources' || this.sources.count > 0)) {
      u.spawnFirst.value = batch.first
      u.spawnSlot.value = batch.slot
      u.spawnCount.value = batch.count
      nodes.push(this.emitNode) // dispatched for maxPerFrame threads; the spawn count uniform guards the rest
    }
    nodes.push(this.updateNode)
    return nodes
  }

  /** Back-to-front depth sort (when `render.sort` and a camera was given to the last prepare/update). */
  sort(renderer: Renderer): this {
    if (this.sorter && this.camera) this.sorter.compute(renderer)
    return this
  }

  /** Nodes of particle `index` (for grid splats and custom passes). */
  particle(index: any): SplatParticle {
    const P = this.buffers.position.element(index), V = this.buffers.velocity.element(index), Q = this.buffers.props.element(index)
    const alive = select(V.w.greaterThan(0), float(1), float(0))
    const t = clamp(P.w.div(max(V.w, 1e-6)), 0, 1)
    return { position: P.xyz, alive, t, temperature: Q.x, size: this.uniforms.size.mul(Q.y).mul(this.curves.sizeAt(t)), tint: Q.w }
  }

  /** Kills every particle (next update starts empty) and restarts the serials. */
  clear(renderer: Renderer): this {
    this.clock.reset()
    const kill = Fn(() => { this.buffers.velocity.element(instanceIndex).assign(vec4(0)) })().compute(this.capacity)
    renderer.compute(kill)
    kill.dispose()
    return this
  }

  /** Removes the mesh and frees GPU resources. */
  dispose(): void {
    this.object.removeFromParent()
    this.object.geometry.dispose()
    this.object.material.dispose()
    this.emitNode.dispose()
    this.updateNode.dispose()
  }

  private applyOptions(): this {
    const o = this.options, u = this.uniforms, e = o.emitter, f = o.forces, r = o.render
    const key = JSON.stringify([o.capacity, r.shading, r.blending, r.sort, r.shadowSteps, r.lightSteps])
    if (key !== this.structureKey) console.warn('threejs-particles: capacity, shading, blending, sort, shadowSteps and lightSteps are fixed at construction')
    u.seed.value = seedOf(o.seed)
    u.shape.value = SHAPE_ID[e.shape]
    u.emitPosition.value.fromArray(e.position)
    u.emitSize.value.fromArray(e.size)
    u.emitVelocity.value.fromArray(e.velocity)
    u.spread.value = e.spread
    u.life.value.set(o.life[0], o.life[1], 0)
    u.temperature.value.set(e.temperature[0], e.temperature[1], 0)
    u.sizeRandom.value.set(r.sizeRandom[0], r.sizeRandom[1], 0)
    u.gravity.value = f.gravity
    u.buoyancy.value = f.buoyancy
    u.ambientTemperature.value = f.ambientTemperature
    u.cooling.value = f.cooling
    u.wind.value.fromArray(f.wind)
    u.windShear.value = f.windShear
    u.drag.value = f.drag
    u.turbulence.value = f.turbulence
    u.turbulenceScale.value = f.turbulenceScale
    u.turbulenceSpeed.value = f.turbulenceSpeed
    u.gridLift.value = f.gridLift
    u.size.value = r.size
    u.aspect.value = r.aspect
    u.stretch.value = r.stretch
    u.intensity.value = r.intensity
    u.opacity.value = r.opacity
    u.blackbody.value = r.blackbody ? 1 : 0
    u.softness.value = Math.max(1e-3, r.softness)
    u.detail.value = r.detail
    u.detailDistance.value = r.detailDistance
    u.absorption.value = r.absorption
    u.anisotropy.value = r.anisotropy
    u.silverLining.value = r.silverLining
    u.albedoClean.value.set(r.albedo[0])
    u.albedoDirty.value.set(r.albedo[1])
    u.glow.value.set(r.glow)
    u.glowStrength.value = r.glowStrength
    u.refraction.value = r.refraction
    u.capHeight.value = r.capHeight
    this.curves.set(o.curves)
    return this
  }

  // ---- compute ----

  private rand(serial: any, k: number): any {
    return hash(serial.mul(16).add(k).add(this.uniforms.seed))
  }

  private buildEmit(): ComputeNode {
    const u = this.uniforms, b = this.buffers, s = this.sourceNodes, cap = this.capacity
    return Fn(() => {
      If(instanceIndex.lessThan(u.spawnCount), () => {
        // Everything random is computed into vars up front: TSL emits a temporary where it is first used,
        // so a value first used inside one shape's branch would be unset in the others.
        const serial = u.spawnFirst.add(instanceIndex).toVar()
        const slot = u.spawnSlot.add(instanceIndex).mod(uint(cap)).toVar()
        const rs = Array.from({ length: 13 }, (_, k) => this.rand(serial, k).toVar())
        const r = (k: number) => rs[k]
        const signed = (k: number) => r(k).mul(2).sub(1)
        const p = vec3(u.emitPosition).toVar()
        const data = vec4(1, 0, 0, 1).toVar()
        const motion = vec4(0, 0, 0, 1).toVar()
        const box = vec3(signed(1), signed(2), signed(3)).mul(u.emitSize).toVar()
        const dir = randomDirection(r(4), r(5)).toVar()
        If(u.shape.equal(1), () => { p.addAssign(box) })
        If(u.shape.equal(2), () => {
          const a = r(1).mul(Math.PI * 2), rad = sqrt(r(2)).mul(u.emitSize.x)
          p.addAssign(vec3(a.cos().mul(rad), 0, a.sin().mul(rad)))
        })
        If(u.shape.equal(3), () => { p.addAssign(randomDirection(r(1), r(2)).mul(pow(r(3), 1 / 3).mul(u.emitSize.x))) })
        If(u.shape.equal(4), () => {
          // Weighted pick: binary search of the prefix sums.
          const target = r(0).mul(u.sourceTotal)
          const lo = int(0).toVar(), hi = u.sourceCount.sub(1).toVar()
          Loop(13, () => {
            If(lo.lessThan(hi), () => {
              const mid = lo.add(hi).div(2)
              If(s.cdf.element(mid).lessThanEqual(target), () => { lo.assign(mid.add(1)) }).Else(() => { hi.assign(mid) })
            })
          })
          const src = s.positions.element(lo)
          data.assign(s.data.element(lo))
          motion.assign(s.motion.element(lo))
          p.assign(src.xyz.add(box).add(vec3(0, r(6).mul(data.y), 0)))
        })
        const v = u.emitVelocity.add(motion.xyz).add(dir.mul(u.spread.mul(r(7))))
        const life = mix(u.life.x, u.life.y, r(8))
        const temp = mix(u.temperature.x, u.temperature.y, r(9)).mul(data.w)
        const size = mix(u.sizeRandom.x, u.sizeRandom.y, r(10)).mul(data.x)
        // Born at a random moment of the last step (already moved and aged that much), so a batch spawned
        // in one frame spreads along its path instead of clumping into a puff per frame at low frame rates.
        const sub = r(12).mul(u.dt)
        b.position.element(slot).assign(vec4(p.add(v.mul(sub)), sub))
        b.velocity.element(slot).assign(vec4(v, life))
        b.props.element(slot).assign(vec4(temp, size, r(11), data.z))
        b.light.element(slot).assign(vec4(1, 0, motion.w, 0))
      })
    })().compute(this.options.maxPerFrame, [64])
  }

  private buildUpdate(): ComputeNode {
    const u = this.uniforms, b = this.buffers, grid = this.grid, r = this.options.render
    const L = this.lighting.uniforms
    return Fn(() => {
      const i = instanceIndex
      // Read each buffer once into registers: TSL re-evaluates un-var'd reads after the writes below.
      const P = b.position.element(i).toVar(), V = b.velocity.element(i).toVar(), Q = b.props.element(i).toVar()
      If(V.w.greaterThan(0), () => {
        const age = P.w.add(u.dt).toVar()
        If(age.greaterThanEqual(V.w), () => {
          b.velocity.element(i).assign(vec4(0))
        }).Else(() => {
          const p = P.xyz, v = V.xyz
          const Ta = u.ambientTemperature
          const T = Ta.add(Q.x.sub(Ta).mul(exp(u.cooling.mul(u.dt).negate())))
          const lift = float(9.81).mul(u.buoyancy).mul(T.sub(Ta)).div(Ta)
          const heat = grid ? grid.sample(p).x : float(0)
          const gridLift: any = grid ? u.gridLift.mul(heat.div(heat.add(1))) : float(0) // saturating: at most gridLift
          const shear = float(1).add(u.windShear.mul(max(p.y.sub(u.emitPosition.y), 0)).div(100))
          const air = u.wind.mul(shear)
          const tp = p.div(u.turbulenceScale.mul(8)).add(vec3(0.31, 0.67, 0.53).mul(u.time.mul(u.turbulenceSpeed).div(8)))
          const turb = curlNoise(this.noise, tp).mul(u.turbulence)
          const a = vec3(0, lift.add(gridLift).sub(u.gravity), 0).add(air.sub(v).mul(u.drag)).add(turb)
          const nv = v.add(a.mul(u.dt)).toVar()
          const np = p.add(nv.mul(u.dt)).toVar()
          const nT = T.toVar()
          if (grid && r.shading === 'smoke' && r.lightSteps > 0) {
            // Per-particle sun transmittance through the grid's density (channel 1).
            const cell = grid.uniforms.size.div(vec3(...grid.resolution))
            const stepLen = cell.x.add(cell.y).add(cell.z).div(3)
            let sum: any = float(0)
            for (let k = 0; k < r.lightSteps; k++) sum = sum.add(grid.sample(p.add(L.sunDirection.mul(stepLen.mul(k + 0.75)))).y)
            b.light.element(i).assign(vec4(exp(sum.mul(u.absorption).mul(-0.3)), heat, b.light.element(i).z, 0))
          }
          b.position.element(i).assign(vec4(np, age))
          b.velocity.element(i).assign(vec4(nv, V.w))
          b.props.element(i).assign(vec4(nT, Q.y, Q.z, Q.w))
        })
      })
    })().compute(this.capacity, [64])
  }

  private buildSort(): CountingSort {
    const u = this.uniforms, b = this.buffers
    const sorter = new CountingSort(this.capacity, { binCount: SORT_BINS, workgroupSize: 64 })
    sorter.setBinNode(() => {
      const P = b.position.element(instanceIndex), V = b.velocity.element(instanceIndex)
      const far = sqrt(clamp(length(P.xyz.sub(u.camera)).div(u.sortRange), 0, 1))
      return select(V.w.greaterThan(0), uint(far.oneMinus().mul(SORT_BINS - 1)), uint(SORT_BINS - 1))
    })
    return sorter
  }

  // ---- render ----

  private buildMaterial(): MeshBasicNodeMaterial {
    const o = this.options, r = o.render, u = this.uniforms, b = this.buffers, L = this.lighting.uniforms
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: r.blending === 'additive' ? AdditiveBlending : NormalBlending })
    if (r.blending === 'premultiplied') {
      // Emission adds; coverage partly hides what is behind (dense flame cores read as solid).
      Object.assign(m, { blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor, blendSrcAlpha: OneFactor, blendDstAlpha: OneMinusSrcAlphaFactor })
    }
    m.name = `Particles ${r.shading}`
    m.fog = r.shading === 'smoke' || r.shading === 'unlit'

    // Vertex: fetch the particle (sorted order if sorting), build the billboard.
    const index = this.sorter ? storage(this.sorter.orderAttribute, 'uint', this.capacity).toReadOnly().element(instanceIndex) : instanceIndex
    const P = b.position.element(index), V = b.velocity.element(index), Q = b.props.element(index), Lt = b.light.element(index)
    const alive = select(V.w.greaterThan(0), float(1), float(0))
    const t = clamp(P.w.div(max(V.w, 1e-6)), 0, 1)
    const center = P.xyz
    const world = modelWorldMatrix.mul(vec4(center, 1)).xyz
    const toCamRaw = cameraPosition.sub(world)
    const dist = length(toCamRaw)
    const toCam = toCamRaw.div(max(dist, 1e-4))
    let width: any = u.size.mul(Q.y).mul(this.curves.sizeAt(t))
    let fade: any = float(1)
    if (r.shading === 'spark') {
      // Keep sparks at least ~1.5 px wide; dim them instead of letting them alias away.
      const minWidth = dist.mul(u.pixelAngle).mul(1.5)
      fade = clamp(width.div(max(minWidth, 1e-5)), 0, 1)
      width = max(width, minWidth)
    }
    const speed = length(V.xyz)
    const vdir0 = select(speed.greaterThan(1e-3), V.xyz.div(max(speed, 1e-3)), vec3(0, 1, 0))
    // Flames lean with the wind but stay buoyant: bias their axis towards up.
    const vdir = r.shading === 'flame' ? normalize(vdir0.add(vec3(0, 1.2, 0))) : vdir0
    const stretched = u.stretch.greaterThan(0)
    const axis = select(stretched, vdir, normalize(cross(toCam, normalize(cross(vec3(0, 1, 0), toCam)))))
    const side = normalize(cross(axis, toCam))
    const len = width.mul(u.aspect).add(select(stretched, speed.mul(u.stretch), float(0)))
    // Alpha particles closer than about their own size fade out and are collapsed (no fragments): huge
    // screen-filling quads around the camera cost the most fill and add the least.
    const near = r.blending === 'alpha' ? smoothstep(width.mul(0.5), width.mul(1.5), dist) : float(1)
    const keep = alive.mul(select(near.greaterThan(0.001), float(1), float(0)))
    const corner = positionGeometry
    m.positionNode = center.add(side.mul(corner.x.mul(width).mul(keep))).add(axis.mul(corner.y.mul(len).mul(keep)))

    const vary = (n: any): any => varying(n)
    const vT = vary(t), vTemp = vary(Q.x), vSeed = vary(Q.z), vTint = vary(Q.w), vLight = vary(Lt.xy), vOpacity = vary(Lt.z)
    const vSide = vary(side), vAxis = vary(axis), vToCam = vary(toCam), vDist = vary(dist), vFade = vary(fade), vNear = vary(near)
    // Smoke cap: how far into the pyrocumulus top this particle is (0 below capHeight × 0.6, 1 at capHeight).
    const vCap = vary(select(u.capHeight.greaterThan(0), smoothstep(u.capHeight.mul(0.45), u.capHeight, center.y.sub(u.emitPosition.y)), float(0)))

    // Fragment.
    const q = uv()
    const c = q.sub(0.5)
    const curve = this.curves.colorAt(vT)
    const soft = clamp(positionView.z.sub(sceneViewZ()).div(u.softness), 0, 1)
    const detail = clamp(float(1).sub(vDist.div(u.detailDistance)), 0, 1).mul(u.detail)
    const tint = curve.xyz.mul(mix(vec3(1), blackbodyNode(vTemp).mul(pow(vTemp.div(1400), 4)), u.blackbody))
    const N = this.noise
    let color: any, alpha: any

    if (r.shading === 'flame') {
      const tp = u.time
      const n1 = sampleNoise(N, vec3(q.x.mul(0.35).add(vSeed.mul(7)), q.y.mul(0.45).sub(tp.mul(0.9)), vSeed.mul(3).add(vT.mul(0.3)))).w
      const n2 = sampleNoise(N, vec3(q.x.mul(0.9).add(vSeed.mul(5)), q.y.mul(1.1).sub(tp.mul(2.1)), vSeed.mul(11))).w
      const x = c.x.add(n1.sub(0.5).mul(0.55).mul(q.y.add(0.15)))
      const w = float(0.5).mul(pow(max(float(1).sub(q.y), 0), 0.65)).add(0.02)
      const d = abs(x).div(w)
      const body = smoothstep(1, 0.55, d.add(n2.sub(0.5).mul(mix(0.2, 0.7, detail))))
      const density = body.mul(smoothstep(0, 0.1, q.y)).mul(smoothstep(1, 0.7, q.y.add(n1.sub(0.5).mul(0.5))))
      const T = vTemp.mul(float(0.7).add(pow(d.oneMinus().clamp(0, 1), 2).mul(0.5))).mul(float(1).sub(q.y.mul(0.3))).mul(n2.mul(0.25).add(0.88))
      const bb = blackbodyNode(T).mul(pow(T.div(1400), 4))
      color = mix(curve.xyz, bb.mul(curve.xyz), u.blackbody).mul(u.intensity)
      alpha = density.mul(curve.w).mul(u.opacity).mul(soft)
      if (r.blending === 'premultiplied') {
        // Premultiplied: emission × coverage adds; coverage (denser at the hot core) hides the background.
        color = color.mul(alpha)
        alpha = alpha.mul(smoothstep(0.2, 0.9, density).mul(0.7).add(0.15))
      }
    } else if (r.shading === 'spark') {
      const across = abs(c.x).mul(2)
      const core = pow(clamp(float(1).sub(across), 0, 1), 2).mul(smoothstep(0, 0.25, q.y)).mul(smoothstep(1, 0.55, q.y))
      color = tint.mul(u.intensity)
      alpha = core.mul(curve.w).mul(u.opacity).mul(vFade).mul(soft)
    } else if (r.shading === 'haze') {
      const n = sampleNoise(N, vec3(q.mul(0.6).add(vSeed.mul(9)) as any, u.time.mul(0.35))).xy.sub(0.5)
      const mask = smoothstep(0.5, 0.1, length(c)).mul(curve.w).mul(soft).mul(detail) // fades out with distance
      const offset = n.mul(u.refraction).mul(mask)
      color = viewportSharedTexture(screenUV.add(offset)).rgb
      alpha = mask.mul(u.opacity)
    } else if (r.shading === 'smoke') {
      // Built inside a Fn so shared values are materialised in vars before the distance-gated branch.
      const out = Fn(() => {
        const det = detail.toVar()
        const fade = soft.toVar()
        // Rotated noise coordinates per puff, evolving over life; eroded edges merge puffs into one volume.
        const ang = vSeed.mul(Math.PI * 2).add(vT.mul(0.6))
        const ca: any = ang.cos().toVar(), sa: any = ang.sin().toVar()
        const rc: any = (vec2 as any)(c.x.mul(ca).sub(c.y.mul(sa)), c.x.mul(sa).add(c.y.mul(ca))).toVar()
        const density = (o2: any) => {
          // Warped, billowing, evolving noise dominates the shape; the radial falloff only keeps it inside the quad.
          const p = vec3(o2.mul(0.55).add(vSeed.mul(13)), vSeed.mul(7).add(vT.mul(0.3)).add(u.time.mul(0.01)))
          const warp = sampleNoise(N, p.mul(0.5).add(3.1)).xyz.sub(0.5).mul(0.35)
          const n1 = sampleNoise(N, p.add(warp)).w
          const n2 = sampleNoise(N, p.mul(2.7).add(warp.mul(2))).w
          const n = mix(float(0.55), n1.mul(0.65).add(n2.mul(0.35)), det)
          const r2 = dot(o2, o2).mul(4)
          // Soft gaussian-like falloff, so overlapping puffs blend with no visible rims.
          const falloff = exp(r2.mul(-3))
          const soft2 = falloff.mul(1.35).sub(0.3).add(n.sub(0.55).mul(1.4)).sub(vT.mul(0.25))
          // In the cap the billows are denser and sharply edged.
          return clamp(soft2.mul(mix(float(1), float(2.4), vCap)).add(vCap.mul(0.15)), 0, 1)
        }
        const dens = density(rc).toVar()
        const Ldir = L.sunDirection
        // Self-shadow: a few density taps towards the sun across the billboard; skipped (branch) when far away.
        const shadow = float(0).toVar()
        if (r.shadowSteps > 0) {
          const sx: any = dot(Ldir, vSide), sy: any = dot(Ldir, vAxis)
          const sdir = (vec2 as any)(sx.mul(ca).add(sy.mul(sa)), sy.mul(ca).sub(sx.mul(sa))).mul(0.16).toVar()
          If(det.greaterThan(0.05), () => {
            let sum: any = float(0)
            for (let k = 1; k <= r.shadowSteps; k++) sum = sum.add(density(rc.add(sdir.mul(k))))
            shadow.assign(sum.mul(det))
          })
        }
        const Tself = exp(shadow.mul(u.absorption).mul(-0.6).mul(float(1).sub(vCap.mul(0.4))))
        const r2 = clamp(dot(c, c).mul(4), 0, 1)
        const Nrm = normalize(vSide.mul(c.x).add(vAxis.mul(c.y)).add(vToCam.mul(sqrt(float(1).sub(r2)).add(0.6))))
        const g = u.anisotropy
        const cosT = dot(Ldir.negate(), vToCam)
        const hg = float(1).sub(g.mul(g)).div(pow(float(1).add(g.mul(g)).sub(g.mul(2).mul(cosT)), 1.5))
        const phase = mix(float(1), hg, 0.5).add(hg.mul(u.silverLining).mul(float(1).sub(dens)).mul(0.5))
        const wrap = clamp(dot(Nrm, Ldir).add(0.25).div(1.25), 0, 1)
        // Multiple scattering keeps even deep smoke from going black: never less than ~30% of single-scatter light.
        const Tsun = mix(float(0.3), float(1), Tself.mul(mix(vLight.x, float(1), vCap.mul(0.6))))
        const sun = L.sunColor.mul(Tsun).mul(wrap.mul(0.85).add(0.15)).mul(phase)
        const sky = L.ambient.mul(Nrm.y.mul(0.35).add(0.65)).mul(Tself.mul(0.5).add(0.5))
        const albedo = mix(mix(u.albedoClean, u.albedoDirty, vTint), vec3(0.95, 0.94, 0.92), vCap).mul(curve.xyz)
        // Lit from below only while freshly hot (just above the flames), cooling to grey higher up.
        const hot = pow(clamp(vTemp.sub(u.ambientTemperature).sub(130).div(360), 0, 1), 2)
        const under = clamp(Nrm.y.negate().mul(0.5).add(0.6), 0, 1)
        const glow = u.glow.mul(u.glowStrength).mul(hot).mul(under)
        return (vec4 as any)(albedo.mul(sun.add(sky).add(glow)), dens.mul(curve.w).mul(u.opacity).mul(vOpacity).mul(mix(float(1), float(1.6), vCap)).mul(fade))
      })()
      color = out.xyz
      alpha = out.w
    } else {
      const disc = smoothstep(0.5, 0.2, length(c))
      color = tint.mul(u.intensity)
      alpha = disc.mul(curve.w).mul(u.opacity).mul(vOpacity).mul(soft)
    }
    m.colorNode = color
    m.opacityNode = r.blending === 'alpha' ? alpha.mul(vNear) : alpha
    return m
  }
}

/** Unit vector from two uniform random numbers. */
function randomDirection(a: any, b: any): any {
  const z = a.mul(2).sub(1)
  const phi = b.mul(Math.PI * 2)
  const s: any = sqrt(max(float(1).sub(z.mul(z)), 0))
  return vec3(s.mul(phi.cos()), z, s.mul(phi.sin()))
}

/** View-space z of the opaque scene behind the current fragment (plain and logarithmic depth). */
const sceneViewZ = () => Fn((builder: any) => {
  const d = viewportDepthTexture().x
  return builder.renderer.logarithmicDepthBuffer ? logarithmicDepthToViewZ(d, cameraNear, cameraFar) : perspectiveDepthToViewZ(d, cameraNear, cameraFar)
})()

const _v = new Vector3()
const _c = new Color()
