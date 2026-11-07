# 27: Publish threejs-grass 0.2.0 (blocked on NPM_TOKEN secret)

**What to build:** Publish the packages to npm and create tagged releases on GitHub.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] Behaviour described in the imported issue body is implemented

## Comments

**2026-11-07** — Closed: publishing is now the release workflow's job, not a ticket. Hidden by this ticket was that `.github/workflows/release.yml` uses OIDC trusted publishing and `<package>@<version>` tags; the old `v0.2.0` tag could never trigger it, and grass 0.2.0 was already on npm.

Shipped: grass bumped to 0.3.0 for the Corn and terrain-ref API, lockfile synced, `main` merged to origin, and `threejs-grass@0.3.0` tagged. The run (`42349162148`) passed `npm ci`, typecheck, tests and build, then failed `npm publish` with a 404 because npm has no trusted publisher for the package. That is an npm account setting, not repo work: add the trusted publisher (AskAlice / threejs-worldgen / release.yml) or run `npm login && scripts/publish-all.sh`, then `gh run rerun 42349162148 --failed`.

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

## Comments

**2026-11-07** — The token premise is out of date. `.github/workflows/release.yml` publishes with **OIDC trusted publishing** (`id-token: write`, no token) and triggers on `<package>@<version>` tags, so the old `v0.2.0` tag cannot start it. threejs-grass is already on npm at 0.2.0, so the release needed a new version.

Done: `threejs-grass` bumped to **0.3.0** (Corn and late-mounting terrain refs are new API since 0.2.0), lockfile synced (`a000c94`), `main` fast-forwarded to origin, and `threejs-grass@0.3.0` tagged and pushed. The workflow ran: `npm ci`, typecheck, the test suite and the build all passed; **`npm publish` failed with 404 "you do not have permission"**, which is npm's answer when the package has no trusted publisher matching this repo and workflow.

Remaining, needs npm account access (this machine is not logged in):
1. Add the trusted publisher for `threejs-grass` — GitHub Actions, org `AskAlice`, repo `threejs-worldgen`, workflow `release.yml` — or run `npm login && scripts/publish-all.sh`, which publishes and then registers it.
2. Rerun the failed job: `gh run rerun 42349162148 --failed`. The tag is in place, so no re-tag is needed.

---
<sub>Migrated from Linear ASK-30 · created 2026-10-09 by Alice Knag · </sub>
<!-- linear-id: ASK-30 -->
