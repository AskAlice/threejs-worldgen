# 02: Seamless LOD swaps

**What to build:** Changing level must not pop or flicker. With sampling fixed by ticket 01, the remaining pop is geometric: coarse vertices snap to their fine positions the moment a swap happens, selection can oscillate at a boundary, and adjacent levels can crack. Use the standard game techniques: geomorph vertices between levels over a transition band, add hysteresis so a boundary crossed does not immediately cross back, and hide remaining cracks with skirts or stitching.

**Context:** The demo currently swaps at a single distance threshold with no hysteresis, and the visible blocky coastlines and patch edges in aerial views are the cracks and snaps this ticket removes.

**Blocked by:** 01 (LOD-independent sampling). Morphing geometry onto a shape that is still LOD-dependent would just animate the bug.

**Status:** ready-for-agent

- [ ] Vertices morph between the coarse and fine positions across a transition band instead of snapping at the swap
- [ ] Selection has hysteresis: a level change requires crossing a margin, so a boundary does not oscillate while the camera drifts
- [ ] Cracks at level seams are hidden at every combination of neighbouring levels (skirts or stitching)
- [ ] A scripted camera sweep across several boundaries produces no visible pop and a bounded number of rebuilds per second
- [ ] Frame captures of the same world point before, during and after a swap show no colour or silhouette jump
- [ ] Performance stays within the existing build budget
