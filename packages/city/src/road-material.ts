import { attribute, float } from 'three/tsl'
import { CENTRE_LINES, RoadSurface, type CentreLine, type RoadSurfaceInput } from 'threejs-props'
import type { CityUniforms } from './facade-material.ts'
import type { RoadType } from './graph.ts'
import type { RoadLookOptions } from './options.ts'
import { eq, type N } from './shader-utils.ts'

/** Markings of one road class. */
export interface RoadMarkings {
  /** Lanes per direction. */
  lanes: number
  /** Centre line style. */
  centreLine: CentreLine
  /** Dashed lines between lanes. */
  laneLines: boolean
  /** Solid lines along both edges. */
  edgeLines: boolean
}

/** Markings per road class: arterials a double centre line and lanes each way, collectors a single dashed line, local streets bare edges. */
export const ROAD_MARKINGS: Record<RoadType, RoadMarkings> = {
  primary: { lanes: 2, centreLine: 'double', laneLines: true, edgeLines: true },
  secondary: { lanes: 1, centreLine: 'dashed', laneLines: false, edgeLines: true },
  minor: { lanes: 1, centreLine: 'none', laneLines: false, edgeLines: false },
}

/** The city's {@link RoadLookOptions} as a threejs-props {@link RoadSurface} look. Marking styles come per road class. */
export function roadSurfaceLook(look: RoadLookOptions): RoadSurfaceInput {
  return {
    wear: look.wear,
    markings: look.markings,
    colors: {
      asphalt: look.colors.asphalt,
      cobblestone: look.colors.cobblestone,
      gravel: look.colors.gravel,
      dirt: look.colors.dirt,
      sidewalk: look.sidewalk,
      curb: look.kerb,
      concrete: look.concrete,
      marking: look.marking,
      centreLine: look.centerLine,
    },
  }
}

const CLASSES: readonly RoadType[] = ['primary', 'secondary', 'minor']

/** A node that picks `pick` for the road class in `type` (the `road.y` vertex attribute). */
function perClass(type: N, pick: (m: RoadMarkings) => number): N {
  return CLASSES.reduce((node: N, k, i) => node.add(eq(type, i).mul(pick(ROAD_MARKINGS[k]))), float(0))
}

/**
 * Road material: threejs-props' {@link RoadSurface} on the city's road mesh, so city streets and props
 * road ribbons share one look and one weather model. Geometry attributes: `uv` (metres across from the
 * centreline, metres along) and `road` = (half carriageway width, class, surface, part) — see
 * `ROAD_VERTEX`. The class drives the markings ({@link ROAD_MARKINGS}) through the material's per-edge
 * inputs, so arterials, collectors and local streets are painted differently in one draw call. Weather
 * comes live from `uniforms.roadWeather`; change the look with {@link roadSurfaceLook} and
 * `RoadSurface.set`.
 */
export function createRoadMaterial(u: CityUniforms, look: RoadLookOptions): RoadSurface {
  const r = attribute('road', 'vec4') as N
  const w = u.roadWeather as N
  return new RoadSurface(roadSurfaceLook(look), {
    part: r.w,
    halfWidth: r.x,
    surfaceIndex: r.z,
    lanes: perClass(r.y, (m) => m.lanes),
    centreLine: perClass(r.y, (m) => CENTRE_LINES.indexOf(m.centreLine)),
    laneLines: perClass(r.y, (m) => (m.laneLines ? 1 : 0)),
    edgeLines: perClass(r.y, (m) => (m.edgeLines ? 1 : 0)),
    states: { wetness: w.x, snow: w.y, burn: w.z, damage: w.w },
  })
}
