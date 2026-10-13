import * as THREE from 'three/webgpu'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { button, useControls } from 'leva'
import {
  FluidSurface, MPM, ParticleLighting, Particles, PuddleField, SplashEmitter, WATER_PRESETS, resolveFluidSurfaceOptions, resolveMPMOptions,
  resolvePuddleOptions, resolveSplashOptions, type MPMSolverImpl, type ParticleSystemImpl,
} from 'threejs-particles/react'
import { panels } from './mpm-water.panel'
import { RAIN, VIEWS, check, height, puddleOptions, releaseDam, splashOptions, streaks, waterConfig, waterGround, waterLoop, waterStage, waterView } from './mpm-water-scene'
import { View, mount, useHud, useSpec, type V3 } from './r3f-shared'

// threejs-particles MPM water in React Three Fiber: the water sandbox of mpm-water.ts with <MPM>, <FluidSurface> and
// <Particles> (the rain). A dam break collapses onto the terrain, a stream runs off a 0.6 m ledge into a plunge pool, and
// rain splashes on the ground and fills puddles in the hollows. Same URL parameters: `?view=dam|fall|rain`, `?muddy`,
// `?soak=<minutes>`, `?rain=0`, `?dam=0`, `?fall=0`, `?pause=<s>`, `?check`. Every solver, surface, splash and puddle
// option is a control, from the same panel manifest (mpm-water.panel.ts).
const hud = document.getElementById('hud')!
const params = new URLSearchParams(location.search)
const muddy = params.has('muddy')
const preset = muddy ? WATER_PRESETS.muddy : WATER_PRESETS.clear
const view = waterView(params) // the demo folder writes into it; the scene's helpers read it
const config = waterConfig(muddy)
const panel = panels['threejs-particles']
// The panels start at the sandbox's settings, as mpm-water.ts's do.
const specs = {
  solver: { ...panel.MPMSolver, target: resolveMPMOptions(config) },
  surface: { ...panel.FluidSurface, target: resolveFluidSurfaceOptions(preset.surface) },
  splash: { ...panel.SplashEmitter, target: resolveSplashOptions(splashOptions(view)) },
  puddles: { ...panel.PuddleField, target: resolvePuddleOptions(puddleOptions) },
}
// Puddles over the domain, feeding the ground shader through a texture.
const puddles = new PuddleField(puddleOptions, height)
const ground = waterGround(puddles, view)
const soak = Number(params.get('soak') ?? 0)
if (soak > 0) puddles.update(soak * 60, view.rainRate)
const pauseAt = Number(params.get('pause') ?? Infinity) // `?pause=<s>` freezes the water at that simulated time (screenshots)
// The fluid surface's light: the sun behind thin overcast and the sky's mean colour, set once the stage is up.
const lighting = new ParticleLighting()

/** The overcast sky (dome and environment), fog, the sun and the ground. */
function Stage() {
  const { gl, scene } = useThree()
  useEffect(() => {
    const { sun, skyAvg, remove } = waterStage(gl as unknown as THREE.WebGPURenderer, scene as unknown as THREE.Scene)
    lighting.set(sun.position.toArray(), sun.color.clone().multiplyScalar(sun.intensity), skyAvg)
    return remove
  }, [gl, scene])
  return <>{ground.meshes.map((m, i) => <primitive key={i} object={m} />)}</>
}

/** One frame of the simulation (splashes, puddles, waterfall, solver step, rain follow), before the surface draws. */
function Step({ loop, rain }: { loop: ReturnType<typeof waterLoop>; rain: { near: { current: ParticleSystemImpl | null }; far: { current: ParticleSystemImpl | null } } }) {
  useFrame(({ camera, controls }, dt) => {
    const target = (controls as unknown as { target?: THREE.Vector3 } | null)?.target ?? new THREE.Vector3()
    loop.frame(Math.min(0.1, dt), camera as unknown as THREE.Camera, target, { near: rain.near.current, far: rain.far.current })
  })
  return null
}

function Water() {
  const gl = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer
  const solver = useSpec('MPMSolver', specs.solver)
  const surface = useSpec('FluidSurface', specs.surface)
  const splashOptions = useSpec('SplashEmitter', specs.splash)
  const puddleOptions = useSpec('PuddleField', specs.puddles)
  const [mpm, setMpm] = useState<MPMSolverImpl | null>(null)
  const splash = useMemo(() => mpm && new SplashEmitter(mpm, splashOptions, { height, puddles }), [mpm])
  useEffect(() => () => splash?.dispose(), [splash])
  useEffect(() => void splash?.set(splashOptions))
  useEffect(() => void puddles.set(puddleOptions))
  const loop = useMemo(() => mpm && splash && waterLoop(gl, mpm, splash, puddles, ground, view, pauseAt), [mpm, splash])
  const latest = useRef(mpm)
  latest.current = mpm
  const demo = useControls('demo', {
    rain: { value: view.rain, label: 'rain' },
    rainRate: { value: view.rainRate, min: 0, max: 80, step: 0.5, label: 'rain (mm/h)' },
    puddleSpeed: { value: view.puddleSpeed, min: 1, max: 200, step: 1, label: 'puddle fast-forward ×' },
    waterfall: { value: view.waterfall, label: 'waterfall' },
    flow: { value: view.flow, min: 0, max: 2, step: 0.05, label: 'stream speed (m/s)' },
    damBreak: { value: view.damBreak, label: 'dam break on reset' },
    'reset water (dam break)': button(() => latest.current && releaseDam(latest.current, view)),
    'dry the ground': button(() => puddles.clear()),
    camera: { value: VIEWS[params.get('view') ?? ''] ? params.get('view')! : 'overview', options: Object.keys(VIEWS) },
  })
  const { camera, ...settings } = demo
  Object.assign(view, settings)
  useEffect(() => {
    if (!mpm) return
    mpm.object.visible = false // the FluidSurface draws the water
    releaseDam(mpm, view)
  }, [mpm])

  const rain = { near: useRef<ParticleSystemImpl>(null), far: useRef<ParticleSystemImpl>(null) }
  const fps = useRef(60)
  useFrame((_, dt) => void (fps.current = fps.current * 0.95 + (1 / Math.max(1e-3, Math.min(0.1, dt))) * 0.05))
  useHud(() => `threejs-particles · <MPM> + <FluidSurface> + <Particles>\n${loop?.hud(fps.current) ?? 'starting…'}`)
  useEffect(() => void Object.assign(window, { mpm, splash, puddles, view, rain }), [mpm, splash]) // for the console

  const [position, target] = VIEWS[camera]
  return (
    <>
      {/* The solver is stepped with the splashes in one batch (Step), so <MPM> doesn't step itself. */}
      <MPM ref={setMpm} {...solver} capacity={config.capacity} resolution={config.resolution} cellSize={config.cellSize} height={height} timeStep={0} />
      {mpm && loop && (
        <>
          <Step loop={loop} rain={rain} />
          <FluidSurface source={mpm} lighting={lighting} {...surface} />
        </>
      )}
      {/* Rain in the air, around the camera: thin streaks, a near layer and a far one (rate and box set each frame). */}
      <Particles ref={rain.near} {...streaks(...RAIN.near)} />
      <Particles ref={rain.far} {...streaks(...RAIN.far)} />
      <View position={position as V3} target={target as V3} />
    </>
  )
}

/** `?check`: the GPU vs CPU reference check instead of the sandbox. */
function Check() {
  const gl = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer
  useEffect(() => void check(gl).then((text) => (hud.textContent = text)), [gl])
  return null
}

mount(params.has('check') ? <Check /> : <><Stage /><Water /></>, { fov: 50, near: 0.03, far: 1500 }, { toneMapping: THREE.AgXToneMapping, toneMappingExposure: 1.1 })
