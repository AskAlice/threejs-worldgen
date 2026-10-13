import { useEffect, useState } from 'react'
import { useControls } from 'leva'
import { World } from 'threejs-biomes'
import { DEFAULT_POPULATION, PopulationOverlay, usePopulation, type PopulationInput, type PopulationOverlayImpl } from 'threejs-city/react'
import { panels } from './population.panel'
import { Daylight, Ground, View, mount, useHud, useSpec } from './r3f-shared'

// threejs-city settlement planner in React Three Fiber: usePopulation(world, input) and a <PopulationOverlay> hex
// choropleth over the world's terrain. Every control is the hook's input or an overlay prop: every option, from the
// same panel manifest as population.ts (population.panel.ts lists the few left out, and why).
const world = new World({ seed: 1 })
const spec = panels['threejs-city']

/** `value`, once it has stopped changing for `ms` (re-running the population on every slider tick is slow). */
function useSettled<T>(value: T, ms = 200): T {
  const [settled, setSettled] = useState(value)
  const key = JSON.stringify(value)
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
  }, [key])
  return settled
}

function Scene() {
  const { night } = useControls('Scene', { night: { value: 0.3, min: 0, max: 1, step: 0.01 } })
  const input = useSpec('Population', spec.Population)
  const { resolution, ...overlay } = useSpec('PopulationOverlay', spec.PopulationOverlay) // resolution −1 = 'auto'

  const settled = useSettled(input) as PopulationInput
  const population = usePopulation(world, settled)
  const radius = settled.radius ?? DEFAULT_POPULATION.radius
  const [cx, cz] = settled.center ?? DEFAULT_POPULATION.center
  const [impl, setImpl] = useState<PopulationOverlayImpl | null>(null)
  useEffect(() => void Object.assign(window, { world, population, overlay: impl }), [population, impl]) // for the console
  useHud(() => {
    const d = population.data, count: Record<string, number> = {}
    for (const s of d.settlements) count[s.class] = (count[s.class] ?? 0) + 1
    return `threejs-city · usePopulation + <PopulationOverlay>\n${d.total.toLocaleString()} people · H3 res ${d.resolution} (${d.cellEdge.toFixed(0)} m)\n` +
      `${Object.entries(count).map(([k, v]) => `${v} ${k}`).join(' · ')}\n${population.network.edges.length} network links`
  })

  return (
    <>
      <Daylight night={night} target={[cx, 0, cz]} extent={radius} />
      <Ground world={world} center={[cx, cz]} size={radius * 2.4} segments={256} />
      <PopulationOverlay ref={setImpl} population={population} {...overlay} resolution={resolution < 0 ? 'auto' : resolution} />
      <View position={[cx, 26_000, cz + 30_000]} target={[cx, 0, cz]} />
    </>
  )
}

mount(<Scene />, { fov: 55, near: 10, far: 400_000 })
