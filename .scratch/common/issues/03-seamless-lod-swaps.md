# 03: Seamless LOD swaps

**What to build:** Changing level must not pop or flicker. With LOD-independent sampling in place, the remaining pop is geometric: coarse vertices snap to their fine positions the moment a swap happens, selection can oscillate at a boundary, and adjacent levels can crack. Use the standard game techniques: geomorph vertices between levels over a transition band, add hysteresis so a boundary crossed does not immediately cross back, and hide remaining cracks with skirts or stitching.

**Context:** The demo currently swaps at a single distance threshold with no hysteresis, and the visible blocky coastlines and patch edges in aerial views are the cracks and snaps this ticket removes.

**Blocked by:** None (its original blocker was completed and removed).

**Status:** ready-for-human

- [x] Vertices morph between the coarse and fine positions across a transition band instead of snapping at the swap
- [x] Selection has hysteresis: a level change requires crossing a margin, so a boundary does not oscillate while the camera drifts
- [x] Cracks at level seams are hidden at every combination of neighbouring levels (skirts or stitching)
- [ ] A scripted camera sweep across several boundaries produces no visible pop and a bounded number of rebuilds per second
- [ ] Frame captures of the same world point before, during and after a swap show no colour or silhouette jump
- [ ] Performance stays within the existing build budget

## Comments

**2026-11-06** — The three mechanical criteria landed in `60fff83` (Wave A) and were never ticked here: `chunk.ts` computes a per-vertex geomorph offset so a child lands on the parent's triangulated surface instead of snapping, `lod.ts` keeps `selectChunks` history for split/merge hysteresis, and every chunk carries a skirt deeper than the crack a finer neighbour opens. `chunk.test.ts` pins all three on planes and planets.

Still open for a human: the temporal checks (no pop across a sweep, before/during/after captures, rebuild budget). Those need a moving camera, so screenshots alone cannot prove them.
