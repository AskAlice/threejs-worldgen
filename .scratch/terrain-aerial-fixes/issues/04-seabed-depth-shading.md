# 04: Seabed depth shading

**What to build:** Under the new sea surface, the submerged ground must read as underwater: shallow shelves turquoise, mid depths blue-green, deep ocean dark. Today the sea floor keeps its dry mud and sand colours, so even with water added the ocean will look like flooded desert.

**Context:** The ground material already knows the waterline for the sand band; this extends that knowledge to depth below sea level. The water package's refraction and depth tint assume something sensible beneath it.

**Blocked by:** 03 (ocean surface, dogfooding threejs-water). Depth shading is only meaningful once there is a surface defining depth.

**Status:** ready-for-agent

- [ ] Ground colour is driven by depth below the local water surface: shallow, mid and deep bands distinguishable
- [ ] The shoreline transition between sand and submerged colour is smooth and noise-broken, not a hard ring
- [ ] Underwater ground darkens with depth so deep ocean reads dark rather than pale
- [ ] No banding or hard contour lines at depth thresholds in an aerial view
- [ ] The effect uses the same water surface the ocean renders, so a changing sea level moves the colour bands with it
- [ ] Typecheck and the terrain demo build pass
