# 55: Fuzzy-searchable asset gallery for spawning and placing assets

**What to build:** Every asset should also generate randomly in plausible locations, and there should be a fuzzy-searchable asset gallery for spawning and placing assets.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#37](https://github.com/AskAlice/threejs-worldgen/issues/37)
- State: OPEN
- Milestone: threejs-worldgen · M5 — Living world
- Labels: enhancement, ready-for-agent, story, project:threejs-worldgen, package:worldgen, area:site
- Packages: worldgen
- Opened: 2026-10-13

## Request

Every asset should also generate randomly in plausible locations, and there should be a fuzzy-searchable asset gallery for spawning and placing assets.

As a world builder I want to search every asset by name, tags, biome and package (fuzzy, typo-tolerant), preview it with thumbnails, tweak its parameters, and click to place it on the terrain (snapped to ground/water, aligned, with a seeded variant), so that I can hand-dress a generated world.

Shared `AssetRegistry` (in threejs-worldgen) that every package registers into: id, name, tags, package, biome affinity, parameter schema (JSON), generator, placement rules, thumbnail. Gallery UI in the demos (three.js and R3F). Placed assets serialise to JSON with the world seed.

## Progress so far

Assessed at migration against committed code (`worldgen-design` at 6f1b8ff): **partial**.

- [x] Shared registry type with id, name, tags, package, biome affinity, params, placement, generator, optional thumbnail
- [x] Fuzzy, typo-tolerant search
- [ ] Every package registers into the registry
- [ ] Gallery UI with thumbnails in three.js and R3F demos
- [ ] Parameter tweaking in the gallery
- [ ] Click to place on terrain/water with a seeded variant
- [ ] Placed assets serialise to JSON with the world seed
- [ ] Registry exported from threejs-worldgen

Evidence:
- AssetRegistry with typo-tolerant fuzzy search over names, tags, categories, packages and biomes; thumbnail field; seeded planSpawns (packages/worldgen/src/assets.ts (b2bc431))
- Tests for fuzzy search and plausible placement (packages/worldgen/test/assets.test.ts)
- worldgen exports nothing, so the registry isn't public (packages/worldgen/src/index.ts)
- No gallery UI is committed in the demos (example/ at HEAD (no gallery files))

Related: #15

---
<sub>Migrated from Linear ASK-36 · created 2026-10-09 by Alice Knag · </sub>
<!-- linear-id: ASK-36 -->
