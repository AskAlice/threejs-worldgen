import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoadGraph } from 'threejs-city'
import { DEFAULT_VEHICLE, Fleet, VEHICLE_KINDS, VEHICLE_TYPES, Vehicle, circlePoints, defaultParams, type FleetEnvironment, type FleetGroup } from 'threejs-vehicles'
import { patch, type Ranges } from './options-gui'
import { classOf, createPanel, type PanelClass } from './panel'
import { GALLERY_ROWS, JUNCTION, junctionLoop, junctionMesh, rowPosition, skyEnvironment, threeQuarter } from './vehicles-rows'

// threejs-vehicles sandbox. Default: a gallery of every vehicle type, each with its own parameters, and
// real-scale rows of the car lookalikes, pickups, trucks and tractors behind it (`?row=cars&focus=2`
// frames one exhibit in a ¾ view).
// `?scene`: a live scene with traffic on a road graph, a train, harbour boats, a carrier with parked
// jets, planes overhead and a rocket launch, with weather toggles (rain, snow, wildfire, damage, night).
const params = new URLSearchParams(location.search)
const hud = document.getElementById('hud')!

const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl') })
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.ACESFilmicToneMapping
document.body.appendChild(renderer.domElement)
await renderer.init()

const scene = new THREE.Scene()
const day = new THREE.Color('#9cc4e4'), night = new THREE.Color('#0b1220')
scene.background = day.clone()
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 30_000)
const sun = new THREE.DirectionalLight('#fff4e0', 3)
sun.position.set(300, 500, 200)
const hemi = new THREE.HemisphereLight('#cfe3ff', '#4a5040', 1.1)
scene.add(sun, sun.target, hemi)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

/** Day/night: dims the lights and switches headlights and windows on. */
function setNight(n: number) {
  ;(scene.background as THREE.Color).copy(day).lerp(night, n)
  sun.intensity = 3 * (1 - n) + 0.05
  hemi.intensity = 1.1 * (1 - n) + 0.15
}

let frames = 0, fps = 0, lastFps = performance.now()
function tickFps() {
  frames++
  const now = performance.now()
  if (now - lastFps > 500) { fps = (frames * 1000) / (now - lastFps); frames = 0; lastFps = now }
}

if (params.has('scene')) await liveScene()
else gallery()

function gallery() {
  scene.add(new THREE.GridHelper(120, 60, '#6d8aa0', '#86a3b8'))
  skyEnvironment(renderer, scene)
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2).translate(0, -0.01, 80), new THREE.MeshStandardNodeMaterial({ color: '#8b8d8f', roughness: 0.92 }))
  ground.receiveShadow = true
  scene.add(ground)
  renderer.shadowMap.enabled = true
  sun.castShadow = true
  sun.shadow.mapSize.set(4096, 4096)
  sun.shadow.bias = -0.0003
  sun.shadow.normalBias = 0.02
  Object.assign(sun.shadow.camera, { left: -150, right: 150, top: 150, bottom: -150, near: 1, far: 1500 })
  sun.position.set(230, 300, 340)
  sun.target.position.set(50, 0, 90)
  const shared = structuredClone(DEFAULT_VEHICLE) as Record<string, any>
  shared.speed = 6
  for (const k of ['type', 'params', 'tint', 'heading']) delete shared[k]
  const vehicles = VEHICLE_TYPES.map((type, i) => {
    const v = new Vehicle({ ...shared, type, seed: i + 1, params: type === 'train' ? { wagons: 2 } : {} })
    // Shown about 9 m long so a bicycle and a carrier compare by shape; standing on the grid.
    const m = v.fleet.sim.models[0]
    const k = 9 / Math.max(...m.size)
    const minY = Math.min(...m.parts.map((p) => p.mesh.bounds[1]))
    const pivot = new THREE.Group()
    pivot.position.set(((i % 4) - 1.5) * 15, 0, (Math.floor(i / 4) - 1) * 15)
    v.object.scale.setScalar(k)
    v.object.position.y = -minY * k
    pivot.add(v.object)
    scene.add(pivot)
    return { v, pivot }
  })
  camera.position.set(0, 26, 52)
  controls.target.set(0, 2, 0)
  // Real-scale rows, facing the camera's side of the gallery (+z), wheels turning with `speed`.
  const rows = GALLERY_ROWS.map((row, r) => row.items.map((item, i) => {
    const v = new Vehicle({ ...shared, type: item.type, params: item.params, seed: 11 + r * 17 + i })
    const [x, z] = rowPosition(r, i)
    v.object.position.set(x, 0, z)
    v.fleet.object.traverse((o) => { o.castShadow = o.receiveShadow = true })
    scene.add(v.object)
    return { v, item, x, z }
  }))
  // A road train on a loop through a large-radius junction: trailers off-track inside the kerb, not over it.
  scene.add(junctionMesh())
  const junction = new Fleet({ seed: 4, groups: [{ type: 'truck', count: 1, params: { trailers: 3, trailer: 'mixed', cab: 'conventional', sleeper: true }, speed: [9, 9], route: { kind: 'path', points: junctionLoop().points, closed: true, smooth: 1 } }] })
  scene.add(junction.object)
  const rowName = params.get('row')
  const focus = (r: number, i: number, side = 1) => {
    const { v, x, z } = rows[r][i]
    const m = v.fleet.sim.models[0]
    const view = threeQuarter(x, z, m.size[2], m.size[1], side)
    camera.position.set(...view.position)
    controls.target.set(...view.target)
  }
  if (rowName === 'junction') {
    const [x0, z0] = JUNCTION.min
    camera.position.set(x0 - 45, 38, z0 - 40)
    controls.target.set(x0 + 25, 0, z0 + 25)
  } else if (rowName) {
    const r = Math.max(0, GALLERY_ROWS.findIndex((row) => row.name === rowName))
    const i = params.has('focus') ? Number(params.get('focus')) : -1
    if (i >= 0) focus(r, i, Number(params.get('side') ?? 1))
    else {
      const [x0, z] = rowPosition(r, 0), [x1] = rowPosition(r, GALLERY_ROWS[r].items.length - 1)
      camera.position.set((x0 + x1) / 2 + 4, 6, z + Math.abs(x1 - x0) * 0.9 + 6)
      controls.target.set((x0 + x1) / 2, 0.8, z)
    }
  }
  const all = { set: (input: any) => [...vehicles, ...rows.flat()].forEach(({ v }) => v.set(input)) }
  const ui = { turntable: !rowName, night: 0 }
  const classes: PanelClass[] = [
    classOf('all vehicles', all, shared, {
      ranges: { speed: [0, 30], lights: [0, 1], crumple: [0, 0.5], period: [20, 300, 1], seed: [1, 100, 1], wetness: [0, 1], snow: [0, 1], burn: [0, 1], damage: [0, 1], heat: [0, 1] },
    }),
    ...VEHICLE_TYPES.map((type, i) => {
      const defs = VEHICLE_KINDS[type].params
      const ranges: Ranges = Object.fromEntries(Object.entries(defs).flatMap(([k, d]) => (d.type === 'number' ? [[k, [d.min, d.max, d.step ?? 0.01] as [number, number, number]]] : [])))
      const choices = Object.fromEntries(Object.entries(defs).flatMap(([k, d]) => (d.type === 'choice' ? [[k, d.options]] : [])))
      return {
        name: type, target: { ...defaultParams(type), tint: '' },
        onChange: (path: string[], value: unknown) => void vehicles[i].v.set(path[0] === 'tint' ? { tint: String(value) } : { params: patch(path, value) as any }),
        ranges, choices,
      } satisfies PanelClass
    }),
  ]
  const gui = createPanel([{ name: 'threejs-vehicles', classes }], { title: 'threejs-vehicles' })
  const sandbox = gui.addFolder('sandbox')
  sandbox.add(ui, 'turntable')
  sandbox.add(ui, 'night', 0, 1, 0.01).onChange((n: number) => { setNight(n); all.set({ lights: n }) })
  const goto = { row: rowName && rowName !== 'junction' ? rowName : GALLERY_ROWS[0].name, exhibit: 0 }
  const jump = () => focus(GALLERY_ROWS.findIndex((r) => r.name === goto.row), Math.min(goto.exhibit, GALLERY_ROWS.find((r) => r.name === goto.row)!.items.length - 1))
  sandbox.add(goto, 'row', GALLERY_ROWS.map((r) => r.name)).onChange(jump)
  sandbox.add(goto, 'exhibit', 0, 7, 1).onChange(jump)
  Object.assign(window, { vehicles, rows, junction, scene, camera, controls, focus, all })
  let last = performance.now()
  renderer.setAnimationLoop(() => {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000)
    last = now
    controls.update()
    for (const { v, pivot } of vehicles) {
      if (ui.turntable) pivot.rotation.y += dt * 0.3
      v.update(dt)
    }
    for (const { v } of rows.flat()) v.update(dt)
    junction.update(dt)
    renderer.render(scene, camera)
    tickFps()
    hud.textContent = `${fps.toFixed(0)} fps · ${VEHICLE_TYPES.length} vehicle types, each at ~9 m for comparison\none InstancedMesh per part (body, wheels, fans, stages), one material`
  })
}

async function liveScene() {
  // --- Ground: land to the west, sea to the east, a town, a railway and a launch pad.
  const SHORE = 350
  const land = new THREE.Mesh(new THREE.PlaneGeometry(4000, 8000).rotateX(-Math.PI / 2).translate(SHORE - 2000, 0, 0), new THREE.MeshStandardNodeMaterial({ color: '#6b8f45', roughness: 0.95 }))
  const beach = new THREE.Mesh(new THREE.PlaneGeometry(40, 8000).rotateX(-Math.PI / 2).translate(SHORE + 10, -0.3, 0), new THREE.MeshStandardNodeMaterial({ color: '#d8c79a', roughness: 1 }))
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(30000, 30000).rotateX(-Math.PI / 2).translate(15000 + SHORE, -0.5, 0), new THREE.MeshStandardNodeMaterial({ color: '#2b6f8a', roughness: 0.15, metalness: 0.1 }))
  land.receiveShadow = true
  scene.add(land, beach, sea)

  // Town: a street grid as a threejs-city RoadGraph (what `city.graph` gives you on a generated city).
  const graph = new RoadGraph(70)
  const N = 7, S = 75, X0 = -820, Z0 = -260
  const ids: number[] = []
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) ids.push(graph.addNode(X0 + i * S + (j % 2) * 6, Z0 + j * S + (i % 3) * 4))
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const main = i === 3 || j === 3
    if (i < N - 1) graph.addEdge(ids[j * N + i], ids[j * N + i + 1], main ? 'primary' : 'minor', main ? 12 : 8, 2)
    if (j < N - 1) graph.addEdge(ids[j * N + i], ids[(j + 1) * N + i], main ? 'primary' : 'minor', main ? 12 : 8, 2)
  }
  scene.add(roadMesh(graph))
  scene.add(blocks(X0, Z0, S, N))

  // Railway: an oval round the town.
  const rail = circlePoints([X0 + (S * (N - 1)) / 2, 0.4, Z0 + (S * (N - 1)) / 2], 1, 64).map(([x, y, z]) => {
    const cx = X0 + (S * (N - 1)) / 2, cz = Z0 + (S * (N - 1)) / 2
    return [cx + (x - cx) * 420, y, cz + (z - cz) * 330] as [number, number, number]
  })
  scene.add(railMesh(rail))
  const pad: [number, number, number] = [-200, 0, 700]

  const groups: FleetGroup[] = [
    { type: 'car', count: Number(params.get('cars') ?? 140), variants: 8, route: { kind: 'roads' } },
    { type: 'bicycle', count: 30, route: { kind: 'roads' } },
    { type: 'train', count: 1, params: { wagons: 8, cargo: 'mixed' }, route: { kind: 'path', points: rail } },
    { type: 'fishing-boat', count: 5, route: { kind: 'circle', center: [SHORE + 260, 0, -300], radius: 170 } },
    { type: 'speedboat', count: 6, route: { kind: 'circle', center: [SHORE + 420, 0, 150], radius: 260, clockwise: true } },
    { type: 'hovercraft', count: 2, route: { kind: 'path', points: [[SHORE + 60, 0, -900], [SHORE + 60, 0, 900]], closed: false } },
    { type: 'cruise-liner', count: 1, route: { kind: 'circle', center: [SHORE + 1900, 0, -400], radius: 900 } },
    { type: 'aircraft-carrier', count: 1, route: { kind: 'circle', center: [SHORE + 2400, 0, 1400], radius: 1300, clockwise: true } },
    { type: 'fighter-jet', count: 6, route: { kind: 'host', group: 7 } },
    { type: 'airplane', count: 3, route: { kind: 'circle', center: [0, 650, 0], radius: 2600 } },
    { type: 'airplane', count: 2, params: { style: 'light' }, route: { kind: 'circle', center: [-500, 220, 200], radius: 700, clockwise: true } },
    { type: 'fighter-jet', count: 3, route: { kind: 'circle', center: [1500, 420, 500], radius: 1300 } },
    { type: 'rocket', count: 1, route: { kind: 'pad', position: pad, heading: Math.PI / 2, period: 90, delay: 4, countdown: 8 } },
    // A car park west of town: parked cars collect snow that moving traffic sheds.
    { type: 'car', count: 14, variants: 6, speed: [0, 0], route: { kind: 'static', position: [X0 - 60, 0.05, Z0 + 120], heading: Math.PI / 2, spacing: 3.4 } },
  ]
  const fleet = new Fleet({
    seed: 1, groups,
    waves: { count: 8, seed: 3, amplitude: 0.45, wavelength: [3, 45], direction: [1, 0.4], spread: 0.6, choppiness: 0.5, speed: 1 },
    rocket: { accel: 6, turn: 3500, separation: [28, 55], fallTime: 35 },
  }, { roads: graph, height: () => 0.05 })
  scene.add(fleet.object)

  // Shadows around the town.
  renderer.shadowMap.enabled = true
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  Object.assign(sun.shadow.camera, { left: -600, right: 600, top: 600, bottom: -600, near: 10, far: 2000 })
  sun.position.set(-400, 700, 300)
  sun.target.position.set(-600, 0, 0)

  // Weather toggles: rain and snow exposure, a wildfire across the main street, a storm-damage zone.
  const ui = { view: 'town', rain: false, snowfall: false, wildfire: false, storm: false, night: 0, wet: false, snowy: false, burnt: false, damaged: false, onFire: false }
  const fireAt = [X0 + S * 3, Z0 + S * 3.5] as const
  const fireMarker = new THREE.Mesh(new THREE.CircleGeometry(45, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicNodeMaterial({ color: '#2a160c', transparent: true, opacity: 0.6, depthWrite: false }))
  fireMarker.position.set(fireAt[0], 0.12, fireAt[1])
  fireMarker.visible = false
  scene.add(fireMarker)
  const stormAt = [X0 + S * 5, Z0 + S * 1] as const
  const env: FleetEnvironment = {}
  const syncEnv = () => {
    env.fire = ui.wildfire ? { heatAt: (x, z) => (Math.hypot(x - fireAt[0], z - fireAt[1]) < 45 ? 1 : 0) } : undefined
    env.field = ui.storm ? { sample: (x, z) => ({ wetness: 0, snow: 0, burn: 0, damage: Math.hypot(x - stormAt[0], z - stormAt[1]) < 80 ? 0.85 : 0 }) } : undefined
    fireMarker.visible = ui.wildfire
    fleet.set({ exposure: { rain: ui.rain ? 1 : 0, snowfall: ui.snowfall ? 1 : 0 } })
  }
  const setStates = () => fleet.set({ states: { wetness: ui.wet ? 1 : 0, snow: ui.snowy ? 0.9 : 0, burn: ui.burnt ? 0.8 : 0, damage: ui.damaged ? 0.7 : 0, heat: ui.onFire ? 1 : 0 } })

  // Views: [camera offset from target, target, vehicle to follow (group) or none].
  const views: Record<string, [number[], number[], number?]> = {
    town: [[90, 90, 160], [X0 + S * 3, 0, Z0 + S * 4]],
    'car park': [[-14, 9, 26], [X0 - 60, 0, Z0 + 100]],
    harbour: [[-420, 140, -380], [SHORE + 300, 0, -150]],
    carrier: [[-260, 120, 240], [0, 0, 0], 7],
    train: [[-40, 25, 50], [0, 0, 0], 2],
    'launch pad': [[-220, 10, 200], [0, 0, 0], 12],
    sky: [[-1200, -300, 1800], [0, 600, 0]],
  }
  let follow = -1
  const target = () => {
    const [, t, g] = views[ui.view]
    if (g === undefined) return new THREE.Vector3(t[0], t[1], t[2])
    const v = fleet.sim.vehiclesOf(g)[0], p = fleet.sim.pose
    return new THREE.Vector3(p[v * 8], p[v * 8 + 1], p[v * 8 + 2])
  }
  const goTo = (name: string) => {
    ui.view = name
    const [o, , g] = views[name]
    follow = g ?? -1
    controls.target.copy(target())
    camera.position.copy(controls.target).add(new THREE.Vector3(o[0], o[1], o[2]))
  }
  goTo('town')

  const fleetOptions = structuredClone(fleet.settings) as Record<string, any>
  const gui = createPanel([{
    name: 'threejs-vehicles',
    classes: [classOf('Fleet', fleet, fleetOptions, {
      skip: ['groups', 'waves', 'separation', 'seed'],
      ranges: { timeScale: [0, 5], lights: [0, 1], crumple: [0, 0.5], tilt: [0, 1], wetness: [0, 1], snow: [0, 1], burn: [0, 1], damage: [0, 1], heat: [0, 1], rain: [0, 1], snowfall: [0, 1], budget: [10, 2000, 1], accel: [2, 20], turn: [500, 20000, 100] },
    })],
  }], { title: 'threejs-vehicles' })
  const sandbox = gui.addFolder('sandbox')
  sandbox.add(ui, 'view', Object.keys(views)).onChange(goTo)
  const weather = sandbox.addFolder('weather (exposure)')
  weather.add(ui, 'rain').onChange(syncEnv)
  weather.add(ui, 'snowfall').name('snowfall (moving vehicles shed it)').onChange(syncEnv)
  weather.add(ui, 'wildfire').name('wildfire on the main street').onChange(syncEnv)
  weather.add(ui, 'storm').name('storm damage zone').onChange(syncEnv)
  sandbox.add(ui, 'night', 0, 1, 0.01).onChange((n: number) => { setNight(n); fleet.set({ lights: n }) })
  const states = sandbox.addFolder('states (every vehicle)')
  for (const k of ['wet', 'snowy', 'burnt', 'damaged', 'onFire'] as const) states.add(ui, k).onChange(setStates)
  let ignited = 0
  sandbox.add({ ignite: () => fleet.ignite((++ignited * 7919) % fleet.count) }, 'ignite').name('set a vehicle on fire')
  Object.assign(window, { fleet, graph, scene, camera, goTo, ui, syncEnv, setStates, setNight }) // for the console

  let last = performance.now()
  renderer.setAnimationLoop(() => {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000)
    last = now
    fleet.update(dt, env)
    if (follow >= 0) {
      // Keep the followed vehicle centred: move camera and target with it.
      const t = target(), d = t.clone().sub(controls.target)
      controls.target.add(d)
      camera.position.add(d)
    }
    controls.update()
    renderer.render(scene, camera)
    tickFps()
    let burning = 0
    for (let i = 0; i < fleet.count; i++) if (fleet.sim.heat[i] > 0) burning++
    const r = fleet.sim.flightTime[fleet.sim.vehiclesOf(12)[0]]
    hud.textContent = `${fps.toFixed(0)} fps · ${fleet.count} vehicles · ${fleet.drawCalls} draw calls
rocket: ${r < 0 ? `T−${(-r).toFixed(0)} s` : `T+${r.toFixed(0)} s, stage ${fleet.sim.activeStage(fleet.sim.vehiclesOf(12)[0]) + 1}`} · burning: ${burning}`
  })
}

/** Road surfaces of a RoadGraph as one merged mesh. */
function roadMesh(graph: RoadGraph): THREE.Mesh {
  const pos: number[] = []
  for (const e of graph.edges) {
    const a = graph.nodes[e.a], b = graph.nodes[e.b]
    const l = Math.hypot(b.x - a.x, b.z - a.z), nx = -(b.z - a.z) / l * e.width / 2, nz = (b.x - a.x) / l * e.width / 2
    const ex = (b.x - a.x) / l * e.width / 2, ez = (b.z - a.z) / l * e.width / 2
    const q = [[a.x - nx - ex, a.z - nz - ez], [b.x - nx + ex, b.z - nz + ez], [b.x + nx + ex, b.z + nz + ez], [a.x + nx - ex, a.z + nz - ez]]
    for (const k of [0, 2, 1, 0, 3, 2]) pos.push(q[k][0], 0.03, q[k][1])
  }
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  const m = new THREE.Mesh(g, new THREE.MeshStandardNodeMaterial({ color: '#3a3b3e', roughness: 0.9 }))
  m.receiveShadow = true
  return m
}

/** Simple building blocks between the streets: one instanced box mesh. */
function blocks(x0: number, z0: number, s: number, n: number): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardNodeMaterial({ color: '#c9c2b6', roughness: 0.85 }), (n - 1) * (n - 1) * 4)
  const m = new THREE.Matrix4()
  let k = 0
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) for (let q = 0; q < 4; q++) {
    const h = 5 + ((i * 7 + j * 13 + q * 5) % 9) * (i === 3 || j === 3 ? 2.2 : 1)
    const cx = x0 + (i + 0.5) * s + ((q % 2) - 0.5) * s * 0.42, cz = z0 + (j + 0.5) * s + (Math.floor(q / 2) - 0.5) * s * 0.42
    mesh.setMatrixAt(k++, m.makeScale(s * 0.3, h, s * 0.3).setPosition(cx, 0, cz))
  }
  mesh.castShadow = mesh.receiveShadow = true
  return mesh
}

/** A ballast bed with two rails along a closed loop. */
function railMesh(points: [number, number, number][]): THREE.Group {
  const group = new THREE.Group()
  const strip = (offsets: [number, number][], y: number, color: string) => {
    const pos: number[] = []
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length]
      const l = Math.hypot(b[0] - a[0], b[2] - a[2]), nx = -(b[2] - a[2]) / l, nz = (b[0] - a[0]) / l
      for (const [o0, o1] of offsets) {
        const q = [[a[0] + nx * o0, a[2] + nz * o0], [b[0] + nx * o0, b[2] + nz * o0], [b[0] + nx * o1, b[2] + nz * o1], [a[0] + nx * o1, a[2] + nz * o1]]
        for (const k of [0, 1, 2, 0, 2, 3]) pos.push(q[k][0], y, q[k][1])
      }
    }
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.computeVertexNormals()
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardNodeMaterial({ color, roughness: 0.8, side: THREE.DoubleSide }))
    mesh.receiveShadow = true
    group.add(mesh)
  }
  strip([[-2.2, 2.2]], 0.06, '#6f6a62')
  strip([[-0.8, -0.65], [0.65, 0.8]], 0.4, '#9a9fa6')
  return group
}
