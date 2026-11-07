# 10: One MPM option sanitiser

**What to build:** Water, lava, the reference solver and the fluid surface each repeat the same ladder of number coercion, integer rounding, clamping and hex validation over different option structs. One schema-driven sanitiser should serve all three, so a validation rule is fixed once and every solver rejects the same bad input the same way.

**Context:** Found in the 70-commit review (standards axis, repeated switches). The three ladders are structurally identical and differ only in field names and bounds.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] One sanitiser validates field type, range, integer rounding and colour format from a per-solver schema
- [x] Water, lava, reference and the fluid surface use it; no hand-written ladder remains
- [x] Invalid values fall back exactly as before (pinned by tests per field type: number, integer, colour)
- [x] Each solver keeps its current defaults and clamping bounds
- [x] Exhaust, vent and solver tests pass unchanged
- [x] Typecheck and the particles package build pass

## Comments

**2026-11-06** — `466ddff`. `packages/particles/src/sanitize.ts` holds a field-spec union plus `applySchema(options, schema, defaults)`; `MPM_SCHEMA`, `LAVA_SCHEMA`, `PUDDLE_SCHEMA`, `SPLASH_SCHEMA` and `FLUID_SURFACE_SCHEMA` replace the four ladders. Rounding stays `Math.round` after clamping; the dependent `maxSubsteps ≥ substeps` bound resolves in key order; `Infinity` still falls back rather than clamping; a short vector keeps defaults for missing elements. `MPMOptions.materials` stays hand-written (dynamic keys), and the separate `ParticleOptions` ladder in `options.ts` was out of scope and is untouched.

Particles 65 tests pass (13 new), build and example build pass.
