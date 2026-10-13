// Shared by the corn sandboxes (corn.ts, corn-r3f.tsx): gently rolling farmland, three corn fields in the shape
// threejs-city's farm planner hands over, a grass meadow around them, and a box "tractor" driving laps through the
// mature field (the real tractor comes from threejs-vehicles, #85).
import * as THREE from 'three/webgpu'
import { GrassMap, pointInPolygon, type Corn, type CornField, type CornInput } from 'threejs-grass'

/** Gently rolling farmland. */
export const farm = (x: number, z: number) => Math.sin(x * 0.006) * 3 + Math.cos(z * 0.0045) * 2.5 + Math.sin((x - z) * 0.013) * 0.8

export function farmGeometry(size = 1400, segments = 280) {
  const geo = new THREE.PlaneGeometry(size, size, segments, segments).rotateX(-Math.PI / 2)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) pos.setY(i, farm(pos.getX(i), pos.getZ(i)))
  geo.computeVertexNormals()
  return geo
}

const field = (polygon: [number, number][], rowSpacing = 0.76, rowDirection?: number): CornField => {
  const [[x0, z0], [x1, z1]] = polygon
  return { polygon, rowDirection: rowDirection ?? Math.atan2(z1 - z0, x1 - x0), rowSpacing }
}

/** Three fields at different stages, each one Corn instance: mature (with the tractor), harvested, young. */
export const FIELDS: { name: string; field: CornField; input: CornInput }[] = [
  { name: 'mature', field: field([[-120, -90], [140, -100], [150, 85], [-110, 95]]), input: { growth: 0.8 } },
  { name: 'harvested', field: field([[165, -100], [330, -112], [342, 88], [172, 84]], 0.76, Math.PI / 2 - 0.05), input: { growth: 1, harvested: true, seed: 2 } },
  { name: 'young', field: field([[-108, 112], [152, 102], [162, 262], [-96, 270]], 0.76), input: { growth: 0.38, seed: 3 } },
]

/** Grass everywhere except the fields (with a 1.5 m headland of grass) and the farm track between them. */
export function farmGrassMap() {
  const map = new GrassMap({ center: [100, 80], size: 760, resolution: 1024 })
  const r = map.resolution
  const texel = map.size / r
  for (let j = 0; j < r; j++) {
    for (let i = 0; i < r; i++) {
      const x = map.minX + (i + 0.5) * texel
      const z = map.minZ + (j + 0.5) * texel
      const inField = FIELDS.some(({ field }) => pointInPolygon(field.polygon, x, z))
      const track = Math.abs(x - 157 - Math.sin(z * 0.02) * 1.5) < 2.2 || Math.abs(z - 98 - Math.sin(x * 0.015) * 1.2) < 2
      if (inField || track) map.data[(j * r + i) * 4] = 0
    }
  }
  map.texture.needsUpdate = true
  return map
}

/** The tractor's lap: two passes along the rows of the mature field, joined by headland turns. 3 m/s. */
const LANES = { x0: -40, x1: 60, z: -8, gap: 12, speed: 3 }
const turn = Math.PI * (LANES.gap / 2)
const lap = 2 * (LANES.x1 - LANES.x0) + 2 * turn

/** Tractor position (XZ) and heading (unit XZ) at time `t` seconds. */
export function tractorAt(t: number): { x: number; z: number; dx: number; dz: number } {
  const { x0, x1, z, gap } = LANES
  let s = ((t * LANES.speed) % lap + lap) % lap
  const straight = x1 - x0
  const r = gap / 2
  if (s < straight) return { x: x0 + s, z, dx: 1, dz: 0 }
  s -= straight
  if (s < turn) {
    const a = s / r - Math.PI / 2
    return { x: x1 + Math.cos(a) * r, z: z + r + Math.sin(a) * r, dx: -Math.sin(a), dz: Math.cos(a) }
  }
  s -= turn
  if (s < straight) return { x: x1 - s, z: z + gap, dx: -1, dz: 0 }
  s -= straight
  const a = s / r + Math.PI / 2
  return { x: x0 + Math.cos(a) * r, z: z + r + Math.sin(a) * r, dx: -Math.sin(a), dz: Math.cos(a) }
}

/** Tractor radius (metres) for its interactor: the strip it flattens is twice this. */
export const TRACTOR_RADIUS = 1.4

/** A box tractor (body, cab, four wheels), its origin on the ground under its centre. */
export function createTractor() {
  const g = new THREE.Group()
  const paint = new THREE.MeshStandardNodeMaterial({ color: '#7d1a12', roughness: 0.45, metalness: 0.2 })
  const dark = new THREE.MeshStandardNodeMaterial({ color: '#1b1b1b', roughness: 0.9 })
  const glass = new THREE.MeshStandardNodeMaterial({ color: '#223038', roughness: 0.1, metalness: 0.3 })
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat)
    m.position.set(x, y, z)
    m.castShadow = m.receiveShadow = true
    g.add(m)
    return m
  }
  add(new THREE.BoxGeometry(3.6, 1.1, 1.3), paint, 0.3, 1.25, 0)
  add(new THREE.BoxGeometry(1.5, 1.5, 1.5), glass, -0.7, 2.5, 0)
  add(new THREE.BoxGeometry(1.6, 0.08, 1.6), paint, -0.7, 3.28, 0)
  for (const [x, r, w] of [[-1, 0.85, 0.55], [1.4, 0.55, 0.4]]) {
    for (const z of [-1, 1]) add(new THREE.CylinderGeometry(r, r, w, 24).rotateX(Math.PI / 2), dark, x, r, z * 1.05)
  }
  return g
}

/** Places the tractor at time `t` on the terrain, facing its heading. */
export function driveTractor(tractor: THREE.Object3D, t: number) {
  const p = tractorAt(t)
  tractor.position.set(p.x, farm(p.x, p.z), p.z)
  tractor.rotation.y = Math.atan2(-p.dz, p.dx)
}

/** Flattens the path the tractor drove from 0 to `t` seconds (so a freshly loaded page shows its track). */
export function predrive(corn: Corn, t: number) {
  for (let s = 0; s <= t; s += 0.15) {
    const p = tractorAt(s)
    corn.flatten(p.x, p.z, TRACTOR_RADIUS, p.dx, p.dz)
  }
}

/** Sun elevation and azimuth (degrees) for the sandboxes: mid-morning light from the side of the default views. */
export const SUN: [elevation: number, azimuth: number] = [38, 140]

/** Camera views (`?view=2|20|200|path`): eye height or altitude in metres. */
export const VIEWS: Record<string, { position: [number, number, number]; target: [number, number, number] }> = {
  2: { position: [-6, 1.7, -97.2], target: [8, 1.5, -91] },
  20: { position: [-34, 20, -112], target: [0, 0, -62] },
  200: { position: [-90, 200, -270], target: [40, 0, 10] },
  path: { position: [2, 26, -48], target: [12, 0, -2] },
}

/** A view's camera position and target, with heights measured from the ground. */
export function view(name: string) {
  const v = VIEWS[name] ?? VIEWS[20]
  const [px, py, pz] = v.position
  const [tx, ty, tz] = v.target
  return { position: [px, farm(px, pz) + py, pz] as [number, number, number], target: [tx, farm(tx, tz) + ty, tz] as [number, number, number] }
}
