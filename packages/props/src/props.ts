import {
  BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Quaternion, Vector3,
  type MeshStandardNodeMaterial, type Node, type Object3D,
} from 'three/webgpu'
import { time as tslTime } from 'three/tsl'
import { hash01, seedOf } from 'threejs-biomes'
import { InstanceStates, type MaterialStates, type StateLook } from 'threejs-weathering'
import { buildProp, PROP_KINDS, quatFromUp, type PropMaterialId, type PropModel, type PropPlacement } from './catalog.ts'
import { catenaryPoints } from './catenary.ts'
import { shapeData, type ShapeId } from './geometry.ts'
import { createPropMaterial, createPropUniforms, type PropMaterialContext } from './materials.ts'

/** Power line cables. Plain JSON. */
export interface CableOptions {
  /** Midspan sag as a share of the span (0.03 = 3 m on a 100 m span). */
  sag: number
  /** Extra sag at full snow (ice load), as a share of `sag`. */
  iceSag: number
  /** Straight pieces per span. */
  segments: number
  /** Cable thickness, metres. */
  thickness: number
  /** Cable colour (`#rrggbb`). */
  color: string
}

/** Settings of {@link Props}. Plain JSON. */
export interface PropsOptions {
  /** Every prop instance (see `decorateRoads`, `planPowerLine`, or write your own). */
  placements: PropPlacement[]
  /** Weather floor for every prop (each instance shows the larger of this and its own state). */
  states: MaterialStates
  /** Ember glow on burnt surfaces, 0…1. */
  heat: number
  /** 0 day … 1 night: street lamps glow. Ignored when a `night` node was given at creation. */
  night: number
  /** Lamp brightness (emissive multiplier). */
  lampIntensity: number
  /** Seconds per traffic light cycle. */
  trafficCycle: number
  /** Lean at full damage, radians (scaled per kind: poles lean fully, pylons barely, bins not at all). */
  lean: number
  /** Power line cables. */
  cables: CableOptions
  /** Cast shadows. */
  castShadow: boolean
  /** Receive shadows. */
  receiveShadow: boolean
}

/** Defaults of {@link PropsOptions}. */
export const DEFAULT_PROPS: PropsOptions = {
  placements: [],
  states: { wetness: 0, snow: 0, burn: 0, damage: 0 },
  heat: 0,
  night: 0,
  lampIntensity: 6,
  trafficCycle: 24,
  lean: 0.38,
  cables: { sag: 0.025, iceSag: 0.6, segments: 10, thickness: 0.03, color: '#1c1c1c' },
  castShadow: true,
  receiveShadow: true,
}

/** Partial settings (nested groups merge). */
export type PropsInput = Partial<Omit<PropsOptions, 'states' | 'cables'>> & { states?: Partial<MaterialStates>; cables?: Partial<CableOptions> }

/** Options of {@link Props.create}: settings plus live inputs (not JSON). */
export interface PropsCreateOptions extends PropsInput {
  /** 0 day … 1 night as a TSL node, e.g. threejs-sky's `sky.uniforms.night` (overrides the `night` number). */
  nightNode?: Node
  /** Seconds as a TSL node (default: TSL `time`). */
  time?: Node
  /** Weathering look (default: threejs-weathering's shared look). */
  look?: StateLook
  /** If given, the props are added to it and update whenever it renders. */
  scene?: Object3D
}

interface Group_ {
  shape: ShapeId
  material: PropMaterialId
  prop: number[]
  local: number[]
  tint: number[]
  glow: number[]
}

interface Span { from: number; to: number; a: [number, number, number]; b: [number, number, number] }

const _m = new Matrix4()
const _l = new Matrix4()
const _q = new Quaternion()
const _ql = new Quaternion()
const _p = new Vector3()
const _s = new Vector3()
const _v = new Vector3()
const _w = new Vector3()
const _c = new Color()
const UP = new Vector3(0, 1, 0)

function merge<T>(target: T, input: unknown): T {
  if (!input || typeof input !== 'object') return target
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === undefined) continue
    const cur = (target as Record<string, unknown>)[k]
    ;(target as Record<string, unknown>)[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)
      ? merge({ ...(cur as object) }, v)
      : v
  }
  return target
}

/** Resolves partial settings against {@link DEFAULT_PROPS}. */
export function resolvePropsOptions(input: PropsInput = {}): PropsOptions {
  const o = merge(structuredClone({ ...DEFAULT_PROPS, placements: [] as PropPlacement[] }), input)
  o.placements = input.placements ?? []
  return o
}

/**
 * Street and countryside props: every placement is assembled from a few unit shapes, and all of them
 * are drawn as one `InstancedMesh` per (shape, material) pair, single-material, with typed-array
 * per-instance tint (`aTint`, read in `colorNode`) and weather states (`aStates`). Power poles and
 * pylons with the same `line` are strung with sagging catenary cables (instanced segments).
 *
 * Per-prop weather goes through {@link Props.states}, a threejs-weathering `InstanceStates` with one
 * entry per placement, so `applyDamage`, `StormDamage` and `sampleField` work on props directly
 * (positions in {@link Props.positions}). Damaged poles, lights and signs lean; wet props darken and
 * shine; snow settles on top; burnt props char.
 *
 * @example
 * ```ts
 * const props = await Props.create({ scene, placements: decorateRoads(city.graph!, world).placements })
 * props.states.set(3, { damage: 1 })                     // prop 3 leans over
 * applyDamage({ instances: props.states, positions: props.positions }, x, z, 20, 0.8)
 * props.set({ night: 1, states: { wetness: 0.7 } })      // lamps on, everything wet
 * ```
 */
export class Props {
  /** Root object, in frame-local coordinates (add it where the placements' frame is, e.g. `city.local`). */
  readonly object = new Group()
  /** Shared material uniforms. */
  readonly uniforms = createPropUniforms()
  /** Resolved settings. */
  options: PropsOptions
  /** Weather per placement (wetness, snow, burn, damage). Replaced when the number of placements changes. */
  states: InstanceStates
  /** Placement positions, xyz per placement (for `applyDamage`, `StormDamage`, `sampleField`). */
  positions: Float32Array = new Float32Array(0)
  /** The instanced meshes, by `shape|material` (and `cables`). */
  readonly meshes = new Map<string, InstancedMesh>()

  private readonly ctx: PropMaterialContext
  private readonly materials = new Map<PropMaterialId, MeshStandardNodeMaterial>()
  private models: PropModel[] = []
  private groups = new Map<string, Group_>()
  private spans: Span[] = []
  private layoutKey = ''
  private synced = -1
  private syncKey = ''
  private propMatrices = new Float32Array(0)
  private cablePoints = new Float32Array(0)
  private unhook = () => {}

  /** Creates the props (async for symmetry with the other packages; nothing to wait for). */
  static async create(options: PropsCreateOptions = {}): Promise<Props> {
    return new Props(options)
  }

  /** Prefer {@link Props.create}. */
  constructor({ nightNode, time, look, scene, ...input }: PropsCreateOptions = {}) {
    this.object.name = 'Props'
    this.ctx = { uniforms: this.uniforms, night: nightNode ?? this.uniforms.night, time: time ?? tslTime, look }
    this.options = resolvePropsOptions(input)
    this.states = new InstanceStates(0)
    this.apply()
    if (scene) {
      scene.add(this.object)
      const previous = scene.onBeforeRender
      scene.onBeforeRender = (...args) => {
        previous.apply(scene, args)
        this.update()
      }
      this.unhook = () => { scene.onBeforeRender = previous }
    }
  }

  /** Number of placements. */
  get count(): number {
    return this.options.placements.length
  }

  /** Changes settings, merging into the current ones. New `placements` rebuild the meshes; everything else is instant. */
  set(input: PropsInput): this {
    this.options = merge(this.options, input)
    if (input.placements) this.options.placements = input.placements
    return this.apply()
  }

  /** Replaces all settings (anything not given goes back to its default). */
  reset(input: PropsInput = {}): this {
    this.options = resolvePropsOptions(input)
    return this.apply()
  }

  private apply(): this {
    const o = this.options, u = this.uniforms
    u.wetness.value = o.states.wetness
    u.snow.value = o.states.snow
    u.burn.value = o.states.burn
    u.damage.value = o.states.damage
    u.heat.value = o.heat
    u.night.value = o.night
    u.lampIntensity.value = o.lampIntensity
    u.trafficCycle.value = o.trafficCycle
    const key = JSON.stringify([o.placements, o.cables.segments])
    if (key !== this.layoutKey) {
      this.layoutKey = key
      this.layout()
    }
    for (const mesh of this.meshes.values()) {
      mesh.castShadow = o.castShadow
      mesh.receiveShadow = o.receiveShadow
    }
    _c.set(o.cables.color)
    const cables = this.meshes.get('cables')
    if (cables) {
      const tint = cables.geometry.getAttribute('aTint') as InstancedBufferAttribute
      for (let i = 0; i < cables.count; i++) tint.setXYZ(i, _c.r, _c.g, _c.b)
      tint.needsUpdate = true
    }
    this.update()
    return this
  }

  private material(id: PropMaterialId): MeshStandardNodeMaterial {
    let m = this.materials.get(id)
    if (!m) this.materials.set(id, (m = createPropMaterial(id, this.ctx)))
    return m
  }

  // Rebuilds models, instance groups and meshes from the placements.
  private layout() {
    const o = this.options, list = o.placements
    const old = this.states
    this.states = new InstanceStates(list.length)
    this.states.array.set(old.array.subarray(0, Math.min(old.array.length, this.states.array.length)))
    this.positions = new Float32Array(list.length * 3)
    this.models = list.map((p, i) => {
      this.positions[i * 3] = p.x
      this.positions[i * 3 + 1] = p.y
      this.positions[i * 3 + 2] = p.z
      return buildProp(p)
    })
    this.groups.clear()
    this.models.forEach((model, i) => {
      for (const part of model.parts) {
        const key = `${part.shape}|${part.material}`
        let g = this.groups.get(key)
        if (!g) this.groups.set(key, (g = { shape: part.shape, material: part.material, prop: [], local: [], tint: [], glow: [] }))
        g.prop.push(i)
        _l.compose(_p.set(...part.p), _q.set(...part.q), _s.set(...part.s))
        g.local.push(..._l.elements)
        _c.setRGB(part.color[0], part.color[1], part.color[2], 'srgb')
        g.tint.push(_c.r, _c.g, _c.b)
        g.glow.push(part.glow?.[0] ?? 0, part.glow?.[1] ?? 0)
      }
    })
    // Power lines: consecutive placements with the same line id, wired attach point to attach point.
    this.spans = []
    const last = new Map<number, number>()
    list.forEach((p, i) => {
      if (p.line === undefined) return
      const prev = last.get(p.line)
      last.set(p.line, i)
      if (prev === undefined) return
      const a = this.models[prev].attach, b = this.models[i].attach
      for (let k = 0; k < Math.min(a.length, b.length); k++) this.spans.push({ from: prev, to: i, a: a[k], b: b[k] })
    })

    for (const mesh of this.meshes.values()) {
      mesh.geometry.dispose()
      mesh.removeFromParent()
    }
    this.meshes.clear()
    for (const [key, g] of this.groups) {
      this.meshes.set(key, this.makeMesh(key, g.shape, g.material, g.prop.length, new Float32Array(g.tint), g.material === 'lamp' ? new Float32Array(g.glow) : null))
    }
    const segs = Math.max(1, Math.round(o.cables.segments))
    if (this.spans.length) this.meshes.set('cables', this.makeMesh('cables', 'wire', 'cable', this.spans.length * segs, new Float32Array(this.spans.length * segs * 3), null))
    this.propMatrices = new Float32Array(list.length * 16)
    this.cablePoints = new Float32Array((segs + 1) * 3)
    this.synced = -1
  }

  private makeMesh(name: string, shape: ShapeId, material: PropMaterialId, count: number, tint: Float32Array, glow: Float32Array | null): InstancedMesh {
    const d = shapeData(shape)
    const g = new BufferGeometry()
    // Own attribute objects per mesh (disposing one geometry frees its GPU buffers); the arrays are shared.
    g.setIndex(new BufferAttribute(d.index, 1))
    g.setAttribute('position', new BufferAttribute(d.position, 3))
    g.setAttribute('normal', new BufferAttribute(d.normal, 3))
    g.setAttribute('uv', new BufferAttribute(d.uv, 2))
    g.setAttribute('aTint', new InstancedBufferAttribute(tint, 3))
    g.setAttribute('aStates', new InstancedBufferAttribute(new Float32Array(count * 4), 4))
    if (glow) g.setAttribute('aGlow', new InstancedBufferAttribute(glow, 2))
    const mesh = new InstancedMesh(g, this.material(material), count)
    mesh.name = `props/${name}`
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    mesh.castShadow = this.options.castShadow
    mesh.receiveShadow = this.options.receiveShadow
    this.object.add(mesh)
    return mesh
  }

  /**
   * Applies per-prop states (lean, cable ice sag, shader states) when they changed. Called automatically
   * when a `scene` was given (and by `<Props>`); cheap when nothing changed.
   */
  update(): void {
    const o = this.options
    const key = JSON.stringify([o.lean, o.cables, o.states])
    if (this.states.attribute.version === this.synced && key === this.syncKey) return
    this.synced = this.states.attribute.version
    this.syncKey = key
    const list = o.placements, st = this.states.array
    // Prop matrices: position, yaw, lean away from a seeded direction as damage grows.
    for (let i = 0; i < list.length; i++) {
      const p = list[i]
      const damage = Math.max(st[i * 4 + 3], o.states.damage)
      const lean = o.lean * PROP_KINDS[p.kind].lean * smooth(0.25, 1, damage)
      _q.setFromAxisAngle(UP, p.yaw)
      if (lean > 0) {
        const dir = hash01(seedOf(p.seed), 3, 17, 5) * Math.PI * 2
        _ql.setFromAxisAngle(_v.set(Math.cos(dir), 0, Math.sin(dir)), lean)
        _q.premultiply(_ql)
      }
      _m.compose(_p.set(p.x, p.y, p.z), _q, _s.set(1, 1, 1)).toArray(this.propMatrices, i * 16)
    }
    for (const [key, g] of this.groups) {
      const mesh = this.meshes.get(key)!
      const arr = mesh.instanceMatrix.array as Float32Array
      const states = mesh.geometry.getAttribute('aStates') as InstancedBufferAttribute
      const sa = states.array as Float32Array
      for (let j = 0; j < g.prop.length; j++) {
        const i = g.prop[j]
        _m.fromArray(this.propMatrices, i * 16)
        _l.fromArray(g.local, j * 16)
        _m.multiply(_l).toArray(arr, j * 16)
        for (let c = 0; c < 4; c++) sa[j * 4 + c] = st[i * 4 + c]
      }
      mesh.instanceMatrix.needsUpdate = true
      states.needsUpdate = true
      mesh.computeBoundingSphere()
    }
    const cables = this.meshes.get('cables')
    if (cables) {
      const segs = Math.max(1, Math.round(o.cables.segments))
      const arr = cables.instanceMatrix.array as Float32Array
      const states = cables.geometry.getAttribute('aStates') as InstancedBufferAttribute
      const sa = states.array as Float32Array
      const t = o.cables.thickness
      let n = 0
      for (const span of this.spans) {
        _m.fromArray(this.propMatrices, span.from * 16)
        const a = _v.set(...span.a).applyMatrix4(_m).toArray()
        _m.fromArray(this.propMatrices, span.to * 16)
        const b = _w.set(...span.b).applyMatrix4(_m).toArray()
        const snow = Math.max(st[span.from * 4 + 1], st[span.to * 4 + 1], o.states.snow)
        const L = Math.hypot(b[0] - a[0], b[2] - a[2])
        const pts = catenaryPoints(a, b, L * o.cables.sag * (1 + snow * o.cables.iceSag), segs, this.cablePoints)
        for (let k = 0; k < segs; k++, n++) {
          const dx = pts[k * 3 + 3] - pts[k * 3], dy = pts[k * 3 + 4] - pts[k * 3 + 1], dz = pts[k * 3 + 5] - pts[k * 3 + 2]
          const len = Math.hypot(dx, dy, dz) || 1e-6
          const q = quatFromUp(dx / len, dy / len, dz / len)
          _m.compose(_p.set(pts[k * 3], pts[k * 3 + 1], pts[k * 3 + 2]), _q.set(q[0], q[1], q[2], q[3]), _s.set(t, len, t)).toArray(arr, n * 16)
          for (let c = 0; c < 4; c++) sa[n * 4 + c] = st[span.from * 4 + c]
        }
      }
      cables.instanceMatrix.needsUpdate = true
      states.needsUpdate = true
      cables.computeBoundingSphere()
    }
  }

  /** Removes the props and frees GPU resources. */
  dispose(): void {
    this.unhook()
    for (const mesh of this.meshes.values()) mesh.geometry.dispose()
    for (const m of this.materials.values()) m.dispose()
    this.meshes.clear()
    this.materials.clear()
    this.object.removeFromParent()
  }
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
