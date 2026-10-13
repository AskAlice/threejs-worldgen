// Real-scale gallery rows shared by the vanilla and React Three Fiber vehicle sandboxes: one row per
// family (lookalike cars, pickups, trucks, tractors), lined up side by side at the same scale.
import * as THREE from 'three/webgpu'
import { mix, normalize, positionLocal, smoothstep, vec3 } from 'three/tsl'
import type { VehicleParams, VehicleType } from 'threejs-vehicles'

/** One exhibit in a row. */
export interface RowItem {
  type: VehicleType
  params: VehicleParams
  label: string
}

/** A row of exhibits at real scale. */
export interface GalleryRow {
  name: string
  /** Distance between exhibit centres along x, metres. */
  spacing: number
  items: RowItem[]
}

export const GALLERY_ROWS: GalleryRow[] = [
  {
    name: 'cars',
    spacing: 6.5,
    items: [
      { type: 'car', params: { style: 'compact' }, label: 'compact' },
      { type: 'car', params: { style: 'retroWagon' }, label: 'retro wagon' },
      { type: 'car', params: { style: 'vintage' }, label: 'vintage' },
      { type: 'car', params: { style: 'electricSaloon' }, label: 'electric saloon' },
      { type: 'car', params: { style: 'roadster' }, label: 'roadster' },
      { type: 'car', params: { style: 'muscle' }, label: 'muscle' },
    ],
  },
  {
    name: 'pickups',
    spacing: 7.5,
    items: [
      { type: 'pickup', params: { style: 'fullSize', cab: 'crew', bed: 'short' }, label: 'full-size, crew cab' },
      { type: 'pickup', params: { style: 'fullSize', cab: 'regular', bed: 'long', hitch: true, load: 'hay' }, label: 'full-size, regular cab, long bed, hay' },
      { type: 'pickup', params: { style: 'fullSize', cab: 'extended', bed: 'long', lift: 0.2, load: 'crates' }, label: 'full-size, extended cab, lifted' },
      { type: 'pickup', params: { style: 'ute', ute: 'coupe' }, label: 'ute' },
      { type: 'pickup', params: { style: 'ute', ute: 'tray', load: 'crates' }, label: 'cab-chassis tray ute' },
      { type: 'pickup', params: { style: 'angular' }, label: 'angular stainless' },
    ],
  },
]

/** Where row `r` stands (its z) and where its item `i` stands (x), metres. */
export function rowPosition(r: number, i: number): [x: number, z: number] {
  const row = GALLERY_ROWS[r]
  return [(i - (row.items.length - 1) / 2) * row.spacing, 40 + GALLERY_ROWS.slice(0, r).reduce((z, rw) => z + (rw.name === 'trucks' ? 26 : 14), 0)]
}

/**
 * A ¾ front view of an exhibit of length `length` standing at (x, z): camera position and target.
 * `side` 1 looks from the front right, −1 from the front left.
 */
export function threeQuarter(x: number, z: number, length: number, height: number, side = 1): { position: [number, number, number]; target: [number, number, number] } {
  const d = Math.max(4.5, length * 1.25 + 2)
  const a = side * 0.72
  return { position: [x + Math.sin(a) * d, height * 0.55 + d * 0.22, z + Math.cos(a) * d], target: [x, height * 0.45, z] }
}

/** Sky light: a gradient dome (blue zenith, bright horizon, dark ground) prefiltered into `scene.environment`, so paint, glass and metal have something to reflect. */
export function skyEnvironment(renderer: THREE.WebGPURenderer, scene: THREE.Scene, intensity = 0.8): void {
  const dome = new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false }))
  const dir = normalize(positionLocal)
  const horizon = vec3(0.86, 0.9, 0.95), zenith = vec3(0.32, 0.5, 0.78), ground = vec3(0.2, 0.19, 0.17)
  ;(dome.material as THREE.MeshBasicNodeMaterial).colorNode = mix(mix(horizon, ground, smoothstep(0, -0.08, dir.y)), zenith, smoothstep(0.02, 0.7, dir.y).pow(0.7)).mul(1.4)
  const env = new THREE.Scene()
  env.add(dome)
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(env, 0, 0.1, 1000).texture
  scene.environmentIntensity = intensity
}
