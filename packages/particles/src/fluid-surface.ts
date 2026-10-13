import {
  AddEquation, BufferAttribute, Color, CustomBlending, FloatType, HalfFloatType, InstancedBufferGeometry, LinearFilter, Mesh, MeshBasicNodeMaterial, NearestFilter,
  OneFactor, PlaneGeometry, QuadMesh, RedFormat, RenderTarget, Scene, Sphere, Vector2, Vector3, type Camera, type PerspectiveCamera, type Renderer, type Texture,
} from 'three/webgpu'
import {
  Discard, Fn, If, Loop, abs, cameraFar, cameraNear, cameraPosition, cameraWorldMatrix, clamp, cross, dot, exp, floor, ivec3, modelWorldMatrix, mx_noise_float, float, fwidth, instanceIndex, length, max, min, mix,
  normalize, perspectiveDepthToViewZ, pmremTexture, positionGeometry, positionView, pow, reflect, screenUV, select, smoothstep, sqrt, texture, uniform, varying, vec2, vec3, vec4,
  viewZToPerspectiveDepth, viewportDepthTexture, viewportSharedTexture,
} from 'three/tsl'
import { ParticleLighting } from './system.ts'
import { merge, type DeepPartial } from './options.ts'

/** Settings of a {@link FluidSurface}. Plain JSON; all live through `set`. */
export interface FluidSurfaceOptions {
  /** Particle sphere radius, in particle spacings (Δx/2). About 1 makes neighbours overlap into one surface. */
  radius: number
  /** Radius multiplier of tagged particles (`buffers.state.z` ≠ 0, e.g. rain splashes): small drops, not blobs. */
  tagRadius: number
  /** Resolution of the offscreen passes relative to the drawing buffer (0.25…1). */
  resolution: number
  /** Depth smoothing radius, in particle radii (world space; the bilateral filter keeps silhouettes). */
  smoothing: number
  /** Smoothing passes (each a horizontal and a vertical blur), 0…4. */
  iterations: number
  /** Beer–Lambert absorption of the water, per metre (linear RGB): pure water loses red first. */
  absorption: [number, number, number]
  /** In-scattering by suspended matter, per metre: 0 is glass-clear, tens is opaque mud within centimetres. */
  turbidity: number
  /** Colour of the in-scattered light (silt, algae), `#rrggbb`. */
  scatterColor: string
  /** Colour of whitewater (aerated, fast or broken water), `#rrggbb`. */
  foamColor: string
  /** Speeds (m/s) over which water turns to whitewater: none below the first, all above the second. */
  foamSpeed: [number, number]
  /** Most whitewater coverage, 0…1. */
  foam: number
  /** How opaque aerated water gets per metre of thickness (whitewater is translucent where thin). */
  foamDensity: number
  /** Contrast of the flow-aligned streaks in falling whitewater, 0…1. */
  streaks: number
  /**
   * Spray: water where the solver's grid is nearly empty (a node mass of a full cell of 1000 kg/m³ = 1) is drawn as soft
   * mist, not as surface; all mist below the first value, all surface above the second (needs a source with a grid).
   */
  spray: [number, number]
  /** Opacity of one spray particle's mist. */
  mist: number
  /** Width of a spray particle's mist, in particle spacings. */
  mistSize: number
  /** Exposure time of the mist's motion blur, seconds (streak length = speed × shutter). */
  shutter: number
  /** Index of refraction (sets the Fresnel reflectance; 1.333 for water). */
  ior: number
  /** How far the background shifts through the surface, per metre of water thickness (screen fraction). */
  refraction: number
  /** Microfacet roughness of the sun highlight (0.02 glassy … 0.3 rippled). */
  roughness: number
  /** Water thickness (m) over which the rim of the water fades in (anti-aliased edges; a thin film is still a reflecting surface). */
  edge: number
  /** Reflected sky when no `envMap`: zenith, horizon and ground colours, `#rrggbb` (scaled by the lighting's ambient). */
  sky: [string, string, string]
}

/** Partial {@link FluidSurfaceOptions}. */
export type FluidSurfaceInput = DeepPartial<FluidSurfaceOptions>

/** Default surface: clear water. */
export const DEFAULT_FLUID_SURFACE: FluidSurfaceOptions = {
  radius: 1.4,
  tagRadius: 0.15,
  resolution: 1,
  smoothing: 3,
  iterations: 2,
  absorption: [0.45, 0.07, 0.03],
  turbidity: 0.4,
  scatterColor: '#9fc4c8',
  foamColor: '#f4f7f8',
  foamSpeed: [2, 3.4],
  foam: 0.85,
  foamDensity: 45,
  streaks: 0.85,
  spray: [0.05, 0.14],
  mist: 0.05,
  mistSize: 4,
  shutter: 1 / 30,
  ior: 1.333,
  refraction: 0.06,
  roughness: 0.1,
  edge: 0.0005,
  sky: ['#6f93c0', '#c5d3df', '#4a4a40'],
}

/** What a {@link FluidSurface} draws: an `MPMSolver` (or anything with its pool buffers). */
export interface FluidSource {
  /**
   * Pool buffers: position xyz (local to `object`), velocity xyz and w > 0 when alive; optionally a state with a tag in z,
   * and the solver's grid (w: node mass) with its `resolution`, which tells spray from bulk water.
   */
  buffers: { position: any; velocity: any; state?: any; grid?: any }
  /** Grid nodes along x, y, z (with `buffers.grid`). */
  resolution?: readonly number[]
  /** Pool size. */
  capacity: number
  /** The object the positions are local to. */
  object: { matrixWorld: { elements: ArrayLike<number> } }
  /** `cellSize` sets the particle spacing (Δx/2). */
  options: { cellSize: number }
}

/** Construction options: settings plus object inputs. */
export interface FluidSurfaceConfig extends FluidSurfaceInput {
  /** Sun and sky light (default: a new one; call `fluid.lighting.fromScene(scene)`). */
  lighting?: ParticleLighting
  /** Environment for reflections, e.g. `scene.environment` (PMREM, equirectangular or cube; default: the `sky` gradient). */
  envMap?: Texture | null
}

/**
 * Screen-space fluid rendering of particles (van der Laan et al. 2009): the particles are drawn as sphere
 * impostors into a linear depth buffer and as additive thickness splats, the depth is smoothed by a separable
 * bilateral filter, and a full-screen pass in your scene rebuilds normals from it and shades a water surface:
 * Fresnel reflection of the sky, a GGX sun highlight, refraction of what is behind (the scene's own colour
 * buffer), Beer–Lambert absorption and turbid in-scattering by thickness, and whitewater where the water is fast.
 * Thin sheets and lone drops fade out by thickness, so edges are soft. Needs the WebGPU backend.
 *
 * @example
 * ```ts
 * const fluid = new FluidSurface(mpm, WATER_PRESETS.clear.surface)
 * scene.add(fluid.object)
 * mpm.object.visible = false
 * // each frame, before rendering the scene:
 * fluid.lighting.fromScene(scene)
 * fluid.render(renderer, camera)
 * ```
 */
export class FluidSurface {
  /** Resolved settings. */
  options: FluidSurfaceOptions
  /** Add this to your scene: the full-screen composite (drawn after the opaque scene, it reads its colour and depth). */
  readonly object: Mesh
  /** Sun and sky light. */
  readonly lighting: ParticleLighting
  /** Shader uniforms. */
  readonly uniforms = {
    /** Sphere radius, metres. */ radius: uniform(0.1),
    /** Radius multiplier of tagged particles. */ tagRadius: uniform(1),
    /** Thickness scale: particle volume over sphere volume (overlapping spheres would overcount). */ volume: uniform(1),
    /** Camera right, world. */ right: uniform(new Vector3(1, 0, 0)),
    /** Camera up, world. */ up: uniform(new Vector3(0, 1, 0)),
    /** Projection [0][0] and [1][1]. */ projection: uniform(new Vector2(1, 1)),
    /** One texel of the offscreen passes. */ texel: uniform(new Vector2(1, 1)),
    /** Blur direction (texels). */ direction: uniform(new Vector2(1, 0)),
    /** Smoothing radius, metres. */ smoothing: uniform(0.1),
    /** Absorption per metre. */ absorption: uniform(new Vector3()),
    /** Turbidity per metre. */ turbidity: uniform(0),
    /** Scatter colour (linear). */ scatterColor: uniform(new Color()),
    /** Foam colour (linear). */ foamColor: uniform(new Color()),
    /** Foam speeds. */ foamSpeed: uniform(new Vector2(2, 4)),
    /** Foam amount. */ foam: uniform(1),
    /** Fresnel F0. */ f0: uniform(0.02),
    /** Refraction. */ refraction: uniform(0.05),
    /** Roughness. */ roughness: uniform(0.06),
    /** Edge thickness. */ edge: uniform(0.004),
    /** Foam opacity per metre. */ foamDensity: uniform(45),
    /** Streak contrast. */ streaks: uniform(0.65),
    /** Spray node-mass thresholds. */ spray: uniform(new Vector2(0.07, 0.2)),
    /** Mist opacity. */ mist: uniform(0.1),
    /** Mist width, metres. */ mistSize: uniform(0.06),
    /** Shutter, seconds. */ shutter: uniform(1 / 60),
    /** 1/Δx of the source. */ invDx: uniform(1),
    /** Seconds (streak animation). */ time: uniform(0),
    /** Sky zenith (linear). */ zenith: uniform(new Color()),
    /** Sky horizon (linear). */ horizon: uniform(new Color()),
    /** Ground (linear). */ ground: uniform(new Color()),
  }

  private readonly source: FluidSource
  private readonly depthMesh: Mesh
  private readonly thickMesh: Mesh
  private readonly mistMesh: Mesh
  private readonly depthScene = new Scene()
  private readonly thickScene = new Scene()
  private readonly mistScene = new Scene()
  private readonly depthRT: RenderTarget
  private readonly tempRT: RenderTarget
  private readonly smoothRT: RenderTarget
  private readonly thickRT: RenderTarget
  private readonly mistRT: RenderTarget
  private readonly blurInput: any
  private readonly blur: QuadMesh
  private env: Texture | null
  private readonly size = new Vector2()
  private readonly clear = new Color()

  /** A surface for `source`'s particles. */
  constructor(source: FluidSource, { lighting, envMap = null, ...input }: FluidSurfaceConfig = {}) {
    this.source = source
    this.options = resolveFluidSurfaceOptions(input)
    this.lighting = lighting ?? new ParticleLighting()
    const target = (type: typeof FloatType | typeof HalfFloatType, format?: typeof RedFormat, depth = false) => {
      const rt = new RenderTarget(1, 1, { type, format, depthBuffer: depth, magFilter: type === FloatType ? NearestFilter : LinearFilter, minFilter: type === FloatType ? NearestFilter : LinearFilter, generateMipmaps: false })
      return rt
    }
    this.depthRT = target(FloatType, RedFormat, true)
    this.tempRT = target(FloatType, RedFormat)
    this.smoothRT = target(FloatType, RedFormat)
    this.thickRT = target(HalfFloatType)
    this.mistRT = target(HalfFloatType)

    const g = new InstancedBufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3))
    g.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1))
    g.instanceCount = source.capacity
    g.boundingSphere = new Sphere(new Vector3(), 1e9)
    this.depthMesh = this.particleMesh(g, false)
    this.thickMesh = this.particleMesh(g, true)
    this.mistMesh = this.mistParticles(g)
    this.depthScene.add(this.depthMesh)
    this.thickScene.add(this.thickMesh)
    this.mistScene.add(this.mistMesh)

    this.blurInput = texture(this.depthRT.texture)
    this.blur = new QuadMesh(this.blurMaterial())
    this.env = envMap
    this.object = new Mesh(new PlaneGeometry(2, 2), this.compositeMaterial())
    this.object.frustumCulled = false
    this.object.renderOrder = 1000
    this.object.name = 'Fluid surface'
    this.applyOptions()
  }

  /** Merges `input` into the settings. */
  set(input: FluidSurfaceInput): this {
    this.options = resolveFluidSurfaceOptions(merge(structuredClone(this.options), input))
    return this.applyOptions()
  }

  /** Replaces the reflected environment (`null`: the `sky` gradient). Rebuilds the composite material. */
  setEnvironment(envMap: Texture | null): this {
    if (envMap === this.env) return this
    this.env = envMap
    ;(this.object.material as MeshBasicNodeMaterial).dispose()
    this.object.material = this.compositeMaterial()
    return this
  }

  /** Draws the offscreen passes for `camera` (call each frame before rendering the scene that holds `object`). */
  render(renderer: Renderer, camera: Camera): this {
    const o = this.options, u = this.uniforms
    renderer.getDrawingBufferSize(this.size)
    const w = Math.max(1, Math.round(this.size.x * o.resolution)), h = Math.max(1, Math.round(this.size.y * o.resolution))
    for (const rt of [this.depthRT, this.tempRT, this.smoothRT, this.thickRT, this.mistRT]) if (rt.width !== w || rt.height !== h) rt.setSize(w, h)
    u.texel.value.set(1 / w, 1 / h)
    const p = (camera as PerspectiveCamera).projectionMatrix.elements
    u.projection.value.set(p[0], p[5])
    camera.updateMatrixWorld()
    const m = camera.matrixWorld.elements
    u.right.value.set(m[0], m[1], m[2]).normalize()
    u.up.value.set(m[4], m[5], m[6]).normalize()
    u.time.value = (performance.now() / 1000) % 1000
    for (const mesh of [this.depthMesh, this.thickMesh, this.mistMesh]) {
      mesh.matrix.fromArray(this.source.object.matrixWorld.elements)
      mesh.matrixWorld.copy(mesh.matrix)
    }

    const prevTarget = renderer.getRenderTarget(), prevAlpha = renderer.getClearAlpha(), prevAuto = renderer.autoClear
    renderer.getClearColor(this.clear)
    renderer.autoClear = false
    renderer.setClearColor(0x000000, 0)
    renderer.setRenderTarget(this.depthRT)
    renderer.clear()
    renderer.render(this.depthScene, camera)
    renderer.setRenderTarget(this.thickRT)
    renderer.clear()
    renderer.render(this.thickScene, camera)
    renderer.setRenderTarget(this.mistRT)
    renderer.clear()
    renderer.render(this.mistScene, camera)
    let src = this.depthRT
    for (let i = 0; i < o.iterations; i++) {
      for (const [dir, dst] of [[[1, 0], this.tempRT], [[0, 1], this.smoothRT]] as const) {
        this.blurInput.value = src.texture
        u.direction.value.set(dir[0], dir[1])
        renderer.setRenderTarget(dst)
        this.blur.render(renderer)
        src = dst
      }
    }
    if (o.iterations === 0) {
      this.blurInput.value = this.depthRT.texture
      u.direction.value.set(0, 0)
      renderer.setRenderTarget(this.smoothRT)
      this.blur.render(renderer)
    }
    renderer.setRenderTarget(prevTarget)
    renderer.setClearColor(this.clear, prevAlpha)
    renderer.autoClear = prevAuto
    return this
  }

  /** Frees the GPU resources. */
  dispose(): void {
    for (const rt of [this.depthRT, this.tempRT, this.smoothRT, this.thickRT, this.mistRT]) rt.dispose()
    for (const mesh of [this.depthMesh, this.thickMesh, this.mistMesh, this.object]) (mesh.material as MeshBasicNodeMaterial).dispose()
    this.depthMesh.geometry.dispose()
    this.object.geometry.dispose()
    ;(this.blur.material as MeshBasicNodeMaterial).dispose()
    this.object.removeFromParent()
  }

  private applyOptions(): this {
    const o = this.options, u = this.uniforms
    const spacing = this.source.options.cellSize / 2
    u.radius.value = o.radius * spacing
    u.tagRadius.value = o.tagRadius
    u.volume.value = spacing ** 3 / ((4 / 3) * Math.PI * (o.radius * spacing) ** 3)
    u.smoothing.value = o.smoothing * o.radius * spacing
    u.absorption.value.fromArray(o.absorption)
    u.turbidity.value = o.turbidity
    u.scatterColor.value.set(o.scatterColor)
    u.foamColor.value.set(o.foamColor)
    u.foamSpeed.value.fromArray(o.foamSpeed)
    u.foam.value = o.foam
    u.foamDensity.value = o.foamDensity
    u.streaks.value = o.streaks
    u.spray.value.fromArray(o.spray)
    u.mist.value = o.mist
    u.mistSize.value = o.mistSize * spacing
    u.shutter.value = o.shutter
    u.invDx.value = 1 / this.source.options.cellSize
    u.f0.value = ((o.ior - 1) / (o.ior + 1)) ** 2
    u.refraction.value = o.refraction
    u.roughness.value = o.roughness
    u.edge.value = o.edge
    u.zenith.value.set(o.sky[0])
    u.horizon.value.set(o.sky[1])
    u.ground.value.set(o.sky[2])
    return this
  }

  // How much of particle `i` (local position P) is spray: tagged drops never; else by the grid mass at its nearest node.
  private sprayOf(P: any): any {
    const b = this.source.buffers, res = this.source.resolution, u = this.uniforms
    if (!b.grid || !res) return float(0)
    const [nx, ny, nz] = res
    // Trilinear between the 8 surrounding nodes (the nearest node alone would size particles in cell-sized blocks).
    const x: any = clamp(P.mul(u.invDx), vec3(0), vec3(nx - 1.001, ny - 1.001, nz - 1.001)).toVar()
    const i0: any = (ivec3 as any)(floor(x)).toVar()
    const f: any = x.sub(floor(x)).toVar()
    const at = (di: number, dj: number, dk: number) => b.grid.element(i0.z.add(dk).mul(nx * ny).add(i0.y.add(dj).mul(nx)).add(i0.x.add(di))).w
    const lerp = (a: any, c: any, t: any) => a.add(c.sub(a).mul(t))
    const mass = lerp(
      lerp(lerp(at(0, 0, 0), at(1, 0, 0), f.x), lerp(at(0, 1, 0), at(1, 1, 0), f.x), f.y),
      lerp(lerp(at(0, 0, 1), at(1, 0, 1), f.x), lerp(at(0, 1, 1), at(1, 1, 1), f.x), f.y), f.z)
    const tagged = b.state ? b.state.element(instanceIndex).z.notEqual(0) : null
    const s = smoothstep(u.spray.y, u.spray.x, mass)
    return tagged ? select(tagged, float(0), s) : s
  }

  // Camera-facing quads around each live particle: sphere impostor depth (front surface), or an additive chord-length
  // thickness splat (water volume per pixel, metres) with its whitewater share in G, tagged-drop share in B and falling
  // share in A. Spray shrinks out of both (it is drawn as mist).
  private particleMesh(g: InstancedBufferGeometry, thickness: boolean): Mesh {
    const u = this.uniforms, b = this.source.buffers
    const m = new MeshBasicNodeMaterial({ depthTest: !thickness, depthWrite: !thickness })
    m.fog = false
    m.toneMapped = false
    if (thickness) Object.assign(m, { transparent: true, blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneFactor, blendSrcAlpha: OneFactor, blendDstAlpha: OneFactor })
    const P = b.position.element(instanceIndex), V = b.velocity.element(instanceIndex)
    const keep = select(V.w.greaterThan(0), float(1), float(0))
    const scale = b.state ? select(b.state.element(instanceIndex).z.notEqual(0), u.tagRadius, float(1)) : float(1)
    // Sparse water: fast, it is spray (drawn as mist, so it shrinks out of the surface); slow, it is a film on the ground
    // (wider, flatter discs that merge into one sheet instead of beading).
    const sparse = this.sprayOf(P.xyz), fast = smoothstep(2.5, 4, length(V.xyz))
    const film: any = varying(sparse.mul(fast.oneMinus()))
    const radius: any = varying(u.radius.mul(scale).mul(float(1).sub(sparse.mul(fast))).mul(film.mul(0.4).add(1)))
    const corner = positionGeometry.xy
    m.positionNode = P.xyz.add(u.right.mul(corner.x).add(u.up.mul(corner.y)).mul(radius.mul(keep)))
    const q = varying(corner)
    const speed = length(V.xyz)
    const fallingNow = smoothstep(0.4, 0.85, V.y.negate().div(max(speed, 1e-4))).mul(smoothstep(1.8, 2.8, speed))
    // Fast water is aerated, and so is water falling free (a fall entrains air from its lip on).
    const foamy = varying(max(smoothstep(u.foamSpeed.x, u.foamSpeed.y, speed), fallingNow.mul(0.85)))
    const falling = varying(fallingNow)
    const r2 = dot(q, q)
    const nz: any = sqrt(max(float(1).sub(r2), 0)).mul(float(1).sub(film.mul(0.6)))
    if (thickness) {
      // Chord through the sphere, scaled so the splat holds the particle's own water volume.
      const chord = nz.mul(radius.mul(2)).mul(u.volume).div(scale.mul(scale).mul(scale))
      m.colorNode = vec4(chord, chord.mul(foamy), chord.mul(select(scale.notEqual(1), float(1), float(0))), chord.mul(falling))
    } else {
      m.colorNode = Fn(() => {
        If(r2.greaterThan(1), () => { Discard() })
        return vec4(positionView.z.add(nz.mul(radius)).negate(), 0, 0, 1)
      })()
      m.depthNode = viewZToPerspectiveDepth(positionView.z.add(nz.mul(radius)), cameraNear, cameraFar)
    }
    const mesh = new Mesh(g, m)
    mesh.frustumCulled = false
    mesh.matrixAutoUpdate = false
    return mesh
  }

  // Spray as mist: soft Gaussian splats stretched along the velocity by the shutter (motion blur), accumulated additively
  // (R: opacity, G: opacity × view depth for the occlusion test; B: film, slow sparse water). Bulk water collapses to nothing.
  private mistParticles(g: InstancedBufferGeometry): Mesh {
    const u = this.uniforms, b = this.source.buffers
    const m = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, transparent: true })
    Object.assign(m, { blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneFactor, blendSrcAlpha: OneFactor, blendDstAlpha: OneFactor })
    m.fog = false
    m.toneMapped = false
    const P = b.position.element(instanceIndex), V = b.velocity.element(instanceIndex)
    const speed = length(V.xyz)
    const sparse = this.sprayOf(P.xyz).mul(select(V.w.greaterThan(0), float(1), float(0)))
    const fast = smoothstep(2.5, 4, speed)
    const amount = sparse.mul(fast), film = sparse.mul(fast.oneMinus())
    const keep = select(sparse.greaterThan(0.01), float(1), float(0))
    const toCam = normalize(cameraPosition.sub(modelWorldMatrix.mul(vec4(P.xyz, 1)).xyz))
    const axis = select(speed.greaterThan(0.05), V.xyz.div(max(speed, 0.05)), u.up)
    const side = normalize(cross(axis, toCam))
    const corner = positionGeometry.xy
    const half = u.mistSize.add(speed.mul(u.shutter))
    m.positionNode = P.xyz.add(side.mul(corner.x.mul(u.mistSize)).add(axis.mul(corner.y.mul(half))).mul(keep))
    const q = varying(corner), a = varying(amount), fl = varying(film)
    const profile: any = exp(dot(q, q).mul(-4))
    const alpha = profile.mul(a).mul(u.mist)
    // B: where slow sparse water lies as a film (the composite draws it as a faint wet sheen, not as a surface of beads).
    m.colorNode = vec4(alpha, alpha.mul(positionView.z.negate()), profile.mul(fl), 1)
    const mesh = new Mesh(g, m)
    mesh.frustumCulled = false
    mesh.matrixAutoUpdate = false
    return mesh
  }

  // Separable bilateral blur of the linear depth: Gaussian in screen space with a radius of `smoothing` metres at that
  // depth, weighted down across depth jumps (so drops in front of a pool keep their silhouettes). Empty pixels stay empty.
  private blurMaterial(): MeshBasicNodeMaterial {
    const u = this.uniforms
    const m = new MeshBasicNodeMaterial()
    m.toneMapped = false
    m.colorNode = Fn(() => {
      const c = screenUV
      const d0 = this.blurInput.sample(c).x.toVar()
      const out = d0.toVar()
      If(d0.greaterThan(0), () => {
        // Filter radius in texels: smoothing (m) projected at depth d0, capped.
        const px = min(u.smoothing.mul(u.projection.x).div(d0).mul(0.5).div(u.texel.x), 18)
        const sigma = max(px.mul(0.5), 0.5)
        const range = u.radius.mul(4)
        const sum = float(0).toVar(), wsum = float(0).toVar()
        // Filter the residual from the local depth slope, not the depth itself: a slanted surface (a pool seen at a grazing
        // angle) keeps its plane instead of being cut into terraces by the range weights. The slope is taken over half the
        // kernel, wide enough not to see single particles (a noisy slope would streak across the blur direction).
        const step = u.direction.mul(u.texel)
        const b = clamp(px.mul(0.5).floor(), 2, 9)
        const dp = this.blurInput.sample(c.add(step.mul(b))).x, dm = this.blurInput.sample(c.sub(step.mul(b))).x
        const slope = select(dp.greaterThan(0).and(dm.greaterThan(0)), dp.sub(dm).div(b.mul(2)), select(dp.greaterThan(0), dp.sub(d0).div(b), select(dm.greaterThan(0), d0.sub(dm).div(b), float(0)))).toVar()
        // A neighbour far off the plane (a drop in front of the pool) is another surface: excluded.
        If(abs(slope.mul(b)).greaterThan(range.mul(2)), () => { slope.assign(0) })
        // Every texel out to the cap (skipping texels, or fractional offsets on this nearest-sampled float buffer, aliases
        // into stripes across the blur direction).
        Loop({ start: -18, end: 19, type: 'int', condition: '<' }, ({ i }: { i: any }) => {
          const t = float(i)
          const d = this.blurInput.sample(c.add(step.mul(t))).x
          const r = d.sub(slope.mul(t))
          const dz = r.sub(d0).div(range)
          const w = exp(t.mul(t).div(sigma.mul(sigma).mul(-2))).mul(exp(dz.mul(dz).negate())).mul(select(d.greaterThan(0), float(1), float(0)))
          sum.addAssign(r.mul(w))
          wsum.addAssign(w)
        })
        out.assign(sum.div(max(wsum, 1e-6)))
      })
      return vec4(out, 0, 0, 1)
    })()
    return m
  }

  // The water surface over the scene: normals from the smoothed depth, Fresnel sky reflection and sun highlight,
  // refracted scene colour through absorbing, scattering water, whitewater by speed, soft thin edges.
  private compositeMaterial(): MeshBasicNodeMaterial {
    const u: any = this.uniforms, L: any = this.lighting.uniforms
    const m = new MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false })
    m.fog = false
    m.vertexNode = vec4(positionGeometry.xy, 0, 1)
    const depthTex = texture(this.smoothRT.texture), thickTex = texture(this.thickRT.texture), rawTex = texture(this.depthRT.texture)
    const view = (c: any, d: any): any => (vec3 as any)(c.x.mul(2).sub(1).mul(d).div(u.projection.x), float(1).sub(c.y.mul(2)).mul(d).div(u.projection.y), d.negate())
    const sky = (dir: any): any => {
      if (this.env) return pmremTexture(this.env, dir, u.roughness).rgb
      const grad: any = select(dir.y.greaterThan(0), mix(u.horizon, u.zenith, pow(clamp(dir.y, 0, 1), 0.5)), mix(u.horizon, u.ground, clamp(dir.y.negate().mul(4), 0, 1)))
      return grad.mul(dot(L.ambient, vec3(1 / 3)).mul(1.5))
    }
    const mixv = mix as any
    const mistTex = texture(this.mistRT.texture)
    const color = Fn(() => {
      const c = screenUV
      const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture().x, cameraNear, cameraFar).negate().toVar()
      const light: any = L.ambient.add(L.sunColor.mul(clamp(L.sunDirection.y, 0, 1).mul(0.5))).toVar()
      // Mist (spray): opacity from the accumulated splats, faded where the scene is in front of it.
      const M = mistTex.sample(c).toVar()
      const mistDepth = M.y.div(max(M.x, 1e-6))
      const mistAlpha = float(1).sub(exp(M.x.negate())).mul(smoothstep(0, 0.15, sceneZ.sub(mistDepth))).toVar()
      const mistColor = u.foamColor.mul(light).mul(0.9)
      const surface = vec3(0).toVar(), coverage = float(0).toVar()
      const d = depthTex.sample(c).x.toVar()
      If(d.greaterThan(0), () => {
        // Small tagged drops keep their own round (unsmoothed) depth: smoothing would flatten them into coins.
        const T = thickTex.sample(c).toVar()
        const drop = clamp(T.z.div(max(T.x, 1e-6)), 0, 1).toVar()
        const depthAt = (cc: any): any => mix(depthTex.sample(cc).x, rawTex.sample(cc).x, drop)
        d.assign(depthAt(c))
        const P: any = view(c, d).toVar()
        // Normal: of the two one-sided differences per axis, the smaller (no smearing across silhouettes).
        const tx = u.texel.x, ty = u.texel.y
        const side = (dc: any): any => {
          const dd = depthAt(c.add(dc))
          return select(dd.greaterThan(0), view(c.add(dc), dd), P.add(P.sub(view(c.sub(dc), depthAt(c.sub(dc))))))
        }
        const xr = side(vec2(tx, 0)).sub(P), xl = P.sub(side(vec2(tx, 0).negate()))
        const yu = side(vec2(0, ty)).sub(P), yd = P.sub(side(vec2(0, ty).negate()))
        const ddx: any = select(abs(xr.z).lessThan(abs(xl.z)), xr, xl)
        const ddy: any = select(abs(yu.z).lessThan(abs(yd.z)), yu, yd)
        const nv: any = normalize(cross(ddy, ddx)).toVar()
        If(dot(nv, P).greaterThan(0), () => { nv.assign(nv.negate()) })
        const Vv: any = normalize(P.negate())
        const N = normalize(cameraWorldMatrix.mul(vec4(nv, 0)).xyz).toVar()
        const Vw = normalize(cameraWorldMatrix.mul(vec4(Vv, 0)).xyz).toVar()
        const NdV = clamp(dot(N, Vw), 0, 1)
        const F = u.f0.add(float(1).sub(u.f0).mul(pow(float(1).sub(NdV), 5)))
        const R = reflect(Vw.negate(), N)
        // GGX sun highlight (capped: a sharp highlight on per-pixel normals would otherwise sparkle).
        const Ls = L.sunDirection
        const H = normalize(Ls.add(Vw))
        const a2 = u.roughness.mul(u.roughness).mul(u.roughness).mul(u.roughness)
        const NdH = clamp(dot(N, H), 0, 1), NdL = clamp(dot(N, Ls), 0, 1)
        const D = a2.div(NdH.mul(NdH).mul(a2.sub(1)).add(1).pow(2).mul(Math.PI))
        const spec = L.sunColor.mul(min(D.mul(F).mul(NdL).div(max(NdV.mul(4), 0.1)), 4))
        const reflection = sky(R).mul(F).add(spec)
        // Through the water: the scene behind, shifted by the normal, absorbed and scattered by the thickness. The ground
        // seen through it is soaked, so darker (less light escapes its grains).
        const thick = T.x
        const behind = viewportSharedTexture(c.add(nv.xy.mul(u.refraction).mul(min(thick, 0.5)))).rgb
        const absorbed: any = exp(u.absorption.mul(thick).negate())
        const scatter = float(1).sub(exp(u.turbidity.mul(thick).negate()))
        const soaked = mix(float(1), float(0.6), smoothstep(0, 0.01, thick))
        const body = mixv(behind.mul(absorbed).mul(soaked), u.scatterColor.mul(light).mul(0.6), scatter)
        // Whitewater: aerated where fast, translucent where thin, and in falling water streaked along the fall (bands of
        // aerated and glassy water a few cm across, moving down with it; faded out by fwidth before they could alias).
        const Pw = cameraWorldMatrix.mul(vec4(P, 1)).xyz
        const across = dot(Pw, u.right).mul(60)
        const fall = clamp(T.w.div(max(thick, 1e-5)), 0, 1)
        const n = mx_noise_float(vec3(across, Pw.y.mul(2.5).add(u.time.mul(8)), 0.5))
        const streak = mix(float(1), smoothstep(-0.3, 0.35, n).mul(0.85).add(0.15), fall.mul(u.streaks).mul(smoothstep(1, 0.35, fwidth(across))))
        const whitewater = clamp(T.y.div(max(thick, 1e-5)), 0, 1).mul(u.foam).mul(streak).mul(float(1).sub(exp(thick.mul(u.foamDensity).negate())))
        const foamLit = u.foamColor.mul(L.ambient.add(L.sunColor.mul(NdL.mul(0.6).add(0.25))))
        surface.assign(mixv(body.mul(float(1).sub(F)).add(reflection), foamLit, whitewater))
        // Soft edges (thickness with a one-pixel fwidth ramp), and a soft fade behind the opaque scene: tested with the raw
        // sphere depth (smoothing sinks a film into the ground it lies on), with a particle radius of slack for spheres
        // poking into the ground they rest on.
        const fw = fwidth(thick)
        const hidden = rawTex.sample(c).x.sub(sceneZ)
        const film = clamp(M.z.mul(0.7), 0, 1)
        coverage.assign(smoothstep(u.edge.mul(0.15).sub(fw), u.edge.add(fw), thick).mul(smoothstep(u.radius.mul(2), u.radius, hidden)).mul(mix(float(1), float(0.3), film)))
      })
      const alpha = coverage.mul(float(1).sub(mistAlpha)).add(mistAlpha)
      If(alpha.lessThan(0.002), () => { Discard() })
      return vec4(surface.mul(coverage).mul(float(1).sub(mistAlpha)).add(mistColor.mul(mistAlpha)).div(alpha), alpha)
    })()
    m.colorNode = color
    m.opacityNode = color.w
    return m
  }
}

/** `structuredClone(DEFAULT_FLUID_SURFACE)` merged with `input`, sanitized. */
export function resolveFluidSurfaceOptions(input: unknown): FluidSurfaceOptions {
  const o = merge(structuredClone(DEFAULT_FLUID_SURFACE), input)
  const d = DEFAULT_FLUID_SURFACE
  const num = (v: unknown, def: number, lo = -Infinity, hi = Infinity) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def)
  const hex = (v: unknown, def: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : def)
  o.radius = num(o.radius, d.radius, 0.1, 4)
  o.tagRadius = num(o.tagRadius, d.tagRadius, 0.05, 4)
  o.resolution = num(o.resolution, d.resolution, 0.25, 1)
  o.smoothing = num(o.smoothing, d.smoothing, 0, 16)
  o.iterations = Math.round(num(o.iterations, d.iterations, 0, 4))
  o.absorption = [0, 1, 2].map((a) => num(o.absorption?.[a], d.absorption[a], 0)) as [number, number, number]
  o.turbidity = num(o.turbidity, d.turbidity, 0)
  o.scatterColor = hex(o.scatterColor, d.scatterColor)
  o.foamColor = hex(o.foamColor, d.foamColor)
  o.foamSpeed = [0, 1].map((a) => num(o.foamSpeed?.[a], d.foamSpeed[a], 0)) as [number, number]
  o.foam = num(o.foam, d.foam, 0, 1)
  o.foamDensity = num(o.foamDensity, d.foamDensity, 0)
  o.streaks = num(o.streaks, d.streaks, 0, 1)
  o.spray = [0, 1].map((a) => num(o.spray?.[a], d.spray[a], 0)) as [number, number]
  o.mist = num(o.mist, d.mist, 0, 1)
  o.mistSize = num(o.mistSize, d.mistSize, 0.1, 16)
  o.shutter = num(o.shutter, d.shutter, 0, 1)
  o.ior = num(o.ior, d.ior, 1, 3)
  o.refraction = num(o.refraction, d.refraction, 0)
  o.roughness = num(o.roughness, d.roughness, 0.01, 1)
  o.edge = num(o.edge, d.edge, 1e-5)
  o.sky = [0, 1, 2].map((a) => hex(o.sky?.[a], d.sky[a])) as [string, string, string]
  return o
}
