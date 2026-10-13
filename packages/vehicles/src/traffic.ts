// Traffic pools: what drives where. Each pool is a weighted list of vehicle types and parameters;
// `trafficGroups` splits a vehicle count over one into fleet groups.
import type { VehicleParams, VehicleType } from './models.ts'
import type { FleetGroup, RouteSpec } from './sim.ts'

/** Kinds of road a pool is for. */
export type TrafficPoolName = 'urban' | 'highway' | 'rural' | 'dirtRoad'

/** One entry of a traffic pool. */
export interface TrafficEntry {
  /** Vehicle type. */
  type: VehicleType
  /** Its parameters. */
  params: VehicleParams
  /** Relative share. */
  weight: number
}

/**
 * Weighted traffic by road kind: town streets (mixed cars, buses, a few pickups, box trucks and
 * bicycles), highways (semi-trailer rigs weigh in), rural roads (pickups, utes and tractors weigh in) and
 * dirt roads (mostly pickups, utes and tractors).
 */
export const TRAFFIC_POOLS: Record<TrafficPoolName, TrafficEntry[]> = {
  urban: [
    { type: 'car', params: { style: 'mixed' }, weight: 78 },
    { type: 'car', params: { style: 'bus' }, weight: 3 },
    { type: 'pickup', params: { style: 'mixed' }, weight: 7 },
    { type: 'truck', params: { body: 'rigid', cab: 'cabOver', sleeper: false, axles: 2 }, weight: 3 },
    { type: 'bicycle', params: { style: 'mixed' }, weight: 8 },
  ],
  highway: [
    { type: 'car', params: { style: 'mixed' }, weight: 74 },
    { type: 'pickup', params: { style: 'mixed' }, weight: 12 },
    { type: 'car', params: { style: 'bus' }, weight: 2 },
    { type: 'truck', params: { trailers: 1 }, weight: 12 },
    { type: 'truck', params: { trailers: 2 }, weight: 2 },
  ],
  rural: [
    { type: 'car', params: { style: 'mixed' }, weight: 46 },
    { type: 'pickup', params: { style: 'fullSize' }, weight: 26 },
    { type: 'pickup', params: { style: 'ute' }, weight: 8 },
    { type: 'pickup', params: { style: 'ute', ute: 'tray' }, weight: 5 },
    { type: 'pickup', params: { style: 'angular' }, weight: 2 },
    { type: 'truck', params: { trailers: 1 }, weight: 4 },
    { type: 'tractor', params: {}, weight: 3 },
  ],
  dirtRoad: [
    { type: 'pickup', params: { style: 'fullSize', lift: 0.12 }, weight: 30 },
    { type: 'pickup', params: { style: 'fullSize', cab: 'regular', bed: 'long', load: 'hay' }, weight: 12 },
    { type: 'pickup', params: { style: 'ute', ute: 'tray', load: 'crates' }, weight: 14 },
    { type: 'car', params: { style: 'suv' }, weight: 14 },
    { type: 'car', params: { style: 'mixed' }, weight: 12 },
    { type: 'car', params: { style: 'vintage' }, weight: 2 },
    { type: 'tractor', params: {}, weight: 6 },
    { type: 'tractor', params: { implement: 'trailer' }, weight: 3 },
  ],
}

/**
 * Splits `count` vehicles over a traffic pool into fleet groups sharing `route` (largest remainders,
 * so the counts always add up and the same inputs give the same groups).
 *
 * @example
 * ```ts
 * new Fleet({ groups: trafficGroups('rural', 60, { kind: 'roads' }) }, { roads: graph })
 * ```
 */
export function trafficGroups(pool: TrafficPoolName | TrafficEntry[], count: number, route: RouteSpec, extra: Partial<FleetGroup> = {}): FleetGroup[] {
  const entries = typeof pool === 'string' ? TRAFFIC_POOLS[pool] : pool
  const total = entries.reduce((a, e) => a + Math.max(0, e.weight), 0)
  const n = Math.max(0, Math.floor(count))
  if (!total || !n) return []
  const exact = entries.map((e) => (Math.max(0, e.weight) / total) * n)
  const counts = exact.map(Math.floor)
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1])
  for (let k = 0, left = n - counts.reduce((a, b) => a + b, 0); k < left; k++) counts[order[k % order.length][1]]++
  return entries.flatMap((e, i) => (counts[i] ? [{ ...extra, type: e.type, count: counts[i], params: { ...e.params }, route: structuredClone(route) }] : []))
}
