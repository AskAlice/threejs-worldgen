# 79: Zoom-out detail gap: planet becomes one flat colour between terrain patch and visible atmosphere

**What to build:** When zooming out, the skybox becomes extremely low-detail for a brief moment while the Earth still fills the screen, before the atmosphere is visible.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#51](https://github.com/AskAlice/threejs-worldgen/issues/51)
- State: OPEN
- Milestone: none
- Labels: bug, ready-for-agent, story, project:threejs-worldgen, package:biomes, package:sky
- Packages: biomes, sky
- Opened: 2026-10-13

## Request

When zooming out, the skybox becomes extremely low-detail for a brief moment while the Earth still fills the screen, before the atmosphere is visible.

## Cause

* In the sky demo, the only terrain is a 6 km sine-hill patch.
* Past it, the planet surface comes from the sky shader's fallback (`skyColorNode`, `hitsGround` branch in sky `atmosphere.ts`): one flat `groundColor` uniform with Lambert lighting.
* At mid altitudes (roughly 10–300 km) the patch no longer covers the view and the limb isn't visible yet, so the whole screen is a single flat colour.

## Fix (agent running)

1. **Sky package:**
   * an optional planet albedo input (node or texture; the host can pass threejs-biomes `renderWorldMap`);
   * a procedural default with seeded continents and oceans, ice caps, biome bands, distance-gated detail octaves, ocean glint and cloud shadows;
   * aerial perspective matched so the handoff from terrain to fallback is invisible.
2. **Sky demo:** replace the sine patch with the biomes streaming planet (`World` sphere plus `WorldTerrain`), and feed the fallback a `renderWorldMap` of the same world.

## Acceptance

* Zoom from 2 m to 1,000 km+ is continuously detailed, with no flat-colour band.
* The far planet's colours match the near terrain.
* Before/after zoom sequence at 1 / 10 / 30 / 100 / 300 / 1,000 km.
* fps reported at 30 and 300 km.

<details><summary>Linear discussion (1 comment)</summary>

**Alice Knag** · 2026-10-11

2026-10-11: agent report in. **Photorealism gate: FAIL**, not committed. The sky demo also depends on the uncommitted biomes `earthLike()` from #40/260.

Done so far:
- cause confirmed (flat fallback, plus fog hiding the patch);
- new `ground.ts` with an albedo map or a procedural Earth, using fwidth-capped octaves and packed-neighbour noise that fixed the stair-stepped coasts;
- a structured-weather cloud shell (`cloud-shell.ts`) with shadows;
- the sky dome drawn last among opaque objects;
- the demo moved to an Earth-radius biomes planet with floating origin and a baked albedo;
- AgX tone mapping;
- 29/29 tests, clean typecheck.

Review against the reference photos (Artemis II; the RITCHIE balloon photo at about 30 km; an ISS photo):
- **30 km:** the frame is washed-out sky blue, with the ground invisible and a sun blob. Exposure 2.13, in-scatter too strong. 5 fps.
- **300 km:** a huge round glare disc on the ocean, blurry coast, no clouds.
- **1,000 km:** muddy and low-contrast, blurry continents, rainbow limb banding, faint clouds.

Sent back with fixes:
- auto exposure meters the ground and clamps;
- Cox–Munk GGX glint;
- crisp coasts;
- Earth albedos and contrast (ocean about 0.06, land 0.15–0.3, clouds 0.7–0.9);
- less in-scatter;
- limb banding fixed with more steps near the limb or a precomputed transmittance table;
- crisp cloud systems at about 60–70% coverage;
- the 5 fps profiled;
- every altitude re-captured.

Needs from biomes:
- an equirectangular whole-planet `renderWorldMap`;
- `earthLike()` kept exported;
- a terrain-material hook for the sky's aerial perspective and cloud shadows.

</details>

Related: #40, #13, #57, #55

---
<sub>Migrated from Linear ASK-256 · created 2026-10-11 by Alice Knag · </sub>
<!-- linear-id: ASK-256 -->
