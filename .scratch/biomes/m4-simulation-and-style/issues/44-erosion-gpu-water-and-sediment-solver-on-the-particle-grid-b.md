# 44: Erosion: GPU water and sediment solver on the particle grid (baked first, steppable for live)

**What to build:** Erosion belongs in the particle-physics stack (with #18 and the shared GPU particle/grid package), not as a separate terrain feature. Terrain-scale erosion comes first as a **classic GPU solver**: water and sediment transport over the heightfield on the particle package's grid. It runs as a **baked pass** for bounded maps (deterministic, cached as the map's height source), and the same solver can 

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#33](https://github.com/AskAlice/threejs-worldgen/issues/33)
- State: OPEN
- Milestone: threejs-worldgen · M4 — Simulation and style
- Labels: enhancement, ready-for-agent, task, project:threejs-worldgen, package:heightfield, package:biomes, package:particles
- Packages: biomes, heightfield, particles
- Opened: 2026-10-13

## Request

Erosion belongs in the particle-physics stack (with #18 and the shared GPU particle/grid package), not as a separate terrain feature. Terrain-scale erosion comes first as a **classic GPU solver**: water and sediment transport over the heightfield on the particle package's grid. It runs as a **baked pass** for bounded maps (deterministic, cached as the map's height source), and the same solver can later step **live** for rain and flood scenes. Learned (NeuralMPM-style) acceleration is a separate research spike under #18.

## Decisions (triage, 2026-10-12)

- Live or baked: **both, baked first.** This issue delivers the baked pass with a steppable solver; live runtime mode is a follow-up.
- Learned acceleration: **classic solver first**, with a neural research spike that trains on this solver's output.
- Real-time erosion still needs numerical approximation. Recent claims about the Navier–Stokes existence problem don't remove that need (see the triage notes).

---
<sub>Migrated from Linear ASK-31 · created 2026-10-09 by Alice Knag · </sub>
<!-- linear-id: ASK-31 -->
