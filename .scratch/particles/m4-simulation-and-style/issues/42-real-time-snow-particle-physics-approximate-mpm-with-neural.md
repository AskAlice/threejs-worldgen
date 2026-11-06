# 42: Real-time snow/particle physics: approximate MPM with neural model reduction (INR hyper-reduction)

**What to build:** Add real-time snow/particle physics that uses an approximation of the position-based material point model (MPM), further optimized by Neural Model Reduction. This approach uses Implicit Neural Representations (INR) to reduce the computational cost of MPM by orders of magnitude. It learns a continuous, discretization-agnostic deformation map, which allows hyper-reduction: dynamics are computed for 

**Blocked by:** None (can start immediately).

**Status:** ready-for-human

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#18](https://github.com/AskAlice/threejs-worldgen/issues/18)
- State: OPEN
- Milestone: threejs-worldgen · M4 — Simulation and style
- Labels: enhancement, ready-for-human, story, project:threejs-worldgen, package:particles, area:simulation
- Packages: particles
- Opened: 2026-10-13

## Request

Add real-time snow/particle physics that uses an approximation of the position-based material point model (MPM), further optimized by Neural Model Reduction. This approach uses Implicit Neural Representations (INR) to reduce the computational cost of MPM by orders of magnitude. It learns a continuous, discretization-agnostic deformation map, which allows hyper-reduction: dynamics are computed for only a small subset of material points. The technique reaches real-time performance with millions of points, with speedups of over 20x compared to full-order models, while keeping position errors below 1%.

## As a … I want … so that …

As a scene author I want snow and granular materials that deform, pile and react to characters in real time, so that winter biomes and footprints feel physical.

## Approach (to refine)

* Full-order reference: MLS-MPM / position-based MPM approximation on WebGPU compute (P2G, grid update, G2P) for snow (Stomakhin 2013 plasticity), sand (Drucker–Prager).
* Reduction: an INR (MLP) maps reference position → deformation; dynamics integrated in its latent space with hyper-reduction on a small subset of material points; decode positions for millions of render particles. Trained offline per material/scenario; inference in WGSL.
* Integration: snow cover from biomes (glacier, tundra, snowline), interaction with ragdolls/crowds and grass.

## Acceptance criteria

* Millions of points at 60 fps on a desktop GPU; >20× faster than the full-order model; < 1% position error vs full order on a benchmark scene.
* Parametric (material params, budget, particle count) with optional R3F component.

## Open questions

Training pipeline (Python/JAX offline vs in-browser), model size budget, which reference paper/implementation to follow.

<details><summary>Linear discussion (1 comment)</summary>

**Alice Knag** · 2026-10-11

2026-10-11: shared foundation decided. The user asked that the wildfire particle rework share its foundation with the snow physics feature (#50). A new **threejs-particles** package is being built as that common core. It has GPU storage-buffer particle pools with TSL compute emit and update, seeded emitters, forces, soft instanced billboards, and an optional coarse grid abstraction for particle-to-grid and grid-to-particle passes. MPM snow (position-based MPM plus neural model reduction) should build on that grid and those pools rather than a separate system. MPM itself is still not started.

</details>

Related: #50, #6

---
<sub>Migrated from Linear ASK-15 · created 2026-10-09 by Alice Knag · </sub>
<!-- linear-id: ASK-15 -->
