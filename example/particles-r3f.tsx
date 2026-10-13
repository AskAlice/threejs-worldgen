import * as THREE from 'three/webgpu'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { ParticleGrid, ParticleLighting, Particles, merge, type ParticleGridImpl, type ParticleSystemImpl } from 'threejs-particles/react'
import { panels } from './particles.panel'
import { Backdrop, Post, View, mount, useHud, useSpec } from './r3f-shared'

// threejs-particles in React Three Fiber: the bonfire of the three.js sandbox (particles.ts) as three <Particles>
// (blackbody flames, lit smoke, spark streaks) in a <ParticleGrid> plume, on a plain ground with bloom. Every option
// is a control, from the same panel manifest (particles.panel.ts lists the few left out, and why), and every control
// is a prop; the structural ones (capacity, shading, …) would rebuild a system, so they stay as the fire needs them.
const spec = panels['threejs-particles']
const lighting = new ParticleLighting()

type Ref<T> = { current: T | null }

/**
 * The fire's splats into the grid (P2G): heat from the flames, density from the smoke. Inside `<ParticleGrid>` after
 * the systems, so it runs after they update and before the grid resolves (`splat` builds each pass once).
 */
function Splats({ flames, smoke, grid }: { flames: Ref<ParticleSystemImpl>; smoke: Ref<ParticleSystemImpl>; grid: Ref<ParticleGridImpl> }) {
  const gl = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer
  useFrame(() => {
    const f = flames.current, s = smoke.current, g = grid.current
    if (!f || !s || !g) return
    const cell = g.cellSize()
    gl.compute([
      g.splat(f, 0, (p) => p.temperature.sub(400).max(0).div(1200).mul(0.02)), // heat per second
      g.splat(s, 1, (p) => p.size.mul(p.size).mul(p.size).mul(0.2 / (cell.x * cell.y * cell.z)).mul(p.t.oneMinus())),
    ])
  })
  return null
}

function Fire() {
  const options = { flames: useSpec('flames', spec.flames), smoke: useSpec('smoke', spec.smoke), sparks: useSpec('sparks', spec.sparks) }
  const grid = useSpec('grid', spec.grid)
  // The panel leaves the structural settings out: they come from the manifest's starting values.
  const props = (name: keyof typeof options) => merge(structuredClone(spec[name].target) as any, options[name])
  const refs = { flames: useRef<ParticleSystemImpl>(null), smoke: useRef<ParticleSystemImpl>(null), sparks: useRef<ParticleSystemImpl>(null), grid: useRef<ParticleGridImpl>(null) }
  const ref = (name: keyof typeof options, renderOrder: number) => (impl: ParticleSystemImpl | null) => {
    if (impl) impl.object.renderOrder = renderOrder
    refs[name].current = impl
  }
  const light = useRef<THREE.PointLight>(null)
  const fps = useRef(60)
  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime
    if (light.current) light.current.intensity = 40 * (1 + 0.2 * Math.sin(t * 13) + 0.1 * Math.sin(t * 23 + 1))
    fps.current = fps.current * 0.95 + (1 / Math.max(1e-3, dt)) * 0.05
  })
  useEffect(() => void Object.assign(window, refs), []) // for the console (flames.current, …)
  useHud(() => `threejs-particles · <Particles> × 3 + <ParticleGrid>\n${fps.current.toFixed(0)} fps · ${[refs.flames, refs.smoke, refs.sparks].reduce((n, r) => n + (r.current?.capacity ?? 0), 0)} particle slots`)
  return (
    <>
      <Particles ref={ref('flames', 2)} {...props('flames')} lighting={lighting} />
      {/* The smoke and sparks read the plume grid (heat lifts them, smoke density shadows the smoke); the flames don't. */}
      <ParticleGrid ref={refs.grid} {...grid} resolution={spec.grid.target!.resolution}>
        <Particles ref={ref('smoke', 1)} {...props('smoke')} lighting={lighting} />
        <Particles ref={ref('sparks', 3)} {...props('sparks')} lighting={lighting} />
        <Splats flames={refs.flames} smoke={refs.smoke} grid={refs.grid} />
      </ParticleGrid>
      <pointLight ref={light} color="#ff8a3a" intensity={40} distance={60} decay={1.6} position={[0, 2, 0]} />
    </>
  )
}

function Scene() {
  const scene = useThree((s) => s.scene)
  useFrame(() => void lighting.fromScene(scene))
  return (
    <>
      <Backdrop color="#8fb1d6" fog={0.004} />
      <directionalLight color="#fff1dc" intensity={3} position={[-30, 40, -20]} />
      <hemisphereLight args={['#cfe3ff', '#4a4030', 0.8]} />
      <mesh rotation-x={-Math.PI / 2}>
        <planeGeometry args={[400, 400]} />
        <meshStandardNodeMaterial color="#5d5446" roughness={0.95} />
      </mesh>
      <Fire />
      <Post output={(color) => color.add(bloom(color, 0.2, 0.3, 1.5))} />
      <View position={[14, 6, 18]} target={[0, 4, 0]} />
    </>
  )
}

mount(<Scene />, { fov: 50, near: 0.1, far: 2000 }, { toneMapping: THREE.AgXToneMapping })
