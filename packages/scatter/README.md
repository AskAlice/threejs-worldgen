# threejs-scatter

Streams instanced objects (trees, rocks, shrubs, anything) over terrain in camera-centred tiles, for **three.js** and
**react-three-fiber**. Placement is seamless blue noise filtered by density, slope, height and clumping noise, so the
world is a pure function of `seed` and position. Each layer and level of detail is one pooled instanced mesh (one per
material group when `material` is an array, sharing the instance buffers), so draw calls don't grow with the number of
tiles. Far away, octahedral impostors stand in for the meshes.

Part of [threejs-worldgen](https://github.com/AskAlice/threejs-worldgen). For generated trees, plants and rocks to
scatter, see [`threejs-trees`](https://www.npmjs.com/package/threejs-trees).

```bash
npm i threejs-scatter three
# for React:
npm i @react-three/fiber react
```

## three.js

```ts
import * as THREE from 'three/webgpu'
import { materialColor } from 'three/tsl'
import { Scatter, bakeImpostor, scatterParamsNode } from 'threejs-scatter'

const renderer = new THREE.WebGPURenderer({ antialias: true })
await renderer.init()

const rockMaterial = new THREE.MeshStandardNodeMaterial({ color: '#777' })
rockMaterial.colorNode = materialColor.mul(scatterParamsNode().y) // colorVariation tint (1 off-scatter)
const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(1), rockMaterial)
const impostor = await bakeImpostor(renderer, rock, { frames: 8, size: 512 })

const scatter = Scatter.create({
  camera, scene, terrain: (x, z) => myHeight(x, z), // or a terrain Mesh (baked into a heightfield once)
  seed: 7,
  layers: [{
    name: 'boulder',
    spacing: 12,                                  // Poisson-disk radius, metres
    density: (x, z) => myBiomes.rockiness(x, z),  // 0..1 keep probability (or a number)
    maxSlope: 1.5, align: 1, sink: 0.3, scale: [0.6, 2], tilt: 0.2, colorVariation: 0.15,
    cluster: { scale: 80, threshold: 0.5, strength: 0.8 }, // patches and clearings
    lods: [{ distance: 120, geometry: rock.geometry, material: rock.material }],
    impostor: { distance: 600, geometry: impostor.geometry, material: impostor.material, castShadow: false },
  }],
})
// With `scene` given it updates itself whenever the scene renders; otherwise call scatter.update() once per frame.

scatter.query(x, z, 5)        // instances near a point, deterministic, for gameplay / collision
scatter.set({ maxDistance: 400 }) // runtime changes; only what changed is rebuilt
```

## React Three Fiber

```tsx
import { Scatter } from 'threejs-scatter/react'

<mesh ref={ground} geometry={hills} />
<Scatter terrain={ground} seed={7} layers={[{ name: 'boulder', spacing: 12, lods: [{ distance: 150, geometry, material }] }]} />
```

Props are the options; the camera defaults to the R3F camera, `terrain` takes a mesh, a ref to one or a height
function, and `ref` gives you the `ScatterImpl` instance (for `query` and `stats`).

## Options

`Scatter.create(options)` / `set(partial)` / `reset(full)` / `<Scatter {...props}>`:

| Option | Default | |
|---|---|---|
| `camera` | — | Camera tiles stream around (R3F: the default camera). |
| `scene` | — | If given, the scatter adds itself and updates on `scene.onBeforeRender`. |
| `terrain` | flat | Mesh / group (baked to a heightfield) or `(x, z) => y`. |
| `seed` | `1` | World seed. |
| `tileSize` | `64` | Tile edge, metres. |
| `maxDistance` | `600` | Nothing beyond this (each layer also stops at its last LOD distance). |
| `buildBudget` | `4` | Milliseconds per frame for generating tiles, nearest first. |
| `lodHysteresis` | `0.1` | Fractional band an instance must cross to switch level. |
| `refreshDistance` | `1` | Camera movement (m) that re-sorts instances into levels. |
| `layers` | `[]` | `ScatterLayer[]`, below. |

Layer fields (all but `name` have defaults):

| Field | Default | |
|---|---|---|
| `name` | — | Also seeds the layer's clumping noise. |
| `group` | `name` | Layers in one group share a point set and never overlap; each point goes to one layer by its density. |
| `spacing` | `4` | Minimum distance between instances (group: the first layer's). |
| `density` | `1` | 0..1 keep probability, or `(x, z) => number` (e.g. a biome weight). |
| `minSlope` / `maxSlope` | `0` / `Infinity` | Terrain slope range (rise / run). |
| `minHeight` / `maxHeight` | `±Infinity` | Terrain height range. |
| `cluster` | `null` | `{ scale, threshold, strength }` noise that clumps instances into patches. |
| `scale` | `[1, 1]` | Uniform scale range. |
| `align` | `0` | 0 = upright, 1 = follow the terrain normal. |
| `randomYaw` | `true` | Random turn about the up axis. |
| `tilt` | `0` | Max random lean, radians. |
| `sink` | `0` | Metres pushed into the ground. |
| `colorVariation` | `0` | Per-instance brightness in `scatterParams.y`; multiply `scatterParamsNode().y` into your `colorNode` (before any weather, so snow stays white). |
| `lods` | `[]` | `{ distance, geometry, material, castShadow? }[]`, nearest first; `material` may be an array for geometry groups. |
| `impostor` | `null` | Far level drawn after the meshes (from `bakeImpostor`). |
| `castShadow` / `receiveShadow` | `true` | |

Everything is plain JSON except `terrain`, `camera`, `scene`, a function `density`, and the LOD geometries and materials.

## Exports

| Export | |
|---|---|
| `Scatter` | The streamer: `create`, `set`, `reset`, `update(budgetMs?)`, `query`, `setTerrain`, `regenerate`, `dispose`, `.object`, `.stats`. |
| `bakeImpostor(renderer, object, { mode, frames, size, hemisphere, alphaTest })` | Renders `object` from `frames × frames` octahedral directions (or one side view, `mode: 'billboard'`) into colour + normal atlases and returns `{ texture, normalTexture, material, geometry, bounds, dispose }`. The material is lit, alpha-tested and picks the nearest view in TSL. |
| `scatterParamsNode()` | TSL `vec4` per instance: yaw, brightness tint, random 0..1. Every pooled mesh carries it, so materials can vary per instance. |
| `placeTile`, `poissonDisk`, `clusterFactor`, `groupSeed`, `INSTANCE_STRIDE` | The pure placement functions (usable in a worker). |
| `selectLod`, `octEncode`, `octDecode`, `frameDirection`, `directionToFrame` | Pure LOD and octahedral math. |
| `disposeLayers(layers)` | Frees every geometry, material and texture of a set of layers. |
| `hash`, `hashString`, `mulberry32`, `valueNoise2`, `fbm2` | Deterministic random helpers. |

Pools start at 1100 instances and double as needed. That keeps three.js on its vertex-attribute instancing path (a
smaller pool would put its matrices in a uniform buffer that is reallocated when the pool grows). Replaced pools are
dropped (and garbage-collected) rather than `dispose()`d, because their geometry buffers are shared with the layer.

Multi-material levels are split into single-material meshes. In a shadow pass three.js draws every object with one
override material and keys its render object by object, so the groups of a material-array mesh would share one
render object and rebuild it (and its GPU binding buffers) for every group, every frame.

How placement stays seamless: one jittered candidate per global grid cell (`spacing / 2`) with a hashed priority;
a few elimination rounds keep candidates that beat every live neighbour within `spacing`. A candidate's fate after
`k` rounds depends only on candidates within `(2k + 1) · spacing`, so each tile evaluates that margin and keeps its own
points: tiles match exactly whatever order they are built in.

Imports from `three/webgpu` (WebGPURenderer; falls back to WebGL2 by itself). Full API docs:
<https://askalice.github.io/threejs-worldgen/docs/>.

## License

Apache-2.0
