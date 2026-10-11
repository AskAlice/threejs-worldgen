import { hash, mulberry32 } from 'threejs-scatter'
import { BufferAttribute, BufferGeometry } from 'three/webgpu'
import { linearColor } from './tube-mesh.ts'

/** Every parameter of a generated rock. Lengths in metres. Plain JSON. */
export interface RockParams {
  /** Approximate diameter. */
  size: number
  /** Stretch along x relative to z (1 = round in plan). */
  elongation: number
  /** Vertical squash, 0..1 (0 = as tall as wide, 0.6 = a slab). */
  flatness: number
  /** Large-scale lumpiness (fBm displacement), relative to size. */
  roughness: number
  /** Faceting and cracks from Worley noise, relative to size. */
  facets: number
  /** Noise frequency over the unit sphere; higher = smaller features. */
  noiseScale: number
  /** Icosphere subdivisions (0..5). Each level has 4× the triangles. */
  detail: number
  /** Share of the rock below which it is cut flat (sits on the ground), 0..0.5. */
  baseCut: number
  /** Base colour, CSS. */
  color: string
  /** Brightness variation across the surface, 0..1. */
  colorVariation: number
  /** Moss or lichen on upward faces, 0..1. */
  moss: number
  /** Moss colour, CSS. */
  mossColor: string
  /** Suggested minimum distance between two rocks of this kind when scattered. */
  spacing: number
}

/** The rock preset names. */
export type RockName = 'boulder' | 'rock' | 'pebble' | 'scree' | 'cliffChunk'

/** Parameters every rock starts from. */
export const DEFAULT_ROCK_PARAMS: RockParams = {
  size: 1.2, elongation: 1.2, flatness: 0.25, roughness: 0.18, facets: 0.12, noiseScale: 1.6, detail: 3, baseCut: 0.25,
  color: '#7c776f', colorVariation: 0.2, moss: 0, mossColor: '#56662f', spacing: 6,
}

const r = (o: Partial<RockParams>): RockParams => ({ ...DEFAULT_ROCK_PARAMS, ...o })

/** Tuned rock presets. */
export const rocks: Record<RockName, RockParams> = {
  boulder: r({ size: 3, elongation: 1.3, flatness: 0.2, roughness: 0.2, facets: 0.14, detail: 4, baseCut: 0.3, moss: 0.35, spacing: 18 }),
  rock: r({}),
  pebble: r({ size: 0.25, elongation: 1.4, flatness: 0.45, roughness: 0.08, facets: 0.04, detail: 2, baseCut: 0.15, color: '#8a857c', spacing: 0.9 }),
  scree: r({ size: 0.6, elongation: 1.5, flatness: 0.35, roughness: 0.12, facets: 0.3, noiseScale: 2.2, detail: 2, baseCut: 0.2, color: '#77736d', spacing: 1.6 }),
  cliffChunk: r({ size: 7, elongation: 1.6, flatness: 0.1, roughness: 0.25, facets: 0.28, noiseScale: 2, detail: 4, baseCut: 0.35, color: '#6e6a63', moss: 0.15, spacing: 30 }),
}

/**
 * Generates a rock: an icosphere displaced by fBm (lumps) and Worley noise (facets and cracks), squashed, stretched and
 * cut flat underneath, with vertex colours for weathering and moss on top. Deterministic in `params` and `seed`.
 * The base sits at y = 0. Attributes: position, normal, uv (spherical), color.
 */
export function generateRock(params: Partial<RockParams>, seed = 1): BufferGeometry {
  const p: RockParams = { ...DEFAULT_ROCK_PARAMS, ...params }
  const rand = mulberry32(hash(seed, 0x50c4))
  const salt = hash(seed, 0x50c5)
  const { positions: unit, indices } = icosphere(Math.max(0, Math.min(5, Math.round(p.detail))))
  const n = unit.length / 3
  const axis = rand() * Math.PI
  const sx = p.elongation
  const sy = 1 - Math.min(0.9, p.flatness)
  const pos = new Float32Array(n * 3)
  const shade = new Float32Array(n)
  const c = Math.cos(axis)
  const s = Math.sin(axis)
  const worley: [number, number] = [0, 0]
  for (let i = 0; i < n; i++) {
    const dx = unit[i * 3]
    const dy = unit[i * 3 + 1]
    const dz = unit[i * 3 + 2]
    const qx = dx * p.noiseScale
    const qy = dy * p.noiseScale
    const qz = dz * p.noiseScale
    const lumps = fbm3(qx, qy, qz, salt, 4) * 2 - 1
    const [f1, f2] = worley3(qx * 1.7, qy * 1.7, qz * 1.7, salt, worley)
    // F2 - F1 is small along cell borders: carve shallow cracks there and flatten cell interiors into facets.
    const crack = Math.max(0, 1 - (f2 - f1) * 6)
    const radius = 1 + lumps * p.roughness * 2 - f1 * p.facets - crack * p.facets * 0.6
    const x = dx * radius * sx
    const z = dz * radius
    pos[i * 3] = x * c - z * s
    pos[i * 3 + 1] = dy * radius * sy
    pos[i * 3 + 2] = x * s + z * c
    shade[i] = 1 + (fbm3(qx * 3 + 9, qy * 3, qz * 3, salt + 1, 3) * 2 - 1) * p.colorVariation - crack * 0.35
  }
  // Cut the base flat, then sit it on y = 0 and scale to size.
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    minY = Math.min(minY, pos[i * 3 + 1])
    maxY = Math.max(maxY, pos[i * 3 + 1])
  }
  const cut = minY + (maxY - minY) * Math.min(0.5, p.baseCut)
  const scale = p.size / 2 / Math.max(sx, 1)
  for (let i = 0; i < n; i++) {
    let y = pos[i * 3 + 1]
    if (y < cut) y = cut + (y - cut) * 0.12
    pos[i * 3] *= scale
    pos[i * 3 + 1] = (y - cut) * scale
    pos[i * 3 + 2] *= scale
  }

  const normals = vertexNormals(pos, indices)
  const base = linearColor(p.color)
  const moss = linearColor(p.mossColor)
  const uvs = new Float32Array(n * 2)
  const colors = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    uvs[i * 2] = 0.5 + Math.atan2(unit[i * 3 + 2], unit[i * 3]) / (2 * Math.PI)
    uvs[i * 2 + 1] = 0.5 + Math.asin(Math.max(-1, Math.min(1, unit[i * 3 + 1]))) / Math.PI
    const up = normals[i * 3 + 1]
    const m = p.moss * smooth(0.35, 0.8, up) * smooth(0.35, 0.65, fbm3(unit[i * 3] * 4, unit[i * 3 + 1] * 4, unit[i * 3 + 2] * 4, salt + 2, 3))
    // Darker towards the ground (soil, damp), lighter on top (weathered).
    const ao = 0.7 + 0.3 * Math.min(1, pos[i * 3 + 1] / (p.size * 0.25 + 1e-3))
    for (let k = 0; k < 3; k++) colors[i * 3 + k] = (base[k] * (1 - m) + moss[k] * m) * shade[i] * ao
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('normal', new BufferAttribute(normals, 3))
  g.setAttribute('uv', new BufferAttribute(uvs, 2))
  g.setAttribute('color', new BufferAttribute(colors, 3))
  g.setAttribute('cardRandom', new BufferAttribute(new Float32Array(n).fill(-1), 1))
  g.setIndex(new BufferAttribute(n <= 65536 ? Uint16Array.from(indices) : Uint32Array.from(indices), 1))
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Indexed unit icosphere: an icosahedron subdivided `level` times, vertices shared (no seams). */
export function icosphere(level: number): { positions: number[]; indices: number[] } {
  const t = (1 + Math.sqrt(5)) / 2
  const positions: number[] = []
  const add = (x: number, y: number, z: number) => {
    const l = Math.hypot(x, y, z)
    positions.push(x / l, y / l, z / l)
    return positions.length / 3 - 1
  }
  for (const [x, y, z] of [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]) add(x, y, z)
  let faces = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1]
  for (let l = 0; l < level; l++) {
    const cache = new Map<number, number>()
    const mid = (a: number, b: number) => {
      const key = a < b ? a * 1e6 + b : b * 1e6 + a
      let m = cache.get(key)
      if (m === undefined) {
        m = add(positions[a * 3] + positions[b * 3], positions[a * 3 + 1] + positions[b * 3 + 1], positions[a * 3 + 2] + positions[b * 3 + 2])
        cache.set(key, m)
      }
      return m
    }
    const next: number[] = []
    for (let f = 0; f < faces.length; f += 3) {
      const [a, b, c] = [faces[f], faces[f + 1], faces[f + 2]]
      const ab = mid(a, b)
      const bc = mid(b, c)
      const ca = mid(c, a)
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca)
    }
    faces = next
  }
  return { positions, indices: faces }
}

function vertexNormals(pos: Float32Array, indices: number[]): Float32Array {
  const nrm = new Float32Array(pos.length)
  for (let f = 0; f < indices.length; f += 3) {
    const a = indices[f] * 3
    const b = indices[f + 1] * 3
    const c = indices[f + 2] * 3
    const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2]
    const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2]
    // Area-weighted face normal, accumulated on its three corners.
    const nx = e1y * e2z - e1z * e2y
    const ny = e1z * e2x - e1x * e2z
    const nz = e1x * e2y - e1y * e2x
    nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz
    nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz
    nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz
  }
  for (let i = 0; i < nrm.length; i += 3) {
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1
    nrm[i] /= l
    nrm[i + 1] /= l
    nrm[i + 2] /= l
  }
  return nrm
}

/** Seeded 3D value noise in [0, 1]. */
function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  const fx = x - xi
  const fy = y - yi
  const fz = z - zi
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const sz = fz * fz * (3 - 2 * fz)
  const h = (a: number, b: number, c: number) => hash(xi + a, yi + b, hash(zi + c, seed)) / 4294967296
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t
  return lerp(
    lerp(lerp(h(0, 0, 0), h(1, 0, 0), sx), lerp(h(0, 1, 0), h(1, 1, 0), sx), sy),
    lerp(lerp(h(0, 0, 1), h(1, 0, 1), sx), lerp(h(0, 1, 1), h(1, 1, 1), sx), sy),
    sz,
  )
}

/** Seeded 3D fBm in [0, 1]. */
export function fbm3(x: number, y: number, z: number, seed: number, octaves = 4): number {
  let sum = 0
  let amp = 0.5
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise3(x, y, z, seed + o * 31) * amp
    norm += amp
    x *= 2.03
    y *= 2.03
    z *= 2.03
    amp *= 0.5
  }
  return sum / norm
}

/** Seeded 3D Worley (cellular) noise: distances to the nearest and second-nearest feature points (written into `out`). */
export function worley3(x: number, y: number, z: number, seed: number, out: [number, number] = [0, 0]): [f1: number, f2: number] {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  let f1 = Infinity
  let f2 = Infinity
  for (let a = -1; a <= 1; a++) {
    for (let b = -1; b <= 1; b++) {
      for (let c = -1; c <= 1; c++) {
        const h = hash(xi + a, yi + b, hash(zi + c, seed))
        const px = xi + a + (h & 1023) / 1023
        const py = yi + b + ((h >>> 10) & 1023) / 1023
        const pz = zi + c + ((h >>> 20) & 1023) / 1023
        const d = Math.hypot(px - x, py - y, pz - z)
        if (d < f1) {
          f2 = f1
          f1 = d
        } else if (d < f2) f2 = d
      }
    }
  }
  out[0] = f1
  out[1] = f2
  return out
}
