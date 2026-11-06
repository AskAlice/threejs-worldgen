# 57: Shrink the committed CC0 asset set (118 MB) for the web

**What to build:** The CC0 trees, plants, bark and leaf textures are committed (example/public/cc0, 118 MB) so the scatter demo never falls back. The demo would download all of it, and one tree mesh alone is 38.8 MB (island_tree_02.bin).

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#67](https://github.com/AskAlice/threejs-worldgen/issues/67)
- State: OPEN
- Milestone: threejs-worldgen · M5 — Living world
- Labels: enhancement, ready-for-agent, task, project:threejs-worldgen, package:trees, area:site
- Packages: trees
- Opened: 2026-10-13

## Request
The CC0 trees, plants, bark and leaf textures are committed (example/public/cc0, 118 MB) so the scatter demo never falls back. The demo would download all of it, and one tree mesh alone is 38.8 MB (island_tree_02.bin).

## Agent Brief
**Category:** enhancement
**Summary:** Cut the committed asset set to a web-friendly size without visible quality loss.

**Desired behavior:**
- Meshes compressed with meshopt or Draco (both decoders ship with three) and simplified for real-time use, with LODs.
- Textures at 1K/2K as KTX2 or JPEG/WebP, keeping normal maps high quality.
- The demo loads lazily, only the species in view.
- Credits and licences stay intact.

**Acceptance criteria:**
- [ ] The total committed set is at most about 30 MB, with no single file over 5 MB.
- [ ] The photoreal forest looks the same in side-by-side screenshots.
- [ ] No new runtime npm dependency (a dev-time optimiser script is fine).
