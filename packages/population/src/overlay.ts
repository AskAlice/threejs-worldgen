import { BufferAttribute, BufferGeometry, Color, DoubleSide, Group, LineBasicNodeMaterial, LineSegments, Mesh, MeshBasicNodeMaterial, Sphere, SRGBColorSpace, Vector3, type Camera } from 'three/webgpu'
import type { Vec3 } from 'threejs-biomes'
import { aggregatePopulation } from './model.ts'
import { cellColor, DEFAULT_STYLE, densityT, type PopulationMode, type PopulationStyle } from './map.ts'
import type { Population } from './population.ts'

/** Every overlay setting (plain data). Change at runtime with {@link PopulationOverlay.set}. */
export interface OverlayOptions {
  /** What cells are coloured (and extruded) by. */
  mode: PopulationMode
  /** H3 resolution to draw, or `'auto'` to step coarser as the camera pulls away. */
  resolution: number | 'auto'
  /** `'auto'`: at most this many resolutions coarser than the data. */
  coarsest: number
  /** `'auto'`: stay at the finest resolution until the camera is this many fine-cell edges away. */
  autoDistance: number
  /** Prism height at the top of the ramp, metres (0 = flat, ground-draped tiles). */
  extrude: number
  /** Lift above the ground, metres. */
  offset: number
  /** 0…1 opacity. */
  opacity: number
  /** 0…0.5: shrink each hexagon towards its centre, leaving a gap between cells. */
  gap: number
  /** Draw roads, rails and power lines. */
  networks: boolean
  /** Lift of network lines above the ground, metres. */
  networkOffset: number
  /** Floating origin: the world position at render-space zero (as in `WorldTerrain`). */
  origin: Vec3
  /** Show the overlay. */
  visible: boolean
  /** Colours. */
  style: PopulationStyle
}

/** Partial overlay settings (`style` merges one level deep). */
export type OverlayInput = Partial<Omit<OverlayOptions, 'style'>> & {
  /** Colours (merged into the current ones). */
  style?: Partial<PopulationStyle>
}

/** Default overlay: density, auto resolution, 60 % opaque, extruded up to 400 m, with networks. */
export const DEFAULT_OVERLAY: OverlayOptions = {
  mode: 'density', resolution: 'auto', coarsest: 3, autoDistance: 40, extrude: 400, offset: 4, opacity: 0.6, gap: 0.06,
  networks: true, networkOffset: 3, origin: [0, 0, 0], visible: true, style: structuredClone(DEFAULT_STYLE),
}

/** Options for the {@link PopulationOverlay} constructor. */
export interface OverlayCreateOptions extends OverlayInput {
  /** The population to draw. */
  population: Population
  /** Camera for `resolution: 'auto'`. */
  camera?: Camera
}

/**
 * A hex choropleth over the terrain: one prism (or flat tile) per H3 cell, coloured by density, land use,
 * night lights or habitability, plus the road / rail / power network as lines. With `resolution: 'auto'`
 * it switches to coarser, parent cells (exact sums of their children) as the camera pulls away.
 *
 * @example
 * ```ts
 * const overlay = new PopulationOverlay({ population, camera, mode: 'density', extrude: 600 })
 * scene.add(overlay.object)
 * renderer.setAnimationLoop(() => { overlay.update(); renderer.render(scene, camera) })
 * ```
 */
export class PopulationOverlay {
  /** Add this to your scene. */
  readonly object = new Group()
  /** Resolved settings. */
  options: OverlayOptions
  /** The population drawn. */
  readonly population: Population
  /** Camera for `'auto'` resolution. */
  camera?: Camera
  /** H3 resolution currently drawn. */
  resolution = -1

  private readonly material = new MeshBasicNodeMaterial({ vertexColors: true, side: DoubleSide, transparent: true })
  private readonly lineMaterial = new LineBasicNodeMaterial({ vertexColors: true, transparent: true })
  private readonly meshes = new Map<number, Mesh>()
  private lines: LineSegments | null = null
  private readonly unsubscribe: () => void

  /** Creates the overlay; it rebuilds itself when the population changes. */
  constructor({ population, camera, ...input }: OverlayCreateOptions) {
    this.population = population
    this.camera = camera
    this.options = mergeOverlay(structuredClone(DEFAULT_OVERLAY), input)
    this.unsubscribe = population.onChange(() => this.rebuild())
    this.rebuild()
  }

  /** Merges `input` into the current settings. */
  set(input: OverlayInput): this {
    this.options = mergeOverlay(this.options, input)
    this.rebuild()
    return this
  }

  /** Replaces all settings: anything not in `input` goes back to {@link DEFAULT_OVERLAY}. */
  reset(input: OverlayInput = {}): this {
    const next = mergeOverlay(structuredClone(DEFAULT_OVERLAY), input)
    if (JSON.stringify(next) === JSON.stringify(this.options)) return this
    this.options = next
    this.rebuild()
    return this
  }

  /** Call once per frame: picks the resolution for the camera distance and keeps the origin current. */
  update(): void {
    const o = this.options
    this.object.visible = o.visible
    const res = o.resolution === 'auto' ? this.autoResolution() : Math.max(0, Math.min(15, Math.round(o.resolution)))
    if (res !== this.resolution) {
      this.resolution = res
      let mesh = this.meshes.get(res)
      if (!mesh) this.meshes.set(res, (mesh = this.buildCells(res)))
      for (const [r, m] of this.meshes) m.visible = r === res
      if (!mesh.parent) this.object.add(mesh)
    }
    const a = this.anchor()
    for (const child of this.object.children) child.position.set(a[0] - o.origin[0], a[1] - o.origin[1], a[2] - o.origin[2])
  }

  /** Frees GPU resources and stops following the population. */
  dispose(): void {
    this.unsubscribe()
    this.clear()
    this.material.dispose()
    this.lineMaterial.dispose()
    this.object.removeFromParent()
  }

  private clear() {
    for (const m of this.meshes.values()) { m.geometry.dispose(); m.removeFromParent() }
    this.meshes.clear()
    if (this.lines) { this.lines.geometry.dispose(); this.lines.removeFromParent(); this.lines = null }
    this.resolution = -1
  }

  private rebuild() {
    this.clear()
    const o = this.options
    this.material.opacity = o.opacity
    this.material.depthWrite = o.opacity >= 1
    this.lineMaterial.opacity = Math.min(1, o.opacity + 0.3)
    if (o.networks) this.object.add((this.lines = this.buildLines()))
    this.update()
  }

  private autoResolution(): number {
    const { data } = this.population
    const o = this.options
    if (!this.camera) return data.resolution
    const f = data.grid.frame
    const p = this.camera.position
    const qx = p.x + o.origin[0] - f.origin[0], qy = p.y + o.origin[1] - f.origin[1], qz = p.z + o.origin[2] - f.origin[2]
    const x = qx * f.east[0] + qy * f.east[1] + qz * f.east[2]
    const y = qx * f.up[0] + qy * f.up[1] + qz * f.up[2]
    const z = -(qx * f.north[0] + qy * f.north[1] + qz * f.north[2])
    const [cx, cz] = data.options.center
    const d = Math.hypot(Math.max(0, Math.hypot(x - cx, z - cz) - data.options.radius), Math.max(1, y))
    const step = Math.floor(Math.log(Math.max(1, d / (o.autoDistance * data.cellEdge))) / Math.log(Math.sqrt(7)))
    return Math.max(0, data.resolution - Math.max(0, Math.min(o.coarsest, step)))
  }

  // World position of the region centre on the ground: geometry is stored relative to it (float32 precision).
  private anchor(): Vec3 {
    const { data } = this.population
    return data.grid.frame.toWorld(data.options.center[0], 0, data.options.center[1])
  }

  private buildCells(res: number): Mesh {
    const { data } = this.population
    const o = this.options
    const f = data.grid.frame
    const a = this.anchor()
    // H3 cells differ in shape (projection, rotation, pentagons), so all cells share one merged, non-indexed
    // geometry rather than instances of one hexagon. Pass 1 gathers rings and heights, pass 2 fills typed arrays.
    const prisms: { cx: number; cz: number; ring: [number, number][]; base: number; top: number; rgb: [number, number, number] }[] = []
    let count = 0
    for (const cell of aggregatePopulation(data, res).values()) {
      if (cell.landUse === 'water' && o.mode !== 'landUse') continue
      if (cell.population <= 0 && (o.mode === 'density' || o.mode === 'lights')) continue
      const [cx, cz] = data.grid.centerLocal(cell.cell)
      const ring = data.grid.boundaryLocal(cell.cell).map(([x, z]): [number, number] => [x + (cx - x) * o.gap, z + (cz - z) * o.gap])
      let ground = f.height(cx, cz)
      for (const [x, z] of ring) ground = Math.max(ground, f.height(x, z))
      const base = ground + o.offset
      const t = o.mode === 'density' ? densityT(cell.density, o.style) : o.mode === 'lights' ? cell.light : 0
      const top = base + o.extrude * t
      prisms.push({ cx, cz, ring, base, top, rgb: cellColor(cell, o.mode, o.style) })
      count += ring.length * (top > base + 1e-3 ? 9 : 3)
    }
    const pos = new Float32Array(count * 3), col = new Float32Array(count * 3)
    const w: Vec3 = [0, 0, 0]
    const c = new Color()
    let v = 0, r2 = 0
    const push = (x: number, y: number, z: number, k: number) => {
      f.toWorld(x, y, z, w)
      const px = w[0] - a[0], py = w[1] - a[1], pz = w[2] - a[2]
      pos[v * 3] = px; pos[v * 3 + 1] = py; pos[v * 3 + 2] = pz
      col[v * 3] = c.r * k; col[v * 3 + 1] = c.g * k; col[v * 3 + 2] = c.b * k
      r2 = Math.max(r2, px * px + py * py + pz * pz)
      v++
    }
    for (const p of prisms) {
      c.setRGB(p.rgb[0], p.rgb[1], p.rgb[2], SRGBColorSpace)
      const { ring, base, top } = p
      for (let i = 0; i < ring.length; i++) {
        const [x0, z0] = ring[i], [x1, z1] = ring[(i + 1) % ring.length]
        push(p.cx, top, p.cz, 1); push(x0, top, z0, 1); push(x1, top, z1, 1)
        if (top > base + 1e-3) {
          push(x0, base, z0, 0.7); push(x1, base, z1, 0.7); push(x1, top, z1, 0.7)
          push(x0, base, z0, 0.7); push(x1, top, z1, 0.7); push(x0, top, z0, 0.7)
        }
      }
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(pos, 3))
    geometry.setAttribute('color', new BufferAttribute(col, 3))
    geometry.boundingSphere = new Sphere(new Vector3(), Math.sqrt(r2))
    const mesh = new Mesh(geometry, this.material)
    mesh.renderOrder = 1
    return mesh
  }

  private buildLines(): LineSegments {
    const { data, network } = this.population
    const o = this.options
    const f = data.grid.frame
    const a = this.anchor()
    // Power lines are straight spans: resample them so they follow the ground between pylons.
    const spans = network.edges.map((e) => e.type === 'powerline' ? resample(e.points, data.cellEdge) : e.points)
    let segments = 0
    for (const pts of spans) segments += Math.max(0, pts.length - 1)
    const pos = new Float32Array(segments * 6), col = new Float32Array(segments * 6)
    const c = new Color()
    const w: Vec3 = [0, 0, 0]
    let v = 0, r2 = 0
    const at = (x: number, z: number) => {
      f.toWorld(x, f.height(x, z) + o.networkOffset, z, w)
      const px = w[0] - a[0], py = w[1] - a[1], pz = w[2] - a[2]
      pos[v * 3] = px; pos[v * 3 + 1] = py; pos[v * 3 + 2] = pz
      col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b
      r2 = Math.max(r2, px * px + py * py + pz * pz)
      v++
    }
    network.edges.forEach((e, k) => {
      c.set(o.style.networks[e.type]).convertSRGBToLinear()
      const pts = spans[k]
      for (let i = 1; i < pts.length; i++) { at(pts[i - 1][0], pts[i - 1][1]); at(pts[i][0], pts[i][1]) }
    })
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(pos, 3))
    geometry.setAttribute('color', new BufferAttribute(col, 3))
    geometry.boundingSphere = new Sphere(new Vector3(), Math.sqrt(r2))
    const lines = new LineSegments(geometry, this.lineMaterial)
    lines.renderOrder = 2
    return lines
  }
}

function resample(points: [number, number][], step: number): [number, number][] {
  const out: [number, number][] = [points[0]]
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1], [bx, bz] = points[i]
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step))
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n])
  }
  return out
}

function mergeOverlay(base: OverlayOptions, input: OverlayInput): OverlayOptions {
  const out: OverlayOptions = { ...base, style: { ...base.style } }
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue
    if (k === 'style') Object.assign(out.style, structuredClone(v))
    else (out as unknown as Record<string, unknown>)[k] = Array.isArray(v) ? [...v] : v
  }
  return out
}
