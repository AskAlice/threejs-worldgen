# 04: Screen-space reflections with sky fallback

**What to build:** The surface should reflect what is actually around it — the far bank, a boat, the sky — instead of a flat `skyColor`. Trace reflections in screen space against the depth buffer, fall back to the environment/sky where the ray leaves the frame, and mix by Fresnel so calm water reflects sharply and rough water blurs toward the environment.

**Context:** The current surface reads as painted plastic because the reflection term is a constant colour. The atmosphere work in ticket 06 will later give the fallback a believable sky to reflect.

**Blocked by:** 01 (depth/normal prepass and colour copy).

**Verified on main:** implemented and committed; tests, typecheck and build pass. Visual acceptance not yet confirmed — a 51.9 m frame over the river mouth shows no obvious bank reflection, so check a lower, bank-facing camera before closing.

**Status:** ready-for-human

- [ ] Reflections show nearby geometry (bank, objects) rather than one constant colour
- [ ] Rays leaving the screen fall back to the environment without a visible seam
- [ ] Reflection strength follows Fresnel and the roughness setting blurs the reflection accordingly
- [ ] No unresolved noise or flicker in a static frame; temporal artefacts stay below a stated threshold
- [ ] A frame with an object on the bank shows its reflection at the waterline
- [ ] Typecheck and the water package build pass
