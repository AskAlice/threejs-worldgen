# 02: Particles exported API is documented and honest

**What to build:** Every symbol the particles package exports is described in the published API docs, and the lava vent reads solver state through a public accessor instead of casting through two types into a private ring buffer. Today a set of exported constants render as bare names in TypeDoc, and one vent path reaches into solver internals with `as unknown as { head }`, which hides the coupling from the compiler.

**Context:** Found in the 70-commit review (standards axis, hard violations 2 and 3). The affected exports are the lava skin/yield family and the snow hardening family; the cast is in the lava vent code.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Every exported particles symbol has a JSDoc description that states units and valid range where they apply
- [ ] The docs build reports no undocumented exports for the package
- [ ] The solver exposes the ring-buffer accessor the vent needs, documented and covered by a test
- [ ] No `as unknown as` cast remains on the vent path
- [ ] Exhaust and vent tests pass unchanged
- [ ] Typecheck and the particles package build pass
