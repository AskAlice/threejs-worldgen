import { Matrix4, Quaternion, Vector3 } from 'three/webgpu'
import type { HeightFn } from 'threejs-heightfield'
import { poissonDisk } from './poisson.ts'
import { fbm2, hash, hashString, mulberry32 } from './random.ts'

/** Clumping noise: instances gather in patches with clearings between them. */
export interface ScatterCluster {
  /** Size of the patches, in metres (noise wavelength). */
  scale: number
  /** 0..1: the share of land that is clearing. 0.5 = about half the ground is in a patch. */
  threshold: number
  /** 0 = no clumping, 1 = nothing at all in clearings. Values between thin clearings out partially. */
  strength: number
}

/** A density as a constant or a function of world position (for example a biome weight). */
export type DensityFn = (x: number, z: number) => number

/** The placement rules of one layer: where its instances go, and how each is scaled and turned. */
export interface PlacementRules {
  /** Layer name. Also seeds the layer's clumping noise, so renaming a layer moves its patches. */
  name: string
  /**
   * Layers with the same `group` share one blue-noise point set and never overlap: each point goes to at most one
   * layer, chosen by comparing a per-point random number against the layers' densities (in layer order). The group's
   * `spacing` is the first layer's. Defaults to the layer's own `name` (its own point set).
   */
  group?: string
  /** Minimum distance between instances, in metres (Poisson-disk radius). */
  spacing: number
  /**
   * Probability (0..1) of keeping each blue-noise point, constant or per world position. The function form lets
   * biome weights drive it. Within a group, densities that add up to more than 1 are normalised.
   */
  density: number | DensityFn
  /** Lowest terrain slope (rise / run) that gets instances. */
  minSlope: number
  /** Steepest terrain slope (rise / run) that gets instances. `Infinity` = no limit. */
  maxSlope: number
  /** Lowest terrain height, in metres. */
  minHeight: number
  /** Highest terrain height, in metres. */
  maxHeight: number
  /** Clumping into patches and clearings, or `null` for an even spread. */
  cluster: ScatterCluster | null
  /** Uniform scale range `[min, max]`; each instance picks a random value in it. */
  scale: [min: number, max: number]
  /** 0 = stand upright, 1 = tilt fully onto the terrain normal (rocks), anything between blends. */
  align: number
  /** Turn each instance by a random angle around its up axis. */
  randomYaw: boolean
  /** Maximum random lean of each instance away from vertical, in radians (applied before `align`). */
  tilt: number
  /** How far each instance is pushed into the ground, in metres (hides the base on slopes). */
  sink: number
  /** Per-instance brightness variation, 0..1 (sent as instance colour). */
  colorVariation: number
}

/** Defaults for every {@link PlacementRules} field except `name`. */
export const DEFAULT_PLACEMENT: Omit<PlacementRules, 'name'> = {
  spacing: 4,
  density: 1,
  minSlope: 0,
  maxSlope: Infinity,
  minHeight: -Infinity,
  maxHeight: Infinity,
  cluster: null,
  scale: [1, 1],
  align: 0,
  randomYaw: true,
  tilt: 0,
  sink: 0,
  colorVariation: 0,
}

/**
 * Floats per placed instance in the arrays returned by {@link placeTile}:
 * `[0..15]` world matrix (column-major), `16` yaw (radians), `17` scale, `18` brightness tint, `19` random in [0, 1).
 */
export const INSTANCE_STRIDE = 20

const _m = new Matrix4()
const _q = new Quaternion()
const _qa = new Quaternion()
const _qt = new Quaternion()
const _n = new Vector3()
const _p = new Vector3()
const _s = new Vector3()
const UP = new Vector3(0, 1, 0)
const IDENTITY = new Quaternion()

/** Seed of a group's point set: derived from the scatter seed and the group name. */
export function groupSeed(seed: number, group: string): number {
  return hash(seed, hashString(group))
}

/**
 * Places the instances of one group of layers (layers sharing a point set) inside one tile. Pure and deterministic:
 * the result depends only on the arguments, so tiles stitch and can be generated in any order (or in a worker).
 *
 * @param layers The group's layers, in priority order. `layers[0].spacing` sets the point spacing.
 * @param seed Usually {@link groupSeed}`(scatterSeed, groupName)`.
 * @param height Terrain height; points where it returns NaN are skipped.
 * @returns One array per layer of {@link INSTANCE_STRIDE} floats per instance.
 */
export function placeTile(layers: readonly PlacementRules[], x0: number, z0: number, size: number, seed: number, height: HeightFn): Float32Array[] {
  const out = layers.map(() => [] as number[])
  if (!layers.length) return out.map(() => new Float32Array(0))
  const points = poissonDisk(x0, z0, size, layers[0].spacing, seed)
  const needNormal = layers.some((l) => l.minSlope > 0 || Number.isFinite(l.maxSlope) || l.align > 0)
  const clusterSeeds = layers.map((l) => hash(seed, hashString(l.name), 7))
  const probs = new Float64Array(layers.length)

  for (let p = 0; p < points.length; p += 3) {
    const x = points[p]
    const z = points[p + 1]
    const u = points[p + 2]
    const y = height(x, z)
    if (y !== y) continue
    let slope = 0
    if (needNormal) {
      const e = 0.5
      const dx = (height(x + e, z) - height(x - e, z)) / (2 * e)
      const dz = (height(x, z + e) - height(x, z - e)) / (2 * e)
      if (dx !== dx || dz !== dz) continue
      slope = Math.hypot(dx, dz)
      _n.set(-dx, 1, -dz).normalize()
    }

    let total = 0
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i]
      let d = 0
      if (slope >= l.minSlope && slope <= l.maxSlope && y >= l.minHeight && y <= l.maxHeight) {
        d = typeof l.density === 'number' ? l.density : l.density(x, z)
        if (d > 0 && l.cluster && l.cluster.strength > 0) d *= clusterFactor(l.cluster, x, z, clusterSeeds[i])
      }
      probs[i] = d > 0 ? d : 0
      total += probs[i]
    }
    if (total <= 0) continue
    const norm = total > 1 ? total : 1
    let pick = -1
    let acc = 0
    for (let i = 0; i < layers.length; i++) {
      acc += probs[i] / norm
      if (u < acc) {
        pick = i
        break
      }
    }
    if (pick < 0) continue

    const l = layers[pick]
    const rand = mulberry32(hash(Math.floor(u * 4294967296), seed, pick))
    const yaw = l.randomYaw ? rand() * Math.PI * 2 : 0
    const s = l.scale[0] + (l.scale[1] - l.scale[0]) * rand()
    const tint = 1 + (rand() * 2 - 1) * l.colorVariation
    _q.setFromAxisAngle(UP, yaw)
    if (l.tilt > 0) {
      const dir = rand() * Math.PI * 2
      _q.premultiply(_qt.setFromAxisAngle(_p.set(Math.cos(dir), 0, Math.sin(dir)), rand() * l.tilt))
    }
    if (l.align > 0 && needNormal) {
      _qa.setFromUnitVectors(UP, _n)
      _q.premultiply(_qt.slerpQuaternions(IDENTITY, _qa, Math.min(1, l.align)))
    }
    _m.compose(_p.set(x, y - l.sink, z), _q, _s.set(s, s, s))
    const o = out[pick]
    for (let k = 0; k < 16; k++) o.push(_m.elements[k])
    o.push(yaw, s, tint, u)
  }
  return out.map((a) => new Float32Array(a))
}

/** 0..1 clumping multiplier of a {@link ScatterCluster} at (x, z). */
export function clusterFactor(c: ScatterCluster, x: number, z: number, seed: number): number {
  const n = fbm2(x / Math.max(c.scale, 1e-3), z / Math.max(c.scale, 1e-3), seed, 3)
  const t = Math.min(1, Math.max(0, (n - (c.threshold - 0.08)) / 0.16))
  const patch = t * t * (3 - 2 * t)
  return 1 - Math.min(1, c.strength) * (1 - patch)
}
