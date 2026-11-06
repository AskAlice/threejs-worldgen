# 56: Options menu categorised by package, then by class/struct

**What to build:** Revamp the options menu to categorise by package, with subcategories by struct/object/class.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#38](https://github.com/AskAlice/threejs-worldgen/issues/38)
- State: OPEN
- Milestone: threejs-worldgen · M5 — Living world
- Labels: enhancement, ready-for-agent, story, project:threejs-worldgen, package:worldgen, area:site
- Packages: worldgen
- Opened: 2026-10-13

## Request

Revamp the options menu to categorise by package, with subcategories by struct/object/class.

Top-level folders per package (threejs-biomes, -water, -scatter, -trees, -city, -sky, -grass, -weather, -population, -vehicles, …), inside them one folder per class/options struct (e.g. biomes → World → continents/mountains/…, WorldTerrain → material, SurfaceControls). Generated from each package's JSON options (`example/options-gui.ts` already generates panels from options objects) plus a small per-package manifest for ranges/choices. Searchable, collapsible, with reset-to-default per folder and share-by-URL.

## Progress so far

Assessed at migration against committed code (`worldgen-design` at 6f1b8ff): **partial**.

- [x] Top-level folders per package, sub-folders per class/options struct
- [x] Generated from each class's JSON options
- [x] Searchable, collapsible
- [x] Reset per folder
- [x] Share-by-URL
- [ ] Panel adopted across all package demos (water, fauna, population, city, grass/R3F)
- [ ] Small per-package manifest for ranges/choices (ranges and choices are passed inline per demo)

Evidence:
- createPanel: package folders, then class folders generated from JSON options; search box; per-class reset; share-by-URL (example/panel.ts (b2bc431))
- URL-shared options validated (existing keys, matching types) (5d78136)
- Panel used by the terrain, scatter, sky, props, vehicles and weathering demos (example/terrain.ts; example/scatter.ts; example/sky.ts; example/props.ts; example/vehicles.ts; example/weathering.ts)
- Water, fauna and population demos still build a plain lil-gui; city has no options GUI (example/water.ts; example/fauna.ts; example/population.ts; example/city.ts)

Related: #15

---
<sub>Migrated from Linear ASK-37 · created 2026-10-09 by Alice Knag · </sub>
<!-- linear-id: ASK-37 -->
