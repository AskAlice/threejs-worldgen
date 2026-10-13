import * as THREE from 'three/webgpu'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { saturation } from 'three/tsl'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { button, useControls } from 'leva'
import { WorldTerrain, type WorldTerrainImpl } from 'threejs-biomes/react'
import TerrainWorker from 'threejs-biomes/worker?worker'
import { Sky, type SkyImpl } from 'threejs-sky/react'
import {
  LAVA_PRESETS, MPM, MPMLava, ParticleLighting, Particles, resolveLavaOptions, resolveMPMOptions, type MPMLavaImpl, type MPMSolverImpl, type ParticleSystemImpl,
} from 'threejs-particles/react'
import { panels } from './mpm-lava.panel'
import { HAZE, SPARKS, check, emitLayer, lavaConfig, lavaInput, lavaScene, lavaStats } from './mpm-lava-scene'
import { Post, View, mount, useHud, useSpec } from './r3f-shared'

// threejs-particles MPM lava in React Three Fiber: the lava sandbox of mpm-lava.ts with <MPM>, <MPMLava> and <Particles>
// (heat haze and sparks), under a threejs-sky <Sky> on a threejs-biomes <WorldTerrain>. A vent on the flank of a volcano
// pours basalt down the slope; it cools, crusts, cracks and glows. Same URL parameters: `?preset=aa` (default pāhoehoe;
// the preset control reloads with it), `?night`, `?close`, `?nolava`, `?check`. Every solver and lava option is a
// control, from the same panel manifest (mpm-lava.panel.ts).
const hud = document.getElementById('hud')!
const params = new URLSearchParams(location.search)
const { world, DX, RES, origin, vent: v, camera: view0 } = lavaScene(params.has('close'))
const presetName = (params.get('preset') === 'aa' ? 'aa' : 'pahoehoe') as keyof typeof LAVA_PRESETS
const config = lavaConfig(RES, DX, origin, presetName)
const panel = panels['threejs-particles']
// The panels start at the sandbox's settings, as mpm-lava.ts's do.
const solverSpec = { ...panel.MPMSolver, target: resolveMPMOptions(config) }
const lavaSpec = { ...panel.MPMLava, target: resolveLavaOptions(lavaInput(presetName)) }
const lighting = new ParticleLighting()
// The lava as a light source: a few point lights over the brightest clusters of glowing surface (from the read-back).
const glows = Array.from({ length: 4 }, () => new THREE.PointLight('#ff8a3c', 0, 0, 2))
const createWorker = () => new TerrainWorker()

type Ref<T> = { current: T | null }
type Demo = { vent: boolean; ventSpeed: number; ventRadius: number; follow: boolean }

/** Before the lava steps: the domain follows the camera target, the vent pours a layer per particle spacing of outflow, the light follows the sky. */
function Vent({ mpm, lava, demo }: { mpm: MPMSolverImpl; lava: Ref<MPMLavaImpl>; demo: Demo }) {
  const scene = useThree((s) => s.scene)
  const layerClock = useRef(0)
  useEffect(() => void (layerClock.current = 0), [mpm])
  useFrame(({ controls }) => {
    const t = (controls as unknown as { target?: THREE.Vector3 } | null)?.target
    if (demo.follow && t) mpm.center(t.x, t.y, t.z)
    const step = 1 / 60
    if (lava.current && demo.vent && mpm.count + 200 < mpm.capacity) {
      layerClock.current += step * demo.ventSpeed
      while (layerClock.current >= DX / 2) { emitLayer(lava.current, world, v, demo.ventRadius, demo.ventSpeed); layerClock.current -= DX / 2 }
    }
    lighting.fromScene(scene)
  })
  return null
}

function Eruption({ sky, terrain }: { sky: SkyImpl; terrain: Ref<WorldTerrainImpl> }) {
  const gl = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer
  const solver = useSpec('MPMSolver', solverSpec)
  const lavaOptions = useSpec('MPMLava', lavaSpec)
  const [mpm, setMpm] = useState<MPMSolverImpl | null>(null)
  const lava = useRef<MPMLavaImpl>(null)
  const haze = useRef<ParticleSystemImpl>(null), sparks = useRef<ParticleSystemImpl>(null)
  const demo = useControls('demo', {
    preset: { value: presetName as string, options: ['pahoehoe', 'aa'], label: 'preset (pāhoehoe / ʻaʻā, reloads)', onChange: (p: string, _: string, { initial }: { initial: boolean }) => void (initial || (location.search = `?preset=${p}`)) },
    night: { value: params.has('night'), label: 'night' },
    vent: { value: true, label: 'vent erupting' },
    ventSpeed: { value: 0.5, min: 0.1, max: 2, step: 0.05, label: 'vent speed (m/s)' },
    ventRadius: { value: 0.6, min: 0.2, max: 1.2, step: 0.01, label: 'vent radius (m)' },
    follow: { value: false, label: 'domain follows camera target' },
    'clear the lava': button(() => latest.current?.clear()),
  }) as Demo & { night: boolean }
  const latest = useRef(mpm)
  latest.current = mpm
  useEffect(() => void (mpm && (mpm.object.visible = false)), [mpm]) // MPMLava draws the lava
  useEffect(() => void (lava.current && params.has('nolava') && (lava.current.object.visible = false))) // debug: the scene without the lava surface
  // Day: late morning; night: a moonless hour before midnight (the lava is the light).
  useEffect(() => void sky.setTimeOfDay(demo.night ? 22.5 : 10.5), [sky, demo.night])
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3 } | null
  useEffect(() => { if (controls) sky.follow(controls.target) }, [sky, controls])

  // The terrain's aerial perspective (when its material has one) follows the sky's sun and horizon colour.
  useFrame(() => {
    const aerial = terrain.current?.uniforms as { sunDirection?: { value: THREE.Vector3 }; hazeColor?: { value: THREE.Color } } | undefined
    aerial?.sunDirection?.value.set(...sky.state.sunDirection)
    const fog = sky.lighting?.fogColor
    if (fog) aerial?.hazeColor?.value.setRGB(fog[0], fog[1], fog[2])
  })

  // Read-back every 1.5 s: haze/spark sources, the lava light, and flow statistics for the HUD.
  const [stats, setStats] = useState<ReturnType<typeof lavaStats> | null>(null)
  const read = useRef({ busy: false, last: performance.now() })
  const fps = useRef(60)
  useFrame((_, dt) => {
    fps.current = fps.current * 0.95 + (1 / Math.max(1e-3, Math.min(0.1, dt))) * 0.05
    if (!stats && mpm && lava.current && haze.current && sparks.current) setStats(lavaStats(gl, mpm, lava.current, haze.current, sparks.current, glows, v))
    const now = performance.now(), r = read.current
    if (stats && mpm && !r.busy && mpm.time > 0.5 && now - r.last > 1500) { r.last = now; r.busy = true; void stats.measure().finally(() => (r.busy = false)) }
  })
  useHud(() => `threejs-particles · <MPM> + <MPMLava> + <Particles>\n${stats?.hud(fps.current, `${presetName}${demo.night ? ' · night' : ''}`) ?? 'starting…'}`)
  useEffect(() => void Object.assign(window, { mpm, lava, world, sky, terrain, lavaStats: stats?.stats, vent: v }), [mpm, stats]) // for the console

  return (
    <>
      {glows.map((light, i) => <primitive key={i} object={light} />)}
      {/* MPMLava steps the solver with its thermal step, so <MPM> doesn't step itself. */}
      <MPM ref={setMpm} {...solver} capacity={config.capacity} resolution={RES} cellSize={DX} origin={origin} height={world.height} timeStep={0} />
      {mpm && (
        <>
          <Vent mpm={mpm} lava={lava} demo={demo} />
          <MPMLava ref={lava} solver={mpm} {...lavaOptions} material={lavaSpec.target.material} lighting={lighting} timeStep={1 / 60} />
          {/* Heat haze and sparks over the hottest lava (their sources come from the read-back). */}
          <Particles ref={haze} {...HAZE} lighting={lighting} />
          <Particles ref={sparks} {...SPARKS} lighting={lighting} />
        </>
      )}
    </>
  )
}

function Scene() {
  const [sky, setSky] = useState<SkyImpl | null>(null)
  const terrain = useRef<WorldTerrainImpl>(null)
  return (
    <>
      {/* Ground: the biomes terrain (its LOD reaches centimetres at the camera, on the same heights the solver collides with). */}
      <WorldTerrain ref={terrain} world={world} createWorker={createWorker} castShadow />
      {/* Sky over Kīlauea, a day after full moon (a moonlit night); exposure capped like a camera at an eruption: at night it exposes for the lava. */}
      <Sky ref={setSky} observer={{ latitude: 19.4, longitude: -155.3 }} clock={{ date: '2026-03-04T12:00:00Z', paused: true }} lighting={{ autoExposure: true, exposureRange: [0.25, 0.7] }} />
      {sky && <Eruption sky={sky} terrain={terrain} />}
      {/* Bloom: the glare of incandescent lava; AgX's "punchy" look, a saturation lift so incandescence stays orange. */}
      <Post output={(color) => saturation(color.add(bloom(color, 0.35, 0.5, 0.6)), 1.35)} />
      <View position={view0.position} target={view0.target} />
    </>
  )
}

/** `?check`: the GPU vs CPU reference check instead of the sandbox. */
function Check() {
  const gl = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer
  useEffect(() => void check(gl).then((text) => (hud.textContent = text)), [gl])
  return null
}

mount(params.has('check') ? <Check /> : <Scene />, { fov: 45, near: 0.05, far: 30000 }, { toneMapping: THREE.AgXToneMapping })
