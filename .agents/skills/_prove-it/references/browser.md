# Driving a demo page

The repo has no headless browser dependency, so the browser half of a proof is run through the agent's browser tools
(MCP Playwright or Chrome DevTools MCP), not a shell script. This is the recipe; every `prove-<package>` skill with a
demo points here.

## Preconditions

1. `scripts/start.sh` — starts or reuses the dev server on `http://localhost:8460/`.
2. `scripts/health.sh <package>` — prints the commit, the package version and `library: UP`.
3. A WebGPU-capable browser. The demos use `WebGPURenderer`; if a page stays black and the console reports no adapter,
   append `?webgl` to force the WebGL2 fallback and record under **Not covered** that WebGPU itself was not proved.

## Steps

1. **Open** `http://localhost:8460/<page>` in a tab. Use one tab per page and close it when the check is done.
2. **Wait for the canvas and the HUD.** Evaluate:

   ```js
   () => {
     // Take the largest canvas: several demos also draw a small minimap canvas.
     const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0]
     const hud = document.querySelector('#hud, #status, .hud')
     return { canvas: !!c, w: c?.width ?? 0, h: c?.height ?? 0, hud: hud?.textContent?.trim().slice(0, 200) ?? null }
   }
   ```

   Ready means `canvas: true`, `w > 0`, `h > 0`, and either a HUD line or a non-empty scene title. Give it up to 30 s. Worker builds are normal: `scatter.html` shows \"generating trees…\" for several seconds, and chunk streaming fills the terrain demo progressively. Poll until the largest canvas has size and the HUD no longer ends with an ellipsis (`…`), which is how the loading HUDs read ("generating trees…", "loading…"). Do not match on the word "building": the city HUD says "326 buildings" once it is ready.
3. **Collect console errors.** With Chrome DevTools MCP: `list_console_messages` filtered to `error` (and `warn` for
   shader warnings). With Playwright MCP, if console collection is unavailable, re-open the page once with a listener
   injected through `addInitScript` if the tool offers one; otherwise record console as **not collected** on the receipt.
   Any `error` entry, WebGPU validation message, or shader compile error is BROKEN.
4. **Screenshot** the viewport after the HUD appears, and inspect it. A black frame, a single flat colour, or a page
   showing only the panel is BROKEN. Save it under `.prove-it/runs/<run>/<package>-<page>.png`.
5. **If the console shows `504 (Outdated Optimize Dep)` and no canvas appears**, Vite is re-optimising dependencies on first load. Reload the page once, then poll again. If the 504 survives the reload, the Vite optimizer cache is stale (it happens after a dependency changes): stop the server and start it again with `scripts/stop.sh` then `scripts/start.sh`, then reload. Record the retry in the receipt. This is a dev-server event, not a package failure.
6. **Check the demo's own numbers where it has them.** The water and terrain HUDs print frame time, camera altitude and
   object counts; a missing HUD line means the demo never initialised.

## What this does not prove

- Frame rate. The HUD's fps is indicative only; no budget is asserted.
- That the rendered image is *correct*, only that it is not blank and raised no errors. A visual regression needs a
  snapshot, which these skills do not use (the demos animate).
- The WebGL2 fallback unless `?webgl` was actually driven.
