# 21: React component nits found while building the R3F sandboxes (#65)

**What to build:** - `usePopulation` recomputes the whole model on every input change, which is slow while dragging a slider. Memoise or debounce inside the hook.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#68](https://github.com/AskAlice/threejs-worldgen/issues/68)
- State: OPEN
- Milestone: none
- Labels: bug, ready-for-agent, task, project:threejs-worldgen, package:population, package:props
- Packages: population, props
- Opened: 2026-10-13

- `usePopulation` recomputes the whole model on every input change, which is slow while dragging a slider. Memoise or debounce inside the hook.
- `<Props>` calls `props.reset()` during render instead of in an effect. Move it into an effect.
