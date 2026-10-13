// TypeDoc plugin: search titles, per-page descriptions, canonical links and social cards for the API reference.
// Registered in typedoc.json ("plugin"). TypeDoc itself writes docs/sitemap.xml and the index canonical from
// "hostedBaseUrl"; this adds the rest through the renderer's head.end hook, and on endPage swaps TypeDoc's generic
// <title> and "Documentation for …" description for the ones below (a second description tag would be a duplicate),
// and keeps the docs home to one <h1>.
import { existsSync, readFileSync } from 'node:fs'
import { JSX, PageEvent, ReflectionKind } from 'typedoc'
import { SITE, seoTags, esc } from '../landing/seo.mjs'

const DOCS = SITE + 'docs/'
const API = 'threejs-worldgen API reference'
const PAGES = {
  'index.html': [`${API} · procedural worlds for three.js and React Three Fiber`, 'API reference for threejs-worldgen: WebGPU procedural terrain, biomes, water, trees, grass, cities, weather and sky packages for three.js and React Three Fiber.'],
  'modules.html': [`All packages · ${API}`, 'Every threejs-worldgen package and React Three Fiber entry point: heightfield, biomes, water, scatter, trees, grass, city, props, vehicles, fauna, weathering and sky.'],
  'hierarchy.html': [`Class hierarchy · ${API}`, 'The class hierarchy of the threejs-worldgen packages for three.js: terrain, water, scatter, grass, city, vehicles, fauna, weather and sky classes.'],
}

const clip = (s, n = 158) => s.length <= n ? s : s.slice(0, s.lastIndexOf(' ', n - 1)).replace(/[,;:.]$/, '') + '…'
// First paragraph of a doc comment as plain text: inline {@link}s keep their label, markdown is dropped.
function summary(r) {
  const parts = r?.comment?.summary ?? r?.signatures?.[0]?.comment?.summary ?? r?.type?.declaration?.signatures?.[0]?.comment?.summary
  if (!parts) return ''
  return parts.map((p) => p.text).join('').split(/\n\s*\n/)[0]
    .replace(/```[\s\S]*?```/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]|<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}
function pkgDescription(pkg) {
  const file = new URL(`../packages/${pkg.replace(/^threejs-/, '')}/package.json`, import.meta.url)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).description : ''
}

function info(page) {
  const short = (m) => m?.name.split('/')[0].replace(/^threejs-/, '')
  let mod = page.model
  while (mod && !mod.kindOf?.(ReflectionKind.Module)) mod = mod.parent
  const og = existsSync(new URL(`../landing/media/og/${short(mod)}.jpg`, import.meta.url)) ? short(mod) : 'home'
  const base = { url: DOCS + page.url, image: `${SITE}media/og/${og}.jpg`, imageAlt: `${mod?.name.split('/')[0] ?? 'threejs-worldgen'} for three.js` }
  if (PAGES[page.url]) return { ...base, title: PAGES[page.url][0], description: PAGES[page.url][1] }
  if (!mod) return { ...base, title: `${page.model.name} · ${API}`, description: clip(summary(page.model) || PAGES['index.html'][1]) }
  const react = mod.name.endsWith('/react')
  if (page.model === mod) {
    const what = react ? 'React Three Fiber components' : 'three.js API'
    return { ...base, title: `${mod.name} · ${what} reference`, description: clip(`${mod.name}: ${summary(mod) || pkgDescription(mod.name.split('/')[0])}`) }
  }
  const kind = ReflectionKind.singularString(page.model.kind).toLowerCase()
  const name = page.model.getFullName().slice(mod.getFullName().length + 1) // keeps namespace prefixes, drops the module
  return { ...base, title: `${name} ${kind} · ${mod.name} API`, description: clip(`${name} (${kind} in ${mod.name}${react ? ', React Three Fiber' : ', three.js'}): ${summary(page.model) || `part of the ${mod.name} API.`}`) }
}

export function load(app) {
  app.renderer.hooks.on('head.end', (context) => {
    const i = info(context.page)
    let html = seoTags({ ...i, themeColor: '#1f5a35' })
    if (context.page.url === 'index.html') html = html.replace(/<link rel="canonical"[^>]*>\n\s*/, '') // TypeDoc adds this one
    return JSX.createElement(JSX.Raw, { html: html + `<link rel="apple-touch-icon" href="${SITE}apple-touch-icon.png" />` })
  })
  app.renderer.on(PageEvent.END, (page) => {
    if (!page.contents) return
    page.contents = page.contents
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(info(page).title)}</title>`)
      .replace(/<meta name="description" content="Documentation for [^"]*"\/>/, '')
    // The README's "# threejs-worldgen" would be a second <h1> under TypeDoc's page title: make it an <h2>.
    if (page.url === 'index.html') page.contents = page.contents.replace(/<h1( id="[^"]*" class="tsd-anchor-link">[\s\S]*?)<\/h1>/, '<h2$1</h2>')
  })
}
