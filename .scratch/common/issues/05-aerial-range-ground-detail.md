# 05: Aerial-range ground detail

**What to build:** At aerial range the ground is bare per-vertex colour because procedural detail fades out 220 m from the camera. A real aerial photograph is full of mid-scale texture — rock striations, sediment fans, snow fields, vegetation patches. Add a detail layer that survives 1–50 km without shimmering, using distance-stable noise or tiling that does not crawl as the camera moves.

**Context:** Detail currently combines five noise lookups gated by a fade that ends at 220 m; the biome colour beneath it is flat between vertices. The demo's default view is 4 km up, so almost none of the existing detail is visible.

**Blocked by:** None (its original blocker was completed and removed).

**Status:** ready-for-agent

- [ ] Ground at 5, 20 and 50 km altitude shows visible mid-scale variation rather than flat colour

## Comments

**2026-11-07** — The browser pass at 2.54 km found land variation present and stable (no crawl), but the **waterline** had a hard white band. That part was the water shader and the seabed jitter, not this detail layer: fixed in `48890aa` (foam AA and sub-pixel dimming) and `9961d72` (far-detail jitter in the seabed depth). This ticket's own 5/20/50 km check is still unverified.
- [ ] The detail does not shimmer or crawl in a static frame, nor swim when the camera moves slowly
- [ ] Detail is continuous across chunk boundaries with no visible tiling seam
- [ ] Near-ground detail from the existing layer is not lost or doubled
- [ ] Frame cost at the default aerial view stays within the demo's budget (measure and record)
- [ ] Typecheck and the terrain demo build pass
