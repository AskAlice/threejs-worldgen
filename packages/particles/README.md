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
| `MPMSolver` | MLS-MPM on WebGPU compute: `emit`, `step` (or `prepare` to batch), `set`, `setHeight`, `center`, `read`, `clear`, `dispose`. Terrain collision, deterministic fixed-point P2G |
| `registerMPMMaterial`, `JELLY` | Material registry: Kirchhoff stress and an optional plasticity hook in TSL, their CPU twins, JSON parameters |
| `MPMReference` | The same substep in plain TypeScript for tiny particle sets (tests, and checking the GPU) |
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

## MPM (material point method)

`MPMSolver` is a real-time MLS-MPM solver (Hu et al. 2018) on WebGPU compute: APIC transfers with quadratic
B-splines over 3×3×3 nodes, a per-particle deformation gradient F, plastic volume ratio Jp, material id and
temperature, and a terrain boundary from a height function. It is the core that snow (#72), water (#73) and lava
(#74) plug into; the core ships one test material, `jelly`.

```ts
import { MPMSolver } from 'threejs-particles'

const mpm = new MPMSolver(renderer, {
  resolution: [96, 64, 96], cellSize: 0.3, origin: [-14, 0, -14],  // a 28.8 × 19.2 × 28.8 m domain
  friction: 0.8, height: (x, z) => world.height(x, z),             // any (x, z) => y, e.g. threejs-heightfield
})
scene.add(mpm.object)
mpm.emit({ center: [0, 6, 0], size: [1.8, 1.8, 1.8] })              // a jelly block: 8 particles per cell
renderer.setAnimationLoop(() => { mpm.step(1 / 60); renderer.render(scene, camera) })
mpm.set({ materials: { jelly: { youngs: 2e5 } }, gravity: [0, -3, 0] }) // live
mpm.center(camera.position.x, camera.position.y, camera.position.z)    // follow (moves by whole cells, with hysteresis)
```

```tsx
<MPM resolution={[64, 48, 64]} cellSize={0.25} height={world.height} emit={[{ center: [0, 5, 0], size: [1, 1, 1] }]} />
```

Each substep is three compute passes: **P2G** (each particle scatters mass and momentum, with its stress and APIC
terms, into its 27 nodes), the **grid update** (momentum / mass, gravity, domain walls and terrain; it also clears
the accumulators, so the grid is cleared every substep) and **G2P** (velocity, `C`, `F ← (I + dt·C)·F`, the
material's plasticity hook, advection). Particles are drawn by the pool's unlit shading, coloured by volume change.

- **Fixed point**: WebGPU has no float atomics, so P2G adds `round(value × 2²⁰)` as i32. Masses are normalised to
  "full cells of 1000 kg/m³" (a particle weighs ρ/8000) and momentum to that × m/s, so a node channel overflows only
  past 2048 units: a node's mass × speed must stay below 2048 (≈ 200× water at the 10 m/s speed limit). Resolution
  is 1e-6 of a cell's mass. Integer sums are order-independent, so a run is deterministic on a given GPU.
- **Time step**: `dt ≤ cfl·Δx / (maxSpeed + c)` (c: fastest sound speed of the materials) and `Δx² / (6ν)` (most
  viscous). `substeps` is the minimum per frame; past `maxSubsteps` the simulation runs slower than real time
  rather than going unstable. `maxSpeed` is enforced on particles, so it is a true bound.
- **Terrain**: the height function is baked at the node columns (re-baked when the domain moves or `setHeight`).
  Nodes inside the ground lose their inward velocity with Coulomb `friction`; particles within one cell of the
  ground get the same friction, and none ever ends up below the (bilinear) ground.
- **Domain**: a fixed grid at `origin`; the GPU only sees positions relative to it (floating-origin safe). Its sides
  are slip walls (`walls`), or particles that leave it freeze.
- **Size and damping**: a block sags about g·L/c² under its own weight, and explicit viscosity can damp its slowest
  wobble only by roughly 1/(cells across it). The default jelly (E = 100 kPa, η = 1000 Pa·s) suits blocks of a metre
  or two at Δx = 0.25 m; bigger bodies want a larger Δx and a stiffer material.

### Materials

A material is registered once and compiled into solvers whose `materials` option names it (the keys are fixed at
construction; the parameters are live uniforms). Particles carry the material index in `buffers.state.x`.

```ts
registerMPMMaterial({
  name: 'snow',
  defaults: { density: 400, youngs: 1.4e5, poisson: 0.2, hardening: 10, compression: 0.025, stretch: 0.0075 },
  stress: ({ F, J, Jp, C, temperature, dt, params }) => tau,             // Kirchhoff stress P·Fᵀ, a TSL mat3
  plasticity: ({ F, Jp, params }) => ({ F: Fe, Jp: newJp }),           // optional, after F is advanced in G2P
  cpu: { stress: (c) => tau9, plasticity: (c) => ({ F: Fe9, Jp }) },   // the same in plain TS (column-major 3×3)
  soundSpeed: (p) => Math.sqrt((lambda + 2 * mu) / p.density),
  viscosity: (p) => 0,                                                 // optional kinematic ν for the time step
})
const mpm = new MPMSolver(renderer, { materials: { jelly: {}, snow: { hardening: 8 } } })
mpm.emit({ center: [0, 4, 0], size: [2, 0.5, 2], material: 'snow' })
```

Notes for the material tickets: snow needs an SVD of F (clamp the singular values, update Jp) inside its
`plasticity`; water can keep F = J^(1/3)·I in `plasticity` and use an equation-of-state pressure as `stress`; lava
can use `C` for viscosity and return a new `temperature` from `plasticity` (it lives in the pool's `props.x`, so
blackbody shading reads it). `buffers.state.z/w` are free per-particle slots. `MPMReference` runs the same substep on
the CPU, so each material can be tested against the GPU the way `test/mpm.test.ts` does for jelly
(`example/mpm.html?check` records the GPU side).
