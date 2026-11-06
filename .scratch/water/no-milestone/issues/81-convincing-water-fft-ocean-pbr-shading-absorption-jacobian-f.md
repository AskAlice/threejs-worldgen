# 81: Convincing water: FFT ocean, PBR shading, absorption, Jacobian foam, distance filtering; fix blurry-to-noise load-in

**What to build:** Find a much more convincing way of rendering water.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#53](https://github.com/AskAlice/threejs-worldgen/issues/53)
- State: OPEN
- Milestone: none
- Labels: enhancement, ready-for-agent, story, project:threejs-worldgen, package:water
- Packages: water
- Opened: 2026-10-13

## Request

Find a much more convincing way of rendering water.

When it first loads, the water also goes through an odd progressive scan, from a very blurry blob to obvious high-contrast Gaussian noise.

## Plan (agent running)

* **Diagnose the load-in progression and the noise look.** Likely suspects: a time-sliced wave or normal build, and unfiltered high-frequency normals aliasing at distance. First frames should look final.
* **Ocean:** a GPU FFT ocean via TSL compute (Tessendorf, JONSWAP/Phillips spectrum, wind-directional spreading), 2–3 cascades, choppy displacement. Fallback: tuned Gerstner waves plus detail normals.
* **Shading:**
  * Schlick Fresnel (IOR 1.33);
  * sky/environment reflection and sun specular, with roughness from slope variance;
  * refraction with per-channel Beer–Lambert absorption (turquoise shallows, dark-blue deep water);
  * in-scatter and subsurface glow through crests.
* **Foam:** Jacobian whitecaps with persistence, plus smooth shoreline foam. Includes #49 (edge speckle, z-fighting, demo overhang).
* **Distance:** LEAN/Toksvig-style normal filtering, so the far ocean becomes smooth glinting sky reflection; horizon and aerial perspective blending; planet curvature.
* **Rivers and lakes:** flow-mapped rivers with rapids, calm mirror lakes, and no overlapping surfaces.
* **Optional:** an underwater view with caustics.

## Acceptance

* Reads as real water from eye level to about 2 km and from orbit.
* No sparkle, noise or jaggies.
* No load-in progression.
* About 60 fps at 1280×720.
* Before/after screenshots.

Related: #49

---
<sub>Migrated from Linear ASK-258 · created 2026-10-11 by Alice Knag · </sub>
<!-- linear-id: ASK-258 -->
