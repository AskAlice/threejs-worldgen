# World generation design

How threejs-worldgen grows from grass on a heightfield into whole worlds: climate, biomes, mountains, water,
forests and savannas, and cities. Everything here is a deterministic function of a seed and a world position, so worlds
stay infinite and stream in tiles, the way `threejs-grass` already does.

## Pipeline

Each layer reads only the layers above it. That keeps every query cheap and the same on every machine.

```
seed
 └─ 1. climate fields     continentalness, erosion, ridges, temperature, moisture   (x, z) => number
     └─ 2. height          continents + mountains + valleys + rivers                 HeightFn
         └─ 3. biome       Whittaker lookup + altitude/water/slope overrides         weights per biome
             ├─ 4. ground   material splat (grass, dirt, sand, rock, snow, mud)      per terrain vertex
             ├─ 5. water    sea level, lakes, rivers                                 WaterMesh + masks
             ├─ 6. scatter  trees, shrubs, rocks, grass presets                      instanced, per tile
             └─ 7. settlements  roads, blocks, lots, buildings                       flattens terrain under it
```

### 1. Climate fields

Low-frequency, seeded fBm noise, each domain-warped so nothing lines up on a grid:

| Field | Scale | Drives |
|---|---|---|
| `continentalness` | ~4 km | ocean ↔ coast ↔ inland. A spline maps it to base height. |
| `erosion` | ~2 km | flat plains (high) vs rugged land (low). Scales mountain amplitude. |
| `ridges` (*weirdness*) | ~1 km | where ridged noise peaks form mountain ranges, and where valleys sit. |
| `temperature` | ~3 km | then minus 6.5 °C per 1000 m of height (lapse rate), so peaks are cold. |
| `moisture` | ~2.5 km | plus a rain-shadow term: lower downwind of high ground along the prevailing wind. |

This is the approach Minecraft 1.18 uses (multi-noise biomes). It makes coastlines, ranges and climate bands that
read as natural without any simulation.

### 2. Height

`height = spline(continentalness) + mountains + detail − rivers`

- **Mountains:** ridged multifractal (`1 − |noise|`, squared, octaves weighted by the previous octave), masked by
  `ridges` and scaled down by `erosion`.
- **Erosion look without simulating it:** fBm with analytic derivatives, where each octave is damped by the slope so
  far (Iñigo Quilez's "eroded fBm"). Gives gullies and smooth valley floors for the cost of noise.
- **Biome shaping** (blended by biome weight): sine dunes warped by noise for deserts; height terracing for mesas;
  soft hummocks for tundra; flattened floors for wetlands.
- **Optional real erosion** for bounded maps: GPU hydraulic erosion (droplets or a shallow-water grid) on a baked
  tile, cached. Skipped for infinite worlds.

Height lives on the CPU, in JS. Placement (grass, trees, roads) and rendering then always agree. GPU shaders only
shade.

### 3. Biomes

Classify by temperature × moisture (a Whittaker diagram), then override in this order: water → coast → altitude
(alpine, glacier) → slope (cliff and scree are materials, not biomes).

Transitions must not be hard lines. Each biome has a center in climate space. A position gets a weight for its
nearest 3–4 biomes from distance in that space, smoothed and normalised. Weights blend terrain shaping, ground colour
and grass presets. Scatter picks one species per instance by comparing a per-instance random number against the
weights, so forest edges thin out instead of stopping.

### 4. Ground

Per terrain vertex: biome-weighted splat of grass, dry grass, dirt, sand, rock, snow and mud. Rock takes over above a
slope threshold, snow above a temperature-dependent snowline, wet sand near the water line. In TSL, rock uses
triplanar mapping so cliffs don't stretch, and `mx_worley_noise` / `mx_fractal_noise` break up the tiling.

### 5. Water

- **Ocean and lakes:** a sea-level `WaterMesh` (three r186 ships one for `WebGPURenderer`), shore foam from depth to
  the terrain, depth-tinted colour.
- **Rivers, infinite worlds:** a river noise field where `|noise|` near 0 marks a channel. Carve the channel and
  banks into height, and only where height falls toward the sea. Cheap, infinite, and good enough at a distance.
- **Rivers, bounded maps:** priority-flood fill (fills pits, finds lakes), flow direction, flow accumulation;
  rivers are cells above an accumulation threshold. Real downhill drainage, rivers that join and widen.
- **Wetlands** are low, flat, wet ground near water, with standing-water decals.

### 6. Scatter (trees, shrubs, rocks)

- **Placement:** blue-noise (Poisson-disk) points per tile, seeded per tile so tiles stitch and stream like the grass
  tiles do. Density = biome weight × species density × slope and moisture limits × a clustering noise (forests come
  in patches and clearings, savanna trees stand alone).
- **Trees:** generated once per species at load as a handful of variants, then instanced. Space-colonisation
  (Runions et al. 2007) gives natural crowns; a parameter set per species covers conifer, broadleaf, acacia
  (flat crown), palm, birch, dead snag, mangrove (prop roots). Leaves are instanced cards with alpha.
- **Level of detail:** mesh up close → simplified mesh → octahedral impostor (pre-rendered views on a billboard) far
  away. Same tile/LOD pattern as `threejs-grass`.
- **Rocks:** displaced icospheres with Worley noise, a few variants, instanced; boulders on slopes, scree below cliffs.
- **Grass:** each biome maps to a `threejs-grass` preset (below), blended by weight, painted through a `GrassMap`.

### 7. Cities and settlements

- **Placement:** score land by flatness, nearness to water or a river, and temperate climate. The best score in each
  ~5 km region gets a settlement, sized by score (village → town → city).
- **Roads:** grow major roads from the centre by an L-system-like rule set (Parish & Müller 2001), steered by a
  tensor field (Chen et al. 2008) so streets follow the coast and contours. Avoid water and steep ground; bridge
  rivers. Minor roads fill in a grid or organic pattern depending on the district.
- **Blocks and lots:** blocks are the faces of the road graph. Split each block into lots by recursive
  oriented-bounding-box subdivision until lots reach the district's target size.
- **Buildings:** extrude each lot footprint. Height comes from a density field that peaks downtown, plus noise.
  District sets the style: towers downtown, houses with pitched roofs in residential areas, wide low sheds in
  industrial areas. Windows and facades are a TSL shader (a window grid with lit and unlit cells), not geometry.
  Thousands of buildings fit in a few `BatchedMesh` draw calls.
- **Terrain:** the city writes a height override that flattens and smooths ground under roads and lots, blended out
  at the edges.

## Biomes

| # | Biome | Climate | Terrain | Ground | Vegetation and features | Grass preset |
|---|---|---|---|---|---|---|
| 1 | Deep ocean | continentalness very low | seabed, −50 m and lower | sand, rock | none; dark water | none |
| 2 | Beach and coast | continentalness near shore | gentle slope to sea level | sand, wet sand, pebbles | dune grass, driftwood, palms if hot | Bermuda (sparse) |
| 3 | Temperate grassland (prairie) | mild, medium-dry | rolling, low erosion | grass, dirt | wildflowers, lone oaks | Kentucky Bluegrass / Tall Fescue |
| 4 | Temperate deciduous forest | mild, wet | hills | leaf litter, moss | oak, beech, maple; ferns, fallen logs; autumn tint by season | Fine Fescue (shade) |
| 5 | Temperate rainforest | cool, very wet | steep valleys, rivers | moss, mud | huge conifers, ferns, mossy boulders | Perennial Ryegrass (dense, short) |
| 6 | Boreal forest (taiga) | cold, medium-wet | gentle, many small lakes | needles, moss | spruce, pine, birch; dense stands | Fine Fescue |
| 7 | Tundra | very cold, dry | flat, hummocky | lichen, gravel, snow patches | dwarf shrubs, no trees | Frostbite |
| 8 | Glacier and ice sheet | coldest | smooth, crevasse noise | snow, ice | none | none |
| 9 | Alpine meadow | cold by altitude, above treeline | high, rolling between ridges | short grass, rock | flowers, scattered boulders | Fine Fescue (short) |
| 10 | Mountain peaks | altitude and ridges | ridged multifractal, cliffs | rock, scree, snow above snowline | none above treeline | none |
| 11 | Hot desert (erg) | hot, very dry | warped sine dunes | sand | nothing, the odd dead bush | none |
| 12 | Rocky desert and badlands (mesa) | hot, dry, high erosion | terraced plateaus and canyons | red rock bands, gravel | cacti, sparse shrubs | Golden Savanna (very sparse) |
| 13 | Savanna | hot, seasonal-dry | flat to gently rolling | dry grass, red earth | lone acacias, termite mounds | Golden Savanna |
| 14 | Tropical rainforest (jungle) | hot, very wet | hills, river networks | mud, leaf litter | tall emergent trees, palms, vines, huge leaves | St. Augustine |
| 15 | Tropical dry forest | hot, medium | hills | dry leaf litter | deciduous trees, thorny shrubs | Zoysia |
| 16 | Mediterranean shrubland (chaparral) | warm, dry summers | coastal hills | dry grass, rock | olive-like trees, dense low shrubs | Buffalo Grass |
| 17 | Cold steppe | cold-mild, dry | flat, wide | short dry grass | almost no trees | Buffalo Grass / Autumn Haze |
| 18 | Wetland (marsh and swamp) | mild, very wet, low and flat | flattened, at water level | mud, standing water | reeds, cypress, lily pads | Tall Fescue (reeds) |
| 19 | Mangrove | hot coast, wet | tidal flats | mud, shallow water | mangroves on prop roots | none |
| 20 | Volcanic | rare noise mask, any climate | cone with crater, lava channels | basalt, ash | dead trees at the edges | none |

River valleys and floodplains are not separate biomes: they are rivers carved through the biome they cross, with wetter,
greener ground along the banks (moisture bonus near water).

## Packages

| Package | Contents | Builds on |
|---|---|---|
| `threejs-biomes` | seeded noise, climate fields, biome table and weights, terrain height, chunked terrain mesh (quadtree LOD with skirts) and its splat material | `threejs-heightfield` |
| `threejs-water` | sea and lakes on `WaterMesh`, river carving, flow-accumulation rivers for bounded maps | `threejs-biomes` |
| `threejs-scatter` | tiled blue-noise placement, instancing, impostors; generalises the grass tile streamer | `threejs-heightfield` |
| `threejs-trees` | space-colonisation trees, species presets, rocks | `threejs-scatter` |
| `threejs-city` | settlement placement, road graph, lots, buildings, facade shader, terrain flattening | `threejs-biomes` |

Generation runs in Web Workers (tiles are pure functions of seed and coordinates, so they move to workers with no
shared state), and the main thread only uploads finished buffers.

## Phases

1. **Biomes and terrain:** climate fields, height, biome weights, chunked terrain with the splat material, a biome map
   debug view in the demo. Grass presets follow the biomes.
2. **Water:** ocean, lakes, noise rivers.
3. **Scatter and trees:** forests, savanna, jungle and boreal species, rocks.
4. **Cities:** villages first (organic roads, houses), then towns and cities.
5. **Bounded-map extras:** flow-accumulation rivers and real erosion.
