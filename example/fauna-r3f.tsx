import { useEffect, useState } from 'react'
import { useThree } from '@react-three/fiber'
import { useControls } from 'leva'
import { World, createSample } from 'threejs-biomes'
import { FISH_SPECIES, Fauna, Fish, FishImpl, type FaunaImpl } from 'threejs-fauna/react'
import { panels } from './fauna.panel'
import { Daylight, Ground, View, mount, useHud, useSpec } from './r3f-shared'

// threejs-fauna in React Three Fiber. Gallery: a <Fish> per species swimming in place, each species
// editable. River mouth: one <Fauna> (fish schools and bird flocks) streaming around the camera on a
// threejs-biomes world. Every control is a component prop, from the same panel manifest as fauna.ts
// (fauna.panel.ts lists the few options left out, and why); nothing is remounted when it changes.
const spec = panels['threejs-fauna']
const IDS = Object.keys(FISH_SPECIES)
// Each gallery fish's folder starts at its preset's settings (seeds 1, 2, …), as in fauna.ts.
const START = IDS.map((preset, i) => {
  const fish = new FishImpl({ preset, seed: i + 1 })
  const settings = structuredClone(fish.settings)
  fish.dispose()
  return settings
})

/** One gallery fish and its folder. `all` scales its speed and adds to its turn (fauna.ts's "all fish" folder). */
function GalleryFish({ id, i, all }: { id: string; i: number; all: { speed: number; turn: number } }) {
  const settings = useSpec('Fish', { ...spec.Fish, target: START[i] }, { collapsed: true, folder: `Fish: ${id}` })
  return (
    // Each fish shown about 0.6 m long so small and large species compare by shape.
    <group position={[(i % 4) * 0.9 - 1.35, 1.4 - Math.floor(i / 4) * 0.7, 0]} rotation-y={Math.PI / 2} scale={0.6 / FISH_SPECIES[id].length}>
      <Fish {...settings} preset={id} speed={settings.speed * all.speed} turn={Math.max(-1, Math.min(1, settings.turn + all.turn))} />
    </group>
  )
}

function Gallery() {
  const all = useControls('All fish', { speed: { value: 1, min: 0, max: 4 }, turn: { value: 0, min: -1, max: 1 } })
  useHud(() => `threejs-fauna · <Fish> × ${IDS.length} species, each shown ~0.6 m long\none InstancedMesh each`)
  return (
    <>
      <Daylight target={[0, 0.7, 0]} extent={4} />
      {IDS.map((id, i) => <GalleryFish key={id} id={id} i={i} all={all} />)}
      <View position={[0, 0.7, 3.4]} target={[0, 0.7, 0]} />
    </>
  )
}

// A river mouth in seed 1 (as in the three.js demo); render space is centred on it.
const world = new World({ seed: 1 })
const CENTER: [number, number] = [-10400, 6200]
const ORIGIN: [number, number, number] = [CENTER[0], 0, CENTER[1]]
const s = createSample(8)

function RiverMouth() {
  const { camera, controls } = useThree() as unknown as { camera: import('three/webgpu').Camera; controls: { target: { x: number; z: number } } | null }
  const [fauna, setFauna] = useState<FaunaImpl | null>(null)
  const { fishOn, birdsOn } = useControls('Fauna', { fishOn: { value: true, label: 'fish' }, birdsOn: { value: true, label: 'birds' } })
  // Each layer's seed and states are in its own folder (Fauna's shared ones are just those).
  const fish = useSpec('FishSchools', spec.FishSchools, { collapsed: true })
  const birds = useSpec('BirdFlocks', spec.BirdFlocks, { collapsed: true })
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
      <Fauna ref={setFauna} world={world} origin={ORIGIN} predators={[{ object: camera, radius: 3 }]} fish={fishOn && fish} birds={birdsOn && birds} />
      <View position={[-40, 25, 60]} target={[0, -1, 0]} />
    </>
  )
}

function Scene() {
  const { view } = useControls('Scene', { view: { value: 'gallery', options: ['gallery', 'river mouth'] } })
  return view === 'gallery' ? <Gallery /> : <RiverMouth />
}

mount(<Scene />, { fov: 50, near: 0.01, far: 20_000 })
