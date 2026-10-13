import { ShapeUtils, Vector2 } from 'three/webgpu'
import { ROOF_MATERIALS, WALL_MATERIALS } from './architecture.ts'
import { BUILDING_STYLES, type Building, type BuildingDetail, type BuildingPart } from './buildings.ts'
import { MeshBuilder, type MeshData } from './mesh-builder.ts'
import type { Vec2 } from './polygon.ts'

/** Vertex attributes of building geometry (walls and roofs share them so both fit any BatchedMesh). */
export const BUILDING_VERTEX = {
  /** Position relative to the settlement centre. */
  position: 3,
  /** Flat face normal. */
  normal: 3,
  /** Walls: metres along the wall, metres above the ground floor. Roofs: pattern coordinates in metres. */
  uv: 2,
  /** Wall or roof colour (linear RGB). */
  tint: 3,
  /** Walls: style code (+8 = shops), per-wall seed, wall length (0 = no windows), material. Roofs: part, seed, 0, material. */
  facade: 4,
  /** Building id (per-building weather lookup). */
  bid: 1,
} as const

/**
 * Roof-batch part codes (`facade.x` on roof geometry): what a surface is, so the roof shader can
 * colour it. Walls use `facade.x` for the building style instead.
 */
export const ROOF_PARTS = {
  /** Roof surface (patterned by roof material, coloured by `tint`). */
  roof: 0,
  /** Concrete (rooftop plant, balcony slabs). */
  concrete: 1,
  /** Glazing (saw-tooth roofs). */
  glass: 2,
  /** Brick (chimneys). */
  brick: 3,
  /** Metal (tanks, antennas, AC units). */
  metal: 4,
  /** Wood (stilts). */
  wood: 5,
  /** Balcony railings. */
  railing: 6,
} as const

/** Colours (linear RGB) and proportions for one building's geometry. */
export interface BuildingLook {
  /** Wall colour. */
  wall: [number, number, number]
  /** Roof colour. */
  roof: [number, number, number]
  /** Eave overhang of pitched roofs, metres. */
  overhang: number
  /** Parapet height on flat roofs, metres. */
  parapet: number
}

/** The four meshes of one building: full detail and simple LOD, walls and roofs (details are instanced separately). */
export interface BuildingMeshes {
  /** Walls (facade shader). */
  walls: MeshData
  /** Roofs (roof shader). */
  roofs: MeshData
  /** Far LOD walls: each part as one extruded prism. */
  simpleWalls: MeshData
  /** Far LOD roofs: flat caps. */
  simpleRoofs: MeshData
}

type P3 = [number, number, number]

/** Adds a quad/triangle, flipping its winding if its normal points away from `hint`. */
function face(m: MeshBuilder, p: P3[], uvs: number[], hint: P3) {
  const [a, b, c] = p
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
  if (n[0] * hint[0] + n[1] * hint[1] + n[2] * hint[2] < 0) {
    p = p.slice().reverse()
    const r: number[] = []
    for (let i = p.length - 1; i >= 0; i--) r.push(uvs[i * 2], uvs[i * 2 + 1])
    uvs = r
  }
  if (p.length === 4) m.quad(p, uvs)
  else m.tri(p, uvs)
}

const pool: Vector2[] = []

/** Flat horizontal cap over a polygon at height y (facing up), uv = local xz. */
function cap(m: MeshBuilder, poly: Vec2[], y: number, ox: number, oz: number) {
  // Reused Vector2s: no per-vertex allocations.
  while (pool.length < poly.length) pool.push(new Vector2())
  const tris = ShapeUtils.triangulateShape(poly.map(([x, z], i) => pool[i].set(x, z)), [])
  m.set('normal', 0, 1, 0)
  for (const [i, j, k] of tris) {
    const a = poly[i], b = poly[j], c = poly[k]
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    const order = cross < 0 ? [a, b, c] : [a, c, b]
    const idx = order.map(([x, z]) => m.vertex(x - ox, y, z - oz, x - ox, z - oz))
    m.triangle(idx[0], idx[1], idx[2])
  }
}

/** Vertical walls around a polygon between y0 and y1 (relative heights for uv from `base`). */
function walls(m: MeshBuilder, poly: Vec2[], y0: number, y1: number, base: number, ox: number, oz: number, styleCode: number, seed: number, material: number, windows: boolean) {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len < 1e-3) continue
    m.set('facade', styleCode, (seed * 7.31 + i * 0.618) % 1, windows ? len : 0, material)
    m.quad([[a[0] - ox, y0, a[1] - oz], [a[0] - ox, y1, a[1] - oz], [b[0] - ox, y1, b[1] - oz], [b[0] - ox, y0, b[1] - oz]],
      [0, y0 - base, 0, y1 - base, len, y1 - base, len, y0 - base])
  }
}

/** A box (or an 8-sided prism) standing on the ground plane at height y0..y1, no bottom face. */
function box(m: MeshBuilder, cx: number, cz: number, w: number, d: number, angle: number, y0: number, y1: number, ox: number, oz: number, sides = 4) {
  const ux = Math.cos(angle), uz = Math.sin(angle)
  const ring: Vec2[] = []
  if (sides === 4) {
    for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) ring.push([cx + (ux * s * w) / 2 - (uz * t * d) / 2, cz + (uz * s * w) / 2 + (ux * t * d) / 2])
  } else {
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2
      ring.push([cx + (Math.cos(a) * w) / 2, cz + (Math.sin(a) * d) / 2])
    }
  }
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    const mx = (a[0] + b[0]) / 2 - cx, mz = (a[1] + b[1]) / 2 - cz
    const l = Math.hypot(b[0] - a[0], b[1] - a[1])
    face(m, [[a[0] - ox, y0, a[1] - oz], [a[0] - ox, y1, a[1] - oz], [b[0] - ox, y1, b[1] - oz], [b[0] - ox, y0, b[1] - oz]], [0, 0, 0, y1 - y0, l, y1 - y0, l, 0], [mx, 0, mz])
  }
  cap(m, ring, y1, ox, oz)
}


/** Pitched, skillion or saw-tooth roof on a part's rectangle (gable ends go into the wall mesh). */
function pitchedRoof(roof: MeshBuilder, wall: MeshBuilder, part: BuildingPart, top: number, base: number, ox: number, oz: number, overhang: number, styleCode: number, seed: number, material: number, roofMaterial: number) {
  const r = part.rect!
  const [ux, uz] = r.axis
  const vx = -uz, vz = ux
  const L = r.halfLength, W = r.halfWidth, R = part.roofHeight
  const at = (u: number, v: number, y: number): P3 => [r.center[0] + ux * u + vx * v - ox, y, r.center[1] + uz * u + vz * v - oz]
  const up: P3 = [0, 1, 0]
  const nrm = (u: number, v: number, y: number): P3 => [ux * u + vx * v, y, uz * u + vz * v]
  const slope = R / Math.max(W, 1e-3)
  const o = part.roof === 'sawtooth' ? 0.2 : overhang
  const eave = top - o * slope
  const Lo = L + o, Wo = W + o
  const gableWall = (u: number, pts: P3[], uvs: number[]) => {
    wall.set('facade', styleCode, seed, 0, material)
    face(wall, pts, uvs, nrm(Math.sign(u), 0, 0))
  }
  roof.set('facade', ROOF_PARTS.roof, seed, 0, roofMaterial)
  const slopeLen = Math.hypot(Wo, R + o * slope)
  if (part.roof === 'gable') {
    for (const s of [-1, 1]) {
      face(roof, [at(-Lo, s * Wo, eave), at(Lo, s * Wo, eave), at(Lo, 0, top + R), at(-Lo, 0, top + R)], [0, slopeLen, 2 * Lo, slopeLen, 2 * Lo, 0, 0, 0], nrm(0, s, 1))
      gableWall(s, [at(s * L, -W, top), at(s * L, W, top), at(s * L, 0, top + R)], [0, top - base, 2 * W, top - base, W, top + R - base])
    }
  } else if (part.roof === 'hip') {
    const rl = Math.max(0, L - W)
    for (const s of [-1, 1]) {
      face(roof, [at(-Lo, s * Wo, eave), at(Lo, s * Wo, eave), at(rl, 0, top + R), at(-rl, 0, top + R)], [0, slopeLen, 2 * Lo, slopeLen, Lo + rl, 0, Lo - rl, 0], nrm(0, s, 1))
      face(roof, [at(s * Lo, -Wo, eave), at(s * Lo, Wo, eave), at(s * rl, 0, top + R)], [0, slopeLen, 2 * Wo, slopeLen, Wo, 0], nrm(s, 0, 1))
    }
  } else if (part.roof === 'skillion') {
    // Mono-pitch: high along v = −W, low along v = +W.
    const hi = top + R
    face(roof, [at(-Lo, -Wo, hi + o * (R / (2 * W))), at(Lo, -Wo, hi + o * (R / (2 * W))), at(Lo, Wo, top - o * (R / (2 * W))), at(-Lo, Wo, top - o * (R / (2 * W)))], [0, 0, 2 * Lo, 0, 2 * Lo, 2 * Wo, 0, 2 * Wo], [vx * R, 2 * W, vz * R])
    wall.set('facade', styleCode, seed, 0, material)
    face(wall, [at(-L, -W, top), at(L, -W, top), at(L, -W, hi), at(-L, -W, hi)], [0, top - base, 2 * L, top - base, 2 * L, hi - base, 0, hi - base], nrm(0, -1, 0))
    for (const s of [-1, 1]) gableWall(s, [at(s * L, -W, top), at(s * L, W, top), at(s * L, -W, hi)], [0, top - base, 2 * W, top - base, 0, hi - base])
  } else if (part.roof === 'sawtooth') {
    const n = Math.max(2, Math.round((2 * L) / 7))
    const tw = (2 * L) / n
    for (let i = 0; i < n; i++) {
      const u0 = -L + i * tw, u1 = u0 + tw
      roof.set('facade', ROOF_PARTS.roof, seed, 0, ROOF_MATERIALS.indexOf('metal'))
      face(roof, [at(u0, -W, top), at(u0, W, top), at(u1, W, top + R), at(u1, -W, top + R)], [0, 0, 2 * W, 0, 2 * W, tw, 0, tw], [-ux * R, tw, -uz * R])
      roof.set('facade', ROOF_PARTS.glass, seed, 0, 0)
      face(roof, [at(u1, -W, top), at(u1, W, top), at(u1, W, top + R), at(u1, -W, top + R)], [0, 0, 2 * W, 0, 2 * W, R, 0, R], nrm(1, 0, 0))
      roof.set('facade', ROOF_PARTS.metal, seed, 0, 0)
      for (const s of [-1, 1]) face(roof, [at(u0, s * W, top), at(u1, s * W, top), at(u1, s * W, top + R)], [0, 0, tw, 0, tw, R], nrm(0, s, 0))
    }
  }
}

/**
 * Builds the geometry of one building, relative to `origin` (the settlement centre) so vertex
 * coordinates stay small. Walls carry wall coordinates in `uv` (metres along the wall, metres
 * above the ground floor) for the facade shader.
 */
export function buildingGeometry(b: Building, origin: Vec2, look: BuildingLook): BuildingMeshes {
  const [ox, oz] = origin
  const make = () => new MeshBuilder(BUILDING_VERTEX)
  const w = make(), r = make(), sw = make(), sr = make()
  const styleCode = BUILDING_STYLES.indexOf(b.style) + (b.shops ? 8 : 0)
  const material = WALL_MATERIALS.indexOf(b.material)
  const roofMaterial = ROOF_MATERIALS.indexOf(b.roofMaterial)
  for (const m of [w, sw]) m.set('tint', ...look.wall).set('bid', b.id)
  for (const m of [r, sr]) m.set('tint', ...look.roof).set('bid', b.id)
  const base = b.base
  const flatMaterial = ROOF_MATERIALS.indexOf('concrete')

  for (const part of b.parts) {
    let below = b.bottom
    for (let t = 0; t < part.tiers.length; t++) {
      const tier = part.tiers[t]
      const top = base + tier.top
      walls(w, tier.polygon, below, top, base, ox, oz, styleCode, b.seed, material, true)
      const last = t === part.tiers.length - 1
      if (!last || part.roof === 'flat') {
        r.set('facade', ROOF_PARTS.roof, b.seed, 0, flatMaterial)
        cap(r, tier.polygon, top, ox, oz)
        if (last && look.parapet > 0 && b.style !== 'house') walls(w, tier.polygon, top, top + look.parapet, base, ox, oz, styleCode, b.seed, material, false)
      }
      below = top
    }
    const top = base + part.tiers[part.tiers.length - 1].top
    if (part.roof !== 'flat' && part.rect) {
      pitchedRoof(r, w, part, top, base, ox, oz, look.overhang, styleCode, b.seed, material, roofMaterial)
    }
    // Far LOD: one prism per part, capped halfway up the roof.
    walls(sw, part.tiers[0].polygon, b.bottom, top + part.roofHeight * 0.5, base, ox, oz, styleCode, b.seed, material, true)
    sr.set('facade', ROOF_PARTS.roof, b.seed, 0, part.roof === 'flat' ? flatMaterial : roofMaterial)
    cap(sr, part.tiers[0].polygon, top + part.roofHeight * 0.5, ox, oz)
  }

  return { walls: w.build(), roofs: r.build(), simpleWalls: sw.build(), simpleRoofs: sr.build() }
}

/** Instanced detail shapes: the building details plus balcony slabs and railings. */
export type DetailShape = BuildingDetail['kind'] | 'slab' | 'railing'

/** Every instanced detail shape, in geometry order. */
export const DETAIL_SHAPES: readonly DetailShape[] = ['plant', 'tank', 'antenna', 'chimney', 'ac', 'post', 'slab', 'railing']

const DETAIL_PART: Record<DetailShape, number> = {
  plant: ROOF_PARTS.concrete, tank: ROOF_PARTS.metal, antenna: ROOF_PARTS.metal, chimney: ROOF_PARTS.brick,
  ac: ROOF_PARTS.metal, post: ROOF_PARTS.wood, slab: ROOF_PARTS.concrete, railing: ROOF_PARTS.railing,
}

/**
 * The unit geometry of a detail shape (x and z in −0.5…0.5, y in 0…1; tanks are 8-sided prisms),
 * shared by every instance and scaled per instance. Same vertex format as buildings.
 */
export function detailGeometry(shape: DetailShape): MeshData {
  const m = new MeshBuilder(BUILDING_VERTEX)
  m.set('tint', 1, 1, 1).set('bid', 0).set('facade', DETAIL_PART[shape], 0, 0, 0)
  box(m, 0, 0, 1, 1, 0, 0, 1, 0, 0, shape === 'tank' ? 8 : 4)
  return m.build()
}

/** One placed detail: shape, position (relative to the settlement centre), yaw and size. */
export interface DetailInstance {
  /** Index into {@link DETAIL_SHAPES}. */
  shape: number
  /** Base centre. */
  x: number
  /** Bottom height. */
  y: number
  /** Base centre. */
  z: number
  /** Yaw, radians from +x. */
  angle: number
  /** Size along `angle`. */
  width: number
  /** Height. */
  height: number
  /** Size across `angle`. */
  depth: number
}

/** Every instanced detail of a building (rooftop plant, tanks, chimneys, AC units, stilts, balconies), relative to `origin`. */
export function detailInstances(b: Building, origin: Vec2): DetailInstance[] {
  const [ox, oz] = origin
  const out: DetailInstance[] = []
  for (const d of b.details) {
    out.push({ shape: DETAIL_SHAPES.indexOf(d.kind), x: d.x - ox, y: b.base + d.bottom, z: d.z - oz, angle: d.angle, width: d.width, height: d.top - d.bottom, depth: d.depth })
  }
  for (const bal of b.balconies) {
    const nx = Math.sin(bal.angle), nz = -Math.cos(bal.angle) // outward
    const y = b.base + bal.y
    out.push({ shape: 6, x: bal.x + (nx * bal.depth) / 2 - ox, y: y - 0.18, z: bal.z + (nz * bal.depth) / 2 - oz, angle: bal.angle, width: bal.width, height: 0.18, depth: bal.depth })
    out.push({ shape: 7, x: bal.x + nx * (bal.depth - 0.03) - ox, y, z: bal.z + nz * (bal.depth - 0.03) - oz, angle: bal.angle, width: bal.width, height: 1, depth: 0.06 })
  }
  return out
}
