# 22: Shallow water shows dashed green outlines

**What to build:** Remove the dashed, dithered green outlines visible on the water surface where the bed or an obstacle is close to the surface. They read as an artifact rather than water.

**Context:** Seen during the remote browser pass on `alice-linux` at the demo's default water view and in a 2.6 m-altitude close-up: green bed/obstacle patches show through shallow water (correct) but are ringed by dashed pixel-level outlines. Suspects: the depth-rejection comparison flipping per pixel on a half-resolution depth source, the foam mask's derivative filter at grazing angle, or the shoreline alpha band interacting with refraction. Screenshot on the remote host: `/home/alice/shots/w_close_crop.png`.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] At the demo's default view and at 2.6 m altitude, shallow patches show no dashed or dithered outlines
- [x] The bed still shows through shallow water and foam still follows the bank
- [x] Root cause identified (depth rejection, foam filter, or alpha band) and stated in the ticket comment
- [x] No regression in the smooth shoreline or the per-channel absorption
- [x] Water tests, package build and typecheck pass

## Comments

**2026-11-07** — First fix failed the browser check: the dotted ring was still there. The clamp was not the cause. The water thickness was taken from the **refracted** sample's depth, which is a different world point, so the behind/in-front test flipped pixel by pixel along the waterline and the thickness alternated between 0 and the full water depth — a dashed dark ring round every shallow patch.

`48890aa`: thickness now always comes from the pixel's own depth (refraction still chooses the colour sample); the shoreline coverage band spans four pixels instead of two (a 2 px smoothstep still steps 0.75 of its range per pixel), and the foam ramp gets the same anti-aliasing plus a sub-pixel dimming term so the band cannot become a hard white ring at aerial range. Water 54 tests pass.

**Second browser check still FAILS.** At 3.4 m the dashed dark-green outlines still ring every pale patch. The screenshots (copied to the Mac and inspected) show the marks are **not** foam or seabed edges: they are 1 px dots spaced every few pixels along the boundary of pale blobs, and at 2.5 km the same artifact becomes a regular diagonal lattice of white dashes over open sea. A regular screen-space lattice points at a periodic shader stage (whitecap crests, reflection march, or ripple normals), not at an alpha edge. A controlled remote experiment is toggling whitecaps, foam, detail and the depth/normal prepass one at a time to name the stage before the next fix. Do not spend another patch on the mask until that result is in.
