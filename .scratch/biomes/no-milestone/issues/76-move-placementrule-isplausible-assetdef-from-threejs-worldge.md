# 76: Move PlacementRule/isPlausible/AssetDef from threejs-worldgen into threejs-biomes (break the cycle)

**What to build:** threejs-props and threejs-vehicles both needed `PlacementRule`, `isPlausible` and `AssetDef` from `packages/worldgen/src/assets.ts`. They couldn't import them, because threejs-worldgen depends on every package, which would make a cycle. So each mirrored the types (vehicles also has a smaller built-in plausibility check, with `isPlausible` as an optional callback). That's three copies that will dri

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#48](https://github.com/AskAlice/threejs-worldgen/issues/48)
- State: OPEN
- Milestone: none
- Labels: enhancement, ready-for-agent, task, project:threejs-worldgen, package:biomes, package:props, package:vehicles, package:worldgen
- Packages: biomes, props, vehicles, worldgen
- Opened: 2026-10-13

## Found while working (2026-10-11)

threejs-props and threejs-vehicles both needed `PlacementRule`, `isPlausible` and `AssetDef` from `packages/worldgen/src/assets.ts`. They couldn't import them, because threejs-worldgen depends on every package, which would make a cycle. So each mirrored the types (vehicles also has a smaller built-in plausibility check, with `isPlausible` as an optional callback). That's three copies that will drift.

## Fix

* Move `PlacementRule`, `AssetParam`, `AssetDef` and `isPlausible` (and `planSpawns` if it doesn't need the registry) into threejs-biomes, which every package already depends on.
* threejs-worldgen keeps `AssetRegistry` and the fuzzy search, and re-exports the moved items for compatibility.
* props and vehicles import from threejs-biomes and delete their mirrors and fallback check.

## Acceptance

* One definition of each type.
* All package tests and typechecks pass.
* worldgen's `assets.test.ts` still passes.

---
<sub>Migrated from Linear ASK-253 · created 2026-10-11 by Alice Knag · </sub>
<!-- linear-id: ASK-253 -->
