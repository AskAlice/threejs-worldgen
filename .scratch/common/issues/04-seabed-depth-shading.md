# 04: Seabed depth shading

**What to build:** Under the new sea surface, the submerged ground must read as underwater: shallow shelves turquoise, mid depths blue-green, deep ocean dark. Today the sea floor keeps its dry mud and sand colours, so even with water added the ocean will look like flooded desert.

**Context:** The ground material already knows the waterline for the sand band; this extends that knowledge to depth below sea level. The water package's refraction and depth tint assume something sensible beneath it.

**Blocked by:** None (its original blocker was completed and removed).

**Status:** ready-for-agent

- [x] Ground colour is driven by depth below the local water surface: shallow, mid and deep bands distinguishable
- [x] The shoreline transition between sand and submerged colour is smooth and noise-broken, not a hard ring
- [x] Underwater ground darkens with depth so deep ocean reads dark rather than pale
- [ ] No banding or hard contour lines at depth thresholds in an aerial view
- [x] The effect uses the same water surface the ocean renders, so a changing sea level moves the colour bands with it
- [x] Typecheck and the terrain demo build pass

## Comments

**2026-11-07** — Browser check at 2.54 km: shallow/mid/deep colours read correctly, but the band edges ran as **stepped dashed contours along triangle chords**. Cause: depth was `-climate.x` (a per-vertex attribute) plus patch noise, and the patch noise is exactly zero beyond the 220 m detail fade, so at aerial range the bands were pure iso-height curves of the interpolated attribute.

`9961d72`: depth and the sand edge also take the world-anchored far-detail jitter (per fragment, band-limited, its opacity the complement of the near patch layer), so edges wander with the terrain at every range. `seabedWeightsAtHeight` documents the fragment-height contract. Biomes 31 tests pass. Remote recheck pending.
