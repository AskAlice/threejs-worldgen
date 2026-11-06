# 82: Rule: no jaggies or sparkle — procedural AA (fwidth), smooth state fields, anisotropic filtering, Earth-like palettes

**What to build:** This looks nothing like the Earth. Remove anything jagged.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#54](https://github.com/AskAlice/threejs-worldgen/issues/54)
- State: OPEN
- Milestone: none
- Labels: enhancement, ready-for-agent, task, project:threejs-worldgen, area:docs, area:agents
- Packages: shared
- Opened: 2026-10-13

## Request

This looks nothing like the Earth. Remove anything jagged.

The user asked whether this needs anisotropic filtering and anti-aliasing.

The screenshots (weathering demo) show three problems: stair-stepped burn-scar edges, white salt-and-pepper sparkle on the char, and high-contrast camo noise on unburnt ground.

## Answer and cause

* **Anti-aliasing:** MSAA is already on in every demo (`antialias: true`). But MSAA only smooths geometry edges.
* **Sparkle:** shader aliasing. Procedural noise is evaluated above pixel frequency, and only threejs-city filters its patterns with `fwidth`.
* **Anisotropic filtering:** needed for real textures (the incoming CC0 sets and impostor atlases); `anisotropy` is set nowhere yet.
* **Jaggies:** state fields sampled with nearest filtering and hard thresholds.

## Rule (sent to every rendering agent: terrain, weathering/particles, trees/scatter, sky, world, water)

1. Fade every procedural octave out at the pixel footprint (`fwidth` / derivatives) and blend it to its mean.
2. No hard cell edges: bilinear/bicubic sampling of state fields, and noise-warped thresholds anti-aliased with `fwidth`.
3. Textures and sampled render targets get mipmaps plus `anisotropy = renderer.getMaxAnisotropy()`.
4. Alpha-to-coverage or stable dithering on foliage cards. TRAA/FXAA post where three r186 TSL offers it.
5. Earth-like, low-contrast palettes with realistic albedos.

To do: once the current agents land, add this to the README conventions, and sweep the remaining packages (city, props, vehicles, fauna, population) for unfiltered procedural patterns.

<details><summary>Linear discussion (2 comments)</summary>

**Alice Knag** · 2026-10-11

2026-10-11. The user clarified the core visual problem:

Both the jagged Earth screenshot and the anisotropic-filtering screenshot show a camouflage pattern; that pattern is what the earlier "obvious Gaussian noise" feedback refers to. It looks like an After Effects solid with the Clouds effect applied and the contrast raised a lot.

New rule (added to this one and sent to all six rendering agents: terrain, weathering/particles, sky, water, trees/scatter, world):

- Never drive colour, material, biome or density masks with raw fBm pushed through a narrow threshold or smoothstep. High-contrast isotropic noise produces camo blobs.
- Drive variation from physical fields: altitude, slope, curvature, aspect/insolation, flow accumulation and drainage, moisture, temperature, strata, fuel and fire history, wind direction.
- Noise only perturbs those fields: domain-warped, anisotropic, multi-scale, at low contrast.
- Blend materials by height plus fields, with soft wide transitions and low saturation, like aerial photography.
- Water comes from physical spectra and Jacobian foam. Clouds are structured weather systems.
- Judge every screenshot against real aerial and orbital photos: anything resembling the After Effects Clouds effect fails.

Add this to the README conventions together with the anti-aliasing rule.

---

**Alice Knag** · 2026-10-11

2026-10-11. Request:

Hold every visual change to a strict photorealism standard.

The bar is now a hard gate: Microsoft Flight Simulator 2020 on the ground and from the air, NASA/ISS/Artemis photos from orbit, and real photos for fire, water and forests.

Process:
- Every rendering agent compares its screenshots side by side with real reference photos, iterates until the remaining differences are resolution or detail rather than style, and lists the reference URLs.
- I review the screenshots before any visual commit and send back failures: camo or thresholded noise, sparkle, jaggies, flat or saturated colour, cartoon shapes, physically wrong light, water or smoke.
- Passing tests and typecheck is no longer enough to commit visual work.

</details>

Related: #56

---
<sub>Migrated from Linear ASK-259 · created 2026-10-11 by Alice Knag · </sub>
<!-- linear-id: ASK-259 -->
