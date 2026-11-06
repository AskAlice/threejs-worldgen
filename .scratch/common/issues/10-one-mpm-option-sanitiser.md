# 10: One MPM option sanitiser

**What to build:** Water, lava, the reference solver and the fluid surface each repeat the same ladder of number coercion, integer rounding, clamping and hex validation over different option structs. One schema-driven sanitiser should serve all three, so a validation rule is fixed once and every solver rejects the same bad input the same way.

**Context:** Found in the 70-commit review (standards axis, repeated switches). The three ladders are structurally identical and differ only in field names and bounds.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] One sanitiser validates field type, range, integer rounding and colour format from a per-solver schema
- [ ] Water, lava, reference and the fluid surface use it; no hand-written ladder remains
- [ ] Invalid values fall back exactly as before (pinned by tests per field type: number, integer, colour)
- [ ] Each solver keeps its current defaults and clamping bounds
- [ ] Exhaust, vent and solver tests pass unchanged
- [ ] Typecheck and the particles package build pass
