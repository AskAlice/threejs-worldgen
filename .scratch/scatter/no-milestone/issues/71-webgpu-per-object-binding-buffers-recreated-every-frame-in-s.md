# 71: WebGPU per-object binding buffers recreated every frame in scatter forests (shadow pass)

**What to build:** After the octahedral impostor bake, the scatter demo kept recreating per-object binding buffers every frame. The console showed `Buffer "bindingBuffer…_object" used in submit while destroyed`.

**Blocked by:** None (can start immediately).

**Status:** ready-for-human

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#43](https://github.com/AskAlice/threejs-worldgen/issues/43)
- State: OPEN
- Milestone: none
- Labels: bug, ready-for-human, verify-done, task, project:threejs-worldgen, package:scatter, package:trees
- Packages: scatter, trees
- Opened: 2026-10-13

## Found while working

After the octahedral impostor bake, the scatter demo kept recreating per-object binding buffers every frame. The console showed `Buffer "bindingBuffer…_object" used in submit while destroyed`.

## Cause

Tree LODs were drawn as one mesh with a material array: bark, leaves and fruit.

In a shadow pass, three r186 draws every object with a single override material, and it caches the render object by object and material only. So all three parts of a tree shared one shadow render object.

Each part then wrote its own `alphaTest` (bark 0, leaves 0.5) and `side` into that shared override material. Moving `alphaTest` across zero bumps the material version, so the cache key stopped matching. three then destroyed and rebuilt the render object, with fresh binding buffers, for every part of every pool, every shadow pass, every frame.

It appeared "after the bake" only because that's when the forest starts rendering.

A second leak: each bake cloned every material per variant and never disposed the clones.

## Fix

* The scatter pool splits a multi-material level into one single-material `InstancedMesh` per material group. They share the instance matrices, colours and params, so draw count and uploads are unchanged.
* The R3F `<Tree>`, the lineup demo and the trees README build one mesh per part.
* `bakeImpostor` shares one bake material per source material and pass, and disposes it after the bake.

## Verified (headless Chrome)

* 0 uniform-buffer creations or destroys per frame while still. The only creations happen when new pools stream in.
* Steady 60 fps.
* Uniform buffers went from 368 to 265, and shader programs from 101 to 85.
* A test pins the per-material split.

## Remaining (needs-info)

About 0.67 `updateBindings` calls per render pass, with no allocations, likely from the shared demo environment in `example/shared.ts`.

## Completion assessment

At migration the committed code (`worldgen-design` at 6f1b8ff) appears to complete this: **done, medium confidence**. Labelled `verify-done`: confirm and close.

- Scatter pools split multi-material levels into one single-material InstancedMesh per material group sharing instance buffers (packages/scatter/src/scatter.ts ensurePool (b563543))
- Test pins the per-material split (packages/scatter/test/scatter.test.ts 'multi-material levels pool as single-material meshes…')
- bakeImpostor shares one bake material per source material/pass and disposes them after the bake (packages/scatter/src/impostor.ts (b563543))
- R3F <Tree> renders one mesh per part; README documents it (packages/trees/src/react.tsx; packages/trees/README.md)

Related: #52

---
<sub>Migrated from Linear ASK-247 · created 2026-10-11 by Alice Knag · </sub>
<!-- linear-id: ASK-247 -->
