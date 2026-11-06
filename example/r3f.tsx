import * as THREE from 'three/webgpu'
import { createRoot } from 'react-dom/client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, extend, useFrame, useThree, type ThreeToJSXElements } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { button, folder, useControls } from 'leva'
import { Grass, GrassMap, presets, type GrassImpl, type GrassLOD, type PresetName } from 'threejs-grass/react'
import {
  createEnvironment,
  createGroundMaterial,
  createMinimap,
  hills,
  hillsGeometry,
  keepAboveGround,
  paintPath
} from './shared'

declare module '@react-three/fiber' {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}
extend(THREE as any)

const grassMap = new GrassMap({ size: 300, resolution: 1024 })
paintPath(grassMap)

/** Sky, sun + shadows, IBL, haze and bloom. Takes over rendering (useFrame priority 1). */
function Environment() {
  const { gl, scene, camera, controls } = useThree() as any
  const env = useMemo(() => createEnvironment(gl, scene, camera), [gl, scene, camera])
  useEffect(() => () => env.dispose(), [env])

  const light = useControls('Lighting', {
    elevation: { value: 28, min: 2, max: 89 },
    azimuth: { value: 50, min: 0, max: 360 },
    exposure: { value: 0.6, min: 0.2, max: 1.5 },
    bloom: { value: 0.1, min: 0, max: 1 }
  })
  useEffect(() => env.setSun(light.elevation, light.azimuth), [env, light.elevation, light.azimuth])
  useEffect(() => {
    gl.toneMappingExposure = light.exposure
    env.bloomPass.strength.value = light.bloom
  })

  useFrame(() => {
    keepAboveGround(camera, hills)
    if (controls) env.follow(controls.target)
    env.render()
  }, 1)
  return null
}

function Balls({ refs }: { refs: React.RefObject<THREE.Mesh | null>[] }) {
  useFrame(({ clock }) => {
    refs.forEach((ref, i) => {
      const a = clock.elapsedTime * 0.35 * (i ? -1 : 1) + i * 2
      const r = 4 + i * 2.5
      const x = 2 + Math.cos(a) * r
      const z = -6 + Math.sin(a) * r
      ref.current?.position.set(x, hills(x, z) + 0.45, z)
    })
  })
  return refs.map((ref, i) => (
    <mesh key={i} ref={ref} castShadow>
      <sphereGeometry args={[0.45, 48, 24]} />
      <meshStandardNodeMaterial color="#f4f4f0" roughness={0.35} />
    </mesh>
  ))
}

function Scene() {
  const terrain = useRef<THREE.Mesh>(null)
  const balls = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)]
  const geometry = useMemo(() => hillsGeometry(), [])
  const [grass, setGrass] = useState<GrassImpl | null>(null)

  const look = useControls('Grass', {
    preset: { value: 'kentuckyBluegrass' as string, options: Object.keys(presets) },
    type: { value: 'blades', options: ['blades', 'billboards'] },
    maxDistance: { value: 200, min: 50, max: 400, step: 10 },
    interaction: { value: 1, min: 0, max: 3 }
  })
  // The Style panel overrides the preset, so load the preset's values into it whenever it changes.
  const [style, setStyle] = useControls('Style', () => styleSchema('kentuckyBluegrass'))
  useEffect(() => {
    const p = presets[look.preset as PresetName]
    setStyle(Object.fromEntries(Object.keys(style).map((k) => [k, p[k as keyof typeof p]])))
  }, [look.preset])
  const wind = useControls('Wind', {
    strength: { value: 0.45, min: 0, max: 1.5 },
    speed: { value: 0.8, min: 0, max: 3 },
    scale: { value: 0.045, min: 0.005, max: 0.3 },
    angle: { value: 20, min: 0, max: 360 }
  })
  const lod = useControls('Levels of detail', {
    debugLods: { value: false, label: 'show LODs' },
    'LOD 0': folder({
      d0: { value: 8, min: 0, max: 50, label: 'distance' },
      n0: { value: 1, min: 0, max: 1, label: 'density' },
      s0: { value: 5, min: 1, max: 8, step: 1, label: 'segments' }
    }),
    'LOD 1': folder({
      d1: { value: 25, min: 1, max: 100, label: 'distance' },
      n1: { value: 0.25, min: 0, max: 1, label: 'density' },
      s1: { value: 3, min: 1, max: 8, step: 1, label: 'segments' }
    }),
    'LOD 2': folder({
      d2: { value: 60, min: 1, max: 200, label: 'distance' },
      n2: { value: 0.06, min: 0, max: 1, label: 'density' },
      s2: { value: 2, min: 1, max: 8, step: 1, label: 'segments' }
    }),
    'LOD 3': folder({
      d3: { value: 120, min: 1, max: 400, label: 'distance' },
      n3: { value: 0.03, min: 0, max: 1, label: 'density' },
      s3: { value: 1, min: 1, max: 8, step: 1, label: 'segments' }
    })
  })
  const brush = useControls('Terrain Painter', {
    paint: { value: false, label: 'paint (orbit off)' },
    mode: { value: 'add', options: ['add', 'erase', 'raise', 'lower'] },
    radius: { value: 3, min: 0.5, max: 15 },
    strength: { value: 0.3, min: 0.02, max: 1 },
    'clear all': button(() => grassMap.fill(0)),
    'fill all': button(() => grassMap.fill(1)),
    'reset path': button(() => (grassMap.fill(1), paintPath(grassMap))),
    'save map': button(() =>
      Object.assign(document.createElement('a'), { href: grassMap.toDataURL(), download: 'grass-map.png' }).click()
    ),
    'load map': button(() => loadMap(grassMap))
  })

  const lods: GrassLOD[] = [
    { distance: lod.d0, density: lod.n0, segments: lod.s0 },
    { distance: lod.d1, density: lod.n1, segments: lod.s1 },
    { distance: lod.d2, density: lod.n2, segments: lod.s2 },
    { distance: lod.d3, density: lod.n3, segments: lod.s3 }
  ]

  // Terrain shading reads the grass map (dirt where grass is erased), so it needs the Grass instance.
  useEffect(() => {
    if (grass && terrain.current) terrain.current.material = createGroundMaterial(grass)
    Object.assign(window, { grass }) // handy in the console
  }, [grass])

  useEffect(() => {
    const minimap = createMinimap(grassMap)
    const hud = Object.assign(document.createElement('div'), { id: 'hud' })
    document.body.append(minimap.canvas, hud)
    let raf = 0
    const tick = () => {
      minimap.update((window as any).__camera?.position)
      if (grass)
        hud.innerHTML = `${grass.stats.tiles} tiles · ${grass.stats.instances.toLocaleString()} blades · <a href="./">three.js demo →</a>`
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      cancelAnimationFrame(raf)
      minimap.canvas.remove()
      hud.remove()
    }
  }, [grass])

  const rad = (wind.angle * Math.PI) / 180
  return (
    <>
      <Environment />
      <mesh ref={terrain} geometry={geometry} receiveShadow>
        <meshStandardNodeMaterial color="#1c2a10" />
      </mesh>
      <Balls refs={balls} />
      <Grass
        ref={setGrass}
        terrain={terrain}
        preset={look.preset as PresetName}
        {...style}
        type={look.type as 'blades' | 'billboards'}
        tileSize={25}
        maxDistance={look.maxDistance}
        lods={lods}
        debugLods={lod.debugLods}
        wind={{
          direction: [Math.cos(rad), Math.sin(rad)],
          strength: wind.strength,
          speed: wind.speed,
          scale: wind.scale
        }}
        grassMap={grassMap}
        paint={brush.paint && { mode: brush.mode as any, radius: brush.radius, strength: brush.strength }}
        interactors={balls.map((object) => ({ object, radius: 1.1 }))}
        interactionStrength={look.interaction}
      />
      <OrbitControls makeDefault enabled={!brush.paint} target={[2, hills(2, -6) + 0.6, -6]} enableDamping />
    </>
  )
}

function styleSchema(name: PresetName) {
  const p = presets[name]
  return {
    bladeHeight: { value: p.bladeHeight, min: 0.05, max: 3, step: 0.01, label: 'height' },
    heightVariation: { value: p.heightVariation, min: 0, max: 1, label: 'height var.' },
    bladeWidth: { value: p.bladeWidth, min: 0.005, max: 0.2, step: 0.001, label: 'width' },
    density: { value: p.density, min: 5, max: 150, step: 1 },
    curvature: { value: p.curvature, min: 0, max: 1, label: 'droop' },
    stiffness: { value: p.stiffness, min: 0.2, max: 3 },
    clumping: { value: p.clumping, min: 0, max: 1 },
    baseColor: { value: p.baseColor, label: 'base' },
    tipColor: { value: p.tipColor, label: 'tip' },
    patchiness: { value: p.patchiness, min: 0, max: 1 },
    translucency: { value: p.translucency, min: 0, max: 1.5 }
  }
}

function loadMap(map: GrassMap) {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' })
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    map.load(await createImageBitmap(file))
  }
  input.click()
}

createRoot(document.getElementById('root')!).render(
  <Canvas
    dpr={[1, 1.5]}
    camera={{ position: [-4, hills(-4, 10) + 1.7, 10], fov: 50, near: 0.1, far: 5000 }}
    onCreated={({ camera }) => Object.assign(window, { __camera: camera })}
    gl={async (props) => {
      const renderer = new THREE.WebGPURenderer({
        ...(props as any),
        antialias: true,
        forceWebGL: location.search.includes('webgl')
      })
      await renderer.init()
      return renderer
    }}
  >
    <Scene />
  </Canvas>
)
