# 52: Epic: Parametric scenery assets matched to biomes (vegetation, fauna, roads, props, buildings)

**What to build:** Add parametric scenery assets that promote variety and match the biome each asset lives in: trees from spruce to oak to apple to palm to redwood, as well as bushes, plants, fish, asphalt, sidewalks, dirt roads, mailboxes, power lines, houses, skyscrapers, …

**Blocked by:** None (can start immediately).

**Status:** ready-for-human

- [ ] Behaviour described in the imported issue body is implemented

**Type:** epic · imported from GitHub

## Imported issue

- Imported from: [#34](https://github.com/AskAlice/threejs-worldgen/issues/34)
- State: OPEN
- Milestone: threejs-worldgen · M5 — Living world
- Labels: enhancement, ready-for-human, epic, project:threejs-worldgen, package:scatter, package:trees, package:fauna, package:city, package:props, package:worldgen
- Packages: city, fauna, props, scatter, trees, worldgen
- Opened: 2026-10-13

## Request

Add parametric scenery assets that promote variety and match the biome each asset lives in: trees from spruce to oak to apple to palm to redwood, as well as bushes, plants, fish, asphalt, sidewalks, dirt roads, mailboxes, power lines, houses, skyscrapers, …

Every asset should also generate randomly in plausible locations, and there should be a fuzzy-searchable asset gallery for spawning and placing assets.

## Breakdown

* Vegetation: trees (incl. apple — added to the threejs-trees agent's scope 2026-10-09), bushes and plants (berryBush, flowers, tallGrassTuft, succulent, bamboo, lilyPad added). Per-instance variation params so nothing looks cloned. → #11
* Road surfaces (asphalt, dirt, gravel, cobblestone), sidewalks/kerbs, biome-matched house and skyscraper variety → threejs-city agent's scope (added 2026-10-09). → #12
* Street props: mailboxes, power lines (catenary wires between poles along roads), street lights, signs, fences, benches → new `threejs-props`.
* Fauna: fish schools (boids in water volumes), later birds/animals → new `threejs-fauna`.
* Every asset registers in a shared asset registry with: biome affinity, placement rules (plausible locations), parameter schema, thumbnail.

## Acceptance criteria

* Every asset type is a parametric generator with seeded per-instance variation.
* Each registers placement rules so the world populates it in plausible places only (fish in water, mailboxes at house lots, power lines along roads between settlements, apple trees in orchards near farms, palms on warm coasts, …).

## Progress so far

Assessed at migration against committed code (`worldgen-design` at 6f1b8ff): **partial**.

- [x] Parametric generators with seeded per-instance variation for vegetation, fauna, props, buildings
- [x] Placement rules exist per package (scatter layers, fauna habitats, propAssets, vehicleAssets)
- [x] Road surfaces (asphalt, cobbles, gravel, dirt, sidewalks/kerbs) exist in threejs-props
- [ ] Every asset registers in one shared registry with biome affinity, param schema and thumbnail (trees, city and fauna don't register; registry not exported)
- [ ] Apple trees in orchards near farms (no orchard placement at HEAD)
- [ ] City streets use the props road surfaces (#45)
- [ ] Fuzzy-searchable gallery (#37)

Evidence:
- Tree/bush/plant generators incl. apple, spruce, oak, palm, redwood, berryBush, flowers, tallGrassTuft, succulent, bamboo, lilyPad (packages/trees/src/species.ts (b563543))
- Fauna: 12 fish species and bird flocks with habitat placement (858dc63)
- Props: 14 seeded street-furniture kinds, power lines, RoadSurface materials, propAssets() placement defs (dc1a12d; packages/props/src/assets.ts)
- City buildings vary by biome/climate (houses, blocks, towers) (packages/city/src/architecture.ts (4e021b6))
- Shared AssetRegistry with placement rules, isPlausible and planSpawns (packages/worldgen/src/assets.ts (b2bc431))
- Registry is not exported from the package: worldgen index exports nothing (packages/worldgen/src/index.ts)
- props and vehicles mirror PlacementRule instead of registering into the shared registry (packages/props/src/assets.ts; packages/vehicles/src/placement.ts)

<details><summary>Linear discussion (3 comments)</summary>

**Alice Knag** · 2026-10-10

2026-10-10: the fauna part is done. threejs-fauna was committed on worldgen-design (858dc63) and pushed. It has 12 procedural fish species and bird flocks, one InstancedMesh per species with boids, a Fauna registry, React wrappers and the fauna.html sandbox. 6/6 tests, clean typecheck. Still to do in this epic: trees/scatter (in progress), props and vehicles.

---

**Alice Knag** · 2026-10-11

2026-10-11: round 1 started an agent on threejs-props. It covers road surface materials (asphalt, sidewalks/curbs, dirt and gravel), mailboxes, power lines with catenary cables, street lights tied to the night factor, fences, signs, hydrants and other street furniture. Everything is instanced and single-material, tinted via an attribute (not instanceColor), with weather states, `propAssets()` placement rules and `decorateRoads()` for city road graphs. Trees, fauna and buildings are already covered by their own packages.

---

**Alice Knag** · 2026-10-11

2026-10-11: threejs-props committed and pushed. 8/8 tests and a clean typecheck. Headless check: 60 fps, 230 props, 26 meshes, 2,460 instances, no WebGPU errors.

What's in it:
- 14 seeded prop kinds: US/EU/UK mailboxes, wood and concrete poles and lattice pylons with catenary cables, two styles of street light, four fence styles, signs, benches, bins, hydrants, traffic lights, bus stops, hay bales and wells.
- One single-material InstancedMesh per shape, with an `aTint` attribute instead of instanceColor.
- Weather: per-instance threejs-weathering states. Damaged poles lean and their cables follow, snow ices the cables, damaged lamps go out.
- `RoadSurface` TSL materials: asphalt with markings, cracks, patches and tyre tracks; cobbles; gravel; dirt with ruts and potholes; sidewalks and curbs. Wet roads puddle, snow clears from the tracks first.
- `roadRibbon`/`RoadPath`, `decorateRoads()`, `planPowerLine()` and 24 `propAssets()` defs.

Added the `threejs-weathering` dependency to props/package.json.

Remaining gaps: street lights glow but cast no light pools or bloom, each `propAssets().create()` call builds its own materials, and junction corners are square.

The threejs-city road material adoption is filed separately.

</details>

Related: #11, #12

---
<sub>Migrated from Linear ASK-32 · created 2026-10-09 by Alice Knag · priority: High</sub>
<!-- linear-id: ASK-32 -->
