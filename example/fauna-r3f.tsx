import { useEffect, useState } from 'react'
import { useThree } from '@react-three/fiber'
import { useControls } from 'leva'
import { World, createSample } from 'threejs-biomes'
import { DEFAULT_BIRD_FLOCKS, DEFAULT_FISH_SCHOOLS, FISH_SPECIES, Fauna, Fish, type FaunaImpl } from 'threejs-fauna/react'
import { Daylight, Ground, View, mount, useHud, useOptions } from './r3f-shared'

// threejs-fauna in React Three Fiber. Gallery: a <Fish> per species swimming in place, each species
// editable. River mouth: one <Fauna> (fish schools and bird flocks) streaming around the camera on a
// threejs-biomes world. Every control is a component prop; nothing is remounted when it changes.
const IDS = Object.keys(FISH_SPECIES)
// What a species looks like and how it swims (where it lives and how it schools only matter in schools).
const LOOKS = Object.fromEntries(IDS.map((id) => {
  const { name: _n, habitat: _h, school: _s, ...look } = FISH_SPECIES[id]
  return [id, look]
}))

function Gallery() {
  const { speed, turn } = useControls('All fish', { speed: { value: 1, min: 0, max: 4 }, turn: { value: 0, min: -1, max: 1 } })
  const species = useOptions('Species', LOOKS, {
    ranges: { depth: [0.05, 0.8], width: [0.02, 0.4], bodyLength: [0.5, 0.95], nose: [0.3, 1.5], back: [0.3, 0.7], peduncle: [0.05, 0.6], squareness: [1.5, 4], count: [0, 20, 1], density: [0, 30], amplitude: [0, 0.3], hueVariation: [0, 1], length: [0.05, 6] },
    choices: { shape: ['forked', 'lunate', 'rounded', 'truncate'] },
  })
  useHud(() => `threejs-fauna · <Fish> × ${IDS.length} species, each shown ~0.6 m long\none InstancedMesh each`)
  return (
    <>
      <Daylight target={[0, 0.7, 0]} extent={4} />
      {IDS.map((id, i) => (
        // Each fish shown about 0.6 m long so small and large species compare by shape.
        <group key={id} position={[(i % 4) * 0.9 - 1.35, 1.4 - Math.floor(i / 4) * 0.7, 0]} rotation-y={Math.PI / 2} scale={0.6 / (species[id]?.length ?? FISH_SPECIES[id].length)}>
          <Fish preset={id} seed={i + 1} speed={speed} turn={turn} species={species[id]} />
        </group>
      ))}
      <View position={[0, 0.7, 3.4]} target={[0, 0.7, 0]} />
    </>
  )
}

// A river mouth in seed 1 (as in the three.js demo); render space is centred on it.
const world = new World({ seed: 1 })
const CENTER: [number, number] = [-10400, 6200]
const ORIGIN: [number, number, number] = [CENTER[0], 0, CENTER[1]]
const { species: _fs, predators: _fp, origin: _fo, seed: _fz, ...FISH } = DEFAULT_FISH_SCHOOLS
const { species: _bs, predators: _bp, origin: _bo, seed: _bz, ...BIRDS } = DEFAULT_BIRD_FLOCKS
const s = createSample(8)

function RiverMouth() {
  const { camera, controls } = useThree() as unknown as { camera: import('three/webgpu').Camera; controls: { target: { x: number; z: number } } | null }
  const [fauna, setFauna] = useState<FaunaImpl | null>(null)
  const { seed, fishOn, birdsOn } = useControls('Fauna', { seed: { value: 1, min: 1, max: 100, step: 1 }, fishOn: { value: true, label: 'fish' }, birdsOn: { value: true, label: 'birds' } })
  const fish = useOptions('Fish schools', FISH, { ranges: { density: [0, 2000], gridResolution: [3, 9, 1], tileSize: [16, 256, 1] } }, true)
  const birds = useOptions('Bird flocks', BIRDS, { ranges: { density: [0, 40], gridResolution: [3, 9, 1], tileSize: [64, 1024, 1] } }, true)
  useEffect(() => void Object.assign(window, { fauna }), [fauna]) // for the console
  useHud(() => {
    const t = controls?.target ?? { x: 0, z: 0 }
    world.frame.sample(CENTER[0] + t.x, CENTER[1] + t.z, s, 1)
    const f = fauna?.layers.fish?.stats, b = fauna?.layers.birds?.stats
    return [
      'threejs-fauna · <Fauna> (fish schools + bird flocks)',
      `fish: ${f?.animals ?? 0} in ${f?.groups ?? 0} schools · ${f?.pending ?? 0} tiles pending`,
      `birds: ${b?.animals ?? 0} in ${b?.groups ?? 0} flocks`,
      `target: ${s.waterLevel === s.waterLevel ? `${(s.waterLevel - s.elevation).toFixed(1)} m of ${s.river > 0.25 ? 'river' : 'sea'} water` : 'dry'} · ${s.temperature.toFixed(1)} °C`,
    ].join('\n')
  })
  return (
    <>
      <Daylight target={[0, 0, 0]} extent={300} fog={[600, 2500]} />
      <group position={[-CENTER[0], 0, -CENTER[1]]}>
        <Ground world={world} center={CENTER} size={700} segments={220} waterOpacity={0.35} />
      </group>
      <Fauna ref={setFauna} world={world} origin={ORIGIN} seed={seed} predators={[{ object: camera, radius: 3 }]} fish={fishOn && fish} birds={birdsOn && birds} />
      <View position={[-40, 25, 60]} target={[0, -1, 0]} />
    </>
  )
}

function Scene() {
  const { view } = useControls('Scene', { view: { value: 'gallery', options: ['gallery', 'river mouth'] } })
  return view === 'gallery' ? <Gallery /> : <RiverMouth />
}

mount(<Scene />, { fov: 50, near: 0.01, far: 20_000 })
