import { hash4, mulberry32, seedOf } from 'threejs-biomes'
import { architectureFor, pick, type ArchitectureName, type Climate } from './architecture.ts'
import { assembleBuilding, type Building } from './buildings.ts'
import { DistrictMap } from './districts.ts'
import { RoadGraph, type RoadType } from './graph.ts'
import { polygonsOverlap } from './lots.ts'
import type { CityOptions } from './options.ts'
import type { CityPlan, PlannedLot } from './plan.ts'
import { boxCorners, clipPolygon, pointInPolygon, pointSegment, polygonArea, polygonCentroid, segmentIntersection, type OrientedBox, type Vec2 } from './polygon.ts'
import { assignSurfaces } from './roads.ts'
import { Site, type SiteFn } from './site.ts'
import { gradeRoads, settleBuilding } from './terrain.ts'

/** What a field grows. Corn fields are meant for a 3D crop (threejs-grass); the rest are ground colour. */
export type Crop = 'corn' | 'wheat' | 'fallow' | 'pasture'

/** Every crop, in shader order. */
export const CROPS: readonly Crop[] = ['corn', 'wheat', 'fallow', 'pasture']

/** The buildings of a farmstead (`Building.use`). */
export type FarmBuilding = 'farmhouse' | 'barn' | 'silo' | 'machineShed'

/** One field. Plain data: feed corn fields to a crop renderer by `polygon`, `rows` and `rowSpacing`. */
export interface Field {
  /** Index in `Farm.fields`. */
  id: number
  /** Outline (frame-local), counter-clockwise, convex. */
  polygon: Vec2[]
  /** What grows here. */
  crop: Crop
  /** Unit direction the rows (furrows, tramlines) run along, [x, z]. */
  rows: [number, number]
  /** Row spacing, metres (0 = no rows, e.g. pasture). */
  rowSpacing: number
  /** True if the rows follow the contours (sloping ground) rather than the field's long side. */
  contour: boolean
  /** Ground colour (`#rrggbb`), one of `farm.colors[crop]`. */
  color: string
}

/** Where a vehicle stands (asset id `vehicles/tractor` once threejs-vehicles has one). */
export interface VehicleSpot {
  /** Vehicle kind. */
  kind: 'tractor'
  /** Asset id to spawn. */
  asset: string
  /** Ground position [x, y, z] (frame-local). */
  position: [number, number, number]
  /** Yaw about up, radians, turning the model's +z (front) to face its heading (props' convention: `atan2(dx, dz)`). */
  heading: number
  /** Working a field (driving along its rows) rather than parked in the yard. */
  working: boolean
  /** Field id it works, or −1 when parked. */
  field: number
}

/** A prop to place (the same fields as threejs-props' `PropPlacement`, so the list can be passed to `Props` as is). */
export interface FarmProp {
  /** Prop kind. */
  kind: 'hay-bale' | 'fence'
  /** Position (frame-local). */
  x: number
  /** Ground height. */
  y: number
  /** Position (frame-local). */
  z: number
  /** Yaw about up, radians (fences run along their local x). */
  yaw: number
  /** Per-instance seed. */
  seed: number
  /** Variant (`round` / `square` bales, `rail` / `picket` / `stone` fences). */
  variant?: string
  /** Fence segment length, metres. */
  length?: number
}

/** A farmstead's plan beyond its buildings and roads. Plain JSON. */
export interface Farm {
  /** The farmyard outline (frame-local), counter-clockwise. */
  yard: Vec2[]
  /** Its gravel apron (the rest, round the farmhouse, is grass), counter-clockwise. */
  apron: Vec2[]
  /** Where the driveway meets the road. */
  access: [number, number]
  /** Fields around the yard. */
  fields: Field[]
  /** Tractor spots (for threejs-vehicles). */
  vehicleSpots: VehicleSpot[]
  /** Hay bales and pasture fences (for threejs-props). */
  props: FarmProp[]
}

/** When a crop is grown: its weight inside the temperature and moisture ranges, fading to 0 over `farm.cropMargin` outside. */
export interface CropRule {
  /** Relative weight. */
  weight: number
  /** Mean temperature range, °C. */
  temperature: [number, number]
  /** Moisture range, 0..1. */
  moisture: [number, number]
}

/** Every setting of a farmstead (`City` with `size: 'farmstead'`). Sizes in metres. */
export interface FarmOptions {
  /** The road the driveway joins, a frame-local polyline (`planCities` sets it from the population's road network); empty = a country road is laid past the farm. */
  road: [number, number][]
  /** Class of that road (its width and surface). */
  roadType: RoadType
  /** Without `road`: how far the laid road passes from the farmyard. */
  roadDistance: number
  /** Length of road drawn either side of the driveway. */
  roadSpan: number
  /** Longest driveway; a farm further from its road isn't built. */
  maxDriveway: number
  /** Farmyard size [along the driveway, across]. */
  yard: [number, number]
  /** Steepest ground (rise / run) the farmyard may stand on. */
  maxSlope: number
  /** How far the yard may move from the settlement's position to find dry, gentle ground. */
  search: number
  /** Field size range (each side of the patchwork picks within it). */
  fieldSize: [number, number]
  /** Smallest field kept, m². */
  fieldMinArea: number
  /** Gap between fields (hedgerows, field margins). */
  fieldGap: number
  /** Slope (rise / run) from which rows follow the contours. */
  contourSlope: number
  /** Steepest ground that is farmed; steeper stays wild. */
  fieldMaxSlope: number
  /** Crops by climate. */
  crops: Record<Crop, CropRule>
  /** How far outside a crop's ranges its weight fades out: [°C, moisture]. */
  cropMargin: [number, number]
  /** Row spacing per crop (0 = no rows). */
  rowSpacing: Record<Crop, number>
  /** Row stripe contrast per crop, 0..1 (fades out with distance, no aliasing). */
  rowContrast: Record<Crop, number>
  /** Tramline spacing per crop (sprayer tracks; 0 = none). */
  tramlines: Record<Crop, number>
  /** Ground colours per crop (`#rrggbb`); each field picks one. */
  colors: Record<Crop, string[]>
  /** Farmyard ground colour. */
  yardColor: string
  /** ± brightness of the gentle, large-scale variation across fields (soil and moisture). */
  variation: number
  /** Contrast of the streaks cultivation leaves along the rows. */
  streaks: number
  /** Width of the headland round a cropped field (where the tractor turns). */
  headland: number
  /** Fields and yard float this far above the ground (hides terrain mesh facets). */
  fieldOffset: number
  /** Field mesh grid step. */
  fieldStep: number
  /** Farmhouse: width (along the yard front) and depth ranges, floors. */
  farmhouse: { width: [number, number]; depth: [number, number]; floors: [number, number] }
  /** Barn: width, length and wall height ranges; chance (0..1) of a gambrel roof (else gable); wall colours (red or weathered timber). */
  barn: { width: [number, number]; length: [number, number]; wallHeight: [number, number]; gambrel: number; colors: string[] }
  /** Grain silos: how many (range), radius and height ranges. */
  silos: { count: [number, number]; radius: [number, number]; height: [number, number] }
  /** Machine shed: width, length and wall height ranges. */
  shed: { width: [number, number]; length: [number, number]; height: [number, number] }
  /** Pasture fences: segment length and props variant. */
  fences: { length: number; variant: string }
  /** Hay bales in a field (count range). */
  hayBales: [number, number]
  /** Chance (0..1) that the tractor is out working a field (else parked in the yard). */
  tractorWorking: number
}

/** Default farmstead settings: a mixed farm, crops matched to the climate. */
export const DEFAULT_FARM: FarmOptions = {
  road: [],
  roadType: 'secondary',
  roadDistance: 140,
  roadSpan: 320,
  maxDriveway: 4000,
  yard: [78, 62],
  maxSlope: 0.12,
  search: 160,
  fieldSize: [80, 190],
  fieldMinArea: 3000,
  fieldGap: 3,
  contourSlope: 0.08,
  fieldMaxSlope: 0.22,
  crops: {
    corn: { weight: 1, temperature: [13, 28], moisture: [0.35, 0.85] },
    wheat: { weight: 1, temperature: [4, 22], moisture: [0.2, 0.65] },
    fallow: { weight: 0.3, temperature: [-5, 35], moisture: [0, 1] },
    pasture: { weight: 0.8, temperature: [-3, 26], moisture: [0.35, 1] },
  },
  cropMargin: [6, 0.15],
  rowSpacing: { corn: 0.76, wheat: 0.18, fallow: 0.9, pasture: 0 },
  rowContrast: { corn: 0.06, wheat: 0.05, fallow: 0.14, pasture: 0 },
  tramlines: { corn: 0, wheat: 24, fallow: 0, pasture: 0 },
  colors: {
    corn: ['#4a6130', '#506733', '#465c2f'],
    wheat: ['#a3955f', '#ab9c66', '#988c5a', '#868c50'],
    fallow: ['#73604b', '#7d6954', '#6a5845', '#847159'],
    pasture: ['#62753f', '#6a7c45', '#5d703d'],
  },
  yardColor: '#7a7464',
  variation: 0.09,
  streaks: 0.07,
  headland: 9,
  fieldOffset: 0.18,
  fieldStep: 6,
  farmhouse: { width: [10, 14], depth: [8, 11], floors: [1, 2] },
  barn: { width: [12, 16], length: [22, 34], wallHeight: [4.5, 6], gambrel: 0.5, colors: ['#8f3426', '#9a3c2b', '#843025', '#6f6355', '#7d7163', '#635a4f'] },
  silos: { count: [0, 2], radius: [2.8, 3.8], height: [12, 20] },
  shed: { width: [11, 15], length: [16, 24], height: [4.5, 6] },
  fences: { length: 3, variant: 'rail' },
  hayBales: [3, 9],
  tractorWorking: 0.5,
}

const span = (r: [number, number], rand: () => number) => r[0] + rand() * (r[1] - r[0])

/** Nearest point on a polyline: position, segment index and distance. */
export function nearestOnPolyline(pts: readonly Vec2[], x: number, z: number): { x: number; z: number; segment: number; t: number; distance: number } {
  let best = { x: pts[0][0], z: pts[0][1], segment: 0, t: 0, distance: Math.hypot(x - pts[0][0], z - pts[0][1]) }
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i]
    const h = pointSegment(x, z, ax, az, bx, bz)
    if (h.distance < best.distance) best = { x: ax + (bx - ax) * h.t, z: az + (bz - az) * h.t, segment: i - 1, t: h.t, distance: h.distance }
  }
  return best
}

/**
 * The stretch of a polyline within `span` metres (along it) of its point on segment `segment` at `t`, that point
 * included (index `at`), with points at most `step` metres apart.
 */
function stretch(pts: readonly Vec2[], segment: number, t: number, span: number, step = 30): { points: Vec2[]; at: number } {
  const [ax, az] = pts[segment], [bx, bz] = pts[segment + 1]
  const p: Vec2 = [ax + (bx - ax) * t, az + (bz - az) * t]
  const walk = (dir: 1 | -1) => {
    const out: Vec2[] = []
    let prev = p, left = span
    for (let i = dir > 0 ? segment + 1 : segment; i >= 0 && i < pts.length && left > 0; i += dir) {
      let q = pts[i], l = Math.hypot(q[0] - prev[0], q[1] - prev[1])
      if (l > left) { q = [prev[0] + ((q[0] - prev[0]) * left) / l, prev[1] + ((q[1] - prev[1]) * left) / l]; l = left }
      const n = Math.ceil(l / step)
      if (l > 2) for (let k = 1; k <= n; k++) out.push([prev[0] + ((q[0] - prev[0]) * k) / n, prev[1] + ((q[1] - prev[1]) * k) / n])
      left -= l; prev = q
    }
    return out
  }
  const back = walk(-1).reverse()
  return { points: [...back, p, ...walk(1)], at: back.length }
}

/**
 * Plans a farmstead: a farmyard on dry, gentle ground near the settlement's position (moved up to `search` metres,
 * else no farm), a farmhouse, a barn, silos and a machine shed in it, a dirt driveway to the nearest point of
 * `farm.road` (or of a country road laid past it), and fields around it, split into a patchwork aligned with the
 * driveway, kept off water, roads and steep ground, each with a crop picked by the climate. Pure and deterministic.
 * A generator like {@link planCity} (which calls it for `size: 'farmstead'`).
 */
export function* planFarm(ground: SiteFn, o: CityOptions, climate: Climate | null = null): Generator<void, CityPlan> {
  const seed = seedOf(o.seed)
  const rand = mulberry32(hash4(seed, 83, 5, 7))
  const f = o.farm
  const sizeClass = o.sizes.farmstead
  const radius = o.radius > 0 ? o.radius : (sizeClass.radius[0] + sizeClass.radius[1]) / 2
  const [cx, cz] = o.center
  const c = o.climate ?? climate
  const architecture: ArchitectureName = o.architecture !== 'auto' ? o.architecture : c ? architectureFor(c) : 'temperate'
  const arch = o.architectures[architecture]
  const [L, W] = f.yard
  const given = f.road.length >= 2

  // 1. Ground: enough to cover the fields, the driveway and the road stretch.
  const toRoad = given ? nearestOnPolyline(f.road, cx, cz).distance : f.roadDistance
  const extent = (Math.max(radius, Math.min(toRoad, f.maxDriveway) + f.roadSpan) + f.search) * 1.1
  const site = Site.around(cx, cz, extent, o.siteResolution > 0 ? o.siteResolution : Math.min(25, Math.max(8, extent / 60)))
  for (let j = 0; j < site.count; j++) {
    site.fillRow(ground, j)
    if ((j & 7) === 7) yield
  }
  const districts = new DistrictMap(o.districts, sizeClass.districts, cx, cz, radius, seed)
  const empty: CityPlan = {
    center: [cx, cz], radius, style: sizeClass.style, architecture, site, districts, graph: new RoadGraph(30), profiles: [], blocks: [], lots: [], buildings: [], population: 0, farm: null,
  }

  // 2. The farmyard: the first spot (spiralling out) that is dry and gentle, with a dry, short enough driveway.
  const angle0 = rand() * Math.PI * 2
  const roadWidth = o.roads[f.roadType].width / 2
  // Wet stretches along a→b as [from, to] distances (each gets a bridge); null if one is too wide to bridge or b is wet.
  const wetRuns = (ax: number, az: number, bx: number, bz: number): [number, number][] | null => {
    const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(len / 4))
    const runs: [number, number][] = []
    let start = -1
    for (let i = 0; i <= n; i++) {
      const wet = site.wet(ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n), d = (len * i) / n
      if (wet && start < 0) start = Math.max(0, d - len / n)
      if (!wet && start >= 0) { runs.push([start, d]); start = -1 }
    }
    return start >= 0 || runs.some(([a, b]) => b - a > o.roads.maxBridge) ? null : runs
  }
  let yard: { x: number; z: number; ux: number; uz: number; px: number; pz: number; bridges: [number, number][] } | null = null
  const step = 15
  for (let k = 0; k * step <= f.search && !yard; k++) {
    const n = k ? 6 * k : 1
    for (let i = 0; i < n && !yard; i++) {
      const a = angle0 + (i / n) * Math.PI * 2
      const x = cx + Math.cos(a) * k * step, z = cz + Math.sin(a) * k * step
      let ux = Math.cos(angle0), uz = Math.sin(angle0), px: number, pz: number
      if (given) {
        const p = nearestOnPolyline(f.road, x, z)
        if (p.distance < L / 2 + roadWidth + o.terrain.roadFalloff + 4 || p.distance > f.maxDriveway) continue
        ux = (p.x - x) / p.distance; uz = (p.z - z) / p.distance; px = p.x; pz = p.z
      } else {
        px = x + ux * (L / 2 + f.roadDistance); pz = z + uz * (L / 2 + f.roadDistance)
      }
      const at = (u: number, v: number): Vec2 => [x + ux * u - uz * v, z + uz * u + ux * v]
      const probes = [[0, 0], [-L / 2, -W / 2], [L / 2, -W / 2], [L / 2, W / 2], [-L / 2, W / 2], [0, -W / 2], [0, W / 2], [-L / 2, 0], [L / 2, 0]].map(([u, v]) => at(u, v))
      if (probes.some(([qx, qz]) => !site.contains(qx, qz) || site.wet(qx, qz) || site.slope(qx, qz) > f.maxSlope)) continue
      const [fx, fz] = at(L / 2, 0)
      // The driveway must meet the road on dry ground.
      const bridges = site.contains(px, pz) && !site.wet(px, pz) ? wetRuns(px, pz, fx, fz) : null
      if (!bridges) continue
      yard = { x, z, ux, uz, px, pz, bridges }
    }
  }
  if (!yard) return empty
  const { x: yx, z: yz, ux, uz } = yard
  const at = (u: number, v: number): Vec2 => [yx + ux * u - uz * v, yz + uz * u + ux * v]
  const box = (u: number, v: number, along: number, across: number): OrientedBox => ({ center: at(u, v), axis: [-uz, ux], halfLength: across / 2, halfWidth: along / 2 })

  // 3. Roads: the stretch of the road past the driveway, and the driveway (a dirt track) up to the yard.
  let road: Vec2[]
  if (given) road = f.road
  else {
    const n = Math.ceil(f.roadSpan / 30)
    road = []
    for (let i = -n; i <= n; i++) road.push([yard.px - uz * i * 30, yard.pz + ux * i * 30])
  }
  const near = nearestOnPolyline(road, yard.px, yard.pz)
  const piece = stretch(road, near.segment, near.t, f.roadSpan)
  const graph = new RoadGraph(30)
  const rc = o.roads[f.roadType]
  // Nodes on dry ground only; the road bridges whatever water lies between two of them. It stops at the site edge.
  let prev = -1, access = -1, over = false
  piece.points.forEach(([x, z], i) => {
    if (!site.contains(x, z)) { prev = -1; over = false; return }
    if (site.wet(x, z)) { over = true; return }
    const node = graph.addNode(x, z)
    if (prev >= 0) {
      const a = graph.nodes[prev]
      graph.addEdge(prev, node, f.roadType, rc.width, rc.sidewalk, over || !(wetRuns(a.x, a.z, x, z)?.length === 0))
    }
    if (i === piece.at) access = node
    prev = node
    over = false
  })
  if (access < 0 || !graph.nodes[access].edges.length) return empty // no road to join (the access point is dry, so only a road off the site)
  // Driveway from the road to the yard: ~30 m steps over dry ground, one bridge per stream it crosses.
  const [fx, fz] = at(L / 2, 0)
  const dl = Math.hypot(fx - yard.px, fz - yard.pz), dx = (fx - yard.px) / (dl || 1), dz = (fz - yard.pz) / (dl || 1)
  let done = 0
  prev = access
  const lane = (to: number, bridge: boolean) => {
    const n = bridge ? 1 : Math.max(1, Math.ceil((to - done) / 30))
    for (let i = 1; i <= n; i++) {
      const d = done + ((to - done) * i) / n, node = graph.addNode(yard.px + dx * d, yard.pz + dz * d)
      graph.addEdge(prev, node, 'minor', o.roads.minor.width, 0, bridge)
      prev = node
    }
    done = to
  }
  for (const [a, b] of yard.bridges) {
    if (a > done + 0.5) lane(a, false)
    lane(b, true)
  }
  if (dl > done + 0.5) lane(dl, false)
  assignSurfaces(graph, districts, sizeClass.surfaces, null, o.roads)
  const profiles = gradeRoads(graph, site, o.terrain)
  yield

  // 4. The farmyard and its buildings: farmhouse by the entrance, machine shed across from it, barn and silos behind.
  const yardPoly = [at(-L / 2, -W / 2), at(L / 2, -W / 2), at(L / 2, W / 2), at(-L / 2, W / 2)]
  const lot: PlannedLot = { id: 0, block: -1, polygon: yardPoly, street: [false, true, false, false], front: 1, area: L * W, center: [yx, yz], district: 'farmland' }
  const s = rand() < 0.5 ? 1 : -1
  const buildings: Building[] = []
  const add = (b: Building) => {
    if (!b.parts.every((p) => p.tiers[0].polygon.every(([x, z]) => pointInPolygon(x, z, yardPoly)))) return
    if (buildings.some((o) => o.parts.some((p) => b.parts.some((q) => polygonsOverlap(p.tiers[0].polygon, q.tiers[0].polygon))))) return
    b.id = buildings.length
    settleBuilding(b, site, o.terrain)
    buildings.push(b)
  }
  const tier = (r: OrientedBox, top: number) => [{ polygon: boxCorners(r), top }]
  // Farmhouse: ridge along the yard front, facing the driveway.
  const hw = span(f.farmhouse.width, rand), hd = span(f.farmhouse.depth, rand), floors = Math.round(span(f.farmhouse.floors, rand))
  const house = box(L / 2 - 6 - hd / 2, s * (W / 2 - 5 - hw / 2), hd, hw)
  const houseRoof = pick(arch.houseRoofs, rand())
  const roof = houseRoof === 'skillion' || houseRoof === 'sawtooth' ? 'gable' : houseRoof
  const hb = assembleBuilding(lot, 'farmhouse', 'house', [{ tiers: tier(house, floors * o.buildings.floorHeight.house), rect: house, roof, roofHeight: roof === 'flat' ? 0 : house.halfWidth * span(arch.pitch, rand) }],
    { material: pick(arch.houseMaterials, rand()), roofMaterial: pick(arch.roofMaterials, rand()), floors, floorHeight: o.buildings.floorHeight.house }, rand())
  hb.population = (hb.area * floors) / o.buildings.areaPerPerson
  add(hb)
  // The gravel apron: the whole yard but the farmhouse's side, which stays grass.
  const [va, vb] = [-s * (W / 2 - 1), s * (W / 2 - 8 - hw)].sort((a, b) => a - b)
  const apron = [at(-L / 2 + 1, va), at(L / 2, va), at(L / 2, vb), at(-L / 2 + 1, vb)]
  // Barn at the back, ridge across the yard.
  const bw = span(f.barn.width, rand), bl = Math.min(span(f.barn.length, rand), W - 12), wall = span(f.barn.wallHeight, rand)
  const bv = -s * (W / 2 - 6 - bl / 2)
  const barn = box(-L / 2 + 6 + bw / 2, bv, bw, bl)
  const gambrel = rand() < f.barn.gambrel
  add(assembleBuilding(lot, 'barn', 'shed', [{ tiers: tier(barn, wall), rect: barn, roof: gambrel ? 'gambrel' : 'gable', roofHeight: barn.halfWidth * (gambrel ? 1.15 : 0.8), blank: true }],
    { material: 'wood', roofMaterial: 'metal', floors: 1, floorHeight: wall, tint: f.barn.colors[Math.floor(rand() * f.barn.colors.length) % f.barn.colors.length] }, rand()))
  // Silos in a row beside the barn's far end.
  const silos = Math.round(span(f.silos.count, rand))
  const sr = span(f.silos.radius, rand), sh = span(f.silos.height, rand)
  for (let i = 0; i < silos; i++) {
    const [qx, qz] = at(-L / 2 + 6 + sr + i * (2 * sr + 1.5), bv + s * (bl / 2 + 3 + sr))
    const ring: Vec2[] = Array.from({ length: 24 }, (_, k) => [qx + Math.cos((k / 24) * Math.PI * 2) * sr, qz + Math.sin((k / 24) * Math.PI * 2) * sr])
    add(assembleBuilding(lot, 'silo', 'shed', [{ tiers: [{ polygon: ring, top: sh }], rect: null, roof: 'cone', roofHeight: sr * 0.45, blank: true }],
      { material: 'metal', roofMaterial: 'metal', floors: 1, floorHeight: sh }, rand()))
  }
  // Machine shed across the driveway from the house, clear of the lane through the yard.
  const ew = span(f.shed.width, rand), el = Math.min(span(f.shed.length, rand), W / 2 - 11), eh = span(f.shed.height, rand)
  const shed = box(L / 2 - 8 - ew / 2, -s * (W / 2 - 5 - el / 2), ew, el)
  add(assembleBuilding(lot, 'machineShed', 'shed', [{ tiers: tier(shed, eh), rect: shed, roof: 'gable', roofHeight: shed.halfWidth * 0.3, blank: true }],
    { material: 'metal', roofMaterial: 'metal', floors: 1, floorHeight: eh }, rand()))
  yield

  // 5. Fields: a patchwork of rectangles aligned with the driveway, anchored at the yard front and the driveway.
  const lines = (from: number, dir: 1 | -1, salt: number) => {
    const out = [from]
    // At least a metre a step, so a zero field size can't stall.
    for (let k = 0, x = from; Math.abs(x) < radius + f.fieldSize[1]; k++) out.push((x += dir * Math.max(1, span(f.fieldSize, mulberry32(hash4(seed, salt, k, 91))))))
    return out
  }
  const us = [...lines(L / 2 + f.fieldGap, -1, 1).reverse(), ...lines(L / 2 + f.fieldGap, 1, 2).slice(1)]
  const vs = [...lines(0, -1, 3).reverse(), ...lines(0, 1, 4).slice(1)]
  const clear = (w: number) => w / 2 + o.terrain.roadFalloff + f.fieldGap / 2
  const segments = graph.edges.map((e) => ({ a: graph.nodes[e.a], b: graph.nodes[e.b], clear: clear(e.width) }))
  const fields: Field[] = []
  const g: [number, number] = [0, 0]
  const weights = CROPS.map((crop) => {
    const r = f.crops[crop], t = c?.temperature ?? 12, m = c?.moisture ?? 0.5
    const fit = (x: number, [lo, hi]: [number, number], margin: number) => Math.max(0, 1 - Math.max(lo - x, x - hi, 0) / Math.max(1e-6, margin))
    return r.weight * fit(t, r.temperature, f.cropMargin[0]) * fit(m, r.moisture, f.cropMargin[1])
  })
  for (let i = 0; i + 1 < us.length; i++) for (let j = 0; j + 1 < vs.length; j++) {
    const fr = mulberry32(hash4(seed, i, j, 97))
    let [u0, u1, v0, v1] = [us[i] + f.fieldGap / 2, us[i + 1] - f.fieldGap / 2, vs[j] + f.fieldGap / 2, vs[j + 1] - f.fieldGap / 2]
    if (u1 <= u0 || v1 <= v0 || (u1 - u0) * (v1 - v0) < f.fieldMinArea || Math.hypot((u0 + u1) / 2, (v0 + v1) / 2) > radius) continue
    // Keep clear of the yard (largest remnant of the cell outside it) and of the driveway along v = 0.
    const yu = L / 2 + clear(0), yv = W / 2 + clear(0)
    if (u0 < yu && u1 > -yu && v0 < yv && v1 > -yv) {
      const rest = [[u0, Math.min(u1, -yu), v0, v1], [Math.max(u0, yu), u1, v0, v1], [u0, u1, v0, Math.min(v1, -yv)], [u0, u1, Math.max(v0, yv), v1]]
      ;[u0, u1, v0, v1] = rest.reduce((m, r) => ((r[1] - r[0]) * (r[3] - r[2]) > (m[1] - m[0]) * (m[3] - m[2]) && r[1] > r[0] && r[3] > r[2] ? r : m), [0, 0, 0, 0])
      if (u1 <= u0) continue
    }
    let poly: Vec2[] = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)]
    // Clip off the roads (the driveway and the road stretch), each by its own line, offset by its clearance.
    for (const sg of segments) {
      const ex = sg.b.x - sg.a.x, ez = sg.b.z - sg.a.z, el2 = Math.hypot(ex, ez) || 1
      if (segmentPolygonDistance(sg.a.x, sg.a.z, sg.b.x, sg.b.z, poly) >= sg.clear) continue
      const [mx, mz] = polygonCentroid(poly)
      let nx = -ez / el2, nz = ex / el2
      if ((mx - sg.a.x) * nx + (mz - sg.a.z) * nz < 0) { nx = -nx; nz = -nz }
      poly = clipPolygon(poly, poly.map(() => 0), sg.a.x + nx * sg.clear, sg.a.z + nz * sg.clear, -nx, -nz, 0).polygon
      if (poly.length < 3) break
    }
    if (poly.length < 3 || polygonArea(poly) < f.fieldMinArea) continue
    if (segments.some((sg) => segmentPolygonDistance(sg.a.x, sg.a.z, sg.b.x, sg.b.z, poly) < sg.clear * 0.9)) continue // a bend the clip lines missed
    // Dry all over (a grid of probes), inside the site and not too steep.
    const [mx, mz] = polygonCentroid(poly)
    const probes = [...poly.map(([x, z]): Vec2 => [x + (mx - x) * 0.1, z + (mz - z) * 0.1]), [mx, mz] as Vec2]
    if (probes.some(([x, z]) => !site.contains(x, z))) continue
    if (gridPoints(poly, Math.max(site.cell, 8)).some(([x, z]) => site.wet(x, z))) continue
    const slope = probes.reduce((m, [x, z]) => m + site.slope(x, z), 0) / probes.length
    if (slope > f.fieldMaxSlope) continue
    const total = weights.reduce((a, b) => a + b, 0)
    const crop: Crop = total > 0 ? CROPS[pickIndex(weights, fr() * total)] : 'pasture'
    site.gradient(mx, mz, g)
    const contour = slope > f.contourSlope
    const gl = Math.hypot(g[0], g[1]) || 1
    const rows: [number, number] = contour ? [-g[1] / gl, g[0] / gl] : u1 - u0 >= v1 - v0 ? [ux, uz] : [-uz, ux]
    const colors = f.colors[crop]
    fields.push({ id: fields.length, polygon: poly, crop, rows, rowSpacing: f.rowSpacing[crop], contour, color: colors[Math.floor(fr() * colors.length) % colors.length] ?? '#6a7d45' })
  }

  // 6. Props and the tractor: fences round pastures, a row of bales in a cut field, the tractor at work or in the yard.
  const props: FarmProp[] = []
  for (const fl of fields) {
    if (fl.crop !== 'pasture') continue
    fl.polygon.forEach((a, k) => {
      const b = fl.polygon[(k + 1) % fl.polygon.length]
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.floor(l / Math.max(0.5, f.fences.length))
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t
        props.push({ kind: 'fence', x, y: site.height(x, z), z, yaw: Math.atan2(-(b[1] - a[1]), b[0] - a[0]), seed: hash4(seed, fl.id, k, i), variant: f.fences.variant, length: l / n })
      }
    })
  }
  const byDistance = fields.slice().sort((p, q) => Math.hypot(...sub(polygonCentroid(p.polygon), yx, yz)) - Math.hypot(...sub(polygonCentroid(q.polygon), yx, yz)) || p.id - q.id)
  const cut = byDistance.find((fl) => fl.crop === 'wheat' || fl.crop === 'fallow')
  if (cut) {
    const [mx, mz] = polygonCentroid(cut.polygon)
    const n = Math.round(span(f.hayBales, rand)), gap = 9 + rand() * 6
    for (let i = 0; i < n; i++) {
      const d = (i - (n - 1) / 2) * gap, x = mx + cut.rows[0] * d, z = mz + cut.rows[1] * d
      if (pointInPolygon(x, z, cut.polygon)) props.push({ kind: 'hay-bale', x, y: site.height(x, z), z, yaw: rand() * Math.PI * 2, seed: hash4(seed, i, 5, 101), variant: 'round' })
    }
  }
  const vehicleSpots: VehicleSpot[] = []
  const work = byDistance.find((fl) => fl.crop !== 'pasture')
  if (work && rand() < f.tractorWorking) {
    const [mx, mz] = polygonCentroid(work.polygon)
    const dir = rand() < 0.5 ? 1 : -1
    vehicleSpots.push({ kind: 'tractor', asset: 'vehicles/tractor', position: [mx, site.height(mx, mz), mz], heading: Math.atan2(work.rows[0] * dir, work.rows[1] * dir), working: true, field: work.id })
  } else {
    const [x, z] = at(L / 2 - 8 - ew - 6, -s * (W / 2 - 5 - el / 2))
    vehicleSpots.push({ kind: 'tractor', asset: 'vehicles/tractor', position: [x, site.height(x, z), z], heading: Math.atan2(ux, uz), working: false, field: -1 })
  }

  let population = 0
  for (const b of buildings) population += b.population
  return {
    center: [cx, cz], radius, style: sizeClass.style, architecture, site, districts, graph, profiles, blocks: [], lots: [lot], buildings, population: Math.max(1, Math.round(population)),
    farm: { yard: yardPoly, apron, access: [yard.px, yard.pz], fields, vehicleSpots, props },
  }
}

const sub = ([x, z]: Vec2, ox: number, oz: number): [number, number] => [x - ox, z - oz]

function pickIndex(weights: number[], r: number): number {
  for (let i = 0; i < weights.length; i++) if ((r -= weights[i]) < 0) return i
  return weights.length - 1
}

/** Points of a `step` grid inside a polygon, plus its vertices. */
function gridPoints(p: Vec2[], step: number): Vec2[] {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
  for (const [x, z] of p) { minX = Math.min(minX, x); minZ = Math.min(minZ, z); maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z) }
  const out: Vec2[] = p.slice()
  for (let x = minX + step / 2; x < maxX; x += step) for (let z = minZ + step / 2; z < maxZ; z += step) if (pointInPolygon(x, z, p)) out.push([x, z])
  return out
}

/** Distance from a segment to a polygon (0 if it crosses or lies inside). */
function segmentPolygonDistance(ax: number, az: number, bx: number, bz: number, p: Vec2[]): number {
  if (pointInPolygon(ax, az, p) || pointInPolygon(bx, bz, p)) return 0
  let d = Infinity
  for (let i = 0; i < p.length; i++) {
    const [cx, cz] = p[i], [dx, dz] = p[(i + 1) % p.length]
    if (segmentIntersection(ax, az, bx, bz, cx, cz, dx, dz)) return 0
    d = Math.min(d, pointSegment(cx, cz, ax, az, bx, bz).distance, pointSegment(ax, az, cx, cz, dx, dz).distance, pointSegment(bx, bz, cx, cz, dx, dz).distance)
  }
  return d
}
