import type { Object3D } from 'three/webgpu'
import {
  createSample,
  isPlausible,
  mulberry32,
  seedOf,
  type AssetDef,
  type LocalFrame,
  type PlacementRule,
  type World
} from 'threejs-biomes'
import { Vehicle } from './fleet.ts'
import { VEHICLE_KINDS, VEHICLE_TYPES, type VehicleType } from './models.ts'
import type { RouteSpec } from './sim.ts'

/** Where an asset can plausibly go; threejs-biomes' `PlacementRule`, re-exported. */
export type { PlacementRule } from 'threejs-biomes'

/** A vehicle's placement rule plus the network it moves on. */
export interface VehiclePlacementRule extends PlacementRule {
  /** Roads, rails, open water, airspace or a launch pad. */
  network: 'road' | 'rail' | 'sea' | 'air' | 'pad'
}

/** Where each vehicle type plausibly goes. */
export const VEHICLE_PLACEMENT: Record<VehicleType, VehiclePlacementRule> = {
  car: { network: 'road', surface: 'ground', slope: [0, 0.15], height: [0.5, 4000] },
  pickup: { network: 'road', surface: 'ground', slope: [0, 0.2], height: [0.5, 4500] },
  truck: { network: 'road', surface: 'ground', slope: [0, 0.1], height: [0.5, 4000] },
  tractor: { network: 'road', surface: 'ground', slope: [0, 0.3], height: [0.5, 3500] },
  bicycle: { network: 'road', surface: 'ground', slope: [0, 0.1], height: [0.5, 3000], temperature: [-5, 40] },
  train: { network: 'rail', surface: 'ground', slope: [0, 0.04], height: [1, 3500] },
  'fishing-boat': { network: 'sea', surface: 'water', depth: [3, 400] },
  'cruise-liner': { network: 'sea', surface: 'water', depth: [12, 11000] },
  speedboat: { network: 'sea', surface: 'water', depth: [1.5, 2000] },
  hovercraft: { network: 'sea', surface: 'water', depth: [0.3, 60] },
  'aircraft-carrier': { network: 'sea', surface: 'water', depth: [15, 11000] },
  airplane: { network: 'air', surface: 'air', height: [300, 11000] },
  'fighter-jet': { network: 'air', surface: 'air', height: [150, 15000] },
  rocket: { network: 'pad', surface: 'ground', slope: [0, 0.05], height: [1, 400], nearWater: 1500 }
}

/** `(x, z, rule) => fits`: pass threejs-biomes' `isPlausible` bound to a world and frame to use it. */
export type Plausible = (x: number, z: number, rule: PlacementRule) => boolean

const scratch = createSample()

/** Options of {@link planRoute}. */
export interface PlanRouteOptions {
  /** Centre of the search, frame-local (x, z). */
  center: [x: number, z: number]
  /** Route radius, metres. */
  radius: number
  /** Seed: same seed, same route. */
  seed?: number | string
  /** Points on the loop. Default 10. */
  points?: number
  /** Candidate loops tried before giving up. Default 24. */
  attempts?: number
  /** Placement check (default threejs-biomes' `isPlausible`). */
  plausible?: Plausible
}

/**
 * Plans a plausible route for a vehicle type around a centre: a loop on open water deep enough for the
 * hull, a loop over flat enough dry ground for roads and rails (following the terrain), a holding
 * pattern at a safe height above the highest ground beneath it, or a flat spot near water for a launch
 * pad. Seeded; returns null if nothing plausible is found.
 */
export function planRoute(
  type: VehicleType,
  world: World,
  frame: LocalFrame,
  options: PlanRouteOptions
): RouteSpec | null {
  const rule = VEHICLE_PLACEMENT[type]
  const { center, radius, points = 10, attempts = 24 } = options
  const ok = options.plausible ?? ((x: number, z: number, r: PlacementRule) => isPlausible(world, frame, x, z, r, 2))
  const rand = mulberry32(seedOf(options.seed ?? 1) ^ seedOf(type))
  const sea = world.options.seaLevel
  if (rule.network === 'pad') {
    for (let a = 0; a < attempts * points; a++) {
      const r = radius * Math.sqrt(rand()),
        t = rand() * Math.PI * 2
      const x = center[0] + Math.cos(t) * r,
        z = center[1] + Math.sin(t) * r
      if (ok(x, z, rule)) return { kind: 'pad', position: [x, frame.height(x, z), z], heading: rand() * Math.PI * 2 }
    }
    return null
  }
  for (let a = 0; a < attempts; a++) {
    // Each attempt shifts the centre a little and wobbles the loop.
    const cx = center[0] + (a ? (rand() * 2 - 1) * radius * 0.5 : 0),
      cz = center[1] + (a ? (rand() * 2 - 1) * radius * 0.5 : 0)
    const loop: [number, number, number][] = []
    let fits = true
    for (let i = 0; i < points && fits; i++) {
      const t = (i / points) * Math.PI * 2,
        r = radius * (0.7 + 0.3 * rand())
      const x = cx + Math.cos(t) * r,
        z = cz + Math.sin(t) * r
      if (rule.network === 'air') {
        loop.push([x, 0, z])
        continue
      }
      // Midpoint to the previous point too, so the loop doesn't cut across land (or water).
      const prev = loop[loop.length - 1]
      fits = ok(x, z, rule) && (!prev || ok((x + prev[0]) / 2, (z + prev[2]) / 2, rule))
      const s = frame.sample(x, z, scratch)
      loop.push([
        x,
        rule.network === 'sea'
          ? s.waterLevel === s.waterLevel
            ? s.waterLevel
            : sea
          : s.elevation + (rule.network === 'rail' ? 0.4 : 0.05),
        z
      ])
    }
    if (fits && rule.network !== 'air')
      fits = ok((loop[0][0] + loop[points - 1][0]) / 2, (loop[0][2] + loop[points - 1][2]) / 2, rule)
    if (!fits) continue
    if (rule.network === 'air') {
      // Clear the highest ground under the loop by the rule's minimum height.
      let top = sea
      for (let i = 0; i < points * 4; i++) {
        const t = (i / (points * 4)) * Math.PI * 2
        top = Math.max(top, frame.height(cx + Math.cos(t) * radius, cz + Math.sin(t) * radius))
      }
      const [h0, h1] = rule.height ?? [300, 1000]
      const y = top + h0 + rand() * Math.min(h1 - h0, h0 * 2)
      for (const p of loop) p[1] = y
    }
    if (rule.network === 'sea') {
      const y = Math.min(...loop.map((p) => p[1]))
      for (const p of loop) p[1] = y
    }
    return { kind: 'path', points: loop, closed: true, smooth: 8 }
  }
  return null
}

/** One editable parameter, as JSON; threejs-biomes' `AssetParam`, re-exported. */
export type { AssetParam } from 'threejs-biomes'

/** A registered asset: an `AssetDef` with a vehicle's placement rule. */
export interface VehicleAssetDef extends AssetDef {
  /** Where it plausibly goes. */
  placement: VehiclePlacementRule
  /** Builds one animated instance (it updates itself while rendered). */
  create: (params: Record<string, unknown>, seed: number) => Object3D
}

/**
 * Every vehicle as an asset definition for threejs-worldgen's `AssetRegistry`
 * (`registry.register(...vehicleAssets())`): fuzzy-searchable, with JSON parameters, a placement rule
 * for `planSpawns`, and a generator that returns a self-animating object.
 */
export function vehicleAssets(): VehicleAssetDef[] {
  return VEHICLE_TYPES.map((type) => {
    const kind = VEHICLE_KINDS[type]
    return {
      id: `vehicles/${type}`,
      name: kind.name,
      package: 'threejs-vehicles',
      category: 'vehicle',
      tags: [kind.domain, ...kind.tags],
      params: structuredClone(kind.params),
      placement: VEHICLE_PLACEMENT[type],
      create: (params, seed) => {
        const p = Object.fromEntries(
          Object.entries(params).filter(([, v]) => ['number', 'string', 'boolean'].includes(typeof v))
        ) as Record<string, number | string | boolean>
        const moving = kind.domain !== 'space'
        return new Vehicle({ type, params: p, seed, speed: moving ? 5 : 0 }, { autoUpdate: true }).object
      }
    }
  })
}
