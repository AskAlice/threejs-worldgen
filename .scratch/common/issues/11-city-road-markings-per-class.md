# 11: Restore per-class road markings

**What to build:** The switch to the props `RoadSurface` flattened road markings: every street now gets one dashed centre line plus edge lines, so arterials lost their double centre line and minor roads lost their edge suppression. Restore per-class markings by driving lane count and centre-line style per road class, either through new props material inputs or a per-edge attribute the road mesh supplies.

**Context:** Surfaced while implementing #45 (roads adopt `RoadSurface`). `RoadSurface` takes `lanes` and `centreLine` as material uniforms, so one city uses one style; the old per-class behaviour needs a props change.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Arterials render a double centre line; residential streets render a single one; minor roads suppress edge lines
- [ ] Marking style follows the road class, not one material-wide setting
- [ ] Lane counts per class survive the change
- [ ] The props package exposes whatever the city needs, with tests on the props side
- [ ] A city screenshot shows visibly different markings on arterial, residential and minor roads
- [ ] Typecheck, props and city builds pass
