# 84: threejs-photoreal: shared render pipeline with the three.js equivalents of Blender's realism settings

**What to build:** Provide the three.js equivalents of the most important settings people turn on in Blender when they want a render to look real.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#56](https://github.com/AskAlice/threejs-worldgen/issues/56)
- State: OPEN
- Milestone: none
- Labels: enhancement, ready-for-agent, story, project:threejs-worldgen, package:photoreal
- Packages: photoreal
- Opened: 2026-10-13

## Request

Provide the three.js equivalents of the most important settings people turn on in Blender when they want a render to look real.

## Finding (2026-10-11)

three r186 ships nearly every equivalent:

* AgX tone mapping;
* GTAO, SSGI, SSR and SSS (screen-space shadows);
* TRAA, SMAA, FXAA, TAAU and Denoise;
* Bloom, MotionBlur, DepthOfField, Godrays, Lensflare, Film;
* CSMShadowNode and ImportanceSampledEnvironment.

The repo barely uses them. Nine demos use ACES Filmic, and there's no SSR, SSGI, TRAA, motion blur, DOF, god rays or contact shadows. Each demo wires its own post-processing, or none.

## Mapping (Blender → three.js)

| Blender | three.js |
| -- | -- |
| AgX/Filmic view transform | `AgXToneMapping` |
| Exposure | `toneMappingExposure` plus auto-exposure |
| HDRI world | sky PMREM → `scene.environment`, importance sampled |
| Principled BSDF | `MeshPhysicalNodeMaterial` |
| Colour management | sRGB colour textures / linear data; physical light units |
| AO | GTAO |
| Raytracing / screen-space GI | SSGI |
| Screen-space reflections | SSR |
| Contact shadows | SSS |
| Soft shadows (light angle) | CSM with soft filtering at the sun's \~0.53° |
| Volumetrics / god rays | sky aerial perspective plus Godrays |
| Bloom / glare | Bloom (thresholded) |
| Motion blur | MotionBlur |
| Depth of field | DepthOfField |
| Samples / filter size | MSAA plus TRAA (or SMAA/FXAA), plus Denoise |
| Film grain / dither | Film |
| Texture filtering | mipmaps plus maximum anisotropy |

## Decision

A new package, **threejs-photoreal** (npm name free): `createPhotorealPipeline` with a shared MRT pass, all of the above with photoreal defaults, quality presets plus adaptive quality, sun-shadow, environment and texture helpers, an R3F wrapper, a demo, and a README mapping table.

Every demo and the combined world adopt it afterwards. AgX replaces ACES everywhere.

## Acceptance

* Each effect toggles independently and costs nothing when off.
* Presets hold their frame-time targets.
* A/B screenshots per effect.
* All demos switched over in a follow-up.

Related: #40, #54, #15

---
<sub>Migrated from Linear ASK-261 · created 2026-10-11 by Alice Knag · </sub>
<!-- linear-id: ASK-261 -->
