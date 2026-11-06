# 80: Photoreal vegetation (MSFS 2020 look): CC0 PBR textures + photogrammetry trees + upgraded procedural trees

**What to build:** The weathering demo looks poor overall. The tree assets are cartoonish, while the aim is the look of Microsoft Flight Simulator 2020, or something photorealistic.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#52](https://github.com/AskAlice/threejs-worldgen/issues/52)
- State: OPEN
- Milestone: none
- Labels: enhancement, ready-for-agent, story, project:threejs-worldgen, package:scatter, package:trees
- Packages: scatter, trees
- Opened: 2026-10-13

## Request

The weathering demo looks poor overall. The tree assets are cartoonish, while the aim is the look of Microsoft Flight Simulator 2020, or something photorealistic.

Decision (user, 2026-10-11):

Use a hybrid of CC0 textures and procedural generation: keep the procedural trees, load optional CC0 PBR texture sets, and also obtain SpeedTree exports or photogrammetry assets of trees.

## Plan (agent running)

* **CC0 assets:** photogrammetry trees and plants (Poly Haven / ambientCG), fetched by `scripts/fetch-assets.mjs` from a committed manifest (source, licence, author, checksum) into a gitignored `assets/`, budget about 150 MB. Not committed; fetched for demos and the site build.
* **SpeedTree:** licensed per user, so not redistributable in the public repo. Instead, a loader for any user glTF (SpeedTree exports, scans), documented.
* **Loaded models become species:**
  * single-material parts (#43);
  * LODs plus octahedral impostors with weather (#44);
  * attribute tint (#8);
  * full weather states;
  * mapped onto the BIOMES scatter tables.
* **Procedural fallback upgraded:**
  * PBR bark (CC0 sets or procedural);
  * a textured, translucent, two-sided leaf atlas;
  * canopy normals, alpha-to-coverage, denser natural branching;
  * hierarchical wind and crown-depth ambient occlusion.
* **Demo:** the scatter demo defaults to a photoreal forest, with a photoreal/procedural toggle and graceful fallback when assets are missing.

## Acceptance

* Reads as photoreal at eye level and from about 300 m.
* About 60 fps at 1280×720 for a dense forest.
* Licence-clean.
* Before/after screenshots.

## Related

* Ground CC0 PBR textures for the terrain: #53 (after #40).
* Weathering demo rebuilt on real terrain and trees: #50.

## Progress so far

Assessed at migration against committed code (`worldgen-design` at 6f1b8ff): **partial**.

- [x] Weather states on impostor far LODs (via #44)
- [x] Attribute tint applied before weather (via #8)
- [ ] CC0 photogrammetry trees/plants fetched by scripts/fetch-assets.mjs from a committed manifest into a gitignored assets/
- [ ] Documented loader for user glTF (SpeedTree exports, scans)
- [ ] Loaded models become species: single-material parts, LODs and impostors, BIOMES scatter mapping
- [ ] Procedural fallback upgrade: PBR bark, translucent two-sided leaf atlas, canopy normals, alpha-to-coverage, denser branching, hierarchical wind, crown AO
- [ ] Scatter demo defaults to a photoreal forest with a photoreal/procedural toggle and fallback
- [ ] Reads as photoreal at eye level and from about 300 m
- [ ] About 60 fps at 1280x720 for a dense forest
- [ ] Licence-clean
- [ ] Before/after screenshots

Evidence:
- Prerequisite from #44 is committed: impostors bake a material mask and trees.applyImpostorWeather applies tint, burn, wet and snow to far LODs. (a74abec)
- Prerequisite from #8 is committed: instance tint moved into the base colour before weather states, and instanceColor was dropped. (1f889a2)
- Octahedral impostors and LODs already exist in scatter/trees. (b563543)
- No CC0 manifest, fetch-assets script, glTF loader or model-species code is committed. cc0-assets.json, src/assets.ts, loader.ts, models.ts and scripts/fetch-assets.mjs are all untracked. (packages/trees)
- Procedural bark texture anisotropy is hard-coded to 4, not max anisotropy. There is no committed PBR bark or leaf-atlas upgrade. (packages/trees/src/materials.ts)

Related: #40, #44, #8, #50, #43

---
<sub>Migrated from Linear ASK-257 · created 2026-10-11 by Alice Knag · </sub>
<!-- linear-id: ASK-257 -->
