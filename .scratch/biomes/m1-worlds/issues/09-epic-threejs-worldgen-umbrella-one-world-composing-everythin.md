# 09: Epic: threejs-worldgen umbrella — one <World> composing everything, biome-driven grass, world demos

**What to build:** Implement all worldgen features as specified in PR \[#3\]. This work and all future work must be parametric, with great but optional React Three Fiber support.

**Blocked by:** None (can start immediately).

**Status:** ready-for-human

- [ ] Behaviour described in the imported issue body is implemented

**Type:** epic · imported from GitHub

## Imported issue

- Imported from: [#15](https://github.com/AskAlice/threejs-worldgen/issues/15)
- State: OPEN
- Milestone: threejs-worldgen · M1 — Worlds (WORLDGEN.md phases 1–4)
- Labels: enhancement, ready-for-human, epic, project:threejs-worldgen, package:biomes, package:grass, package:worldgen, area:site
- Packages: biomes, grass, worldgen
- Opened: 2026-10-13

## Request

Implement all worldgen features as specified in PR \[#3\]. This work and all future work must be parametric, with great but optional React Three Fiber support.

## Scope

* `packages/worldgen` (`threejs-worldgen`): a `WorldScene` / `<World>` that composes terrain, water, scatter/trees, cities, sky and grass from one parametric options object.
* Biome-driven grass: one `threejs-grass` field per preset in use near the camera, masked by camera-centred `GrassMap`s from biome weights; re-centred as the camera moves.
* Floating origin + scale-aware camera (near/far by altitude), ant ↔ orbit flight controls.
* Demos: `example/world.html` (three.js + lil-gui, every parameter) and `example/world-r3f.html` (R3F + leva).

## Depends on

Biomes, water, scatter/trees, city and sky epics.

## Update 2026-10-09

Provide a cohesive demo that uses all packages.

The flagship demo (`example/world.html` + R3F twin) composes every package: biomes terrain, water, scatter/trees, grass, city, population, props, vehicles, fauna, weathering and sky, with the categorised options panel (#38), the asset gallery (#37) and ant-to-orbit camera. Built as the integration step once the package agents land; each package also keeps its own sandbox.

## Update 2026-10-09 (2)

All of these packages should work in harmony to create a lively, detailed, well-shaded world.

Acceptance for the integration: one shared lighting/time model (sky drives sun, moon, IBL, night for every material), shared weathering states on every material, shared floating origin, biome-driven placement for every asset, population driving settlements/networks/traffic/night lights, consistent shading quality across packages (#40), and a single combined demo.

## Progress so far

Assessed at migration against committed code (`worldgen-design` at 6f1b8ff): **partial**.

- [x] Dependency epics landed (biomes, water, scatter/trees, city, sky, population, props, vehicles, fauna, weathering)
- [x] Floating origin and scale-aware camera available in threejs-biomes
- [x] Asset registry for the gallery
- [ ] WorldScene / <World> composing all packages from one options object
- [ ] Biome-driven grass (per-preset fields masked by camera-centred GrassMaps)
- [ ] example/world.html and example/world-r3f.html demos
- [ ] Integrated shared lighting/time, weathering, floating origin and biome-driven placement in one combined demo

Evidence:
- threejs-worldgen at HEAD exports nothing; index.ts is a 'work in progress' stub (packages/worldgen/src/index.ts)
- Shared AssetRegistry with fuzzy search and seeded spawn planning (not yet exported from the index) (b2bc431)
- Demos index lists a world.html card, but example/world.* is not committed (example/demos.html)
- Dependency packages landed: water, city, sky, scatter/trees, weathering, props, vehicles (84d767f)
- Shared sky state for other packages (sky.uniforms.night, sun direction/colour) (packages/sky/src/sky.ts)
- Shared weather tint on scatter/trees/city materials (1f889a2)
- Floating origin and scale-aware camera (SurfaceControls) (c177f3d)

<details><summary>Linear discussion (1 comment)</summary>

**Alice Knag** · 2026-10-11

2026-10-11. Request:

The user asked where the demo that uses every package is.

Status: not built yet. It's round 2, held at the user's request until the homepage and terrain work land. The homepage has landed; terrain realism (#40) is still running.

Every dependency it was waiting on has landed: biomes, water, scatter, trees, city, population, props, vehicles, fauna, weathering and sky. The demos index already has a dimmed `world.html` card.

It can start in parallel with terrain, because the folders are separate (`packages/worldgen` and `example/world.*`) and the terrain API is unchanged. Offered to start it now.

</details>

Related: #40, #37, #38, #56, #55

---
<sub>Migrated from Linear ASK-12 · created 2026-10-09 by Alice Knag · priority: High</sub>
<!-- linear-id: ASK-12 -->

## Update 2026-10-16

The flagship demo runs on a globe. Cities, towns and farms are generated from the population density model (#36), so settlement size and farmland follow population density across the planet. It uses as many packages as fit together: grass (meadows and corn on farmland), water, scatter and trees, sky, city, props, vehicles and fauna. Planning happens through a wayfinder map before implementation; the demos index lists it as its "threejs-worldgen" card.
