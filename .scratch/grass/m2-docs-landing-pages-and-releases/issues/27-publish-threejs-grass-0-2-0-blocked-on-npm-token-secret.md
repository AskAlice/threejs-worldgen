# 27: Publish threejs-grass 0.2.0 (blocked on NPM_TOKEN secret)

**What to build:** Publish the packages to npm and create tagged releases on GitHub.

**Blocked by:** None (can start immediately).

**Status:** needs-info

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#32](https://github.com/AskAlice/threejs-worldgen/issues/32)
- State: OPEN
- Milestone: threejs-worldgen · M2 — Docs, landing pages and releases
- Labels: enhancement, needs-info, task, project:threejs-worldgen, package:grass, area:release
- Packages: grass
- Opened: 2026-10-13

## Request

Publish the packages to npm and create tagged releases on GitHub.

Tag `v0.2.0` exists; release run failed with ENEEDAUTH (no secret). Once the user sets `NPM_TOKEN` (granular, 2FA bypass), rerun that workflow run. Afterwards releases use `<package>@<version>` tags.

---
<sub>Migrated from Linear ASK-30 · created 2026-10-09 by Alice Knag · </sub>
<!-- linear-id: ASK-30 -->
