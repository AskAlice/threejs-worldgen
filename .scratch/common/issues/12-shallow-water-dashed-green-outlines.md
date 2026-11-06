# 12: Shallow water shows dashed green outlines

**What to build:** Remove the dashed, dithered green outlines visible on the water surface where the bed or an obstacle is close to the surface. They read as an artifact rather than water.

**Context:** Seen during the remote browser pass on `alice-linux` at the demo's default water view and in a 2.6 m-altitude close-up: green bed/obstacle patches show through shallow water (correct) but are ringed by dashed pixel-level outlines. Suspects: the depth-rejection comparison flipping per pixel on a half-resolution depth source, the foam mask's derivative filter at grazing angle, or the shoreline alpha band interacting with refraction. Screenshot on the remote host: `/home/alice/shots/w_close_crop.png`.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] At the demo's default view and at 2.6 m altitude, shallow patches show no dashed or dithered outlines
- [ ] The bed still shows through shallow water and foam still follows the bank
- [ ] Root cause identified (depth rejection, foam filter, or alpha band) and stated in the ticket comment
- [ ] No regression in the smooth shoreline or the per-channel absorption
- [ ] Water tests, package build and typecheck pass
