import { useEffect, useMemo, useState } from 'react'
import { createPortal, useFrame } from '@react-three/fiber'
import { World } from 'threejs-biomes'
import { City, DEFAULT_CITY, mergeOptions, type CityImpl, type CityInput, type SettlementSize } from 'threejs-city/react'
import { Props } from 'threejs-props/react'
import { demoSites, panels, siteInput } from './city.panel'
import { changed } from './leva-options'
import { Daylight, Ground, View, mount, useHud, useSpec } from './r3f-shared'

// threejs-city in React Three Fiber: one <City> on a threejs-biomes world, placed by the settlement planner
// (generatePopulation, then planCities). The `size` control is the class picker: it moves to a settlement of that
// class, farmstead to metropolis; a farm's hay bales and fences are a threejs-props <Props> in the city's frame.
// Every City option is a control (the same panel manifest as city.ts: city.panel.ts lists the few left out, and why),
// and every control is a <City> prop: looks and weather update instantly, layout changes regenerate in place.
const world = new World({ seed: 11 })
const best = demoSites(world)

/** A farm's hay bales and pasture fences, in the city's frame-local group (its tractor spot waits for threejs-vehicles). */
function FarmProps({ city }: { city: CityImpl }) {
  const [plan, setPlan] = useState(city.plan)
  useFrame(() => void (city.plan !== plan && setPlan(city.plan)))
  const placements = plan?.farm?.props
  return placements?.length ? createPortal(<Props placements={placements} />, city.local) : null
}

function Scene() {
  // Only the edited controls: the rest stays unset, so each size class's own road and district rules apply (as in city.ts).
  const options = changed(useSpec('City', panels['threejs-city'].City), DEFAULT_CITY) as CityInput
  const site = useMemo(() => best((options.size ?? DEFAULT_CITY.size) as SettlementSize), [options.size])
  const [impl, setImpl] = useState<CityImpl | null>(null)
  useEffect(() => void Object.assign(window, { city: impl, world }), [impl]) // for the console
  const r = site.radius
  const y = world.height(site.x, site.z)
  useHud(() => {
    const s = impl?.stats
    if (!s?.ready) return 'generating…'
    const farm = impl!.plan?.farm
    const crops = farm ? `\n${farm.fields.length} fields (${[...new Set(farm.fields.map((f) => f.crop))].join(', ')}) · tractor ${farm.vehicleSpots[0]?.working ? 'working' : 'parked'}` : ''
    return `threejs-city · <City> (${impl!.plan?.architecture}, ${impl!.plan?.style})\n${s.buildings} buildings · ${s.roadKm.toFixed(1)} km roads · ${s.bridges} bridges · pop ≈ ${s.population.toLocaleString()}${crops}\n${s.detailed} at full detail · generated in ${s.generationMs.toFixed(0)} ms`
  })

  return (
    <>
      <Daylight night={options.facade?.night ?? 0} target={[site.x, y, site.z]} extent={Math.max(300, r * 1.2)} fog={[1500, 9000]} />
      <Ground world={world} center={[site.x, site.z]} size={r * 3.2} segments={256} />
      {/* The site's centre, radius and farm road; radius 0 (the default) = the site's own radius, as in city.ts */}
      <City ref={setImpl} world={world} {...mergeOptions(options, siteInput(site))} radius={options.radius || r} />
      {impl && <FarmProps city={impl} />}
      <View position={[site.x + r * 0.9, y + r * 0.7, site.z + r * 1.1]} target={[site.x, y, site.z]} />
    </>
  )
}

mount(<Scene />, { fov: 50, near: 1, far: 30000 })
