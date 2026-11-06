# 72: Impostor (far-LOD) trees ignore weather states — no snow/wet/burn at distance

**What to build:** The #8 agent found this on 2026-10-11 during its browser check. In `/scatter.html` with snow at 1, near trees show white snow, but distant impostor trees show no snow at all. They look the same as in clear weather.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#44](https://github.com/AskAlice/threejs-worldgen/issues/44)
- State: OPEN
- Milestone: none
- Labels: bug, ready-for-agent, task, project:threejs-worldgen, package:scatter, package:trees
- Packages: scatter, trees
- Opened: 2026-10-13

## Found while working

The #8 agent found this on 2026-10-11 during its browser check. In `/scatter.html` with snow at 1, near trees show white snow, but distant impostor trees show no snow at all. They look the same as in clear weather.

## Likely cause

The octahedral or billboard impostor material in threejs-scatter (`impostor.ts`) samples the baked albedo, which was baked with clear weather. That material never runs the weather states that the mesh LOD materials apply. Most likely `applyMaterialStatesTo` isn't applied to the impostor material, or the impostor has no up-facing normal to drive snow coverage.

## Fix

Apply the same states to the impostor material:

* snow from the baked normal's up component;
* wet darkening;
* burn/char, and damage if feasible.

Use the same uniforms as the mesh LODs, so the LOD switch doesn't pop. Keep the per-instance tint from `scatterParams.y` (#8).

## Acceptance

* At full snow, the forest reads as snowy all the way to the horizon, with no visible change at the mesh-to-impostor switch.
* Wet and burn states match the same way.
* No extra draw calls.

## Progress so far

Assessed at migration against committed code (`worldgen-design` at 6f1b8ff): **partial**.

- [x] Snow, wet and burn applied to impostors with shared uniforms
- [x] Per-instance tint kept
- [x] No extra draw calls
- [ ] No visible change at the mesh-to-impostor switch (self-reported: mid-distance impostors look greyer and patchier at full snow)
- [ ] Damage parity (broken branches stay on impostors)

Evidence:
- bakeImpostor bakes a per-material mask; applyImpostorWeather applies tint, burn, wet and snow with the mesh LOD uniforms; layers bake from clear-weather copies (a74abec)
- Test: impostors get the same weather as mesh LODs (snow by baked normal, wet, burn, leaf loss) (packages/trees/test/trees.test.ts)

<details><summary>Linear discussion (1 comment)</summary>

**Alice Knag** · 2026-10-11

2026-10-11: fixed and pushed. 21/21 scatter+trees tests, clean typechecks.

Cause: the mesh LODs get weather from trees' `treeUniforms`, but the impostor material only showed the baked colour times the tint. The bake also used the live materials, so weather at bake time would have been frozen into the atlas.

Fix:
- `bakeImpostor` bakes a per-material mask into the normal atlas alpha and exposes the baked surface.
- `applyImpostorWeather` (trees) applies tint, burn, wet and snow with the same uniforms and order as the meshes. Snow uses the baked normal, and leaf loss uses a baked foliage mask.
- Vegetation layers bake from clear-weather copies of the materials.
- No extra draw calls.

Visual check (before and after screenshots at full snow): before, a green impostor band sat behind the white near trees; after, it's snowy to the horizon. Wet and burn match near and far.

Known limits:
- Mid-distance impostors look a little greyer and patchier than the near meshes at full snow.
- Branches that damage breaks off on the mesh stay on the impostor.

Perf note: the HUD read 23 fps after vs 50 fps before, but the shots used different viewports and machine load, so they can't be compared. #47 tracks a proper same-conditions measurement.

</details>

Related: #8, #52, #47

---
<sub>Migrated from Linear ASK-249 · created 2026-10-11 by Alice Knag · </sub>
<!-- linear-id: ASK-249 -->
