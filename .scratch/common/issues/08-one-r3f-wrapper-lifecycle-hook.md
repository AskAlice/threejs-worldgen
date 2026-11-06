# 08: One R3F wrapper lifecycle hook

**What to build:** The React wrappers for grass, city and particles each repeat the same lifecycle: create asynchronously with a cancellation flag, dispose on unmount, call reset with the latest props, expose an imperative handle, and (for grass) adopt a terrain ref. One hook should own that lifecycle so a fix lands once instead of three times. Wrapper props and behaviour stay unchanged.

**Context:** Found in the 70-commit review (standards axis, duplicated code). The grass wrapper repeats the block internally for its two components as well as across packages.

**Blocked by:** None (its original blocker was completed and removed).

**Status:** ready-for-agent

- [ ] One hook implements create/cancel/dispose, prop-to-reset sync, the imperative handle and terrain adoption
- [ ] Grass (both components), city and particles wrappers use it; no duplicate lifecycle block remains
- [ ] Public component props and exported types are unchanged
- [ ] Unmounting mid-create disposes the created field exactly once
- [ ] The terrain-adoption rule is preserved, covered by the same test
- [ ] Typecheck, the grass build and the example build pass
