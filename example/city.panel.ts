import {
  ARCHITECTURES,
  compositePopulationMap,
  DEFAULT_CITY,
  generateNetworks,
  generatePopulation,
  nearestOnPolyline,
  planCities,
  renderPopulationMap,
  SETTLEMENT_SIZES,
  type CityInput,
  type CitySite,
  type Network,
  type PopulationData,
  type PopulationMode,
  type SettlementSize
} from 'threejs-city'
import { renderWorldMap, type World } from 'threejs-biomes'
import type { PanelSpec } from './panel'

// Panel manifest of the city sandboxes (city.ts and city-r3f.tsx); checked by scripts/options-coverage.mjs.
const surfaces = ['asphalt', 'cobblestone', 'gravel', 'dirt']
const unit: [number, number, number] = [0, 1, 0.01]

/**
 * The settlements both sandboxes show, from a population with every class from farmsteads to a metropolis: for a
 * class, the flattest of its eight largest settlements (farms: of the sixteen nearest a road, away from rivers and
 * coasts so the fields have room), else the smallest settlement of all. Farmsteads come with the nearest road of the
 * population's network, for their driveway.
 */
export function demoSites(world: World): (size: SettlementSize) => CitySite {
  const { data, network } = plannerPopulation(world)
  const sites = planCities(data, undefined, network) // largest first, farmsteads last
  const cell = (s: CitySite) => data.cells[data.index.get(s.settlement.cell)!]
  const road = (s: CitySite) => (s.road ? nearestOnPolyline(s.road.points, s.x, s.z).distance : 0)
  const score = (s: CitySite) => cell(s).slope + (s.size === 'farmstead' ? cell(s).water * 0.3 : 0)
  return (size) =>
    sites
      .filter((s) => s.size === size)
      .sort((a, b) => road(a) - road(b))
      .slice(0, size === 'farmstead' ? 16 : 8)
      .sort((a, b) => score(a) - score(b))[0] ?? sites.at(-1)!
}

const populations = new WeakMap<World, { data: PopulationData; network: Network }>()

/** The population that places the sandboxes' cities, one per world: the map and the sites read the same data. */
export function plannerPopulation(world: World): { data: PopulationData; network: Network } {
  let p = populations.get(world)
  if (!p) {
    const data = generatePopulation(world, { radius: 24_000, totalPopulation: 3_000_000, zipf: 1.5 })
    populations.set(world, (p = { data, network: generateNetworks(data) }))
  }
  return p
}

/** The planner map's controls (`visible` is not a `renderPopulationMap` option). */
export interface PlannerMapOptions {
  visible: boolean
  mode: PopulationMode
  /** −1 = the data's own H3 resolution. */
  hexResolution: number
  settlements: boolean
  networks: boolean
}

export const DEFAULT_PLANNER_MAP: PlannerMapOptions = {
  visible: true,
  mode: 'density',
  hexResolution: -1,
  settlements: true,
  networks: true
}

export const PLANNER_MODES: PopulationMode[] = ['density', 'landUse', 'lights', 'habitability']

/**
 * Draws the planner's hex map of the whole population region into `canvas` (over the world's own map), marking `site`
 * when given: the 2D minimap beside the city, from the same population that chose the site.
 */
export function drawPlannerMap(
  canvas: HTMLCanvasElement,
  world: World,
  { data, network }: { data: PopulationData; network: Network },
  { visible, ...map }: PlannerMapOptions,
  site?: [number, number]
) {
  canvas.style.display = visible ? '' : 'none'
  if (!visible) return
  const n = canvas.width
  const size = data.options.radius * 2
  const [cx, cz] = data.options.center
  const { hexResolution, ...rest } = map
  const base = renderWorldMap(world, { center: [cx, cz], size, resolution: n })
  const top = renderPopulationMap(
    data,
    { ...rest, hexResolution: hexResolution < 0 ? null : hexResolution, resolution: n },
    network
  )
  const ctx = canvas.getContext('2d')!
  ctx.putImageData(new ImageData(compositePopulationMap(base, top), n), 0, 0)
  if (site) {
    const x = ((site[0] - cx) / size + 0.5) * n,
      y = ((site[1] - cz) / size + 0.5) * n
    ctx.beginPath()
    ctx.arc(x, y, 5, 0, Math.PI * 2)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.stroke()
  }
}

/** The site's own settings for a `City` there: centre, radius and (farms) the road the driveway joins. */
export function siteInput(site: CitySite): CityInput {
  return {
    center: [site.x, site.z],
    radius: site.radius,
    ...(site.road ? { farm: { road: site.road.points, roadType: site.road.type } } : {})
  }
}

export const panels: PanelSpec = {
  'threejs-city': {
    City: {
      defaults: DEFAULT_CITY,
      arrays: true,
      skip: {
        center: 'set from a site of that class planCities finds (`demoSites`; keys 1–6 or `size`)',
        climate: 'null = read from the world at the centre; pick an `architecture` instead',
        oldTown: 'null (no old-town core) in every default size class; the panel cannot edit null',
        'farm.road': "a polyline: set from the population's road network for the farm site (`siteInput`)"
      },
      choices: {
        size: [...SETTLEMENT_SIZES],
        roadType: ['primary', 'secondary', 'minor'],
        variant: ['rail', 'picket', 'stone', 'adobe'],
        style: ['auto', 'grid', 'radial', 'organic'],
        architecture: ['auto', ...Object.keys(ARCHITECTURES)],
        primary: surfaces,
        secondary: surfaces,
        minor: surfaces
      },
      ranges: {
        seed: [0, 1000, 1],
        radius: [0, 2500, 1],
        siteResolution: [0, 50, 1],
        arms: [0, 8, 1],
        delay: [0, 20, 1],
        gridAngle: [-3.14, 3.14, 0.01],
        lotJitter: unit,
        night: unit,
        lit: unit,
        wear: unit,
        variation: unit,
        through: unit,
        branchChance: unit,
        wetness: unit,
        snow: unit,
        burn: unit,
        damage: unit,
        buildBudget: [1, 50, 1],
        gambrel: unit,
        tractorWorking: unit,
        fieldOffset: [0, 1, 0.01],
        fieldStep: [2, 20, 1]
      }
    }
  }
}

/** The classes city-r3f.tsx shows (with `useSpec`, from this manifest); checked the same way. */
export const r3f = { 'city-r3f.tsx': ['City'] }
