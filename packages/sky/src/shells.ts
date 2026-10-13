/**
 * Labelled altitude shells around the home planet: the troposphere, the ionosphere, the Kármán line and
 * the moon's apogee by default. Every shell is one instance of a single sphere (one draw), drawn as a
 * glowing rim that the planet hides, and every label is one instance of a single camera-facing quad
 * (one more draw) reading from a canvas atlas. Labels keep a constant screen size and sit on each
 * shell's limb from outside, or near the horizon from inside.
 */
import {
  AdditiveBlending, CanvasTexture, Group, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, NodeMaterial, PlaneGeometry,
  SRGBColorSpace, Sphere, SphereGeometry, Vector3, type BufferGeometry, type Camera,
} from 'three/webgpu'
import {
  abs, attribute, cameraPosition, cameraProjectionMatrix, cameraViewMatrix, dot, float, length, max, normalize, positionLocal, pow,
  select, sqrt, texture, uniform, uv, varying, vec2, vec4,
} from 'three/tsl'
import type { StarSystem } from './bodies.ts'
import type { AtmosphereLayers } from './layers.ts'
import { DEG, hexToLinear, type Vec3 } from './util.ts'

/**
 * Where a shell sits: metres above the surface (Earth metres, scaled with the atmosphere like cloud
 * altitudes), a layer top from {@link AtmosphereLayers}, or the moon's `'perigee'` / `'apogee'`.
 */
export type ShellAltitude = number | keyof AtmosphereLayers | 'perigee' | 'apogee'

/** One shell. Plain JSON. */
export interface AltitudeShell {
  /** Label text. */
  label: string
  /** Altitude; see {@link ShellAltitude}. */
  altitude: ShellAltitude
  /** Rim and label colour (`#rrggbb`). */
  color: string
}

/** Shell overlay settings. Plain JSON. */
export interface ShellsOptions {
  /** Draw the shells (a debug / teaching overlay; off by default). */
  enabled: boolean
  /** The shells, inner to outer. */
  shells: AltitudeShell[]
  /** Rim brightness. */
  opacity: number
  /** Show labels. */
  labels: boolean
  /** Label height as a fraction of its distance to the camera (constant screen size). */
  labelSize: number
}

/** Default shells: troposphere, ionosphere (F2 peak, ~300 km), Kármán line, the moon's apogee. */
export const DEFAULT_SHELLS: ShellsOptions = {
  enabled: false,
  shells: [
    { label: 'Troposphere', altitude: 'troposphere', color: '#7fd1ff' },
    { label: 'Kármán line', altitude: 'karman', color: '#ffffff' },
    { label: 'Ionosphere', altitude: 300_000, color: '#c08cff' },
    { label: 'Apogee', altitude: 'apogee', color: '#ffb35e' },
  ],
  opacity: 0.3,
  labels: true,
  labelSize: 0.035,
}

/** Partial {@link ShellsOptions}. */
export type ShellsInput = Partial<ShellsOptions>

/** A shell with its altitude resolved to metres above the surface. */
export interface ResolvedShell {
  /** Label text. */
  label: string
  /** Metres above the planet's surface. */
  altitude: number
  /** Linear RGB. */
  color: Vec3
}

/**
 * Resolves shell altitudes to metres: layer names from `layers` (already scaled to the planet),
 * numbers scaled by `scale` (R / Earth's radius with `scaleWithRadius`), perigee/apogee from the moon's
 * orbit. Shells that can't be resolved (no moon) are left out. Pure.
 */
export function resolveShells(shells: AltitudeShell[], layers: AtmosphereLayers, system: StarSystem, scale = 1): ResolvedShell[] {
  const out: ResolvedShell[] = []
  for (const s of shells) {
    let altitude: number
    if (typeof s.altitude === 'number') altitude = s.altitude * scale
    else if (s.altitude === 'perigee' || s.altitude === 'apogee') {
      const moon = system.moon
      const a = moon && system.apsides(moon.index)
      if (!a) continue
      altitude = (s.altitude === 'apogee' ? a.apoapsis : a.periapsis) - system.home.radius
    } else altitude = layers[s.altitude]
    out.push({ label: s.label, altitude, color: hexToLinear(s.color) })
  }
  return out
}

/** "100 km", "405 000 km", "850 m". */
export function formatAltitude(m: number): string {
  if (Math.abs(m) < 1000) return `${Math.round(m)} m`
  const km = m / 1000
  return `${km < 100 ? km.toFixed(km < 10 ? 1 : 0) : Math.round(km).toLocaleString('en').replace(/,/g, ' ')} km`
}

const ROW = 64, ATLAS_W = 512, ASPECT = ATLAS_W / ROW

/** Builds the label atlas (one row per label), or null without a canvas (Node). */
function labelAtlas(shells: ResolvedShell[]): CanvasTexture | null {
  const canvas: HTMLCanvasElement | OffscreenCanvas | null =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(ATLAS_W, ROW * shells.length)
      : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: ATLAS_W, height: ROW * shells.length })
        : null
  const ctx = canvas?.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined
  if (!canvas || !ctx) return null
  ctx.textBaseline = 'middle'
  shells.forEach((s, i) => {
    const y = i * ROW + ROW / 2
    const [r, g, b] = s.color.map((c) => Math.round(Math.pow(Math.min(1, c), 1 / 2.2) * 255))
    ctx.fillStyle = `rgb(${r},${g},${b})`
    ctx.fillRect(4, y - 2, 18, 4)
    ctx.font = '600 30px system-ui, sans-serif'
    ctx.lineWidth = 6
    ctx.strokeStyle = 'rgba(0,0,0,0.75)'
    const text = `${s.label}  ${formatAltitude(s.altitude)}`
    ctx.strokeText(text, 30, y)
    ctx.fillText(text, 30, y)
  })
  const t = new CanvasTexture(canvas as HTMLCanvasElement)
  t.colorSpace = SRGBColorSpace
  return t
}

function instancedFrom(base: BufferGeometry, count: number): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry()
  g.index = base.index
  for (const [k, v] of Object.entries(base.attributes)) g.setAttribute(k, v)
  g.instanceCount = count
  g.boundingSphere = new Sphere(new Vector3(), Infinity)
  return g
}

/**
 * The shell overlay. `Sky` owns one (`sky.shells`, settings under `shells`); use it on its own with
 * {@link AltitudeShells.update}.
 */
export class AltitudeShells {
  /** Root group. */
  readonly object = new Group()
  /** Resolved settings. */
  settings: ShellsOptions = structuredClone(DEFAULT_SHELLS)
  private u = {
    center: uniform(new Vector3()),
    radius: uniform(1),
    opacity: uniform(0.8),
    right: uniform(new Vector3(1, 0, 0)),
    up: uniform(new Vector3(0, 1, 0)),
    size: uniform(0.035),
  }
  private shellMesh: Mesh<InstancedBufferGeometry, NodeMaterial> | null = null
  private labelMesh: Mesh<InstancedBufferGeometry, NodeMaterial> | null = null
  private atlas: CanvasTexture | null = null
  private key = ''
  private resolved: ResolvedShell[] = []

  constructor(input: ShellsInput = {}) {
    this.object.name = 'AltitudeShells'
    this.set(input)
  }

  /** Merges settings. */
  set(input: ShellsInput): this {
    for (const [k, v] of Object.entries(input)) if (v !== undefined) (this.settings as any)[k] = structuredClone(v)
    this.u.opacity.value = this.settings.opacity
    this.u.size.value = this.settings.labelSize
    this.object.visible = this.settings.enabled
    if (this.labelMesh) this.labelMesh.visible = this.settings.labels
    return this
  }

  /** Replaces all settings. */
  reset(input: ShellsInput = {}): this {
    this.settings = structuredClone(DEFAULT_SHELLS)
    return this.set(input)
  }

  /** The shells as last drawn (altitudes in metres). */
  get shells(): readonly ResolvedShell[] {
    return this.resolved
  }

  private build(shells: ResolvedShell[]) {
    this.disposeMeshes()
    const n = shells.length
    if (!n) return
    const u = this.u

    // Shells: one instanced sphere; a rim that brightens where the view grazes it, hidden by the planet.
    const sphere = new SphereGeometry(1, 128, 64)
    const g = instancedFrom(sphere, n)
    const aR = new InstancedBufferAttribute(new Float32Array(n), 1), aC = new InstancedBufferAttribute(new Float32Array(n * 3), 3)
    shells.forEach((s, i) => { aC.array.set(s.color, i * 3) })
    g.setAttribute('aRadius', aR); g.setAttribute('aColor', aC)
    const nrm = normalize(positionLocal)
    const world = u.center.add(nrm.mul(attribute('aRadius', 'float')))
    const vWorld: any = varying(world), vN: any = varying(nrm)
    const toFrag = vWorld.sub(cameraPosition)
    const dist = length(toFrag), dir = toFrag.div(dist)
    const rim = pow(float(1).sub(abs(dot(vN, dir))), 8)
    // Planet occlusion, closest-approach form (stable from far away).
    const o = cameraPosition.sub(u.center)
    const b = dot(o, dir)
    const closest = length(o.sub(dir.mul(b)))
    const hit = b.negate().sub(sqrt(max(u.radius.mul(u.radius).sub(closest.mul(closest)), 0)))
    const hidden = closest.lessThan(u.radius).and(hit.greaterThan(0)).and(hit.lessThan(dist))
    const m = new NodeMaterial()
    m.transparent = true; m.depthWrite = false; m.blending = AdditiveBlending; m.fog = false
    m.vertexNode = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(world, 1))
    m.colorNode = vec4(attribute('aColor', 'vec3').mul(rim.mul(u.opacity).mul(select(hidden, 0, 1))), 1)
    this.shellMesh = new Mesh(g, m)
    sphere.dispose()

    // Labels: one instanced quad reading its row of the atlas, always on top.
    this.atlas = labelAtlas(shells)
    if (this.atlas) {
      const quad = new PlaneGeometry(1, 1)
      const lg = instancedFrom(quad, n)
      const aRow = new InstancedBufferAttribute(new Float32Array(n), 1)
      for (let i = 0; i < n; i++) aRow.array[i] = i
      lg.setAttribute('aAnchor', new InstancedBufferAttribute(new Float32Array(n * 3), 3))
      lg.setAttribute('aRow', aRow)
      lg.setAttribute('aAlpha', new InstancedBufferAttribute(new Float32Array(n), 1))
      const anchor = attribute('aAnchor', 'vec3')
      const size = length(anchor.sub(cameraPosition)).mul(u.size)
      const offset = u.right.mul(positionLocal.x.add(0.5).mul(ASPECT)).add(u.up.mul(positionLocal.y))
      const lm = new NodeMaterial()
      lm.transparent = true; lm.depthWrite = false; lm.depthTest = false; lm.fog = false
      lm.vertexNode = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(anchor.add(offset.mul(size)), 1))
      const v = float(1).sub(attribute('aRow', 'float').add(float(1).sub(uv().y)).div(n))
      const texel = texture(this.atlas, vec2(uv().x, v))
      lm.colorNode = vec4(texel.rgb, texel.a.mul(attribute('aAlpha', 'float')))
      this.labelMesh = new Mesh(lg, lm)
      this.labelMesh.renderOrder = 100
      this.labelMesh.visible = this.settings.labels
      quad.dispose()
    }
    for (const mesh of [this.shellMesh, this.labelMesh]) if (mesh) { mesh.frustumCulled = false; this.object.add(mesh) }
  }

  /**
   * Places the shells around a planet and their labels for `camera`.
   * @param center Planet centre, render space.
   * @param radius Planet radius, render units.
   * @param shells Resolved shells (see {@link resolveShells}).
   * @param scale Render units per metre (1 in the sky's frames, e.g. 1e-6 in a `SolarSystem` view).
   */
  update(camera: Camera, center: Vec3, radius: number, shells: ResolvedShell[], scale = 1): void {
    this.resolved = shells
    if (!this.settings.enabled) return
    const key = JSON.stringify(shells)
    if (key !== this.key) {
      this.key = key
      this.build(shells)
    }
    const u = this.u
    u.center.value.set(...center)
    u.radius.value = radius
    if (!this.shellMesh) return
    const radii = this.shellMesh.geometry.getAttribute('aRadius') as InstancedBufferAttribute
    shells.forEach((s, i) => { radii.array[i] = radius + s.altitude * scale })
    radii.needsUpdate = true
    if (!this.labelMesh) return

    camera.updateMatrixWorld()
    const e = camera.matrixWorld.elements
    const P = new Vector3(e[12], e[13], e[14])
    const right = new Vector3(e[0], e[1], e[2]).normalize(), camUp = new Vector3(e[4], e[5], e[6]).normalize()
    const forward = new Vector3(-e[8], -e[9], -e[10]).normalize()
    u.right.value.copy(right); u.up.value.copy(camUp)
    const C = new Vector3(...center)
    const far = (camera as { far?: number }).far ?? 1e9
    const anchors = this.labelMesh.geometry.getAttribute('aAnchor') as InstancedBufferAttribute
    const alphas = this.labelMesh.geometry.getAttribute('aAlpha') as InstancedBufferAttribute
    const toCam = P.clone().sub(C), d = toCam.length()
    const localUp = toCam.clone().divideScalar(d)
    const v = new Vector3(), a = new Vector3()
    shells.forEach((s, i) => {
      const r = radius + s.altitude * scale
      // From outside, hide the label while the shell is smaller on screen than the label is long.
      alphas.array[i] = d > r && r / d < this.settings.labelSize * ASPECT * 0.5 ? 0 : 1
      if (d > r) {
        // Outside: on the limb, fanned out clockwise from the top of the screen so labels don't stack.
        const ang = i * 0.3
        const w = camUp.clone().multiplyScalar(Math.cos(ang)).addScaledVector(right, Math.sin(ang))
        const n = C.clone().sub(P).normalize()
        w.addScaledVector(n, -w.dot(n)).normalize()
        a.copy(C).addScaledVector(localUp, (r * r) / d).addScaledVector(w, r * Math.sqrt(Math.max(0, 1 - (r * r) / (d * d))))
      } else {
        // Inside: where a ray towards the horizon ahead meets the shell, a little higher for each label.
        v.copy(forward).addScaledVector(localUp, -forward.dot(localUp))
        if (v.lengthSq() < 1e-6) v.copy(camUp).addScaledVector(localUp, -camUp.dot(localUp))
        v.normalize()
        const el = (4 + i * 5) * DEG
        v.multiplyScalar(Math.cos(el)).addScaledVector(localUp, Math.sin(el))
        const b = toCam.dot(v), c = d * d - r * r
        const t = -b + Math.sqrt(Math.max(0, b * b - c))
        a.copy(P).addScaledVector(v, t)
      }
      // Size is relative to distance, so pull far anchors in to stay inside the far plane.
      v.copy(a).sub(P)
      const dist = v.length(), max = far * 0.5
      if (dist > max) a.copy(P).addScaledVector(v, max / dist)
      anchors.array.set([a.x, a.y, a.z], i * 3)
    })
    anchors.needsUpdate = true
    alphas.needsUpdate = true
  }

  private disposeMeshes() {
    for (const mesh of [this.shellMesh, this.labelMesh]) {
      if (!mesh) continue
      mesh.removeFromParent()
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
    this.atlas?.dispose()
    this.shellMesh = this.labelMesh = null
    this.atlas = null
  }

  /** Frees GPU resources. */
  dispose(): void {
    this.disposeMeshes()
    this.key = ''
    this.object.removeFromParent()
  }
}
