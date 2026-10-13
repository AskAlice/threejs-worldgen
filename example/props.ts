import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { World } from 'threejs-biomes'
import { applyDamage } from 'threejs-weathering'
import {
  PROP_KIND_IDS, PROP_KINDS, Props, RoadPath, decorateRoads, planPowerLine,
  type DecorateOptions, type PropPlacement, type RoadNetworkLike,
} from 'threejs-props'
import { classOf, createPanel, specOptions } from './panel'
import { panels } from './props.panel'
import { worldGround } from './world-ground'

// threejs-props sandbox: a gallery of every prop and variant with seed variation, a decorated town
// junction, a rural gravel road with a power line, fences and hay, and a pylon line across the fields.
// Everything sits on a threejs-biomes world and is one Props instance (one draw call per shape × material).
// Every option is in the panel (props.panel.ts lists the few left out, and why), with share-by-URL.
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: new URLSearchParams(location.search).has('webgl') })
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.shadowMap.enabled = true
document.body.appendChild(renderer.domElement)
await renderer.init()

const scene = new THREE.Scene()
const day = new THREE.Color('#9cc4e4'), dusk = new THREE.Color('#0b1020')
scene.background = day.clone()
scene.fog = new THREE.Fog(day.clone(), 400, 2200)
const pmrem = new THREE.PMREMGenerator(renderer)
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
scene.environmentIntensity = 0.45
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.3, 6000)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
const sun = new THREE.DirectionalLight('#fff1dc', 3)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
Object.assign(sun.shadow.camera, { left: -160, right: 160, top: 160, bottom: -160, near: 1, far: 900 })
const hemi = new THREE.HemisphereLight('#cfe3ff', '#5a5040', 1.1)
scene.add(sun, sun.target, hemi)

// A flat, dry stretch of coastal grassland on seed 7.
const world = new World({ seed: 7 })
const C: [number, number] = [-3000, 2000]
const H = (x: number, z: number) => world.height(x, z)

// Terrain and water around everything, coloured by the world's ground mix.
const ground = worldGround(world, [C[0], C[1] + 150], 1400, 200)
const terrain = new THREE.Mesh(ground.terrain, new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.95 }))
const water = new THREE.Mesh(ground.water, new THREE.MeshStandardNodeMaterial({ color: '#3a6f8f', roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.85 }))
terrain.receiveShadow = true
scene.add(terrain, water)

// 1. Gallery: every kind (rows) × variants × three seeds (columns), north of the town.
const gallery: PropPlacement[] = []
const G: [number, number] = [C[0] - 130, C[1] - 260]
PROP_KIND_IDS.forEach((kind, row) => {
  if (kind === 'pylon' || kind === 'power-pole') return
  const step = kind === 'bus-stop' ? 6 : kind === 'fence' ? 3.5 : 3
  let col = 0
  for (const variant of PROP_KINDS[kind].variants) for (let seed = 1; seed <= 3; seed++, col++) {
    const x = G[0] + col * step, z = G[1] + row * 7
    gallery.push({ kind, variant, seed: seed * 7919 + row, x, y: H(x, z), z, yaw: 0, length: 3 })
  }
})
// Power poles (both variants) and two pylons, each strung as a short line.
for (const [i, variant] of ['wood', 'concrete'].entries()) for (let k = 0; k < 3; k++) {
  const x = G[0] + 70 + i * 8, z = G[1] + k * 30
  gallery.push({ kind: 'power-pole', variant, seed: k + i * 10, x, y: H(x, z), z, yaw: 0, line: 900 + i })
}
for (let k = 0; k < 2; k++) {
  const x = G[0] + 100, z = G[1] + k * 90
  gallery.push({ kind: 'pylon', seed: k, x, y: H(x, z), z, yaw: 0, line: 902 })
}

// 2. A town junction: primary avenue (x) × minor street (z), plus a gravel road leaving east.
const R = 140
const avenue = { width: 10, sidewalk: 3 }, street = { width: 7, sidewalk: 2 }
const rural: [number, number][] = [[C[0] + R, C[1]], [C[0] + 230, C[1] + 25], [C[0] + 330, C[1] + 10], [C[0] + 440, C[1] + 60], [C[0] + 560, C[1] + 40]]
const net: RoadNetworkLike = {
  nodes: [{ x: C[0], z: C[1] }, { x: C[0] - R, z: C[1] }, { x: C[0] + R, z: C[1] }, { x: C[0], z: C[1] - R }, { x: C[0], z: C[1] + R }, ...rural.slice(1).map(([x, z]) => ({ x, z }))],
  edges: [
    { a: 0, b: 1, type: 'primary', ...avenue, surface: 'asphalt' }, { a: 0, b: 2, type: 'primary', ...avenue, surface: 'asphalt' },
    { a: 0, b: 3, type: 'minor', ...street, surface: 'asphalt' }, { a: 0, b: 4, type: 'minor', ...street, surface: 'asphalt' },
    ...rural.slice(1).map((_, i) => ({ a: i === 0 ? 2 : 4 + i, b: 5 + i, type: 'minor' as const, width: 5, sidewalk: 0, surface: 'gravel' })),
  ],
}
// Mailboxes go to lot frontages along the gravel road.
const lots = [[200, 30], [300, -25], [380, 52], [470, 75], [520, 20]].map(([dx, dz]) => ({ district: 'farmland', building: 0, frontage: { x: C[0] + dx, z: C[1] + dz, nx: 0, nz: 1, edge: -1 } }))
// 3. A high-voltage line between two (imagined) settlements north of the town.
const pylons = planPowerLine([[C[0] - 500, C[1] + 330], [C[0] + 550, C[1] + 420]], world, { seed: 3, spacing: 260 })

const spec = panels['threejs-props']
const decorate = structuredClone(spec.decorateRoads.target) as DecorateOptions
const placementsFor = () => [...gallery, ...decorateRoads(net, world, decorate, { lots }), ...pylons]

const props = await Props.create({ scene, placements: placementsFor() })

// Road ribbons: the junction square, the four arms with sidewalks, the gravel road.
const jx = street.width / 2 + street.sidewalk, jz = avenue.width / 2 + avenue.sidewalk
const roads = [
  new RoadPath({ scene, height: H, points: [[C[0] - jx, C[1]], [C[0] + jx, C[1]]], width: jz * 2, verge: 0, surface: { centreLine: 'none', edgeLines: false, laneLines: false } }),
  new RoadPath({ scene, height: H, points: [[C[0] - jx, C[1]], [C[0] - R, C[1]]], ...avenue, surface: { lanes: 2, centreLine: 'double' } }),
  new RoadPath({ scene, height: H, points: [[C[0] + jx, C[1]], [C[0] + R, C[1]]], ...avenue, surface: { lanes: 2, centreLine: 'double' } }),
  new RoadPath({ scene, height: H, points: [[C[0], C[1] - jz], [C[0], C[1] - R]], ...street, surface: { centreLine: 'dashed' } }),
  new RoadPath({ scene, height: H, points: [[C[0], C[1] + jz], [C[0], C[1] + R]], ...street, surface: { centreLine: 'dashed', wear: 0.8, cracks: 0.7 } }),
  new RoadPath({ scene, height: H, points: rural, width: 5, surface: { surface: 'gravel', centreLine: 'none', edgeLines: false } }),
  new RoadPath({ scene, height: H, points: [[C[0] + 330, C[1] + 10], [C[0] + 345, C[1] - 60], [C[0] + 330, C[1] - 160]], width: 3.2, surface: { surface: 'dirt', width: 3.2 } }),
]
const asphalt = roads[1].surface, dirt = roads[6].surface
Object.assign(window, { world, props, roads, scene, camera }) // for the console

// Weather and time: global floors for every prop and road, plus per-prop events through threejs-weathering.
const weather = { wetness: 0, snow: 0, burn: 0, damage: 0, night: 0 }
const applyWeather = () => {
  const states = { wetness: weather.wetness, snow: weather.snow, burn: weather.burn, damage: weather.damage }
  props.set({ states, night: weather.night })
  for (const r of roads) r.surface.set({ states })
  const n = weather.night
  sun.intensity = 3 * (1 - n) + 0.02
  hemi.intensity = 1.1 * (1 - n) + 0.06
  scene.environmentIntensity = 0.45 * (1 - n) + 0.03
  ;(scene.background as THREE.Color).copy(day).lerp(dusk, n)
  ;(scene.fog as THREE.Fog).color.copy(scene.background as THREE.Color)
}
const damage = { instances: () => props.states, positions: () => props.positions }
Object.assign(window, { weather, applyWeather })

const gui = createPanel([
  {
    name: 'threejs-props',
    classes: [
      classOf('Props', props, { ...props.options, placements: undefined }, specOptions(spec.Props)),
      classOf('RoadSurface (avenue)', { set: (i: object) => { for (const r of roads.slice(0, 5)) r.surface.set(i) } }, asphalt.options, specOptions(spec['RoadSurface (avenue)'])),
      classOf('RoadSurface (dirt lane)', dirt, dirt.options, specOptions(spec['RoadSurface (dirt lane)'])),
      // The panel edits this object in place; re-plan every placement from it.
      { name: 'decorateRoads', target: decorate as Record<string, any>, onChange: () => props.set({ placements: placementsFor() }), ...specOptions(spec.decorateRoads) },
    ],
  },
])
const sandbox = gui.addFolder('weather')
for (const k of ['wetness', 'snow', 'burn', 'damage', 'night'] as const) sandbox.add(weather, k, 0, 1, 0.01).onChange(applyWeather)
sandbox.add({ 'storm hits the rural road': () => applyDamage({ instances: damage.instances(), positions: damage.positions() }, C[0] + 330, C[1] + 10, 90, 0.9) }, 'storm hits the rural road')
sandbox.add({ 'fire at the junction': () => applyDamage({ instances: damage.instances(), positions: damage.positions() }, C[0] + 20, C[1] - 20, 35, 1, 'burn') }, 'fire at the junction')
sandbox.add({ 'flood the gallery': () => applyDamage({ instances: damage.instances(), positions: damage.positions() }, G[0] + 30, G[1] + 40, 60, 1, 'wetness') }, 'flood the gallery')
sandbox.add({ 'clear per-prop states': () => props.states.setAll({ wetness: 0, snow: 0, burn: 0, damage: 0 }) }, 'clear per-prop states')
sandbox.open()

// Camera spots.
const spots: Record<string, [number[], number[]]> = {
  street: [[C[0] + 45, H(C[0], C[1]) + 26, C[1] + 55], [C[0] - 5, H(C[0], C[1]) + 2, C[1] - 5]],
  gallery: [[G[0] + 30, H(G[0], G[1]) + 28, G[1] - 30], [G[0] + 30, H(G[0], G[1]) + 1, G[1] + 40]],
  rural: [[C[0] + 300, H(C[0] + 300, C[1]) + 22, C[1] + 70], [C[0] + 360, H(C[0] + 360, C[1]) + 4, C[1] + 10]],
  pylons: [[C[0], H(C[0], C[1] + 250) + 60, C[1] + 220], [C[0] + 50, H(C[0] + 50, C[1] + 380) + 20, C[1] + 380]],
}
const go = (name: string) => {
  const [p, t] = spots[name]
  camera.position.set(p[0], p[1], p[2])
  controls.target.set(t[0], t[1], t[2])
  sun.target.position.copy(controls.target)
  sun.position.copy(controls.target).add(new THREE.Vector3(-120, 220, -90))
}
document.querySelectorAll<HTMLElement>('[data-go]').forEach((a) => { a.onclick = () => go(a.dataset.go!) })
go('street')

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

const hud = document.getElementById('hud')!
let frames = 0, last = performance.now()
renderer.setAnimationLoop(() => {
  controls.update()
  // Keep the shadow frustum around what we look at.
  sun.target.position.copy(controls.target)
  sun.position.copy(controls.target).add(new THREE.Vector3(-120, 220, -90))
  renderer.render(scene, camera)
  frames++
  const now = performance.now()
  if (now - last > 500) {
    const counts = new Map<string, number>()
    for (const p of props.options.placements) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1)
    let instances = 0
    for (const m of props.meshes.values()) instances += m.count
    hud.textContent = `${((frames * 1000) / (now - last)).toFixed(0)} fps · ${props.count} props · ${props.meshes.size} instanced meshes · ${instances} instances
${[...counts].map(([k, n]) => `${k} ${n}`).join(' · ')}
gallery rows (north → south): ${PROP_KIND_IDS.filter((k) => k !== 'pylon' && k !== 'power-pole').join(', ')}`
    frames = 0
    last = now
  }
})
