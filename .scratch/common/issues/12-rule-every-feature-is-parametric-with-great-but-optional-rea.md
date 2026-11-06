# 12: Rule: every feature is parametric with great but optional React Three Fiber support

**What to build:** This work and all future work must be parametric, with great but optional React Three Fiber support.

**Blocked by:** None (can start immediately).

**Status:** ready-for-human

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#14](https://github.com/AskAlice/threejs-worldgen/issues/14)
- State: OPEN
- Milestone: threejs-worldgen · M1 — Worlds (WORLDGEN.md phases 1–4)
- Labels: enhancement, ready-for-human, verify-done, task, project:threejs-worldgen, area:docs
- Packages: shared
- Opened: 2026-10-13

## Request

This work and all future work must be parametric, with great but optional React Three Fiber support.

## Invariant

* One options object per feature; every number has a default; live `set(partial)` / `reset(full)`; options are plain JSON (save, share, send to a worker, bind to a GUI) except documented object inputs.
* Plain three.js first: imperative class with `.object`, `update()`, `dispose()`, async setup in `static create()`.
* `src/react.tsx` (`./react` export) wraps each class; `react` and `@react-three/fiber` are optional peer deps; the core never imports them.
* Deterministic from `seed` + position.

Documented in README → "Package conventions" (2026-10-09). Applies to all future packages, including CHARACTERS.md and the M4 items.

## Completion assessment

At migration the committed code (`worldgen-design` at 6f1b8ff) appears to complete this: **done, medium confidence**. Labelled `verify-done`: confirm and close.

- README 'Package conventions': parametric options with set/reset, deterministic, plain three.js class with .object/update/dispose/static create, optional R3F via ./react, WebGPU/TSL (README.md)
- All 12 feature packages ship src/react.tsx as a ./react export, with react and `@react-three/fiber` as optional peer dependencies (packages/sky/package.json)
- No core (.ts) source file in any package imports react or `@react-three/fiber` (packages/biomes/src/index.ts)
- Live set/reset on the main classes (World, WorldTerrain, Sky, City, Ocean, ...) (packages/biomes/src/world.ts)

Related: #11

---
<sub>Migrated from Linear ASK-11 · created 2026-10-09 by Alice Knag · priority: High</sub>
<!-- linear-id: ASK-11 -->
