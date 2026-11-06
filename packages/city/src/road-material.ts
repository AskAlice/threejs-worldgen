import { attribute } from 'three/tsl'
import { RoadSurface, type RoadSurfaceInput } from 'threejs-props'
import type { CityUniforms } from './facade-material.ts'
import type { RoadLookOptions } from './options.ts'
import type { N } from './shader-utils.ts'

/** The city's {@link RoadLookOptions} as a threejs-props {@link RoadSurface} look. */
export function roadSurfaceLook(look: RoadLookOptions): RoadSurfaceInput {
  return {
    wear: look.wear,
    centreLine: look.markings ? 'dashed' : 'none',
    laneLines: look.markings,
    edgeLines: look.markings,
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

/**
 * Road material: threejs-props' {@link RoadSurface} on the city's road mesh, so city streets and props
 * road ribbons share one look and one weather model. Geometry attributes: `uv` (metres across from the
 * centreline, metres along) and `road` = (half carriageway width, class, surface, part) — see
 * `ROAD_VERTEX`. Weather comes live from `uniforms.roadWeather`; change the look with
 * {@link roadSurfaceLook} and `RoadSurface.set`.
 */
export function createRoadMaterial(u: CityUniforms, look: RoadLookOptions): RoadSurface {
  const r = attribute('road', 'vec4') as N
  const w = u.roadWeather as N
  return new RoadSurface(roadSurfaceLook(look), {
    part: r.w,
    halfWidth: r.x,
    surfaceIndex: r.z,
    states: { wetness: w.x, snow: w.y, burn: w.z, damage: w.w },
  })
}
