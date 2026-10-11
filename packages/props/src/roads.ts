import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardNodeMaterial, type Node, type Object3D } from 'three/webgpu'
import {
  abs, attribute, exp, float, floor, fract, fwidth, hash, max, mix, mx_noise_float, mx_worley_noise_vec2, normalView, positionWorld, smoothstep,
  step, uniform, uv, vec3,
} from 'three/tsl'
import { applyMaterialStates, type MaterialStateNodes, type MaterialStates, type StateLook } from 'threejs-weathering'
import type { MeshData } from './geometry.ts'
import { eq, type N } from './materials.ts'

/** Carriageway surfaces, in the same order as threejs-city's `ROAD_SURFACES` (the shader indexes by it). */
export type RoadSurfaceKind = 'asphalt' | 'cobblestone' | 'gravel' | 'dirt'

/** Every surface kind, best first. */
export const ROAD_SURFACE_KINDS: readonly RoadSurfaceKind[] = ['asphalt', 'cobblestone', 'gravel', 'dirt']

/** Part codes of road geometry (the same codes as threejs-city's `ROAD_PARTS`). */
export const ROAD_PART = { carriageway: 0, sidewalk: 1, curb: 2, concrete: 3, junction: 4 } as const

/** Centre line styles. */
export type CentreLine = 'none' | 'dashed' | 'solid' | 'double'

/** Colours of a {@link RoadSurface} (`#rrggbb`). */
export interface RoadColors {
  /** Asphalt. */ asphalt: string
  /** Fresh asphalt patches. */ patch: string
  /** Cobblestone setts. */ cobblestone: string
  /** Gravel. */ gravel: string
  /** Dirt. */ dirt: string
  /** Grass on the crown of worn dirt tracks. */ grass: string
  /** Sidewalk slabs. */ sidewalk: string
  /** Curb stones and verges. */ curb: string
  /** Bridge concrete. */ concrete: string
  /** Lane and edge lines. */ marking: string
  /** Centre line (yellow in the Americas, white in Europe). */ centreLine: string
}

/** Look of a {@link RoadSurface}. Plain JSON; every value is live. */
export interface RoadSurfaceOptions {
  /** Carriageway surface. */
  surface: RoadSurfaceKind
  /** Carriageway width (kerb to kerb), metres; markings are laid out on it. */
  width: number
  /** Lanes per direction. */
  lanes: number
  /** Centre line. */
  centreLine: CentreLine
  /** Dashed lines between lanes (when `lanes` > 1). */
  laneLines: boolean
  /** Solid lines along both edges. */
  edgeLines: boolean
  /** Use: polished tyre tracks, faded paint, deeper ruts, grass on dirt crowns (0…1). */
  wear: number
  /** Asphalt cracks (0…1); damage adds more. */
  cracks: number
  /** Asphalt patches (0…1). */
  patches: number
  /** Dirt and gravel ruts (0…1); they fill with water when wet. */
  ruts: number
  /** Potholes on dirt and gravel (0…1); they fill with water when wet. */
  potholes: number
  /** Sidewalk slab size, metres. */
  slabSize: number
  /** Colours. */
  colors: RoadColors
  /** Weather floor (each pixel shows the larger of this and the context's state nodes). */
  states: MaterialStates
}

/** Default road look: worn two-lane asphalt with a dashed centre line. */
export const DEFAULT_ROAD_SURFACE: RoadSurfaceOptions = {
  surface: 'asphalt', width: 7, lanes: 1, centreLine: 'dashed', laneLines: true, edgeLines: true,
  wear: 0.4, cracks: 0.35, patches: 0.3, ruts: 0.5, potholes: 0.3, slabSize: 1,
  colors: {
    asphalt: '#3b3d40', patch: '#26282a', cobblestone: '#6d6a66', gravel: '#8a8378', dirt: '#7a6248', grass: '#55703a',
    sidewalk: '#a9a6a0', curb: '#8f8c86', concrete: '#9d9a94', marking: '#e8e6df', centreLine: '#e0b020',
  },
  states: { wetness: 0, snow: 0, burn: 0, damage: 0 },
}

/** Partial road look (colours and states merge). */
export type RoadSurfaceInput = Partial<Omit<RoadSurfaceOptions, 'colors' | 'states'>> & { colors?: Partial<RoadColors>; states?: Partial<MaterialStates> }

/** Live inputs of a {@link RoadSurface} (not JSON); all optional, for adopting it on other geometry. */
export interface RoadSurfaceContext {
  /** Per-pixel weather, e.g. a threejs-weathering `StateField.node()`. Combined with `options.states` by max. */
  states?: MaterialStateNodes
  /** Part code node ({@link ROAD_PART}). Default: the `roadPart` vertex attribute. threejs-city: `attribute('road', 'vec4').w`. */
  part?: Node
  /** Half carriageway width node. Default: `width / 2`. threejs-city: `attribute('road', 'vec4').x`. */
  halfWidth?: Node
  /** Surface index node ({@link ROAD_SURFACE_KINDS}). Default: `options.surface`. threejs-city: `attribute('road', 'vec4').z`. */
  surfaceIndex?: Node
  /** (metres across from the centreline, metres along). Default: `uv()`. */
  coords?: Node
  /** Weathering look. */
  look?: StateLook
  /** Seconds for animated weather. */
  time?: Node
}

/** Antialiased stripe mask: 1 inside `|x| < half`. */
function band(x: N, half: N): N {
  const aa = fwidth(x).add(1e-4)
  return float(1).sub(smoothstep(half.sub(aa), half.add(aa), abs(x)))
}

/** Running-bond pattern: joint mask, per-cell hash, distance fade. */
function bond(u: N, v: N, w: N, h: N, joint: N): { joint: N; cell: N } {
  const row = floor(v.div(h))
  const x = u.div(w).add(row.mod(2).mul(0.5))
  const col = floor(x)
  const fu = fract(x).sub(0.5).mul(w), fv = fract(v.div(h)).sub(0.5).mul(h)
  const j = max(float(1).sub(band(fu, w.mul(0.5).sub(joint))), float(1).sub(band(fv, h.mul(0.5).sub(joint))))
  const fade = float(1).sub(smoothstep(0.15, 0.5, fwidth(v).div(h)))
  return { joint: j.mul(fade), cell: hash(col.add(16384).add(row.add(16384).mul(911))) }
}

function merge<T>(target: T, input: unknown): T {
  if (!input || typeof input !== 'object') return target
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === undefined) continue
    const cur = (target as Record<string, unknown>)[k]
    ;(target as Record<string, unknown>)[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' ? merge({ ...(cur as object) }, v) : v
  }
  return target
}

/**
 * Procedural road surface material (TSL): asphalt with lane markings, worn tyre tracks, cracks and
 * patches; cobblestones; gravel; rutted dirt with potholes and a grassy crown; paved sidewalks with
 * joints, curbs and bridge concrete. Weathered through threejs-weathering: wet asphalt darkens and turns
 * mirror-like with puddles on the flat, ruts and potholes fill with water, snow clears first from the
 * tyre tracks, damage opens alligator cracks, burn chars.
 *
 * Geometry convention (the same as threejs-city's road mesh): `uv` = (metres across from the
 * centreline, metres along), a `roadPart` float attribute with {@link ROAD_PART} codes. Other geometry
 * can map its own attributes through {@link RoadSurfaceContext}.
 */
export class RoadSurface {
  /** The material. */
  readonly material: MeshStandardNodeMaterial
  /** Resolved look. */
  options: RoadSurfaceOptions
  /** Uniforms behind the look. */
  readonly uniforms = {
    surface: uniform(0), width: uniform(7), lanes: uniform(1), centre: uniform(1), laneLines: uniform(1), edgeLines: uniform(1),
    wear: uniform(0.4), cracks: uniform(0.35), patches: uniform(0.3), ruts: uniform(0.5), potholes: uniform(0.3), slabSize: uniform(1),
    wetness: uniform(0), snow: uniform(0), burn: uniform(0), damage: uniform(0),
    asphalt: uniform(new Color()), patch: uniform(new Color()), cobblestone: uniform(new Color()), gravel: uniform(new Color()), dirt: uniform(new Color()),
    grass: uniform(new Color()), sidewalk: uniform(new Color()), curb: uniform(new Color()), concrete: uniform(new Color()),
    marking: uniform(new Color()), centreLine: uniform(new Color()),
  }

  /** Creates a road surface; anything not given uses {@link DEFAULT_ROAD_SURFACE}. */
  constructor(input: RoadSurfaceInput = {}, ctx: RoadSurfaceContext = {}) {
    this.options = merge(structuredClone(DEFAULT_ROAD_SURFACE), input)
    this.material = this.build(ctx)
    this.set({})
  }

  /** Merges `input` into the look. */
  set(input: RoadSurfaceInput): this {
    this.options = merge(this.options, input)
    const o = this.options, u = this.uniforms
    u.surface.value = Math.max(0, ROAD_SURFACE_KINDS.indexOf(o.surface))
    u.width.value = o.width
    u.lanes.value = Math.max(1, Math.round(o.lanes))
    u.centre.value = ['none', 'dashed', 'solid', 'double'].indexOf(o.centreLine)
    u.laneLines.value = o.laneLines ? 1 : 0
    u.edgeLines.value = o.edgeLines ? 1 : 0
    for (const k of ['wear', 'cracks', 'patches', 'ruts', 'potholes', 'slabSize'] as const) u[k].value = o[k]
    for (const k of ['wetness', 'snow', 'burn', 'damage'] as const) u[k].value = o.states[k]
    for (const [k, v] of Object.entries(o.colors)) (u[k as keyof RoadColors].value as Color).set(v)
    return this
  }

  /** Replaces the look (anything not given goes back to the defaults). */
  reset(input: RoadSurfaceInput = {}): this {
    this.options = structuredClone(DEFAULT_ROAD_SURFACE)
    return this.set(input)
  }

  /** Frees the material. */
  dispose(): void {
    this.material.dispose()
  }

  private build(ctx: RoadSurfaceContext): MeshStandardNodeMaterial {
    const u = this.uniforms as Record<string, N>
    const coords = (ctx.coords ?? uv()) as N
    const p = positionWorld as N
    const lat = coords.x, along = coords.y, alat = abs(lat)
    const hw = (ctx.halfWidth as N) ?? u.width.mul(0.5)
    const part = (ctx.part as N) ?? attribute('roadPart', 'float')
    const surf = (ctx.surfaceIndex as N) ?? u.surface
    const wear = u.wear
    const ext = ctx.states ?? {}
    const st = (k: 'wetness' | 'snow' | 'burn' | 'damage') => (ext[k] === undefined ? u[k] : max(u[k], ext[k] as N))
    const wet = st('wetness'), snow = st('snow'), burn = st('burn'), damage = st('damage')
    const fine = (mx_noise_float(p.mul(4)) as N).mul(0.05)
    const coarse = (mx_noise_float(p.mul(0.12)) as N).mul(0.07)
    const onRoad = eq(part, 0).add(eq(part, 4))

    // Tyre tracks, two per lane.
    const laneW = hw.div(u.lanes)
    const inLane = fract(alat.div(laneW)).sub(0.5).mul(laneW)
    const track = exp(abs(abs(inLane).sub(0.85)).div(0.32).pow(2).negate()).mul(step(alat, hw)).mul(wear)

    // Asphalt: grain, polished tracks, line cracks where a low-frequency mask allows, alligator cracks with damage, patches.
    const crackZone = smoothstep(float(1).sub(u.cracks), float(1.15).sub(u.cracks), (mx_noise_float(p.mul(0.09)) as N).mul(0.5).add(0.5))
    const lines = float(1).sub(smoothstep(0, 0.03, abs(mx_noise_float(p.mul(0.6)) as N))).mul(crackZone)
    const cells = mx_worley_noise_vec2(p.mul(2.2)) as N
    const alligator = smoothstep(0.06, 0, cells.y.sub(cells.x)).mul(smoothstep(0.2, 0.8, damage.add((mx_noise_float(p.mul(0.3)) as N).mul(0.3))))
    const crack = max(lines.mul(u.cracks.add(damage.mul(0.6)).min(1)), alligator)
    const patch = smoothstep(0.55, 0.6, (mx_noise_float(floor(p.mul(0.25)).add(0.5)) as N).add(float(0.5).sub(u.patches.mul(0.6)))).mul(step(0.01, u.patches))
    let asphalt: N = mix(u.asphalt.mul(float(1).add(fine).add(coarse).add(track.mul(0.1))), u.patch.mul(float(1).add(fine)), patch)
    asphalt = asphalt.mul(float(1).sub(crack.mul(0.65)))
    // Markings.
    const dashes = (period: number, duty: number) => step(fract(along.div(period)), duty)
    const centre = band(lat, float(0.06)).mul(eq(u.centre, 1).mul(dashes(9, 0.5)).add(eq(u.centre, 2)))
      .add(band(alat.sub(0.16), float(0.06)).mul(eq(u.centre, 3)))
    const laneDist = abs(fract(alat.div(laneW)).sub(0.5)).mul(laneW)
    const laneLine = band(laneW.mul(0.5).sub(laneDist), float(0.06)).mul(step(laneW.mul(0.5), alat)).mul(step(alat, hw.sub(laneW.mul(0.5))))
      .mul(dashes(12, 0.35)).mul(step(1.5, u.lanes)).mul(u.laneLines)
    const edge = band(alat.sub(hw.sub(0.3)), float(0.07)).mul(u.edgeLines)
    const worn = float(1).sub(wear.mul(0.55).mul((mx_noise_float(p.mul(1.3)) as N).mul(0.5).add(0.5))).mul(float(1).sub(crack.mul(0.8)))
    const paint = eq(part, 0).mul(eq(surf, 0)).mul(worn)
    const white = max(laneLine, edge).mul(paint), yellow = centre.mul(paint)
    asphalt = mix(mix(asphalt, u.marking, white), u.centreLine, yellow)
    const asphaltRough = mix(mix(float(0.92), float(0.72), track), float(0.6), max(white, yellow))

    // Cobblestones: domed setts in offset rows.
    const sett = bond(lat, along, float(0.14), float(0.12), float(0.012))
    const cobble = u.cobblestone.mul(float(1).add(sett.cell.sub(0.5).mul(0.35)).sub(sett.joint.mul(0.45)).add(fine))

    // Gravel: speckles; dirt: two wheel ruts, a grassy crown, potholes.
    const speck = hash(floor(p.x.mul(30)).add(1e5).add(floor(p.z.mul(30)).add(1e5).mul(1013))).sub(0.5).mul(0.3).mul(float(1).sub(smoothstep(0.01, 0.06, fwidth(p.x))))
    const gravel = u.gravel.mul(float(1).add(speck).add(coarse.mul(1.5)).sub(track.mul(0.08)))
    const rut = exp(abs(alat.sub(0.9)).div(0.28).pow(2).negate()).mul(u.ruts).mul(step(alat, hw))
    const crown = float(1).sub(smoothstep(0.25, 0.55, alat)).mul(smoothstep(0.3, 0.7, wear))
    const pothole = smoothstep(0.66, 0.72, (mx_noise_float(p.mul(0.35)) as N).mul(0.5).add(0.5).add(u.potholes.mul(0.25)).sub(0.12)).mul(step(0.01, u.potholes)).mul(step(alat, hw))
    const dirt = mix(u.dirt.mul(float(1).add(coarse.mul(2)).add(fine.mul(2)).sub(rut.mul(0.25)).sub(pothole.mul(0.2))), u.grass.mul(float(1).add(fine.mul(3))), crown.mul(0.7))

    let color: N = asphalt.mul(eq(surf, 0)).add(cobble.mul(eq(surf, 1))).add(gravel.mul(eq(surf, 2))).add(dirt.mul(eq(surf, 3)))
    let rough: N = asphaltRough.mul(eq(surf, 0)).add(eq(surf, 1).mul(0.8)).add(eq(surf, 2).mul(0.95)).add(eq(surf, 3).mul(0.97))

    // Sidewalk slabs, curbs, concrete.
    const slab = bond(along, alat, u.slabSize, u.slabSize, float(0.015))
    const sidewalk = u.sidewalk.mul(float(1).add(slab.cell.sub(0.5).mul(0.1)).sub(slab.joint.mul(0.3)).add(fine))
    color = mix(color, sidewalk, eq(part, 1))
    color = mix(color, u.curb.mul(float(1).add(fine)), eq(part, 2))
    color = mix(color, u.concrete.mul(float(1).add(fine).add(coarse)), eq(part, 3))
    rough = mix(rough, float(0.85), max(eq(part, 1), max(eq(part, 2), eq(part, 3))))

    // Weather: snow clears from tyre tracks; ruts and potholes collect water before the flat does.
    const out = applyMaterialStates(
      { color, roughness: rough },
      { wetness: wet, snow: snow.mul(float(1).sub(track.mul(onRoad).mul(1.4)).max(0)), burn, damage },
      { look: ctx.look, time: ctx.time as N, streaks: false, position: p },
    )
    const hollows = rut.mul(eq(surf, 3)).add(pothole.mul(eq(surf, 2).add(eq(surf, 3)))).mul(onRoad)
    const puddle = smoothstep(0.25, 0.75, wet).mul(smoothstep(0.35, 0.6, hollows.add((mx_noise_float(p.mul(0.5)) as N).mul(0.15))))
    const m = new MeshStandardNodeMaterial()
    m.name = 'props/road-surface'
    m.colorNode = mix(out.color, (out.color as N).mul(0.45).add(vec3(0.01, 0.012, 0.015)), puddle)
    m.roughnessNode = mix(out.roughness, float(0.02), puddle)
    m.normalNode = mix(out.normal, normalView, puddle).normalize()
    m.metalnessNode = out.metalness
    m.emissiveNode = out.emissive
    return m
  }
}

/** Shape of a road ribbon. Plain JSON. */
export interface RibbonOptions {
  /** Carriageway width, metres. */
  width: number
  /** Sidewalk width per side, metres (0 = rural: a sloped verge instead of curbs). */
  sidewalk: number
  /** Curb height, metres. */
  curbHeight: number
  /** Surface height above the ground, metres. */
  offset: number
  /** Resampling step along the path, metres. */
  step: number
  /** Smoothing passes over the centreline height (removes bumps of the ground). */
  smoothing: number
  /** Width of the verge (rural) or sidewalk skirt sloping down to the ground, metres. */
  verge: number
}

/** Default ribbon: a 7 m rural road. */
export const DEFAULT_RIBBON: RibbonOptions = { width: 7, sidewalk: 0, curbHeight: 0.15, offset: 0.06, step: 2, smoothing: 3, verge: 0.8 }

/** Ribbon geometry as typed arrays, plus the `roadPart` code per vertex. */
export interface RibbonData extends MeshData {
  /** {@link ROAD_PART} code per vertex. */
  part: Float32Array
  /** Path length, metres. */
  length: number
}

/** A 2D point `[x, z]` or 3D point `[x, y, z]`. */
export type PathPoint = readonly [number, number] | readonly [number, number, number]

/**
 * Builds a road ribbon along a polyline: resampled every `step` metres, draped on `height` (or the
 * points' own y) with a smoothed centreline kept above the ground across its whole width, a carriageway,
 * and either curbs and raised sidewalks or sloped verges down to the ground. `uv` is (metres across from
 * the centreline, metres along), the convention of {@link RoadSurface} and threejs-city.
 */
export function roadRibbon(points: readonly PathPoint[], input: Partial<RibbonOptions> = {}, height?: (x: number, z: number) => number): RibbonData {
  const o = { ...DEFAULT_RIBBON, ...input }
  const P = points.map((q) => (q.length === 2 ? [q[0], NaN, q[1]] : [q[0], q[1], q[2]]))
  // Resample.
  const st: { x: number; y: number; z: number; s: number }[] = []
  let total = 0
  for (let i = 0; i < P.length - 1; i++) {
    const [ax, ay, az] = P[i], [bx, by, bz] = P[i + 1]
    const l = Math.hypot(bx - ax, bz - az)
    const n = Math.max(1, Math.ceil(l / o.step))
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const t = k / n
      st.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t, z: az + (bz - az) * t, s: total + l * t })
    }
    total += l
  }
  const empty: RibbonData = { position: new Float32Array(0), normal: new Float32Array(0), uv: new Float32Array(0), index: new Uint32Array(0), part: new Float32Array(0), length: 0 }
  if (st.length < 2) return empty
  const hw = o.width / 2, W = hw + o.sidewalk
  // Directions (left normal) and heights: max of the ground under the centre and both edges, then smoothed.
  const dirs = st.map((_, i) => {
    const a = st[Math.max(0, i - 1)], b = st[Math.min(st.length - 1, i + 1)]
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1
    return [dx / l, dz / l]
  })
  let ys = st.map((q, i) => {
    if (!height) return Number.isNaN(q.y) ? 0 : q.y
    const [ux, uz] = dirs[i]
    const lx = -uz, lz = ux
    return Math.max(height(q.x, q.z), height(q.x + lx * W, q.z + lz * W), height(q.x - lx * W, q.z - lz * W))
  })
  for (let pass = 0; pass < o.smoothing; pass++) {
    ys = ys.map((y, i) => (i === 0 || i === ys.length - 1 ? y : Math.max(y, (ys[i - 1] + 2 * y + ys[i + 1]) / 4)))
  }

  const pos: number[] = [], uvs: number[] = [], parts: number[] = [], idx: number[] = []
  const ground = (x: number, z: number, fallback: number) => (height ? height(x, z) : fallback)
  // A strip between two cross-section points (lateral, height above centre or 'ground'), for every station.
  const strip = (l0: number, d0: number | 'ground', l1: number, d1: number | 'ground', part: number, hint: 'up' | 'left' | 'right') => {
    const base = pos.length / 3
    for (let i = 0; i < st.length; i++) {
      const q = st[i], [ux, uz] = dirs[i], lx = -uz, lz = ux, y = ys[i] + o.offset
      for (const [l, d] of [[l0, d0], [l1, d1]] as const) {
        const x = q.x + lx * l, z = q.z + lz * l
        pos.push(x, d === 'ground' ? ground(x, z, y) - 0.15 : y + d, z)
        uvs.push(l, q.s)
        parts.push(part)
      }
    }
    for (let i = 0; i < st.length - 1; i++) {
      const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3
      // Winding: check the first triangle's normal against the hint and flip both if needed.
      const n = triNormal(pos, a, b, c)
      const [ux, uz] = dirs[i]
      const want = hint === 'up' ? [0, 1, 0] : hint === 'left' ? [-uz, 0, ux] : [uz, 0, -ux]
      if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] >= 0) idx.push(a, b, c, b, d, c)
      else idx.push(a, c, b, b, c, d)
    }
  }
  strip(-hw, 0, hw, 0, ROAD_PART.carriageway, 'up')
  if (o.sidewalk > 0) {
    const k = o.curbHeight
    for (const s of [-1, 1]) {
      const out = s > 0 ? 'left' : 'right', inward = s > 0 ? 'right' : 'left'
      strip(s * hw, 0, s * hw, k, ROAD_PART.curb, inward)
      strip(s * hw, k, s * W, k, ROAD_PART.sidewalk, 'up')
      strip(s * W, k, s * (W + o.verge * 0.25), 'ground', ROAD_PART.curb, out)
    }
  } else {
    for (const s of [-1, 1]) strip(s * hw, 0, s * (hw + o.verge), 'ground', ROAD_PART.carriageway, 'up')
  }
  const position = new Float32Array(pos), index = new Uint32Array(idx)
  return { position, normal: computeNormals(position, index), uv: new Float32Array(uvs), index, part: new Float32Array(parts), length: total }
}

function triNormal(p: number[], a: number, b: number, c: number): [number, number, number] {
  const e1 = [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]]
  const e2 = [p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]]
  return [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
}

/** Area-weighted vertex normals of an indexed mesh. */
export function computeNormals(position: Float32Array, index: Uint32Array): Float32Array {
  const n = new Float32Array(position.length)
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2]
    const e1x = position[b * 3] - position[a * 3], e1y = position[b * 3 + 1] - position[a * 3 + 1], e1z = position[b * 3 + 2] - position[a * 3 + 2]
    const e2x = position[c * 3] - position[a * 3], e2y = position[c * 3 + 1] - position[a * 3 + 1], e2z = position[c * 3 + 2] - position[a * 3 + 2]
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x
    for (const v of [a, b, c]) { n[v * 3] += nx; n[v * 3 + 1] += ny; n[v * 3 + 2] += nz }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l
  }
  return n
}

/** A three.js geometry from {@link roadRibbon} data (with the `roadPart` attribute). */
export function ribbonGeometry(d: RibbonData): BufferGeometry {
  const g = new BufferGeometry()
  g.setIndex(new BufferAttribute(d.index, 1))
  g.setAttribute('position', new BufferAttribute(d.position, 3))
  g.setAttribute('normal', new BufferAttribute(d.normal, 3))
  g.setAttribute('uv', new BufferAttribute(d.uv, 2))
  g.setAttribute('roadPart', new BufferAttribute(d.part, 1))
  g.computeBoundingSphere()
  return g
}

/** Settings of a {@link RoadPath}. Plain JSON. */
export interface RoadPathOptions extends RibbonOptions {
  /** The centreline (frame-local `[x, z]` or `[x, y, z]`). */
  points: [number, number][] | [number, number, number][]
  /** Surface look (its `width` follows the ribbon's). */
  surface: RoadSurfaceInput
  /** Receive shadows. */
  receiveShadow: boolean
}

/** Options of {@link RoadPath}: settings plus live inputs. */
export interface RoadPathCreateOptions extends Partial<RoadPathOptions>, RoadSurfaceContext {
  /** Ground height `(x, z) => y` to drape on, e.g. `world.height` or `frame.height`. */
  height?: (x: number, z: number) => number
  /** If given, the path is added to it. */
  scene?: Object3D
}

/**
 * A road, sidewalk or path ribbon following a polyline over the terrain, drawn with a {@link RoadSurface}.
 *
 * @example
 * ```ts
 * const lane = new RoadPath({ scene, height: world.height, points: [[0, 0], [80, 30], [200, 20]], width: 4, surface: { surface: 'dirt' } })
 * lane.surface.set({ states: { wetness: 0.9 } })   // puddles in the ruts
 * ```
 */
export class RoadPath {
  /** The mesh (frame-local coordinates). */
  readonly object: Mesh
  /** The material and its look. */
  readonly surface: RoadSurface
  /** Resolved settings. */
  options: RoadPathOptions
  /** Ground height used for draping. */
  height?: (x: number, z: number) => number

  /** Creates a path. */
  constructor({ height, scene, states, part, halfWidth, surfaceIndex, coords, look, time, ...input }: RoadPathCreateOptions = {}) {
    this.height = height
    this.options = { ...DEFAULT_RIBBON, points: [], surface: {}, receiveShadow: true, ...input }
    this.surface = new RoadSurface({ ...this.options.surface, width: this.options.width }, { states, part, halfWidth, surfaceIndex, coords, look, time })
    this.object = new Mesh(new BufferGeometry(), this.surface.material)
    this.object.name = 'RoadPath'
    this.rebuild()
    scene?.add(this.object)
  }

  /** Changes settings; shape changes rebuild the ribbon, surface changes are instant. */
  set(input: Partial<RoadPathOptions>): this {
    const { surface, ...shape } = input
    this.options = { ...this.options, ...shape, surface: merge({ ...this.options.surface }, surface ?? {}) }
    this.surface.set({ ...(surface ?? {}), width: this.options.width })
    if (Object.keys(shape).some((k) => k !== 'receiveShadow')) this.rebuild()
    this.object.receiveShadow = this.options.receiveShadow
    return this
  }

  /** Rebuilds the ribbon (e.g. after the ground changed). */
  rebuild(): void {
    this.object.geometry.dispose()
    this.object.geometry = ribbonGeometry(roadRibbon(this.options.points, this.options, this.height))
    this.object.receiveShadow = this.options.receiveShadow
  }

  /** Frees GPU resources and removes the path. */
  dispose(): void {
    this.object.geometry.dispose()
    this.surface.dispose()
    this.object.removeFromParent()
  }
}
