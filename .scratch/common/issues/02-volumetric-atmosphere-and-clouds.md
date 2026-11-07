# 02: Volumetric atmosphere and clouds

**What to build:** Replace the animated gaussian cloud splats with an atmospheric scattering model and volumetric clouds: sky colour from Rayleigh/Mie scattering, a sun disc, aerial perspective on distant terrain, and clouds that are lit and shadowed by the sun rather than drifting billboard blobs. This also gives ticket 01 a believable environment to reflect and completes the aerial-haze work that was ticketed separately.

**Context:** The user reports obvious gaussian clouds animating, a flat horizon and no atmosphere at altitude. Aerial views currently lerp a background colour and apply exponential fog, which produces a hard terminator.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Sky colour comes from a scattering model and changes with sun elevation, with a visible sun disc
- [ ] Clouds are volumetric, sun-lit with shadowed undersides, and do not read as moving blobs

## Comments

**2026-11-07** — Browser pass: sky colour, sun disc and the Kármán limb read well, but the clouds **FAIL**: flat soft white blobs and stretched haze with radiating streaks, no lit tops or shadowed undersides. The two-deck march is there but its shaping and shadowing are too crude at the demo's settings. Fix in progress.
- [ ] Distant terrain fades into aerial perspective instead of ending at a hard silhouette
- [ ] From 10 km to 100 km the sky grades toward space with a lit limb
- [ ] Frame cost stays within the demo budget at the aerial default view (measure and record)
- [ ] Typecheck and the sky package build pass
