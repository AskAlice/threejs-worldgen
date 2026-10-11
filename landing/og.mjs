// Renders the social cards and app icons from the existing screenshots. One-off and macOS-only (one headless Chrome
// driven over the DevTools protocol, plus sips for the icon sizes); the outputs are committed, so `npm run build:site`
// never needs a browser.
//
//   node landing/og.mjs
//
// Writes landing/media/og/<short>.jpg (one 1200×630 card per lander), landing/media/og/home.jpg (the homepage mosaic)
// and landing/favicon.svg, landing/apple-touch-icon.png, landing/icon-192.png and landing/icon-512.png.
// Re-run after adding a lander or replacing a hero screenshot.
import { readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { esc, plain, OG } from './seo.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const MAX_BYTES = 200 * 1024
const HOME = { accent: '#1f5a35', icon: '<circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M6 19c4-3 7 1 10-2s6-6 10-3M9 9c3 2 6 1 8-1" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="27" cy="6" r="2.2" fill="currentColor"/>' }

const pkgs = await Promise.all(readdirSync(join(root, 'landing/packages')).filter((f) => f.endsWith('.mjs'))
  .map(async (f) => (await import(pathToFileURL(join(root, 'landing/packages', f)))).default))
const mediaFile = (p) => [join(root, 'landing/media', p), join(root, 'media', p)].find(existsSync)
// Hero, else thumbnail, else the first screenshot in the package's media folder.
const shotOf = (p) => [p.hero?.img, p.thumb].filter(Boolean).map(mediaFile).find(Boolean)
  ?? (existsSync(join(root, 'landing/media', p.short)) ? readdirSync(join(root, 'landing/media', p.short)).filter((f) => f.endsWith('.jpg')).map((f) => join(root, 'landing/media', p.short, f))[0] : null)
const url = (f) => pathToFileURL(f).href

const FONT = '-apple-system, BlinkMacSystemFont, "Inter", "Helvetica Neue", sans-serif'
const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${OG.width}px; height: ${OG.height}px; overflow: hidden; background: #0b0f0d; font-family: ${FONT}; color: #f4f1e8; }
  .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .shade { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(8,12,10,.9) 0%, rgba(8,12,10,.62) 42%, rgba(8,12,10,0) 72%), linear-gradient(0deg, rgba(8,12,10,.55), rgba(8,12,10,0) 45%); }
  .txt { position: absolute; left: 64px; bottom: 84px; width: 660px; }
  .brand { display: flex; align-items: center; gap: 12px; font: 600 24px/1 ${FONT}; letter-spacing: .01em; opacity: .9; }
  .brand svg { width: 34px; height: 34px; }
  h1 { margin: 22px 0 18px; font: 700 84px/1 ${FONT}; letter-spacing: -.045em; }
  h1 i { font-style: normal; }
  p { margin: 0; font: 400 28px/1.35 ${FONT}; opacity: .92; }
  .tags { margin-top: 26px; font: 600 18px/1 ui-monospace, Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; opacity: .72; }
  .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 14px; }
</style></head><body>${body}</body></html>`
const svg = (icon, color) => `<svg viewBox="0 0 32 32" style="color:${color}">${icon}</svg>`

function card(p, shot) {
  const light = `color-mix(in oklab, ${p.accent} 45%, white)`
  return page(`<img class="bg" src="${url(shot)}">
  <div class="shade"></div>
  <div class="txt">
    <div class="brand">${svg(p.icon, light)}threejs-worldgen</div>
    <h1>threejs<i style="color:${light}">${esc(p.name.replace(/^threejs/, ''))}</i></h1>
    <p>${esc(plain(p.pitch))}</p>
    <div class="tags">WebGPU · three.js · React Three Fiber</div>
  </div>
  <div class="bar" style="background:${p.accent}"></div>`)
}

function mosaic(shots) {
  const cells = shots.slice(0, 12).map((s) => `<img src="${url(s)}" style="width:100%;height:100%;object-fit:cover;display:block">`).join('')
  return page(`<div style="position:absolute;inset:0;display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(3,1fr);gap:4px">${cells}</div>
  <div class="shade" style="background:linear-gradient(90deg, rgba(8,12,10,.92) 0%, rgba(8,12,10,.7) 50%, rgba(8,12,10,.25) 100%)"></div>
  <div class="txt" style="width:900px">
    <div class="brand">${svg(HOME.icon, '#9fd0ad')}${pkgs.length} packages · one seed per world</div>
    <h1>threejs<i style="color:#9fd0ad">-worldgen</i></h1>
    <p>Procedural worlds for three.js and React Three Fiber: terrain and biomes, water, forests, grass, cities, weather and sky.</p>
    <div class="tags">WebGPU · three.js · React Three Fiber</div>
  </div>
  <div class="bar" style="background:${HOME.accent}"></div>`)
}

// The site mark: the worldgen globe in paper on a green tile. `round` = false for the full-bleed apple-touch-icon.
const iconSvg = (round) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="${round ? 7 : 0}" fill="${HOME.accent}"/><g transform="translate(3.2 3.2) scale(.8)" style="color:#f4f1e8">${HOME.icon}</g></svg>\n`

// ---------- render ----------

const ogDir = join(root, 'landing/media/og')
mkdirSync(ogDir, { recursive: true })
writeFileSync(join(root, 'landing/favicon.svg'), iconSvg(true))

const tmp = mkdtempSync(join(tmpdir(), 'worldgen-og-'))
const profile = join(tmp, 'chrome-profile')
// One headless Chrome for every shot, driven over the DevTools protocol (Node's built-in WebSocket).
const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run',
  '--no-default-browser-check', '--hide-scrollbars', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' })
let ws
let id = 0
const pending = new Map()
const loaded = []
const send = (method, params = {}) => new Promise((res, rej) => {
  pending.set(++id, { res, rej })
  ws.send(JSON.stringify({ id, method, params }))
})
async function connect() {
  const portFile = join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100)
  const port = readFileSync(portFile, 'utf8').split('\n')[0]
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data)
    if (m.method === 'Page.loadEventFired') loaded.shift()?.()
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result)
  }
  await send('Page.enable')
}
async function shoot(html, w, h, format, quality) {
  const file = join(tmp, 'page.html')
  writeFileSync(file, html)
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  const load = new Promise((res) => loaded.push(res))
  await send('Page.navigate', { url: url(file) })
  await load
  await send('Runtime.evaluate', { expression: 'Promise.all([...document.images].map((i) => i.decode().catch(() => {}))).then(() => document.fonts.ready)', awaitPromise: true })
  return Buffer.from((await send('Page.captureScreenshot', { format, quality, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } })).data, 'base64')
}

try {
  await connect()
  const jobs = pkgs.map((p) => [p.short, shotOf(p) ? card(p, shotOf(p)) : null])
  jobs.push(['home', mosaic(pkgs.map(shotOf).filter(Boolean))])
  for (const [name, html] of jobs) {
    if (!html) { console.warn(`og: no screenshot for ${name}, skipped (the site falls back to home.jpg)`); continue }
    let jpg
    for (const q of [84, 76, 68, 60, 52]) if ((jpg = await shoot(html, OG.width, OG.height, 'jpeg', q)).length <= MAX_BYTES) break
    writeFileSync(join(ogDir, `${name}.jpg`), jpg)
    console.log(`og: ${name}.jpg ${(jpg.length / 1024).toFixed(0)} KB`)
  }
  const icon = join(tmp, 'icon.png')
  writeFileSync(icon, await shoot(`<!doctype html><html><body style="margin:0;background:${HOME.accent}">${iconSvg(false).replace('<svg ', '<svg width="512" height="512" style="display:block" ')}</body></html>`, 512, 512, 'png'))
  for (const [name, size] of [['icon-512.png', 512], ['icon-192.png', 192], ['apple-touch-icon.png', 180]]) {
    spawnSync('sips', ['-z', String(size), String(size), icon, '--out', join(root, 'landing', name)], { stdio: 'ignore' })
    console.log(`icon: ${name}`)
  }
} finally {
  ws?.close()
  chrome.kill()
  spawnSync('pkill', ['-f', profile])
  rmSync(tmp, { recursive: true, force: true })
}
