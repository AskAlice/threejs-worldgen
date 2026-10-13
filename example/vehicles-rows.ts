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
  /** How far the exhibits reach behind their front line (trailers), metres. */
  depth: number
  items: RowItem[]
}

export const GALLERY_ROWS: GalleryRow[] = [
  {
    name: 'cars',
    spacing: 6.5,
    depth: 6,
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
    depth: 7,
    items: [
      { type: 'pickup', params: { style: 'fullSize', cab: 'crew', bed: 'short' }, label: 'full-size, crew cab' },
      { type: 'pickup', params: { style: 'fullSize', cab: 'regular', bed: 'long', hitch: true, load: 'hay' }, label: 'full-size, regular cab, long bed, hay' },
      { type: 'pickup', params: { style: 'fullSize', cab: 'extended', bed: 'long', lift: 0.2, load: 'crates' }, label: 'full-size, extended cab, lifted' },
      { type: 'pickup', params: { style: 'ute', ute: 'coupe' }, label: 'ute' },
      { type: 'pickup', params: { style: 'ute', ute: 'tray', load: 'crates' }, label: 'cab-chassis tray ute' },
      { type: 'pickup', params: { style: 'angular' }, label: 'angular stainless' },
    ],
  },
  {
    name: 'trucks',
    spacing: 7,
    depth: 48,
    items: [
      { type: 'truck', params: { cab: 'conventional', sleeper: true, trailer: 'box' }, label: 'conventional sleeper, box van' },
      { type: 'truck', params: { cab: 'cabOver', sleeper: true, axles: 2, stacks: false, trailer: 'container' }, label: 'cab-over, container chassis' },
      { type: 'truck', params: { cab: 'conventional', sleeper: false, trailer: 'flatbed', load: 'lumber' }, label: 'day cab, flatbed with lumber' },
      { type: 'truck', params: { cab: 'conventional', sleeper: true, trailer: 'tanker' }, label: 'conventional, tanker' },
      { type: 'truck', params: { cab: 'conventional', sleeper: false, trailer: 'flatbed', load: 'machinery', axles: 4 }, label: 'heavy haul, machinery' },
      { type: 'truck', params: { cab: 'cabOver', sleeper: false, body: 'rigid', axles: 2, stacks: false }, label: 'rigid box truck' },
      { type: 'truck', params: { cab: 'conventional', sleeper: true, trailers: 2, trailer: 'flatbed', load: 'pipes' }, label: 'B-double, pipes' },
      { type: 'truck', params: { cab: 'conventional', sleeper: true, trailers: 3, trailer: 'mixed' }, label: 'road train, three trailers' },
    ],
  },
  {
    name: 'tractors',
    spacing: 6,
    depth: 10,
    items: [
      { type: 'tractor', params: { family: 'green' }, label: 'cab' },
      { type: 'tractor', params: { family: 'orange', cab: 'rops' }, label: 'open frame' },
      { type: 'tractor', params: { family: 'red', implement: 'plough' }, label: 'plough' },
      { type: 'tractor', params: { family: 'blue', implement: 'seeder' }, label: 'seeder' },
      { type: 'tractor', params: { family: 'green', implement: 'trailer', load: 'hay' }, label: 'trailer with hay' },
    ],
  },
]

/** Where row `r` stands (its z) and where its item `i` stands (x), metres. */
export function rowPosition(r: number, i: number): [x: number, z: number] {
  const row = GALLERY_ROWS[r]
  // Each row stands clear of the one in front, its exhibits reaching back `depth` metres.
  return [(i - (row.items.length - 1) / 2) * row.spacing, 40 + GALLERY_ROWS.slice(1, r + 1).reduce((z, rw) => z + 8 + rw.depth, 0)]
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

/**
 * A rural road-train route junction beside the gallery: a loop of road (a rounded rectangle) whose
 * first corner is a crossroads with a large-radius inside kerb, as roads built for road trains have. The
 * rig's lane runs `lane` metres outside the kerb, so its trailers off-track inside without mounting it.
 */
export const JUNCTION = { min: [90, 30] as [number, number], size: [170, 130] as [number, number], radius: 42, kerb: 36, road: 12 }

/** The loop the road train drives (closed polyline, counter-clockwise seen from above), and the junction corner's centre. */
export function junctionLoop(): { points: [number, number, number][]; corner: [number, number] } {
  const { min: [x0, z0], size: [w, h], radius: R } = JUNCTION
  const centres: [number, number, number][] = [[x0 + R, z0 + R, Math.PI], [x0 + w - R, z0 + R, -Math.PI / 2], [x0 + w - R, z0 + h - R, 0], [x0 + R, z0 + h - R, Math.PI / 2]]
  const points: [number, number, number][] = []
  for (const [cx, cz, a0] of centres) for (let k = 0; k <= 12; k++) {
    const a = a0 + (k / 12) * (Math.PI / 2)
    points.push([cx + Math.cos(a) * R, 0.05, cz + Math.sin(a) * R])
  }
  return { points, corner: [x0 + R, z0 + R] }
}

/** Asphalt for the junction loop, its crossroads legs, and the raised inside kerb at the junction. */
export function junctionMesh(): THREE.Group {
  const { min: [x0, z0], size: [w, h], radius: R, kerb, road } = JUNCTION
  const group = new THREE.Group()
  const pos: number[] = []
  const quad = (a: number[], b: number[], c: number[], d: number[], y = 0.02) => { for (const q of [a, b, c, a, c, d]) pos.push(q[0], y, q[1]) }
  const strip = (ax: number, az: number, bx: number, bz: number) => {
    const l = Math.hypot(bx - ax, bz - az), nx = (-(bz - az) / l) * road / 2, nz = ((bx - ax) / l) * road / 2
    quad([ax - nx, az - nz], [ax + nx, az + nz], [bx + nx, bz + nz], [bx - nx, bz - nz])
  }
  // Straights, the crossroads legs beyond the junction corner, and the corner annuli.
  strip(x0 - 60, z0, x0 + w - R, z0); strip(x0 + w, z0 + R, x0 + w, z0 + h - R); strip(x0 + w - R, z0 + h, x0 + R, z0 + h); strip(x0, z0 + h - R, x0, z0 - 60)
  // The crossroads box, out to where the corner's outer edge meets the legs.
  const box = R - (R + road / 2) * Math.SQRT1_2 + 2
  quad([x0 - road / 2, z0 - road / 2], [x0 + box, z0 - road / 2], [x0 + box, z0 + box], [x0 - road / 2, z0 + box])
  const corners: [number, number, number][] = [[x0 + R, z0 + R, Math.PI], [x0 + w - R, z0 + R, -Math.PI / 2], [x0 + w - R, z0 + h - R, 0], [x0 + R, z0 + h - R, Math.PI / 2]]
  for (const [cx, cz, a0] of corners) for (let k = 0; k < 24; k++) {
    const a = a0 + (k / 24) * (Math.PI / 2), b = a0 + ((k + 1) / 24) * (Math.PI / 2)
    const r0 = R - road / 2, r1 = R + road / 2
    quad([cx + Math.cos(a) * r0, cz + Math.sin(a) * r0], [cx + Math.cos(a) * r1, cz + Math.sin(a) * r1], [cx + Math.cos(b) * r1, cz + Math.sin(b) * r1], [cx + Math.cos(b) * r0, cz + Math.sin(b) * r0])
  }
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  const asphalt = new THREE.Mesh(g, new THREE.MeshStandardNodeMaterial({ color: '#3d3e40', roughness: 0.92, side: THREE.DoubleSide }))
  asphalt.receiveShadow = true
  group.add(asphalt)
  // The inside kerb of the junction corner: a raised concrete strip on radius `kerb`.
  const kpos: number[] = []
  const [cx, cz] = [x0 + R, z0 + R]
  for (let k = 0; k < 48; k++) {
    const a = Math.PI + (k / 48) * (Math.PI / 2), b = Math.PI + ((k + 1) / 48) * (Math.PI / 2)
    for (const [r0, r1, y0, y1] of [[kerb - 0.3, kerb, 0.15, 0.15], [kerb, kerb, 0.0, 0.15]]) {
      const p = [[r0, y0, a], [r1, y1, a], [r1, y1, b], [r0, y0, b]].map(([r, y, t]) => [cx + Math.cos(t) * r, y, cz + Math.sin(t) * r])
      for (const q of [p[0], p[1], p[2], p[0], p[2], p[3]]) kpos.push(q[0], q[1] + 0.02, q[2])
    }
  }
  const kg = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(kpos, 3))
  kg.computeVertexNormals()
  const kerbMesh = new THREE.Mesh(kg, new THREE.MeshStandardNodeMaterial({ color: '#c9c6bf', roughness: 0.85, side: THREE.DoubleSide }))
  kerbMesh.castShadow = kerbMesh.receiveShadow = true
  group.add(kerbMesh)
  return group
}

/** A field beside the gallery that a tractor works in rows (`fieldRoute`), metres. */
export const FIELD = { center: [-120, 0.02, 90] as [number, number, number], rows: 8, spacing: 6, length: 60 }

/** Tilled ground for the field: furrow stripes along its rows. */
export function fieldMesh(): THREE.Group {
  const { center: [cx, cy, cz], rows, spacing, length } = FIELD
  const group = new THREE.Group()
  const w = rows * spacing + 24, l = length + 30
  const soil = new THREE.Mesh(new THREE.PlaneGeometry(w, l).rotateX(-Math.PI / 2), new THREE.MeshStandardNodeMaterial({ color: '#5b4632', roughness: 0.97 }))
  soil.position.set(cx, cy, cz)
  soil.receiveShadow = true
  group.add(soil)
  const furrow = new THREE.InstancedMesh(new THREE.BoxGeometry(0.35, 0.08, length + 10), new THREE.MeshStandardNodeMaterial({ color: '#4a3826', roughness: 1 }), Math.floor(w / 0.75))
  const m = new THREE.Matrix4()
  for (let i = 0; i < furrow.count; i++) furrow.setMatrixAt(i, m.makeTranslation(cx - w / 2 + 0.4 + i * 0.75, cy + 0.03, cz))
  furrow.receiveShadow = true
  group.add(furrow)
  return group
}
