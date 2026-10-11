import {
  Box3, Color, LinearFilter, Mesh, MeshStandardNodeMaterial, NodeMaterial, OrthographicCamera, PlaneGeometry, RenderTarget, Scene, Sphere,
  SRGBColorSpace, Vector3, type BufferGeometry, type Material, type Object3D, type Renderer, type Texture,
} from 'three/webgpu'
import {
  abs, attribute, cameraPosition, cameraViewMatrix, clamp, cos, cross, diffuseColor, dot, float, max, normalize, normalWorld, positionGeometry,
  round, select, sin, step, texture, uv, varying, vec2, vec3, vec4,
} from 'three/tsl'
import { frameDirection } from './octahedral.ts'

/** How an impostor is baked and drawn. */
export interface ImpostorOptions {
  /**
   * `'octahedral'`: `frames × frames` views over the (hemi)sphere; the quad shows whichever view is closest to the
   * camera direction, so the object turns correctly as you walk around it.
   * `'billboard'`: one side view on a quad that turns around the vertical axis. Cheaper to bake, 4× less memory per
   * view, fine for symmetric objects far away.
   */
  mode: 'octahedral' | 'billboard'
  /** Views per atlas side (octahedral mode). 8 = 64 views. */
  frames: number
  /** Atlas width and height in pixels. Each view gets `size / frames` pixels. */
  size: number
  /** Only bake views from above the horizon (better resolution for things seen from the ground). */
  hemisphere: boolean
  /** Alpha below which impostor pixels are discarded. */
  alphaTest: number
}

/** Result of {@link bakeImpostor}: an atlas plus a material and quad ready to be a `ScatterLayer.impostor`. */
export interface Impostor {
  /** Colour atlas (alpha = coverage). */
  texture: Texture
  /** Normal atlas (object-space normals packed to 0..1), used to light the impostor like the mesh. */
  normalTexture: Texture
  /** Camera-facing, lit, alpha-tested material. Reads the `scatterPosition` / `scatterParams` instance attributes. Disposing it also frees both atlases. */
  material: MeshStandardNodeMaterial
  /** A unit quad (x, y in -1..1); the material places and turns it. */
  geometry: BufferGeometry
  /** Object-space bounding sphere the views were framed on. */
  bounds: Sphere
  /** Options used for the bake. */
  options: ImpostorOptions
  /** Frees the atlases, material and quad. */
  dispose(): void
}

/** Defaults of {@link ImpostorOptions}. */
export const DEFAULT_IMPOSTOR: ImpostorOptions = { mode: 'octahedral', frames: 8, size: 1024, hemisphere: true, alphaTest: 0.5 }

/**
 * Renders `object` from many directions into a texture atlas and returns a material + quad that draw it as a
 * camera-facing impostor, the far level of detail of a scatter layer.
 *
 * Each view is unlit: one pass captures each material's base colour (after its alpha test), a second its normals,
 * so the impostor is lit live by the scene's lights. Materials keep their vertex displacement (`positionNode`), so
 * wind is frozen at bake time; set wind to 0 while baking if that matters.
 *
 * The object is baked in its own local space (its position, rotation and scale are ignored).
 *
 * @param renderer An initialised `WebGPURenderer` (`three/webgpu`).
 */
export async function bakeImpostor(renderer: Renderer, object: Object3D, options: Partial<ImpostorOptions> = {}): Promise<Impostor> {
  const o: ImpostorOptions = { ...DEFAULT_IMPOSTOR, ...options }
  const billboard = o.mode === 'billboard'
  const frames = billboard ? 1 : Math.max(2, Math.round(o.frames))

  const root = object.clone()
  root.position.set(0, 0, 0)
  root.quaternion.identity()
  root.scale.set(1, 1, 1)
  root.updateMatrixWorld(true)
  const bounds = new Box3().setFromObject(root).getBoundingSphere(new Sphere())
  const R = Math.max(bounds.radius, 1e-3)

  const meshes: { mesh: Mesh; material: Material | Material[] }[] = []
  root.traverse((child) => {
    const mesh = child as Mesh
    if (mesh.isMesh) meshes.push({ mesh, material: mesh.material })
  })
  const scene = new Scene()
  scene.add(root)
  const camera = new OrthographicCamera(-R, R, R, -R, R * 0.5, R * 3.5)

  const makeTarget = (srgb: boolean) => {
    const rt = new RenderTarget(o.size, o.size, { depthBuffer: true, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter })
    if (srgb) rt.texture.colorSpace = SRGBColorSpace
    return rt
  }
  const albedoTarget = makeTarget(true)
  const normalTarget = makeTarget(false)

  const previous = {
    target: renderer.getRenderTarget(),
    autoClear: renderer.autoClear,
    clearColor: renderer.getClearColor(new Color()),
    clearAlpha: renderer.getClearAlpha(),
  }
  // One bake material per source material and pass, shared by every mesh that uses it.
  const baked = new Map<string, Material>()
  const convertFor = (pass: 'albedo' | 'normal') => (m: Material) => {
    const key = `${pass}:${m.uuid}`
    let b = baked.get(key)
    if (!b) baked.set(key, (b = bakeMaterial(m, pass)))
    return b
  }
  const passes: [RenderTarget, (m: Material) => Material][] = [
    [albedoTarget, convertFor('albedo')],
    [normalTarget, convertFor('normal')],
  ]
  try {
    for (const [target, convert] of passes) {
      for (const { mesh, material } of meshes) {
        mesh.material = Array.isArray(material) ? material.map(convert) : convert(material)
      }
      await renderer.compileAsync(scene, camera)
      renderer.setRenderTarget(target)
      renderer.setClearColor(0x000000, 0)
      renderer.clear()
      renderer.autoClear = false
      for (let j = 0; j < frames; j++) {
        for (let i = 0; i < frames; i++) {
          const d = billboard ? new Vector3(0, 0, 1) : new Vector3(...frameDirection(i, j, frames, o.hemisphere))
          // Shift the frustum so this view lands in atlas cell (i, j): cells never overlap, so one target,
          // one clear and the default viewport are enough (no backend-specific viewport origin to worry about).
          camera.left = -R - 2 * R * i
          camera.right = camera.left + 2 * R * frames
          camera.bottom = -R - 2 * R * j
          camera.top = camera.bottom + 2 * R * frames
          camera.updateProjectionMatrix()
          camera.up.set(0, 1, 0)
          if (Math.abs(d.y) > 0.999) camera.up.set(0, 0, -1)
          camera.position.copy(bounds.center).addScaledVector(d, 2 * R)
          camera.lookAt(bounds.center)
          camera.updateMatrixWorld()
          renderer.render(scene, camera)
        }
      }
      renderer.autoClear = previous.autoClear
    }
  } finally {
    for (const { mesh, material } of meshes) mesh.material = material
    // Free the bake's render objects (pipelines, per-object binding buffers): the renderer keeps them alive until their
    // material is disposed. They are only used by this bake and every draw has been submitted, so this is safe.
    for (const m of baked.values()) m.dispose()
    renderer.setRenderTarget(previous.target)
    renderer.autoClear = previous.autoClear
    renderer.setClearColor(previous.clearColor, previous.clearAlpha)
  }

  const geometry = new PlaneGeometry(2, 2)
  // Explicit bounds: the material moves and scales the quad per instance.
  geometry.boundingSphere = new Sphere(new Vector3(), Math.SQRT2)
  const material = createImpostorMaterial(albedoTarget.texture, normalTarget.texture, { ...o, frames }, bounds)
  // The atlases are only reachable through shader nodes, so the material owns them: disposing it frees them too
  // (this is what `disposeLayers` relies on).
  const disposeMaterial = material.dispose.bind(material)
  material.dispose = () => {
    disposeMaterial()
    albedoTarget.dispose()
    normalTarget.dispose()
  }
  return {
    texture: albedoTarget.texture,
    normalTexture: normalTarget.texture,
    material,
    geometry,
    bounds,
    options: { ...o, frames },
    dispose() {
      material.dispose()
      geometry.dispose()
    },
  }
}

/** A copy of `source` that outputs its base colour (or its world normal) unlit, keeping its alpha test and displacement. */
function bakeMaterial(source: Material, pass: 'albedo' | 'normal'): Material {
  if (!(source as NodeMaterial).isNodeMaterial) {
    // Classic materials: approximate with a node material carrying the common colour/alpha properties.
    const s = source as any
    const m = new MeshStandardNodeMaterial()
    for (const k of ['color', 'map', 'alphaMap', 'alphaTest', 'vertexColors', 'side', 'opacity']) if (s[k] !== undefined) (m as any)[k] = s[k]
    return bakeMaterial(m, pass)
  }
  const m = (source as NodeMaterial).clone()
  m.transparent = false
  m.depthWrite = true
  if (m.alphaTest <= 0 && (source as NodeMaterial).transparent) m.alphaTest = 0.5
  m.outputNode = pass === 'albedo' ? vec4(diffuseColor.rgb, 1) : vec4(normalize(normalWorld).mul(0.5).add(0.5), 1)
  return m
}

/** TSL: ±1 per component, with +1 for zero (unlike `sign`). */
const signNotZero = (v: any) => step(0, v).mul(2).sub(1)

/** TSL mirror of `octEncode`. */
function octEncodeNode(d: any, hemisphere: boolean): any {
  if (hemisphere) {
    const y = max(d.y, 0)
    const p = vec2(d.x, d.z).div(abs(d.x).add(y).add(abs(d.z)).max(1e-5))
    return vec2(p.x.add(p.y), p.x.sub(p.y)).add(1).mul(0.5)
  }
  const p = vec2(d.x, d.z).div(abs(d.x).add(abs(d.y)).add(abs(d.z)).max(1e-5))
  const folded = float(1).sub(abs(vec2(p.y, p.x))).mul(signNotZero(p))
  return select(d.y.lessThan(0), folded, p).add(1).mul(0.5)
}

/** TSL mirror of `octDecode`. */
function octDecodeNode(uvIn: any, hemisphere: boolean): any {
  if (hemisphere) {
    const a = uvIn.mul(2).sub(1)
    const p = vec2(a.x.add(a.y), a.x.sub(a.y)).mul(0.5)
    return normalize(vec3(p.x, float(1).sub(abs(p.x)).sub(abs(p.y)), p.y))
  }
  const p = uvIn.mul(2).sub(1)
  const y = float(1).sub(abs(p.x)).sub(abs(p.y))
  const folded = float(1).sub(abs(vec2(p.y, p.x))).mul(signNotZero(p))
  const q = select(y.lessThan(0), folded, p)
  return normalize(vec3(q.x, y, q.y))
}

/** Right / up axes of a camera looking along `-d` with three.js' `lookAt` convention (and the bake's up rule). */
function basisNode(d: any) {
  const up = select(abs(d.y).greaterThan(0.999), vec3(0, 0, -1), vec3(0, 1, 0))
  const right = normalize(cross(up, d))
  return { right, up: cross(d, right) }
}

/**
 * The impostor material. Per instance it reads `scatterPosition` (xyz = world base position, w = uniform scale) and
 * `scatterParams` (x = yaw in radians, y = brightness tint), which `Scatter` fills for impostor LODs.
 */
function createImpostorMaterial(albedo: Texture, normals: Texture, o: ImpostorOptions, bounds: Sphere): MeshStandardNodeMaterial {
  const billboard = o.mode === 'billboard'
  const N = o.frames
  const aPos = attribute('scatterPosition', 'vec4')
  const aPar = attribute('scatterParams', 'vec4')
  const c = cos(aPar.x)
  const s = sin(aPar.x)
  // Rotation about +Y by `yaw` (three.js convention) and its inverse.
  const rot = (v: any) => vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s)))
  const unrot = (v: any) => vec3(v.x.mul(c).sub(v.z.mul(s)), v.y, v.z.mul(c).add(v.x.mul(s)))

  const center = aPos.xyz.add(rot(vec3(bounds.center.x, bounds.center.y, bounds.center.z).mul(aPos.w)))
  const toCamRaw = cameraPosition.sub(center)
  const toCam = billboard ? normalize(vec3(toCamRaw.x, 0, toCamRaw.z).add(vec3(0, 0, 1e-5))) : normalize(toCamRaw)
  const view = basisNode(toCam)

  let cell: any = vec2(0)
  let frameDir: any = vec3(0, 0, 1)
  if (!billboard) {
    const n = float(N - 1)
    cell = clamp(round(octEncodeNode(unrot(toCam), o.hemisphere).mul(n)), 0, n)
    frameDir = octDecodeNode(cell.div(n), o.hemisphere)
  }
  // A baked normal is in object space. Express it in the baked view's camera basis, then rebuild it from the quad's
  // own (world) basis, so the impostor is lit as it is shown.
  const frame = basisNode(frameDir)
  const v = (node: any, name: string): any => varying(node, name)
  const vCell = v(cell, 'vImpostorCell')
  const vRight = v(view.right, 'vImpostorRight')
  const vUp = v(view.up, 'vImpostorUp')
  const vDir = v(toCam, 'vImpostorDir')
  const vFrameRight = v(frame.right, 'vImpostorFrameRight')
  const vFrameUp = v(frame.up, 'vImpostorFrameUp')
  const vFrameDir = v(frameDir, 'vImpostorFrameDir')
  const vTint = v(aPar.y, 'vImpostorTint')

  const material = new MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 })
  material.alphaTest = o.alphaTest
  material.positionNode = center.add(view.right.mul(positionGeometry.x).add(view.up.mul(positionGeometry.y)).mul(bounds.radius).mul(aPos.w))

  const inset = 0.5 / Math.max(1, o.size / N)
  const atlasUv = vCell.add(clamp(uv() as any, inset, 1 - inset)).div(N)
  const sample = texture(albedo, atlasUv)
  material.colorNode = vec4(sample.rgb.mul(vTint), sample.a)
  const n: any = texture(normals, atlasUv).xyz.mul(2).sub(1)
  const shown: any = vRight.mul(dot(n, vFrameRight)).add(vUp.mul(dot(n, vFrameUp))).add(vDir.mul(dot(n, vFrameDir)))
  material.normalNode = cameraViewMatrix.mul(vec4(shown.normalize(), 0)).xyz.normalize()
  return material
}
