# 13: Rule: generation is never random — seeded and procedural, but looks random

**What to build:** Map generation must never be random; it must be seeded and procedural, while still appearing random.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#39](https://github.com/AskAlice/threejs-worldgen/issues/39)
- State: OPEN
- Milestone: threejs-worldgen · M1 — Worlds (WORLDGEN.md phases 1–4)
- Labels: enhancement, ready-for-agent, task, project:threejs-worldgen, area:docs, area:tooling
- Packages: shared
- Opened: 2026-10-13

## Request

Map generation must never be random; it must be seeded and procedural, while still appearing random.

## Invariant

No `Math.random()` anywhere in generation code: every value derives from the world `seed` (hashed with position, tile/cell ids or instance ids via `hash4`/`mulberry32`). The same seed and options always produce the same world, in any order of streaming, on any machine, in workers. Variety comes from hashing, never from runtime randomness. Applies to every package (assets, placement, traffic schedules, weather, fire).

Check: grep for `Math.random` in packages/\*/src in CI (to add).

## Progress so far

Assessed at migration against committed code (`worldgen-design` at 6f1b8ff): **partial**.

- [x] No Math.random in generation code
- [x] Values derive from seed hashed with position/ids
- [x] Determinism covered by tests in several packages
- [ ] CI grep check for Math.random in packages/*/src (the issue says 'to add')

Evidence:
- No Math.random in any packages/*/src or example source at HEAD (packages/biomes/src/noise.ts)
- hash4 / mulberry32 / seedOf seeded helpers (packages/biomes/src/noise.ts)
- Determinism tests: tree generation per seed, scatter placement, city growth/planning, meteor schedule, procedural planets, cloud cover (packages/trees/test/trees.test.ts)
- 'Deterministic' rule in Package conventions (README.md)
- CI runs typecheck, tests and site build, but has no Math.random check (.github/workflows/pages.yml)

---
<sub>Migrated from Linear ASK-38 · created 2026-10-09 by Alice Knag · priority: High</sub>
<!-- linear-id: ASK-38 -->
