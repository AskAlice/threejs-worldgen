# 06: Inland water via Rivers and Lakes

**What to build:** The world has rivers — the biome map draws them and the ground material darkens them as mud — but the 3D view shows dry channels. Render river and lake surfaces from the same world using the water package's own river and lake surfaces, so inland water matches what the map promises and what the hydrology computed.

**Context:** The water package already streams river surfaces for a world with a camera, scene, renderer, sun and origin, and can draw computed lakes. The terrain demo has all of those.

**Blocked by:** None (its original blocker was completed and removed).

**Status:** ready-for-agent

- [ ] Rivers visible in the 3D view follow the same polylines the biome map draws
- [ ] River surfaces sit at their water level and tuck under the carved banks without a gap
- [ ] Lakes, where the world produces them, render at their spill level
- [ ] Water at river mouths meets the ocean surface without a step or z-fighting
- [ ] Uses the water package's public river/lake surfaces; any gap is reported against that package
- [ ] Typecheck and the terrain demo build pass
