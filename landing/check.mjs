// Checks the built site: SEO tags on every page, JSON-LD, sitemaps and internal links. Exits 1 on any error.
//
//   node landing/check.mjs [siteDir=site]
//
// Every HTML page needs a title, description, canonical, og:title, og:image and twitter:card; titles and descriptions
// must be unique; JSON-LD must parse; every sitemap URL, og:image and internal href/src must map to a built file.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve, relative, dirname } from 'node:path'
import { SITE } from './seo.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const site = resolve(root, process.argv[2] ?? 'site')
const errors = []
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])
const files = walk(site)
const pages = files.filter((f) => f.endsWith('.html'))

// A site URL or a path relative to `from` -> the built file it serves, or null when it doesn't exist.
function target(ref, from) {
  const path = decodeURI(ref.split(/[?#]/)[0])
  let f = ref.startsWith(SITE) ? join(site, path.slice(SITE.length)) : join(path.startsWith('/') ? site : dirname(from), path)
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html')
  return existsSync(f) ? f : null
}

const seen = { title: new Map(), description: new Map() }
const meta = (html, k) => html.match(new RegExp(`<meta (?:name|property)="${k}" content="([^"]*)"`))?.[1]
let links = 0
for (const f of pages) {
  const html = readFileSync(f, 'utf8')
  const rel = relative(site, f)
  const fail = (msg) => errors.push(`${rel}: ${msg}`)
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1]
  const description = meta(html, 'description')
  const canonical = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1]
  const checks = { title, description, canonical, 'og:title': meta(html, 'og:title'), 'og:image': meta(html, 'og:image'), 'twitter:card': meta(html, 'twitter:card') }
  for (const [k, v] of Object.entries(checks)) if (!v) fail(`missing ${k}`)
  if (!/<html[^>]*\blang="/.test(html)) fail('missing <html lang>')
  if ((html.match(/<meta name="description"/g) ?? []).length > 1) fail('duplicate meta description')
  if ((html.match(/<link rel="canonical"/g) ?? []).length > 1) fail('duplicate canonical')
  if (canonical && !target(canonical, f)) fail(`canonical ${canonical} has no built file`)
  if (checks['og:image'] && !target(checks['og:image'], f)) fail(`og:image ${checks['og:image']} has no built file`)
  for (const k of ['title', 'description']) {
    const v = k === 'title' ? title : description
    if (v && seen[k].has(v)) fail(`${k} also used by ${seen[k].get(v)}: "${v}"`)
    else if (v) seen[k].set(v, rel)
  }
  for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { JSON.parse(json) } catch (e) { fail(`JSON-LD does not parse: ${e.message}`) }
  }
  for (const [, ref] of html.matchAll(/\s(?:href|src|poster|data-src)="([^"]+)"/g)) {
    if (/^(#|mailto:|data:|javascript:)/.test(ref) || (/^https?:/.test(ref) && !ref.startsWith(SITE))) continue
    links++
    if (!target(ref.replace(/&amp;/g, '&'), f) && !errors.includes(`${rel}: broken link ${ref}`)) fail(`broken link ${ref}`)
  }
}

let sitemapUrls = 0
for (const sm of ['sitemap.xml', 'docs/sitemap.xml']) {
  if (!existsSync(join(site, sm))) { errors.push(`missing ${sm}`); continue }
  for (const [, loc] of readFileSync(join(site, sm), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)) {
    sitemapUrls++
    if (!loc.startsWith(SITE) || !target(loc, site)) errors.push(`${sm}: ${loc} has no built file`)
  }
}
const robots = existsSync(join(site, 'robots.txt')) ? readFileSync(join(site, 'robots.txt'), 'utf8') : ''
if (!robots.includes(`Sitemap: ${SITE}sitemap.xml`)) errors.push('robots.txt does not point to sitemap.xml')
for (const f of files.filter((f) => f.includes(`${join('media', 'og')}/`))) {
  if (statSync(f).size > 200 * 1024) errors.push(`${relative(site, f)} is over 200 KB`)
}

for (const e of errors.slice(0, 50)) console.error('error:', e)
if (errors.length > 50) console.error(`… and ${errors.length - 50} more`)
console.log(`check: ${pages.length} pages, ${links} internal links, ${sitemapUrls} sitemap URLs, ${errors.length} errors`)
process.exit(errors.length ? 1 : 0)
