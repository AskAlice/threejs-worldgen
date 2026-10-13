import * as THREE from 'three/webgpu'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { button, useControls } from 'leva'
import { MPM, resolveMPMOptions, type MPMSolverImpl } from 'threejs-particles/react'
import { panels } from './mpm.panel'
import { buildTerrain, check, jellyScene, jellyStats } from './mpm-scene'
import { Backdrop, View, mount, useHud, useSpec } from './r3f-shared'

// threejs-particles MPM in React Three Fiber: the jelly sandbox of mpm.ts with <MPM>. An MLS-MPM jelly block dropped
// onto biomes terrain, bouncing and settling. Every solver option is a control, from the same panel manifest
// (mpm.panel.ts), and a prop of <MPM>; the demo folder re-drops the block. Same URL parameters: `?block=46` drops the
// whole 46³ pool (the performance case), `?drop=` sets the drop height, `?check` runs the GPU vs CPU reference check.
const hud = document.getElementById('hud')!
const params = new URLSearchParams(location.search)
const { world, DX, RES, span, origin, config, dropAt } = jellyScene()
// The panel starts at the sandbox's solver settings (its origin is the site jellyScene found), as mpm.ts's does.
const spec = { ...panels['threejs-particles'].MPMSolver, target: resolveMPMOptions(config) }
const terrain = buildTerrain(world, origin, DX, RES[0], 60)
// Backdrop: coarse terrain out to the fog, a little lower so the exact patch above always wins.
const backdrop = buildTerrain(world, [origin[0] - 300, origin[1], origin[2] - 300], 3, 200 + Math.round(span / 3), 0)
backdrop.position.y = -0.3
const start = { block: Number(params.get('block') ?? 24), dropHeight: Number(params.get('drop') ?? 1) }
const c0 = dropAt(start.block, start.dropHeight), edge = (start.block * DX) / 2

function Jelly() {
  const options = useSpec('MPMSolver', spec)
  const [mpm, setMpm] = useState<MPMSolverImpl | null>(null)
  const latest = useRef({ mpm, view: { ...start, follow: false } })
  const drop = () => {
    const { mpm, view } = latest.current
    if (!mpm) return
    mpm.clear()
    const half = (view.block * DX) / 4 // `block` particles per edge at Δx/2 spacing
    mpm.emit({ center: dropAt(view.block, view.dropHeight), size: [half, half, half] })
  }
  const view = useControls('demo', {
    block: { value: start.block, min: 8, max: Math.round(Math.cbrt(config.capacity!)), step: 1, label: 'block (particles per edge)' },
    dropHeight: { value: start.dropHeight, min: 0, max: 8, step: 0.1, label: 'drop height (m)' },
    follow: { value: false, label: 'domain follows camera target' },
    'drop the block': button(drop),
  })
  latest.current = { mpm, view }
  useEffect(drop, [mpm])

  const stats = useMemo(() => mpm && jellyStats(mpm, world), [mpm])
  const read = useRef({ busy: false, last: 0 })
  const fps = useRef(60)
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3 } | null
  useFrame((_, dt) => {
    fps.current = fps.current * 0.95 + (1 / Math.max(1e-3, dt)) * 0.05
    if (view.follow && mpm && controls) mpm.center(controls.target.x, controls.target.y, controls.target.z)
    const now = performance.now(), r = read.current
    if (stats && !r.busy && now - r.last > 2000) { r.last = now; r.busy = true; void stats.measure().finally(() => (r.busy = false)) }
  })
  useHud(() => `threejs-particles · <MPM>\n${stats?.hud(fps.current) ?? 'starting…'}`)
  useEffect(() => void Object.assign(window, { mpm, world, mpmStats: stats?.stats }), [mpm, stats]) // for the console

  // A fixed step: deterministic, and slow motion rather than instability when frames drop.
  return <MPM ref={setMpm} {...options} capacity={config.capacity} resolution={RES} cellSize={DX} height={world.height} timeStep={1 / 60} />
}

function Scene() {
  return (
    <>
      <Backdrop color="#9db8d3" fog={[40, 280]} />
      <directionalLight color="#fff1dc" intensity={3} position={[-40, 60, 25]} />
      <hemisphereLight args={['#cfe3ff', '#5a5040', 1]} />
      <primitive object={terrain} />
      <primitive object={backdrop} />
      <Jelly />
      <View position={[c0[0] + 2.2 * edge, c0[1] + edge, c0[2] + 2.5 * edge]} target={[c0[0], c0[1] - start.dropHeight - edge * 0.3, c0[2]]} />
    </>
  )
}

/** `?check`: the GPU vs CPU reference check instead of the sandbox. */
function Check() {
  const gl = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer
  useEffect(() => void check(gl).then((text) => (hud.textContent = text)), [gl])
  return null
}

mount(params.has('check') ? <Check /> : <Scene />, { fov: 50, near: 0.1, far: 2000 }, { toneMapping: THREE.AgXToneMapping })
