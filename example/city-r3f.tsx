import { useEffect, useMemo, useState } from 'react'
import { World } from 'threejs-biomes'
import { City, findSettlements, type CityImpl, type CityInput, type SettlementSize } from 'threejs-city/react'
import { panels } from './city.panel'
import { Daylight, Ground, View, mount, useHud, useSpec } from './r3f-shared'

// threejs-city in React Three Fiber: one <City> on a threejs-biomes world, placed by findSettlements.
// Every City option is a control (the same panel manifest as city.ts: city.panel.ts lists the few left out, and why),
// and every control is a <City> prop: looks and weather update instantly, layout changes regenerate in place.
const world = new World({ seed: 11 })
const sites = findSettlements(world, world.frame, { minX: -10000, minZ: -10000, maxX: 10000, maxZ: 10000 })
const best = (size: SettlementSize) => sites.filter((s) => s.size === size).sort((a, b) => b.score - a.score)[0] ?? [...sites].sort((a, b) => b.importance - a.importance)[0]

function Scene() {
  const options = useSpec('City', panels['threejs-city'].City) as CityInput
  const site = useMemo(() => best(options.size as SettlementSize), [options.size])
  const [impl, setImpl] = useState<CityImpl | null>(null)
  useEffect(() => void Object.assign(window, { city: impl, world }), [impl]) // for the console
  const r = site.radius
  const y = world.height(site.x, site.z)
  useHud(() => {
    const s = impl?.stats
    if (!s?.ready) return 'generating…'
    return `threejs-city · <City> (${impl!.plan?.architecture}, ${impl!.plan?.style})\n${s.buildings} buildings · ${s.roadKm.toFixed(1)} km roads · ${s.bridges} bridges · pop ≈ ${s.population.toLocaleString()}\n${s.detailed} at full detail · generated in ${s.generationMs.toFixed(0)} ms`
  })

  return (
    <>
      <Daylight night={options.facade?.night ?? 0} target={[site.x, y, site.z]} extent={Math.max(300, r * 1.2)} fog={[1500, 9000]} />
      <Ground world={world} center={[site.x, site.z]} size={r * 3.2} segments={256} />
      {/* radius 0 (the default) = the site's own radius, as in city.ts */}
      <City ref={setImpl} world={world} {...options} center={[site.x, site.z]} radius={options.radius || r} />
      <View position={[site.x + r * 0.9, y + r * 0.7, site.z + r * 1.1]} target={[site.x, y, site.z]} />
    </>
  )
}

mount(<Scene />, { fov: 50, near: 1, far: 30000 })
