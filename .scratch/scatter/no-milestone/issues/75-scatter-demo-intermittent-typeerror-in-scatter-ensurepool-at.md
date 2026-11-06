# 75: scatter demo: intermittent TypeError in Scatter.ensurePool at startup; measure impostor-weather fps cost

**What to build:** 1. **Intermittent startup error.** Two separate agents (#8 and #44) each saw "Cannot read properties of undefined" / `TypeError` in `Scatter.ensurePool` once when `/scatter.html` first loaded. It didn't recur in later runs, and the same setup runs fine in Node. Possibly a stale Vite dev-server reload while files were being edited, or a real startup race (pools created before a layer's LOD data is 

**Blocked by:** None (can start immediately).

**Status:** needs-info

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#47](https://github.com/AskAlice/threejs-worldgen/issues/47)
- State: OPEN
- Milestone: none
- Labels: bug, needs-info, task, project:threejs-worldgen, package:scatter, package:trees
- Packages: scatter, trees
- Opened: 2026-10-13

## Found while working (2026-10-11)

1. **Intermittent startup error.** Two separate agents (#8 and #44) each saw "Cannot read properties of undefined" / `TypeError` in `Scatter.ensurePool` once when `/scatter.html` first loaded. It didn't recur in later runs, and the same setup runs fine in Node. Possibly a stale Vite dev-server reload while files were being edited, or a real startup race (pools created before a layer's LOD data is ready). Cause unconfirmed.
2. **Impostor weather perf.** After #44, the scatter demo HUD read 23 fps vs 50 fps before. The shots used different viewports and ran under very different machine load, so this is not a confirmed regression. The impostor material now does more work per pixel (tint, burn, wet, snow, leaf-loss mask).

## To do

* Reproduce 1 with a cold load of `/scatter.html` (fresh dev server, clean cache) several times. If it recurs, fix the race in `ensurePool`.
* Measure 2: same camera (`?cam=0,70,0,250,10,250`), same viewport (1280×720), an idle machine, and #44 on vs off, each in clear weather and full snow. If the impostor shader costs more than a few ms, gate the weather terms (skip snow/wet/burn math when all uniforms are 0) or move them to cheaper paths.

Follow the one-Chrome lock routine for browser checks.

Related: #8, #44

---
<sub>Migrated from Linear ASK-252 · created 2026-10-11 by Alice Knag · </sub>
<!-- linear-id: ASK-252 -->
