import * as THREE from 'three/webgpu'
import { useEffect, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { button, useControls } from 'leva'
import { DEFAULT_SNOW_SURFACE, MPM, MPMSnowSurface, SNOW_PRESETS, resolveMPMOptions, type MPMSnowSurfaceImpl, type MPMSolverImpl } from 'threejs-particles/react'
import { panels } from './mpm-snow.panel'
import { Walker, check, snowScene, snowStage, type SceneName } from './mpm-snow-scene'
import { View, mount, useHud, useSpec, type V3 } from './r3f-shared'

// threejs-particles MPM snow in React Three Fiber: the snow sandbox of mpm-snow.ts with <MPM> and <MPMSnowSurface>
// (Stomakhin et al. 2013 snow on the MLS-MPM core). Same two scenes and URL parameters: `?scene=footprints` (default),
// fresh powder a walker or a pair of wheels crosses; `?scene=avalanche`, a slab released on a 38° slope; `?preset=`
// a snow preset; `?check` the GPU vs CPU reference check. Every solver and surface option is a control, from the same
// panel manifest (mpm-snow.panel.ts), and a prop of its component.
const hud = document.getElementById('hud')!
const params = new URLSearchParams(location.search)
const name: SceneName = params.get('scene') === 'avalanche' ? 'avalanche' : 'footprints'
const preset = params.get('preset')
const snow = snowScene(name, preset)
const { spec, config } = snow
const panel = panels['threejs-particles']
// The panels start at the scene's solver and surface settings, as mpm-snow.ts's do.
const solverSpec = { ...panel.MPMSolver, target: resolveMPMOptions(config) }
const surfaceSpec = { ...panel.MPMSnowSurface, target: { ...DEFAULT_SNOW_SURFACE, ...snow.surface } }
const walker = new Walker(spec)
/** A leva `onChange` that reloads the page with the search `search(value)` (not on the initial value). */
const reload = (search: (value: string) => string) => (value: string, _: string, { initial }: { initial: boolean }) => void (initial || (location.search = search(value)))

/** The static scenery: sky, environment light, fog, the sun with soft shadows, the bed, the snow ring, the mountains. */
function Stage() {
  const { gl, scene } = useThree()
  useEffect(() => snowStage(gl as unknown as THREE.WebGPURenderer, scene as unknown as THREE.Scene, spec), [gl, scene])
  return null
}

type Demo = { walker: 'boots' | 'wheels'; walkSpeed: number; sink: number; showWalker: boolean }

/** The walker's colliders, set before the solver steps (so mounted before the <MPM>). */
function Walking({ mpm, demo, start }: { mpm: MPMSolverImpl | null; demo: Demo; start: { current: number } }) {
  useFrame(() => {
    if (!mpm) return
    const t = mpm.time - start.current
    mpm.setColliders(name === 'footprints' && t >= 0 ? walker.colliders(t, demo.walker, demo.walkSpeed, demo.sink) : [])
    walker.object.visible = demo.showWalker && t >= 0 && walker.active
  })
  return <primitive object={walker.object} />
}

function Snow() {
  const solver = useSpec('MPMSolver', solverSpec)
  const surfaceOptions = useSpec('MPMSnowSurface', surfaceSpec)
  const [mpm, setMpm] = useState<MPMSolverImpl | null>(null)
  const [surface, setSurface] = useState<MPMSnowSurfaceImpl | null>(null)
  const start = useRef(Infinity)
  const latest = useRef({ mpm, releaseFriction: 0.2 })
  const reset = () => {
    const m = latest.current.mpm
    if (!m) return
    snow.reset(m)
    start.current = name === 'footprints' ? m.time + 0.6 : Infinity // let the cover settle first
  }
  const walk = () => void (latest.current.mpm && (start.current = latest.current.mpm.time))
  const release = () => latest.current.mpm && snow.release(latest.current.mpm, latest.current.releaseFriction)
  const demo = useControls('demo', {
    scene: { value: name as string, options: ['footprints', 'avalanche'], label: 'scene (reloads)', onChange: reload((s) => `?scene=${s}`) },
    preset: { value: preset && Object.hasOwn(SNOW_PRESETS, preset) ? preset : name === 'avalanche' ? 'packed' : 'powder', options: Object.keys(SNOW_PRESETS), label: 'snow preset (reloads)', onChange: reload((p) => `?scene=${name}&preset=${p}`) },
    showParticles: { value: false, label: 'show particles' },
    'reset the snow': button(reset),
    ...(name === 'footprints'
      ? {
        walker: { value: 'boots', options: ['boots', 'wheels'] },
        walkSpeed: { value: 1.1, min: 0.3, max: 3, step: 0.05, label: 'speed (m/s)' },
        sink: { value: 0.22, min: 0.05, max: 0.33, step: 0.01, label: 'sinks in (m)' },
        showWalker: { value: true, label: 'show walker' },
        'walk across': button(walk),
      }
      : {
        releaseFriction: { value: 0.2, min: 0, max: 1.2, step: 0.01, label: 'bed friction after release' },
        'release the slab': button(release),
      }),
  }) as Record<string, any>
  latest.current = { mpm, releaseFriction: demo.releaseFriction ?? 0.2 }
  useEffect(reset, [mpm])
  useEffect(() => void (mpm && (mpm.object.visible = demo.showParticles)), [mpm, demo.showParticles])

  const fps = useRef(60)
  useFrame((_, dt) => void (fps.current = fps.current * 0.95 + (1 / Math.max(1e-3, dt)) * 0.05))
  useHud(() => (mpm ? `threejs-particles · <MPM> + <MPMSnowSurface>\n${fps.current.toFixed(0)} fps · ${mpm.count.toLocaleString()} snow particles · ${mpm.substeps} substeps · t ${mpm.time.toFixed(1)} s\n` +
    (name === 'footprints' ? `${demo.walker === 'boots' ? 'footprints' : 'tracks'}: "walk across" in the panel; ?scene=avalanche for the slope` : `"release the slab" in the panel (bed friction ${mpm.options.friction.toFixed(2)})`) : 'starting…'))
  const gl = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer
  useEffect(() => void Object.assign(window, { mpm, surface, walk, release, reset, snowStats: () => mpm && surface && snow.stats(gl, mpm, surface, walker), walkerPrints: walker.prints, groundAt: spec.ground }), [mpm, surface]) // for the console

  return (
    <>
      <Walking mpm={mpm} demo={demo as Demo} start={start} />
      {/* A fixed step: deterministic, and slow motion rather than instability when frames drop. */}
      <MPM ref={setMpm} {...solver} capacity={config.capacity} resolution={config.resolution} cellSize={config.cellSize} height={spec.ground} timeStep={1 / 60} />
      {mpm && <MPMSnowSurface ref={setSurface} solver={mpm} {...surfaceOptions} detail={surfaceSpec.target.detail} />}
    </>
  )
}

function Scene() {
  return (
    <>
      <Stage />
      <Snow />
      <View position={spec.camera as V3} target={spec.target as V3} />
    </>
  )
}

/** `?check`: the GPU vs CPU reference check instead of the sandbox. */
function Check() {
  const gl = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer
  useEffect(() => void check(gl).then((text) => (hud.textContent = text)), [gl])
  return null
}

mount(params.has('check') ? <Check /> : <Scene />, { fov: 50, near: 0.05, far: 6000 }, { toneMapping: THREE.AgXToneMapping, toneMappingExposure: spec.exposure })
