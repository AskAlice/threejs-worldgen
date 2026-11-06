import {
  DepthTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  MeshBasicNodeMaterial,
  RenderTarget,
  Vector2,
  type Camera,
  type Scene,
  type WebGPURenderer
} from 'three/webgpu'
import {
  Fn,
  cameraFar,
  cameraNear,
  logarithmicDepthToViewZ,
  normalize,
  normalView,
  perspectiveDepthToViewZ,
  screenUV,
  texture,
  vec4,
  viewZToPerspectiveDepth,
  viewZToReversedPerspectiveDepth,
  viewportSharedTexture
} from 'three/tsl'

/** Options for {@link WaterPrepass}. */
export interface WaterPrepassOptions {
  /** Camera the pass renders the scene with. Assign `prepass.camera` to follow another view. */
  camera: Camera
  /**
   * Resolution of the pass relative to the drawing buffer, 0.1 … 1 (default `0.5`).
   * At `0.5` the pass renders a quarter of the pixels; depth and normals are sampled at half
   * resolution. The colour copy the water reads is the renderer's own full-resolution framebuffer copy.
   */
  resolutionScale?: number
}

/**
 * An opt-in scene prepass for water: renders the opaque scene once per frame into a small target so
 * the water material can read what is behind it — view-space normals, scene depth (as view-space z)
 * and the renderer's readable copy of the colour buffer — in the same frame.
 *
 * The pass draws the scene with an unlit normal material at {@link resolutionScale} (default 0.5,
 * documented downsample), skipping transparent objects (the water itself). It is a prefactor: the
 * water material exposes the pass (`material.userData.prepass`, and `Ocean.prepass` /
 * `Rivers.prepass` / `Lakes.prepass`) so the shading built on it can read scene depth, view-space
 * normals and colour; the built-in shading keeps the renderer's own full-resolution depth and colour
 * readback, so attaching a pass never changes the look.
 *
 * ```ts
 * const prepass = new WaterPrepass({ camera })
 * const ocean = await Ocean.create({ camera, scene, renderer, prepass })
 * // each frame, before the scene render:
 * prepass.update(renderer, scene)
 * renderer.render(scene, camera)
 * ```
 *
 * Without a prepass nothing extra is rendered and the water uses the renderer's own depth and colour
 * readback (`viewportDepthTexture` / `viewportSharedTexture`), exactly as before.
 */
export class WaterPrepass {
  /** Camera the pass renders with. */
  camera: Camera
  /** Fraction of the drawing buffer the pass renders at (0.1 … 1). */
  readonly resolutionScale: number
  /** Size of the pass in pixels, as last rendered by {@link update}. */
  readonly size = new Vector2(1, 1)
  /** The pass target: view-space normals in RGB, scene depth in the depth attachment. */
  readonly target: RenderTarget

  private readonly material: MeshBasicNodeMaterial
  private readonly buffer = new Vector2()

  constructor({ camera, resolutionScale = 0.5 }: WaterPrepassOptions) {
    this.camera = camera
    this.resolutionScale = Math.min(1, Math.max(0.1, resolutionScale))
    this.target = new RenderTarget(1, 1, {
      type: HalfFloatType,
      magFilter: LinearFilter,
      minFilter: LinearFilter,
      generateMipmaps: false,
      // 32-bit float depth works with and without `reversedDepthBuffer` (three's PassNode does the same).
      depthTexture: new DepthTexture(1, 1, FloatType)
    })
    this.target.texture.name = 'Water prepass (view normals)'
    this.target.depthTexture!.name = 'Water prepass (depth)'

    // Unlit: the fragment output is the view-space normal itself, so no lighting, fog or tone mapping.
    this.material = new MeshBasicNodeMaterial()
    this.material.name = 'Water prepass (normal material)'
    this.material.colorNode = vec4(normalView, 1)
    this.material.fog = false
    this.material.toneMapped = false
  }

  /**
   * Scene depth at `uv` as view-space z, metres (negative in front of the camera). Sampled from the
   * pass's depth attachment, nearest, at {@link resolutionScale}. Pixels with no geometry read the far
   * plane, which the water's absorption treats as deep water.
   */
  viewZ(uv: any = screenUV) {
    return Fn((builder: any) => {
      const d = texture(this.target.depthTexture!, uv).x
      return builder.renderer.logarithmicDepthBuffer
        ? logarithmicDepthToViewZ(d, cameraNear, cameraFar)
        : perspectiveDepthToViewZ(d, cameraNear, cameraFar)
    })()
  }

  /**
   * Unit view-space normal of the opaque scene behind `uv`. Bilinear, at {@link resolutionScale}.
   * Pixels with no geometry hold the background colour, so reject them with {@link viewZ} first.
   */
  normal(uv: any = screenUV) {
    return normalize(texture(this.target.texture, uv).xyz)
  }

  /**
   * Scene depth at `uv` in `[0, 1]`, in the form the inverse projection matrix expects: perspective
   * depth, or reversed perspective depth when `reversedDepthBuffer` is on. Log depth is converted
   * (it cannot be inverted by the projection matrix). Pair with `getViewPosition`.
   */
  depth(uv: any = screenUV) {
    return Fn((builder: any) => {
      const d = texture(this.target.depthTexture!, uv).x
      if (!builder.renderer.logarithmicDepthBuffer) return d
      const z = logarithmicDepthToViewZ(d, cameraNear, cameraFar)
      return builder.renderer.reversedDepthBuffer
        ? viewZToReversedPerspectiveDepth(z, cameraNear, cameraFar)
        : viewZToPerspectiveDepth(z, cameraNear, cameraFar)
    })()
  }

  /**
   * Colour of the opaque scene behind `uv`: the renderer's readable framebuffer copy, full resolution.
   * Identical to the copy the water reads without a prepass, so it costs nothing extra.
   */
  colour(uv: any = screenUV) {
    return viewportSharedTexture(uv).rgb
  }

  /**
   * Renders the pass: the scene's opaque geometry into {@link target}. Call once per frame before the
   * scene render. Water and other transparent objects are skipped, and the pass does not run the
   * scene's `onBeforeRender` hooks (so it never advances the water's frame state).
   */
  update(renderer: WebGPURenderer, scene: Scene): void {
    renderer.getDrawingBufferSize(this.buffer)
    const w = Math.max(1, Math.floor(this.buffer.x * this.resolutionScale))
    const h = Math.max(1, Math.floor(this.buffer.y * this.resolutionScale))
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h)
    this.size.set(w, h)

    const target = renderer.getRenderTarget()
    const opaque = renderer.opaque
    const transparent = renderer.transparent
    const override = scene.overrideMaterial
    const before = scene.onBeforeRender

    scene.overrideMaterial = this.material
    scene.onBeforeRender = () => {}
    renderer.opaque = true
    renderer.transparent = false
    renderer.setRenderTarget(this.target)
    renderer.render(scene, this.camera)
    renderer.setRenderTarget(target)
    renderer.transparent = transparent
    renderer.opaque = opaque
    scene.overrideMaterial = override
    scene.onBeforeRender = before
  }

  /** Frees the pass's GPU resources. */
  dispose(): void {
    this.target.dispose()
    this.material.dispose()
  }
}
