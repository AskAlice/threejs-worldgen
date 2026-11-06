# 08: Typed vehicle parameters

**What to build:** A vehicle's parameters are currently a loose record of primitives, re-validated at every consumer, so a misspelled parameter name or a string where a number belongs falls back silently at runtime instead of failing the build. Each vehicle kind should carry a typed parameter shape, so wrong keys and wrong value types are compile errors while defaults and rendered models stay identical.

**Context:** Found in the 70-commit review (standards axis, primitive obsession). The parameter definitions already describe type, range and options; the value type does not use them.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Each vehicle kind's parameter values are typed from its parameter definitions
- [ ] An unknown parameter key and a wrong value type are compile errors at the call sites
- [ ] Missing parameters still resolve to their declared defaults
- [ ] Models and demos render unchanged for the existing parameter sets
- [ ] Tests cover default resolution for every kind and at least one rejected shape
- [ ] Typecheck and the vehicles package build pass
