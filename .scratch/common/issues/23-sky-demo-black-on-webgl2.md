# 23: Sky demo renders black on the WebGL2 fallback

**What to build:** `sky.html` must render on the WebGL2 fallback, or the demo must say clearly that it needs WebGPU. Today the page produces a fully black frame when WebGPU is unavailable, even at midday.

**Context:** Remote browser pass on a host without WebGPU: the renderer logs `WebGPURenderer WebGPU unavailable, WebGL2 backend` and then repeatedly fails with `glBlitFramebuffer: Depth/stencil buffer format combination not allowed`, after which the context is lost. 197 warnings, zero errors, canvas 1841x1291, frame fully black at sun elevation 52°. The other demos (terrain, city, scatter, gallery, grass) render on the same host via WebGL2, so this is specific to the sky demo/renderer path. Screenshot: `/home/alice/code/.playwright-mcp/sky.png` on the remote host.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `sky.html` renders a day sky on a WebGL2-only browser, with no `glBlitFramebuffer` depth/stencil error
- [ ] If WebGPU is genuinely required, the demo detects it and shows a clear message instead of a black canvas
- [ ] Console has no context-loss errors on the fallback path
- [ ] A WebGPU browser still renders the same scene as before
- [ ] Sky tests, package build and typecheck pass
