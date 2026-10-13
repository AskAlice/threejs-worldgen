# threejs-particles

GPU particle systems for three.js WebGPU. Each system is a fixed-capacity pool in storage buffers that TSL compute
passes emit, move and depth-sort, drawn with one instanced draw. Nothing is read back to the CPU. Emitters are seeded
and run as a ring buffer from a point, box, disc, sphere or a weighted list of sources the CPU refreshes cheaply.
Forces cover gravity, temperature-driven buoyancy with cooling, wind with shear and drag, and curl-noise turbulence.
Size, colour and opacity follow lifetime curves. Built-in shading covers lit volumetric smoke, blackbody flame
tongues, spark streaks and heat haze, all with soft depth fade. An optional coarse grid handles particle-to-grid and
grid-to-particle passes. Wildfires in `threejs-weathering` are built on it.

**[Live sandbox](https://askalice.github.io/threejs-worldgen/demo/particles.html)** ·
**[API docs](https://askalice.github.io/threejs-worldgen/docs/modules/threejs-particles.html)**

```bash
npm i threejs-particles three
```

## three.js

```ts
import * as THREE from 'three/webgpu'
import { ParticleGrid, ParticleLighting, ParticleSystem } from 'threejs-particles'

const renderer = new THREE.WebGPURenderer({ antialias: true })
await renderer.init()

const lighting = new ParticleLighting()                       // sun + sky, shared by systems
const grid = new ParticleGrid({ resolution: [24, 32, 24], min: [-30, 0, -30], size: [90, 120, 60], wind: [2, 0, 0] })
const flames = new ParticleSystem({
  capacity: 1500, rate: 160, life: [0.6, 1.2], lighting,
  emitter: { shape: 'disc', size: [1.2, 0, 0], temperature: [1750, 2100] },
  forces: { buoyancy: 0.3, cooling: 1.2, wind: [2, 0, 0], drag: 2.5, turbulence: 6, turbulenceScale: 1.2 },
  render: { shading: 'flame', blending: 'additive', size: 1.1, aspect: 2.6, stretch: 0.1, blackbody: true },
})
const smoke = new ParticleSystem({
  capacity: 2500, rate: 45, life: [12, 20], lighting, grid,
  emitter: { shape: 'disc', position: [0, 2, 0], size: [1, 0, 0], temperature: [450, 520] },
  forces: { buoyancy: 0.25, cooling: 0.08, wind: [2, 0, 0], gridLift: 1.5 },
  render: { shading: 'smoke', blending: 'alpha', sort: true, size: 3.5 },
})
scene.add(smoke.object, flames.object)
const heat = grid.splat(flames, 0, (p) => p.temperature.sub(400).max(0).div(1200).mul(0.02))    // P2G, per second

renderer.setAnimationLoop(() => {
  lighting.fromScene(scene)
  // One batched compute submission: emit + update per system, the splat, then the grid resolve
  // (advects heat with wind + updraft). The smoke reads the grid's heat (lift) and density (shadowing).
  renderer.compute([...flames.prepare(renderer, dt, camera), ...smoke.prepare(renderer, dt, camera), heat, ...grid.resolvePasses(dt)])
  smoke.sort(renderer)                      // or simply system.update(renderer, dt, camera) per system
  renderer.render(scene, camera)
})

flames.set({ forces: { wind: [6, 0, 1] } }) // every setting is live except the structural ones below
smoke.setSources(points)                    // emitter.shape 'sources': 8 floats each (x, y, z, weight, data×4)
```

It needs the WebGPU backend (compute). On the WebGL 2 fallback the systems hide themselves.

## React Three Fiber

```tsx
import { ParticleGrid, Particles } from 'threejs-particles/react'

<ParticleGrid resolution={[24, 32, 24]} min={[-30, 0, -30]} size={[90, 120, 60]}>
  <Particles capacity={2500} rate={45} emitter={{ shape: 'disc' }} render={{ shading: 'smoke', sort: true }} />
</ParticleGrid>
```

`react` and `@react-three/fiber` are optional peer dependencies; the core never imports them.

## What's in the box

| Export | What it does |
|---|---|
| `ParticleSystem` | One pool: emit, update and sort compute passes plus one instanced draw. `set`/`reset`, `setSources`, `update(renderer, dt, camera)` (or `prepare` + `sort` to batch), `particle(i)` nodes, `buffers` |
| `ParticleGrid` | Coarse 3D grid, 4 float channels per cell: atomic `splat` (P2G), `resolve` / `resolvePasses` (advect and decay), trilinear `sample` (G2P) in any shader |
| `ParticleLighting` | Sun direction and colour plus ambient sky, filled from a scene's lights, shared by systems |
| `EmitterClock`, `spawnRate` | Deterministic ring-buffer spawn scheduling: fractional carry, serials and slots, throttled to the pool |
| `fillSourceTable`, `pickSource` | Weighted sources: heaviest kept on overflow, prefix sums the GPU binary-searches |
| `evalCurve`, `resampleCurve`, `CurveUniforms` | Lifetime curves: evenly spaced keys, resampled to 8 GPU keys in uniform arrays |
| `blackbodyColor`, `blackbodyRadiance`, `blackbodyNode` | Planckian colour (Krystek) and T⁴ radiance, on the CPU and in TSL |
| `bakeNoiseVolume`, `noiseVolume`, `curlNoise` | Seeded tileable 3D noise texture, and divergence-free curl noise from it |
| `sanitizeParticleOptions`, `resolveParticleOptions` | Option checking: anything out of range from a GUI or URL becomes safe |

## Options

Every option is plain JSON with a default (`DEFAULT_PARTICLES`). `capacity`, `render.shading`, `render.blending`,
`render.sort`, `render.shadowSteps` and `render.lightSteps` shape the GPU programs, so they are fixed at construction.
Everything else is a uniform.

| Group | Options |
|---|---|
| top level | `seed`, `capacity`, `rate` (per second, or per unit of source weight), `maxPerFrame`, `life` |
| `emitter` | `shape` (`point` `box` `disc` `sphere` `sources`), `position`, `size`, `velocity`, `spread`, `temperature` |
| `forces` | `gravity`, `buoyancy`, `ambientTemperature`, `cooling`, `wind`, `windShear`, `drag`, `turbulence`, `turbulenceScale`, `turbulenceSpeed`, `gridLift` |
| `curves` | `size`, `opacity`, `color` (1 to 8 evenly spaced keys over life) |
| `render` | `shading` (`unlit` `flame` `smoke` `spark` `haze`), `blending`, `size`, `sizeRandom`, `aspect`, `stretch`, `intensity`, `opacity`, `blackbody`, `softness`, `sort`, `detail`, `detailDistance`, `shadowSteps`, `lightSteps`, `absorption`, `anisotropy`, `silverLining`, `albedo`, `glow`, `glowStrength`, `refraction` |

### Shading

- **`smoke`**: each puff's shape is warped, billowing 3D noise that evolves over its life, eroded at the edges so
  puffs merge into one volume. It is lit with a Henyey-Greenstein phase (with a silver lining when back-lit), wrap
  lighting, an ambient sky term and per-pixel self-shadow taps towards the sun. With a grid, it also gets a
  per-particle transmittance through the plume's density. A multiple-scattering floor keeps deep smoke from going
  black. Hot smoke glows from below and cools to grey. Sources tint it from clean (white) to dirty (dark brown).
  Above `render.capHeight` the smoke caps into bright, dense, sharply billowing cloud. Alpha particles closer to the
  camera than about their own size fade out and are culled, which removes the costliest full-screen overdraw.
- **`flame`**: noise-distorted tongues, stretched along velocity but kept buoyantly upright. With
  `blending: 'premultiplied'` they emit light and their dense cores hide what is behind. Colour comes from a blackbody ramp along and across the
  tongue (deep red edges, a near-white core) in HDR, so bloom picks it up.
- **`spark`**: thin streaks along velocity that cool by blackbody. They are kept at least 1.5 px wide and dimmed
  rather than allowed to alias.
- **`haze`**: refracts the opaque scene behind it (screen-space offset from animated noise).

### Quality knobs (performance)

| Knob | Cost |
|---|---|
| `capacity` per system | Memory, plus update and sort time (linear) |
| `render.detail`, `render.detailDistance` | Per-pixel noise. Fades out with distance, and self-shadow taps are branched off beyond it |
| `render.shadowSteps` (0 to 4) | Smoke noise taps per pixel towards the sun |
| `render.lightSteps` (0 to 8) | Grid samples per smoke particle per frame |
| `render.sort` | Four small compute passes (GPU counting sort, 1024 depth bins) |
| `ParticleGrid.resolution` | Grid cells: resolve cost and plume detail |

## Extending: MPM snow (#18)

The pieces an approximate position-based MPM solver needs are already here and public:

- **Pools**: `system.buffers` holds `position`, `velocity`, `props` and `light`. Add per-particle state, such as
  deformation gradient, plastic J or an APIC affine matrix, as more `instancedArray`s indexed by the same
  `instanceIndex`.
- **P2G**: `grid.splat(system, channel, value)` atomically adds any per-particle value (fixed point) into a cell.
  MPM writes mass and momentum into the four channels (`x, y, z` momentum and `w` mass), with weights
  over the 27 nearest cells instead of the nearest one.
- **Grid update**: `grid.resolve` is the per-cell pass (today semi-Lagrangian advection and decay). An MPM grid
  step adds gravity, divides momentum by mass and applies boundaries in the same place.
- **G2P**: `grid.sample(p)` is trilinear in any compute or render shader. MPM gathers velocity (and the APIC affine
  term) back to particles in its own update kernel.
- **Neural model reduction**: the update kernel is a plain TSL `Fn`. A reduced model replaces the force sum with a
  small MLP whose weights sit in a `uniformArray` or storage buffer.

What's missing for MPM: the quadratic B-spline weights, a separate momentum grid with a velocity solve, and
collision with terrain (sample a heightfield texture in the update kernel).
