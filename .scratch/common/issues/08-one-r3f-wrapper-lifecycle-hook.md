# 08: One R3F wrapper lifecycle hook

**What to build:** The React wrappers for grass, city and particles each repeat the same lifecycle: create asynchronously with a cancellation flag, dispose on unmount, call reset with the latest props, expose an imperative handle, and (for grass) adopt a terrain ref. One hook should own that lifecycle so a fix lands once instead of three times. Wrapper props and behaviour stay unchanged.

**Context:** Found in the 70-commit review (standards axis, duplicated code). The grass wrapper repeats the block internally for its two components as well as across packages.

**Blocked by:** None (its original blocker was completed and removed).

**Status:** resolved

- [x] One hook implements create/cancel/dispose, prop-to-reset sync, the imperative handle and terrain adoption
- [x] Grass (both components), city and particles wrappers use it; no duplicate lifecycle block remains
- [x] Public component props and exported types are unchanged
- [x] Unmounting mid-create disposes the created field exactly once
- [x] The terrain-adoption rule is preserved, covered by the same test
- [x] Typecheck, the grass build and the example build pass

## Comments

**2026-11-06** — `d0621c0`. `useInstance`/`mount` live in `threejs-heightfield/react` (the base package every wrapper already depends on, and it already shipped a React entry), so no new package. Grass, Corn, City, Settlements, PopulationOverlay, Particles, MPM, MPMSnowSurface, FluidSurface and MPMLava use it; the mid-create unmount test proves dispose runs once and attach never happens after cancel.

Known taste cost: the particles wrappers now create in an effect rather than `useMemo`, so their return type is `JSX.Element | null` and they attach one commit after mount. Props and exported types are unchanged. Heightfield 11, grass 39, city 43, particles 65 tests pass.
