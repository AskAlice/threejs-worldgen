import { useEffect, useMemo, useState } from 'react'
import { button, useControls } from 'leva'
import { World } from 'threejs-biomes'
import { applyDamage } from 'threejs-weathering'
import {
  DEFAULT_DECORATE, DEFAULT_PROPS, DEFAULT_ROAD_SURFACE, PROP_KIND_IDS, PROP_KINDS, Props, RoadPath, decorateRoads, planPowerLine,
  type DecorateOptions, type PropPlacement, type PropsImpl, type RoadNetworkLike, type RoadPathProps,
} from 'threejs-props/react'
import { Daylight, Ground, View, mount, useHud, useOptions, type V3 } from './r3f-shared'

// threejs-props in React Three Fiber: one <Props> (every prop, instanced) and a <RoadPath> per road on a
// threejs-biomes world: a gallery of every kind and variant, a decorated town junction, a rural gravel
// road with mailboxes and a power line, and a pylon line. Every control is a component prop.
const world = new World({ seed: 7 })
const C: [number, number] = [-3000, 2000]
const H = (x: number, z: number) => world.height(x, z)

// Gallery: every kind (rows) × variants × three seeds (columns), north of the town; then power poles and pylons.
const G: [number, number] = [C[0] - 130, C[1] - 260]
const gallery: PropPlacement[] = []
PROP_KIND_IDS.forEach((kind, row) => {
  if (kind === 'pylon' || kind === 'power-pole') return
  const step = kind === 'bus-stop' ? 6 : kind === 'fence' ? 3.5 : 3
  let col = 0
  for (const variant of PROP_KINDS[kind].variants) for (let seed = 1; seed <= 3; seed++, col++) {
    const x = G[0] + col * step, z = G[1] + row * 7
    gallery.push({ kind, variant, seed: seed * 7919 + row, x, y: H(x, z), z, yaw: 0, length: 3 })
  }
})
for (const [i, variant] of ['wood', 'concrete'].entries()) for (let k = 0; k < 3; k++) {
  const x = G[0] + 70 + i * 8, z = G[1] + k * 30
  gallery.push({ kind: 'power-pole', variant, seed: k + i * 10, x, y: H(x, z), z, yaw: 0, line: 900 + i })
}
for (let k = 0; k < 2; k++) {
  const x = G[0] + 100, z = G[1] + k * 90
  gallery.push({ kind: 'pylon', seed: k, x, y: H(x, z), z, yaw: 0, line: 902 })
}

// A town junction: primary avenue (x) × minor street (z), plus a gravel road leaving east.
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
const lots = [[200, 30], [300, -25], [380, 52], [470, 75], [520, 20]].map(([dx, dz]) => ({ district: 'farmland', building: 0, frontage: { x: C[0] + dx, z: C[1] + dz, nx: 0, nz: 1, edge: -1 } }))
const pylons = planPowerLine([[C[0] - 500, C[1] + 330], [C[0] + 550, C[1] + 420]], world, { seed: 3, spacing: 260 })

// Road ribbons: the junction square and the four town arms (styled by the panel), the gravel road and a dirt lane.
const jx = street.width / 2 + street.sidewalk, jz = avenue.width / 2 + avenue.sidewalk
const town: RoadPathProps[] = [
  { points: [[C[0] - jx, C[1]], [C[0] + jx, C[1]]], width: jz * 2, verge: 0, surface: { centreLine: 'none', edgeLines: false, laneLines: false } },
  { points: [[C[0] - jx, C[1]], [C[0] - R, C[1]]], ...avenue, surface: { lanes: 2, centreLine: 'double' } },
  { points: [[C[0] + jx, C[1]], [C[0] + R, C[1]]], ...avenue, surface: { lanes: 2, centreLine: 'double' } },
  { points: [[C[0], C[1] - jz], [C[0], C[1] - R]], ...street, surface: { centreLine: 'dashed' } },
  { points: [[C[0], C[1] + jz], [C[0], C[1] + R]], ...street, surface: { centreLine: 'dashed' } },
]
const country: RoadPathProps[] = [
  { points: rural, width: 5, surface: { surface: 'gravel', centreLine: 'none', edgeLines: false } },
  { points: [[C[0] + 330, C[1] + 10], [C[0] + 345, C[1] - 60], [C[0] + 330, C[1] - 160]], width: 3.2, surface: { surface: 'dirt' } },
]

const spots: Record<string, [V3, V3]> = {
  street: [[C[0] + 45, H(C[0], C[1]) + 26, C[1] + 55], [C[0] - 5, H(C[0], C[1]) + 2, C[1] - 5]],
  gallery: [[G[0] + 30, H(G[0], G[1]) + 28, G[1] - 30], [G[0] + 30, H(G[0], G[1]) + 1, G[1] + 40]],
  rural: [[C[0] + 300, H(C[0] + 300, C[1]) + 22, C[1] + 70], [C[0] + 360, H(C[0] + 360, C[1]) + 4, C[1] + 10]],
  pylons: [[C[0], H(C[0], C[1] + 250) + 60, C[1] + 220], [C[0] + 50, H(C[0] + 50, C[1] + 380) + 20, C[1] + 380]],
}

function Scene() {
  const [props, setProps] = useState<PropsImpl | null>(null)
  const { view, night, ...states } = useControls('Weather & view', {
    view: { value: 'street', options: Object.keys(spots) },
    wetness: { value: 0, min: 0, max: 1, step: 0.01 },
    snow: { value: 0, min: 0, max: 1, step: 0.01 },
    burn: { value: 0, min: 0, max: 1, step: 0.01 },
    damage: { value: 0, min: 0, max: 1, step: 0.01 },
    night: { value: 0, min: 0, max: 1, step: 0.01 },
  })
  // Per-prop events through threejs-weathering, on the instance behind <Props>.
  const hit = (x: number, z: number, r: number, amount: number, channel?: 'burn' | 'wetness') => props && applyDamage({ instances: props.states, positions: props.positions }, x, z, r, amount, channel)
  useControls('Events', {
    'storm hits the rural road': button(() => hit(C[0] + 330, C[1] + 10, 90, 0.9)),
    'fire at the junction': button(() => hit(C[0] + 20, C[1] - 20, 35, 1, 'burn')),
    'flood the gallery': button(() => hit(G[0] + 30, G[1] + 40, 60, 1, 'wetness')),
    'clear per-prop states': button(() => props?.states.setAll({ wetness: 0, snow: 0, burn: 0, damage: 0 })),
  }, [props])
  const settings = useOptions('Props', DEFAULT_PROPS, {
    skip: ['placements', 'states', 'night'],
    ranges: { heat: [0, 1, 0.01], lean: [0, 1.2, 0.01], sag: [0, 0.12, 0.001], iceSag: [0, 2, 0.01], segments: [1, 24, 1], thickness: [0.005, 0.1, 0.001], lampIntensity: [0, 20, 0.1], trafficCycle: [4, 60, 1] },
  })
  const surface = useOptions('Road surface (town)', DEFAULT_ROAD_SURFACE, {
    skip: ['states', 'width', 'lanes', 'centreLine', 'laneLines', 'edgeLines'],
    choices: { surface: ['asphalt', 'cobblestone', 'gravel', 'dirt'] },
    ranges: { wear: [0, 1, 0.01], cracks: [0, 1, 0.01], patches: [0, 1, 0.01], ruts: [0, 1, 0.01], potholes: [0, 1, 0.01], slabSize: [0.3, 3, 0.01] },
  })
  const decorate = useOptions('decorateRoads', DEFAULT_DECORATE, {
    choices: { 'fences/style': ['auto', 'picket', 'rail', 'adobe', 'stone'], 'mailboxes/style': ['us', 'eu'], kind: ['power-pole', 'pylon'], variant: ['auto', 'cobra', 'post'] },
    ranges: { seed: [1, 100, 1] },
  }) as DecorateOptions
  const decorateKey = JSON.stringify(decorate)
  const placements = useMemo(() => [...gallery, ...decorateRoads(net, world, decorate, { lots }), ...pylons], [decorateKey])

  useEffect(() => void Object.assign(window, { props, world }), [props]) // for the console
  useHud(() => {
    if (!props) return ''
    const counts = new Map<string, number>()
    for (const p of props.options.placements) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1)
    let instances = 0
    for (const m of props.meshes.values()) instances += m.count
    return `threejs-props · <Props> + <RoadPath>\n${props.count} props · ${props.meshes.size} instanced meshes · ${instances} instances\n${[...counts].map(([k, n]) => `${k} ${n}`).join(' · ')}`
  })

  const [position, target] = spots[view]
  return (
    <>
      <Daylight night={night} target={target} extent={160} fog={[400, 2200]} />
      <Ground world={world} center={[C[0], C[1] + 150]} size={1400} segments={200} />
      <Props ref={setProps} placements={placements} {...settings} states={states} night={night} />
      {town.map((road, i) => <RoadPath key={i} height={H} {...road} surface={{ ...road.surface, ...surface, states }} />)}
      {country.map((road, i) => <RoadPath key={i} height={H} {...road} surface={{ ...road.surface, states }} />)}
      <View position={position} target={target} />
    </>
  )
}

mount(<Scene />, { fov: 50, near: 0.3, far: 6000 })
