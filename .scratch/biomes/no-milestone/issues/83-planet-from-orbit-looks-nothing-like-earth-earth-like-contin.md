# 83: Planet from orbit looks nothing like Earth — Earth-like continents, ocean, climate belts, atmosphere and clouds

**What to build:** The terrain demo planet seen from orbit (screenshot) has the same problem. It should look more like this photo of Earth: [https://upload.wikimedia.org/wikipedia/commons/6/63/Earth_From_the_Perspective_of_Artemis_II.jpg](<https://upload.wikimedia.org/wikipedia/commons/6/63/Earth_From_the_Perspective_of_Artemis_II.jpg>)

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#55](https://github.com/AskAlice/threejs-worldgen/issues/55)
- State: OPEN
- Milestone: none
- Labels: bug, ready-for-agent, story, project:threejs-worldgen, package:biomes, package:sky, package:worldgen
- Packages: biomes, sky, worldgen
- Opened: 2026-10-13

## Request

The terrain demo planet seen from orbit (screenshot) has the same problem. It should look more like this photo of Earth: [https://upload.wikimedia.org/wikipedia/commons/6/63/Earth_From_the_Perspective_of_Artemis_II.jpg](<https://upload.wikimedia.org/wikipedia/commons/6/63/Earth_From_the_Perspective_of_Artemis_II.jpg>)

(The reference is a public Wikimedia Commons photo.)

## What the screenshot shows

* The whole sphere is brown, olive and green camo patches with thin white outline artifacts.
* No oceans.
* One random white ice blotch.
* No atmosphere or clouds; a black background.

## Causes

* Continent scale isn't tied to planet radius, so a 60 km demo planet gets hundreds of small patches.
* Ocean biomes aren't coloured as water from orbit when threejs-water isn't loaded.
* Climate isn't latitude-banded enough.
* The terrain demo doesn't use threejs-sky.
* The patch outlines are aliasing.

## Target (the Artemis II photo)

* About 70% deep-navy ocean with turquoise shelves and sun glint.
* Large coherent continents and islands with long natural coastlines; mountains along plate-like ranges.
* Latitude belts: green tropics, tan subtropical deserts, temperate greens, taiga and tundra, ice at both poles.
* White swirling cloud systems with soft shadows.
* A thin blue scattering limb.
* Stars behind.

## Split across running agents

* **Terrain (#40, biomes):** Earth-like generation on spheres (or an `earthLike` preset), water-like ocean albedo from orbit, outline fix, and sky atmosphere and stars in the terrain demo.
* **Sky (#51):** the procedural planet fallback matches the photo; clouds at planet scale.
* **World (#15):** an orbit preset composing water, sky and Earth-like biomes at the largest radius streaming supports.

## Acceptance

A side-by-side screenshot in the same framing as the photo reads as an Earth-like planet.

Related: #40, #15, #51

---
<sub>Migrated from Linear ASK-260 · created 2026-10-11 by Alice Knag · </sub>
<!-- linear-id: ASK-260 -->
