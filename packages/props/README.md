# threejs-props

Procedural street and countryside props for three.js: mailboxes (US and EU), power lines with sagging catenary
cables, street lights that glow at night, biome-matched fences, road signs, benches, bins, fire hydrants, traffic
lights, bus stops, hay bales and wells. Also procedural TSL road surfaces (asphalt with markings, cracks and patches,
cobblestones, gravel, rutted dirt, sidewalks and curbs) and road ribbons that follow a polyline over the terrain.
Everything is seeded: it looks random, but the same seed always gives the same props. Everything is instanced and can
get wet, snowy, burnt or damaged through
[`threejs-weathering`](https://github.com/AskAlice/threejs-worldgen/tree/main/packages/weathering). Part of
[threejs-worldgen](https://github.com/AskAlice/threejs-worldgen).

**[Live sandbox](https://askalice.github.io/threejs-worldgen/demo/props.html)** ·
**[API docs](https://askalice.github.io/threejs-worldgen/docs/modules/threejs-props.html)** ·
**[Design notes](https://github.com/AskAlice/threejs-worldgen/blob/main/WORLDGEN.md)**

```bash
npm i threejs-props threejs-biomes threejs-weathering three
```

## three.js

```ts
import { World } from 'threejs-biomes'
import { City } from 'threejs-city'
import { applyDamage } from 'threejs-weathering'
import { Props, RoadPath, decorateRoads, planPowerLine } from 'threejs-props'

const world = new World({ seed: 7 })
const city = await City.create({ world, scene, size: 'village' })
const data = city.data()!

// Street furniture along the city's roads, mailboxes at its lots, pylons between two settlements.
const placements = [
  ...decorateRoads(data.roads, world, { seed: 7, powerLines: { spacing: 40 } }, { frame: city.frame, lots: data.lots }),
  ...planPowerLine([[-2000, 300], [1800, 900]], world, { spacing: 300 }),
]
const props = await Props.create({ placements, nightNode: sky.uniforms.night }) // lamps follow threejs-sky
city.local.add(props.object)

props.set({ states: { wetness: 0.8 } })               // everything wet
props.states.set(12, { damage: 1 })                    // prop 12 leans over
applyDamage({ instances: props.states, positions: props.positions }, x, z, 30, 0.9) // a storm

// A gravel track over the terrain; puddles collect in its ruts when wet.
const track = new RoadPath({ scene, height: world.height, points: [[0, 0], [80, 30], [200, 20]], width: 4, surface: { surface: 'gravel' } })
track.surface.set({ states: { wetness: 0.9 } })
```

## React Three Fiber

```tsx
import { Props, RoadPath, decorateRoads } from 'threejs-props/react'

function Town({ world, roads }) {
  const placements = useMemo(() => decorateRoads(roads, world, { seed: 7 }), [roads, world])
  return <>
    <Props placements={placements} night={0.8} states={{ snow: 0.4 }} />
    <RoadPath points={[[0, 0], [60, 20], [140, 10]]} height={world.height} width={4} surface={{ surface: 'dirt' }} />
  </>
}
```

`react` and `@react-three/fiber` are optional peer dependencies; the core never imports them.

## What's in the box

| Export | What it does |
|---|---|
| `Props` | Every placement, drawn as one `InstancedMesh` per (shape, material) pair. Cables are strung between poles that share a `line`. Per-prop `states` (a weathering `InstanceStates`) and `positions`. `set`/`reset`/`update`/`dispose` |
| `decorateRoads(roads, world, options, { frame, lots })` | Deterministic street furniture along a threejs-city `RoadGraph`, `CityData.roads` or plain data of that shape |
| `planPowerLine(points, world, options)` | Evenly spaced poles or pylons along a polyline, slid along it to stay out of water |
| `RoadSurface` | The TSL road material: asphalt, cobblestone, gravel and dirt, plus sidewalks, curbs and concrete, with live JSON options |
| `RoadPath` / `roadRibbon` | A road ribbon along a polyline, draped on the terrain, with curbs and sidewalks or sloped verges |
| `propAssets()` | `AssetDef`s for threejs-worldgen's `AssetRegistry`: every kind, biome-matched fence styles, power lines and road samples, each with its placement rule |
| `buildProp`, `PROP_KINDS` | The catalogue: seeded part lists per kind and variant, as plain data |
| `catenaryPoints`, `catenaryParameter` | Hanging-cable math |
| `propStyleAt`, `FENCE_STYLES` | Biome-matched styles: adobe in the desert, stone in the mountains, rail fences in the taiga |

## The props

| Kind | Variants |
|---|---|
| `mailbox-us` · `mailbox-eu` | post, pedestal · post, pillar (British pillar box) |
| `power-pole` · `pylon` | wood, concrete (with crossarm, insulators, the odd transformer) · lattice tower with hanging insulators |
| `street-light` | cobra head, heritage post lantern |
| `fence` | picket, split rail, adobe wall, dry stone wall (`length` per segment) |
| `sign` | stop, yield, speed limit, warning, street names |
| `bench` · `bin` · `hydrant` | wood, concrete · metal, wheelie · US, pillar |
| `traffic-light` · `bus-stop` | post, mast arm (cycling red, green, amber) · shelter, pole |
| `hay-bale` · `well` | round (sometimes wrapped), square (sometimes stacked) · stone, adobe |

Each seed varies sizes, colours and details: mailbox colours and flags, transformer cans, pole heights, wood tones.

## Placement

`decorateRoads` walks the network as chains, which are runs of edges with the same profile through plain bends. It
places:

- **Urban roads (with sidewalks):** street lights staggered on both sides, hydrants near the kerb, bins and benches
  at the back of the sidewalk, bus stops on primary and secondary roads, and speed limit signs at both ends.
- **Junctions:** traffic lights where a primary or secondary road meets, stop signs on minor approaches, and a
  street name sign.
- **Rural roads:** a power line on one side, mailboxes at lot frontages (or driveways when no lots are given),
  fence runs styled by biome, hay bales in farm biomes on gentle slopes, and the odd well.

Props never stand in water, on the carriageway or on top of each other. Everything is a function of the seed, the
roads and the world (no `Math.random`).

`propAssets()` gives every prop a `PlacementRule` (`surface`, `biomes`, `slope`, `temperature`) plus a `context`
(`urban-sidewalk`, `rural-road`, `rural-lot`, `junction`, `field`, `settlement-link`). threejs-worldgen's
`isPlausible` checks the rule; decorators honour the context.

## Weathering

Each instance carries its tint in `aTint` and its weather in `aStates` (wetness, snow, burn, damage). Both are
read in `colorNode`, never `instanceColor`, so snow stays white and ash stays grey. The shader shows the larger of the
per-prop value and the global `states` floor:

- **Wet:** props darken and gloss.
- **Snow:** settles on top. Its weight also sags cables (`cables.iceSag`).
- **Burnt:** props char.
- **Damaged:** props crack, and poles, lights and signs lean away from a seeded direction (cables follow).
- **Lamps:** go out when badly damaged or burnt.

Road surfaces work the same way. Wet asphalt darkens and turns mirror-like, with puddles on the flat. Ruts and
potholes fill with water first. Snow clears from the tyre tracks. Damage opens alligator cracks.

## Options

`Props`:

- `placements`
- `states: { wetness, snow, burn, damage }`
- `heat`
- `night 0`
- `lampIntensity 6`
- `trafficCycle 24` s
- `lean 0.38` rad
- `cables: { sag 0.025, iceSag 0.6, segments 10, thickness 0.03, color }`
- `castShadow`
- `receiveShadow`

Live inputs: `nightNode` (for example threejs-sky's `sky.uniforms.night`), `time` and `look`.

`RoadSurface`: `surface`, `width`, `lanes`, `centreLine` (`none` / `dashed` / `solid` / `double`), `laneLines`,
`edgeLines`, `wear`, `cracks`, `patches`, `ruts`, `potholes`, `slabSize`, `colors`, `states`. Other geometry can feed
its own part, width and surface attributes through the context. For example, threejs-city's road mesh:
`{ part: attribute('road', 'vec4').w, halfWidth: …x, surfaceIndex: …z }`.

## License

Apache-2.0
