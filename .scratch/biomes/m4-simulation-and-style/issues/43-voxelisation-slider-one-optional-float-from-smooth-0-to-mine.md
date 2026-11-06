# 43: Voxelisation slider: one optional float from smooth (0) to Minecraft (1)

**What to build:** Additional to-do item: one optional float value that parametrically controls how voxelised the entire engine and its geometry are, from zero (smooth) up to Minecraft-style blocks.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#19](https://github.com/AskAlice/threejs-worldgen/issues/19)
- State: OPEN
- Milestone: threejs-worldgen · M4 — Simulation and style
- Labels: enhancement, ready-for-agent, story, project:threejs-worldgen, package:biomes, package:scatter, package:trees, package:water, package:city, package:grass, package:worldgen
- Packages: biomes, city, grass, scatter, trees, water, worldgen
- Opened: 2026-10-13

## Request

Additional to-do item: one optional float value that parametrically controls how voxelised the entire engine and its geometry are, from zero (smooth) up to Minecraft-style blocks.

## Approach

* One shared option `voxel: number` (0 = off, default) with a `voxelSize` (1 m at full).
* Terrain: quantise heights to `voxelSize` steps blended by the float; at 1 switch chunk builds to block geometry (top + side faces).
* Meshes (trees, rocks, buildings, grass, water): a shared TSL node that snaps world positions to the grid, blended by the float; normals snapped to axes at 1.
* Placement (scatter, city lots): snap to the grid.
* Works per package and globally through threejs-worldgen.

## Acceptance criteria

* 0 is byte-identical to today; values between blend smoothly; 1 looks block-built; no cracks at chunk seams.

---
<sub>Migrated from Linear ASK-16 · created 2026-10-09 by Alice Knag · </sub>
<!-- linear-id: ASK-16 -->
