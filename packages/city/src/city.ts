import {
  BatchedMesh, BufferGeometry, Color, Float32BufferAttribute, Group, Matrix4, Mesh, Quaternion, Uint16BufferAttribute, Uint32BufferAttribute, Vector3,
  type Camera, type Material, type Object3D,
} from 'three/webgpu'
import { batchIndirectIndex, hash } from 'three/tsl'
import { hash01, type FlattenPath, type LocalFrame, type World } from 'threejs-biomes'
import type { Climate } from './architecture.ts'
import { buildingGeometry, detailGeometry, detailInstances, DETAIL_SHAPES } from './building-mesh.ts'
import type { Building } from './buildings.ts'
import { cityData, type CityData } from './data.ts'
import { applyFacadeUniforms, BuildingWeather, createCityUniforms, createFacadeMaterial, createRoofMaterial } from './facade-material.ts'
import { createFieldMaterial } from './field-material.ts'
import { fieldGeometry } from './field-mesh.ts'
import type { RoadGraph } from './graph.ts'
import type { MeshData } from './mesh-builder.ts'
import { mergeOptions, resolveCityOptions, type CityInput, type CityOptions, type Weather } from './options.ts'
import { planCity, type CityPlan } from './plan.ts'
import { pointInPolygon } from './polygon.ts'
import { createRoadMaterial } from './road-material.ts'
import { roadGeometry } from './road-mesh.ts'
import { ROAD_SURFACES } from './graph.ts'
import { Site } from './site.ts'
import { modifierPoint, padModifier, roadModifiers } from './terrain.ts'

/** Live counters of a {@link City}. */
export interface CityStats {
  /** True once generation has finished and meshes exist. */
  ready: boolean
  /** Road length, km. */
  roadKm: number
  /** Road edges. */
  roads: number
  /** Junctions (nodes where three or more roads meet). */
  junctions: number
  /** Bridges. */
  bridges: number
  /** City blocks. */
  blocks: number
  /** Lots. */
  lots: number
  /** Buildings. */
  buildings: number
  /** Estimated residents. */
  population: number
  /** Terrain modifiers registered on the world. */
  modifiers: number
  /** Milliseconds spent generating (plan and meshes). */
  generationMs: number
  /** Buildings currently drawn at full detail. */
  detailed: number
}

/** Options for {@link City.create}: settings plus the objects a city needs (not JSON). */
export interface CityCreateOptions extends CityInput {
  /** The world the settlement stands on (its height, water and climate; flattening goes here). */
  world: World
  /** Local frame the settlement is laid out in (`world.frame` by default; `world.frameAt(lat, lon)` on planets). */
  frame?: LocalFrame
  /** Camera for level of detail. Without one, everything stays at full detail. */
  camera?: Camera
  /** If given, the city is added to it and updates itself via `scene.onBeforeRender`. */
  scene?: Object3D
}

const _cam = new Vector3()
const _m = new Matrix4()
const _p = new Vector3()
const _q = new Quaternion()
const _s = new Vector3()
const _y = new Vector3(0, 1, 0)

interface Batch { mesh: BatchedMesh; full: number[]; simple: number[]; instance: number[] }

/**
 * A procedural settlement on a threejs-biomes `World`: roads grown along a tensor field, blocks, lots and
 * buildings in a few `BatchedMesh` draw calls with procedural facades, terrain flattened under
 * roads and buildings. Everything derives from the options and the world.
 *
 * @example
 * ```ts
 * const world = new World({ seed: 7 })
 * const city = await City.create({ world, camera, scene, size: 'town', center: [400, -200] })
 * city.set({ facade: { night: 1 } })  // lights on
 * ```
 */
export class City {
  /** Root object: positioned at the centre on the world surface, y along the local up. */
  readonly object = new Group()
  /** Child of `object` in frame-local coordinates: add props here at positions from {@link City.data}. */
  readonly local = new Group()
  /** Shader uniforms (night, window grids, weather, road look). */
  readonly uniforms = createCityUniforms()
  /** Live counters. */
  readonly stats: CityStats = { ready: false, roadKm: 0, roads: 0, junctions: 0, bridges: 0, blocks: 0, lots: 0, buildings: 0, population: 0, modifiers: 0, generationMs: 0, detailed: 0 }
  /** The world. */
  readonly world: World
  /** The frame the city is laid out in. */
  readonly frame: LocalFrame
  /** Camera used for LOD; can be swapped any time. */
  camera: Camera | null
  /** Resolved settings. Change them with {@link City.set} / {@link City.reset}. */
  options: CityOptions
  /** The generated plan (roads, lots, buildings), or `null` while generating. */
  plan: CityPlan | null = null

  private input: CityInput = {}
  private planKey = ''
  private meshKey = ''
  private worldKey = ''
  private job: Generator<void, CityPlan> | null = null
  private jobTime = 0
  private modifiers: FlattenPath[] = []
  private walls: Batch | null = null
  private roofs: Batch | null = null
  private details: BatchedMesh | null = null
  private detailIds: number[][] = []
  private roads: Mesh | null = null
  private fields: Mesh | null = null
  private materials: Material[] = []
  private weather: BuildingWeather | null = null
  private lodState: Uint8Array = new Uint8Array(0)
  private lastCam = new Vector3(Infinity, 0, 0)
  private index = new Map<number, number[]>()
  private unhook = () => {}
  private unlisten: () => void

  /** Creates a city and (unless `progressive`) generates it completely. */
  static async create(options: CityCreateOptions): Promise<City> {
    return new City(options)
  }

  /** Prefer {@link City.create}. */
  constructor({ world, frame, camera, scene, ...input }: CityCreateOptions) {
    this.world = world
    this.frame = frame ?? world.frame
    this.camera = camera ?? null
    this.object.name = 'City'
    this.object.add(this.local)
    this.options = resolveCityOptions(input)
    this.worldKey = this.worldOptionsKey()
    this.unlisten = world.onChange(() => {
      const key = this.worldOptionsKey()
      if (key === this.worldKey) return
      this.worldKey = key
      this.planKey = ''
      this.apply()
    })
    this.set(input)
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

  /** Changes settings, merging into the current input. Looks are instant; layout changes regenerate. */
  set(input: CityInput): this {
    this.input = mergeOptions(this.input, input)
    return this.apply()
  }

  /** Replaces all settings (anything not given goes back to its default). */
  reset(input: CityInput = {}): this {
    this.input = mergeOptions({}, input)
    return this.apply()
  }

  /** The road graph (for navigation), or `null` while generating. */
  get graph(): RoadGraph | null {
    return this.plan?.graph ?? null
  }

  /** Buildings (empty while generating). */
  get buildings(): Building[] {
    return this.plan?.buildings ?? []
  }

  /** Plain-data snapshot for props, vehicles and crowds (frame-local coordinates), or `null` while generating. */
  data(): CityData | null {
    return this.plan ? cityData(this.plan, this.options.roads) : null
  }

  /** The building at frame-local (x, z), or `null`. */
  buildingAt(x: number, z: number): Building | null {
    const list = this.index.get(cellKey(Math.floor(x / 50), Math.floor(z / 50)))
    if (!list || !this.plan) return null
    for (const id of list) {
      const b = this.plan.buildings[id]
      if (b.parts.some((p) => pointInPolygon(x, z, p.tiers[0].polygon))) return b
    }
    return null
  }

  /** Overrides weather for one building (0..1 each; the larger of this and `options.weather.walls/roofs` applies). */
  setBuildingWeather(id: number, weather: Partial<Weather>): void {
    this.weather?.set(id, weather)
  }

  /** Throws away the current settlement and generates it again (e.g. after editing the world by hand). */
  regenerate(): void {
    this.planKey = ''
    this.apply()
  }

  /**
   * Advances progressive generation (within `budget` ms) and updates level of detail. Called
   * automatically when a `scene` was given (and by `<City>`); otherwise call it once per frame.
   */
  update(budget: number = this.options.buildBudget): void {
    if (this.job) {
      const start = performance.now()
      do { // at least one step per call, so any budget (even 0) makes progress
        const r = this.job.next()
        if (r.done) this.finish(r.value)
      } while (this.job && performance.now() - start < budget)
      this.jobTime += performance.now() - start
    }
    this.updateLod()
  }

  /** Removes the city, its terrain modifiers and its GPU resources. */
  dispose(): void {
    this.unhook()
    this.unlisten()
    this.job = null
    this.clearModifiers()
    this.clearMeshes()
    this.object.removeFromParent()
  }

  // ------------------------------------------------------------------------------------------

  private worldOptionsKey(): string {
    const { modifiers: _m, ...rest } = this.world.options
    return JSON.stringify(rest)
  }

  private apply(): this {
    const o = (this.options = resolveCityOptions(this.input))
    applyFacadeUniforms(this.uniforms, o.facade, o.buildings.floorHeight, o.weather)
    const u = this.uniforms
    ROAD_SURFACES.forEach((s, i) => (u.roadColors.array[i] as Color).set(o.roadLook.colors[s]))
    u.sidewalk.value.set(o.roadLook.sidewalk)
    u.kerb.value.set(o.roadLook.kerb)
    u.marking.value.set(o.roadLook.marking)
    u.centerLine.value.set(o.roadLook.centerLine)
    u.concrete.value.set(o.roadLook.concrete)
    u.markings.value = o.roadLook.markings ? 1 : 0
    u.wear.value = o.roadLook.wear

    // Place the root on the world surface, oriented to the frame.
    const f = this.frame
    const [cx, cz] = o.center
    const p = f.toWorld(cx, 0, cz)
    this.object.position.set(p[0], p[1], p[2])
    _m.makeBasis(new Vector3(...f.east), new Vector3(...f.up), new Vector3(-f.north[0], -f.north[1], -f.north[2]))
    this.object.quaternion.setFromRotationMatrix(_m)
    this.local.position.set(-cx, 0, -cz)

    const { facade, roadLook, weather: _w, lod: _l, progressive: _p, buildBudget: _b, ...layout } = o
    const planKey = JSON.stringify(layout)
    const meshKey = JSON.stringify([facade.walls, facade.roofs, facade.variation, roadLook.kerbHeight])
    if (planKey !== this.planKey) {
      this.planKey = planKey
      this.meshKey = meshKey
      this.start()
    } else if (meshKey !== this.meshKey) {
      this.meshKey = meshKey
      if (this.plan) this.buildMeshes(this.plan)
    }
    this.lastCam.set(Infinity, 0, 0)
    return this
  }

  private start() {
    const o = this.options
    this.clearModifiers()
    const t0 = performance.now()
    const s = this.frame.sample(o.center[0], o.center[1])
    const climate: Climate = { temperature: s.temperature, moisture: s.moisture, biome: this.world.options.biomes[s.biomes[0]]?.id ?? '' }
    this.job = planCity(Site.frameFn(this.frame), o, climate)
    this.jobTime = performance.now() - t0
    this.stats.ready = false
    if (!o.progressive) this.update(Infinity)
  }

  private finish(plan: CityPlan) {
    const t0 = performance.now()
    this.job = null
    this.plan = plan
    const o = this.options
    const t = o.terrain
    if (t.flatten) {
      const to = (x: number, z: number, y: number) => modifierPoint(this.world, this.frame, x, z, y)
      // Pads first, roads last: later modifiers win where they overlap.
      const pads = t.flattenLots ? plan.buildings.filter((b) => b.stilts === 0).map((b) => padModifier(b, to, t)) : []
      this.modifiers = [...pads, ...roadModifiers(plan.graph, plan.profiles, to, t)]
      // One change notification for the whole batch.
      this.world.options.modifiers.push(...this.modifiers)
      this.world.set({})
    }
    this.index.clear()
    for (const b of plan.buildings) {
      const seen = new Set<number>()
      for (const part of b.parts) for (const [x, z] of part.tiers[0].polygon) {
        const k = cellKey(Math.floor(x / 50), Math.floor(z / 50))
        if (seen.has(k)) continue
        seen.add(k)
        const list = this.index.get(k)
        if (list) list.push(b.id)
        else this.index.set(k, [b.id])
      }
    }
    this.buildMeshes(plan)
    const g = plan.graph
    Object.assign(this.stats, {
      ready: true, roadKm: g.totalLength() / 1000, roads: g.edges.length, junctions: g.nodes.filter((n) => n.edges.length >= 3).length,
      bridges: g.edges.filter((e) => e.bridge).length, blocks: plan.blocks.length, lots: plan.lots.length, buildings: plan.buildings.length,
      population: plan.population, modifiers: this.modifiers.length, generationMs: this.jobTime + performance.now() - t0,
    })
  }

  private clearModifiers() {
    if (!this.modifiers.length) return
    const mine = new Set<unknown>(this.modifiers)
    const list = this.world.options.modifiers
    for (let i = list.length - 1; i >= 0; i--) if (mine.has(list[i])) list.splice(i, 1)
    this.modifiers = []
    this.world.set({})
  }

  private clearMeshes() {
    for (const b of [this.walls, this.roofs]) if (b) { b.mesh.removeFromParent(); b.mesh.dispose() }
    if (this.details) { this.details.removeFromParent(); this.details.dispose() }
    this.details = null
    this.detailIds = []
    if (this.roads) { this.roads.removeFromParent(); this.roads.geometry.dispose() }
    if (this.fields) { this.fields.removeFromParent(); this.fields.geometry.dispose() }
    this.fields = null
    for (const m of this.materials) m.dispose()
    this.weather?.dispose()
    this.walls = this.roofs = null
    this.roads = null
    this.materials = []
    this.weather = null
  }

  private buildMeshes(plan: CityPlan) {
    this.clearMeshes()
    const o = this.options
    const f = o.facade
    const origin = plan.center
    const color = new Color()
    const rgb = (hex: string, k: number): [number, number, number] => {
      color.set(hex)
      return [color.r * k, color.g * k, color.b * k]
    }
    const pickHex = (list: string[], r: number) => list[Math.floor(r * list.length) % list.length] ?? '#cccccc'
    const meshes = plan.buildings.map((b) => {
      const k = 1 + (hash01(b.id, 7, 3, 1) - 0.5) * 2 * f.variation
      const flat = b.parts[0].roof === 'flat'
      const roofList = b.parts[0].roof === 'sawtooth' ? f.roofs.metal : flat ? f.roofs.concrete : f.roofs[b.roofMaterial]
      return buildingGeometry(b, origin, {
        wall: rgb(b.tint ?? pickHex(f.walls[b.material], b.seed), k),
        roof: rgb(pickHex(roofList, hash01(b.id, 9, 1, 2)), 1 + (k - 1) * 0.5),
        overhang: o.architectures[plan.architecture].overhang,
        parapet: b.style === 'house' ? 0 : 0.9,
      })
    })
    this.weather = new BuildingWeather(plan.buildings.length)
    const facade = createFacadeMaterial(this.uniforms, this.weather)
    const roof = createRoofMaterial(this.uniforms, this.weather)
    const road = createRoadMaterial(this.uniforms)
    // Per-detail shade (0.85…1.1) from the batch instance id, folded in before weather: a BatchedMesh
    // instance colour (setColorAt) would be multiplied in after colorNode and tint the snow.
    const detail = createRoofMaterial(this.uniforms, null, hash(batchIndirectIndex).mul(0.25).add(0.85))
    this.materials = [facade, roof, road, detail]
    this.walls = batch(meshes.map((m) => [m.walls, m.simpleWalls]), facade)
    this.roofs = batch(meshes.map((m) => [m.roofs, m.simpleRoofs]), roof)
    for (const b of [this.walls, this.roofs]) if (b) { b.mesh.castShadow = b.mesh.receiveShadow = true; this.object.add(b.mesh) }

    // Repeated details (balconies, plant, tanks, chimneys, AC units, stilts): one instanced batch
    // sharing a unit geometry per shape, scaled and turned per instance.
    const perBuilding = plan.buildings.map((b) => detailInstances(b, origin))
    const total = perBuilding.reduce((n, l) => n + l.length, 0)
    if (total) {
      const units = DETAIL_SHAPES.map((s) => toGeometry(detailGeometry(s)))
      const verts = units.reduce((n, g) => n + g.attributes.position.count, 0), idx = units.reduce((n, g) => n + g.index!.count, 0)
      const mesh = new BatchedMesh(total, verts, idx, detail)
      const ids = units.map((g) => mesh.addGeometry(g))
      units.forEach((g) => g.dispose())
      this.detailIds = perBuilding.map((list) => list.map((d) => {
        const inst = mesh.addInstance(ids[d.shape])
        _q.setFromAxisAngle(_y, -d.angle)
        mesh.setMatrixAt(inst, _m.compose(_p.set(d.x, d.y, d.z), _q, _s.set(d.width, d.height, d.depth)))
        return inst
      }))
      mesh.computeBoundingSphere()
      mesh.castShadow = mesh.receiveShadow = true
      mesh.name = 'Details'
      this.details = mesh
      this.object.add(mesh)
    }

    const site = plan.site
    const roadData = roadGeometry(plan.graph, plan.profiles, origin, (x, z) => site.height(x, z), {
      kerbHeight: o.roadLook.kerbHeight, offset: o.terrain.roadOffset, deckThickness: 1.2, pierSpacing: 24,
    })
    if (roadData.count) {
      this.roads = new Mesh(toGeometry(roadData), road)
      this.roads.receiveShadow = true
      this.roads.name = 'Roads'
      this.object.add(this.roads)
    }

    // A farm's fields and yard, hugging the ground: the yard follows the flattened pads, fields lie clear of them.
    const farm = plan.farm
    if (farm) {
      const ground = (x: number, z: number) => (pointInPolygon(x, z, farm.apron) ? this.frame.height(x, z) : site.height(x, z))
      const fm = o.farm
      const data = fieldGeometry(farm, origin, ground, { rowContrast: fm.rowContrast, tramlines: fm.tramlines, yardColor: fm.yardColor, offset: fm.fieldOffset, step: fm.fieldStep })
      if (data.count) {
        const material = createFieldMaterial(this.uniforms, fm)
        this.materials.push(material)
        this.fields = new Mesh(toGeometry(data), material)
        this.fields.receiveShadow = true
        this.fields.name = 'Fields'
        this.object.add(this.fields)
      }
    }
    this.lodState = new Uint8Array(plan.buildings.length)
    this.lastCam.set(Infinity, 0, 0)
  }

  private updateLod() {
    const plan = this.plan
    if (!plan || !this.camera) { this.stats.detailed = plan?.buildings.length ?? 0; return }
    this.camera.getWorldPosition(_cam)
    this.object.worldToLocal(_cam)
    const lod = this.options.lod
    if (_cam.distanceTo(this.lastCam) < lod.simple * 0.02) return
    this.lastCam.copy(_cam)
    const [ox, oz] = plan.center
    let detailed = 0
    for (const b of plan.buildings) {
      const d = Math.hypot(b.center[0] - ox - _cam.x, b.base + b.height * 0.5 - _cam.y, b.center[1] - oz - _cam.z)
      const state = d > lod.hide ? 2 : d > lod.simple ? 1 : 0
      if (state === 0) detailed++
      if (state === this.lodState[b.id]) continue
      this.lodState[b.id] = state
      for (const batch of [this.walls, this.roofs]) {
        if (!batch) continue
        const inst = batch.instance[b.id]
        if (inst < 0) continue
        batch.mesh.setVisibleAt(inst, state < 2)
        if (state < 2) batch.mesh.setGeometryIdAt(inst, state === 0 ? batch.full[b.id] : batch.simple[b.id])
      }
      if (this.details) for (const inst of this.detailIds[b.id]) this.details.setVisibleAt(inst, state === 0)
    }
    this.stats.detailed = detailed
    if (this.roads) this.roads.visible = Math.hypot(_cam.x, _cam.y, _cam.z) - plan.radius < lod.roads
  }
}

function cellKey(i: number, j: number) {
  return ((i + 32768) & 0xffff) | (((j + 32768) & 0xffff) << 16)
}

/** Plain mesh data → BufferGeometry. */
function toGeometry(d: MeshData): BufferGeometry {
  const g = new BufferGeometry()
  for (const [k, a] of Object.entries(d.attributes)) g.setAttribute(k, new Float32BufferAttribute(a, d.itemSizes[k]))
  g.setIndex(d.index instanceof Uint16Array ? new Uint16BufferAttribute(d.index, 1) : new Uint32BufferAttribute(d.index, 1))
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}

/** One BatchedMesh holding a full and a simple geometry per building (instances switch between them). */
function batch(pairs: [MeshData, MeshData][], material: Material): Batch | null {
  let verts = 0, idx = 0, n = 0
  for (const [a, b] of pairs) {
    if (!a.count || !b.count) continue
    verts += a.count + b.count
    idx += a.index.length + b.index.length
    n++
  }
  if (!n) return null
  const mesh = new BatchedMesh(n, verts, idx, material)
  const full: number[] = [], simple: number[] = [], instance: number[] = []
  for (const [a, b] of pairs) {
    if (!a.count || !b.count) { full.push(-1); simple.push(-1); instance.push(-1); continue }
    const ga = toGeometry(a), gb = toGeometry(b)
    const fa = mesh.addGeometry(ga), fb = mesh.addGeometry(gb)
    ga.dispose(); gb.dispose()
    full.push(fa); simple.push(fb); instance.push(mesh.addInstance(fa))
  }
  mesh.computeBoundingSphere()
  return { mesh, full, simple, instance }
}
