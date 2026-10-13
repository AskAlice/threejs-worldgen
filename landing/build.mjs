// Builds the static GitHub Pages site shell: the monorepo homepage plus one lander per package.
//
//   node landing/build.mjs [outDir=site]
//
// Writes <out>/index.html (homepage), <out>/<short>/index.html (one per landing/packages/*.mjs), <out>/site.css and
// copies media/ and landing/media/ into <out>/media/. TypeDoc (<out>/docs) and the demos (<out>/demo) come from the
// other steps of `npm run build:site`.
//
// Packages that are still being built ("status: 'dev'") refresh themselves: once example/<demo>.html exists their demo
// links appear, and once landing/media/<short>/hero.jpg exists it replaces the illustration. Re-run this script.
//
// SEO: every page gets a search title and description, canonical, Open Graph/Twitter card (landing/media/og/, rendered
// by landing/og.mjs) and JSON-LD. The built demo pages (<out>/demo/*.html) get the same tags injected, and the script
// writes sitemap.xml, robots.txt, site.webmanifest and the icons. Check the result with `node landing/check.mjs`.
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { SITE, GITHUB, ORDER, esc, plain, seoTags, jsonLd } from './seo.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = resolve(root, process.argv[2] ?? 'site')
const AUTHOR = { '@type': 'Person', '@id': `${SITE}#author`, name: 'AskAlice', url: 'https://github.com/AskAlice' }
const HOME = { name: 'threejs-worldgen', short: 'worldgen', accent: '#1f5a35', icon: '<circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M6 19c4-3 7 1 10-2s6-6 10-3M9 9c3 2 6 1 8-1" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="27" cy="6" r="2.2" fill="currentColor"/>' }

// Related packages for the "Works with" row on each lander.
const RELATED = {
  biomes: ['water', 'scatter', 'grass', 'city', 'sky'],
  water: ['biomes', 'scatter', 'fauna', 'weathering'],
  scatter: ['trees', 'biomes', 'grass', 'props'],
  trees: ['scatter', 'biomes', 'weathering', 'grass'],
  grass: ['biomes', 'scatter', 'trees', 'weathering'],
  city: ['population', 'props', 'vehicles', 'biomes'],
  population: ['city', 'biomes', 'vehicles', 'props'],
  props: ['city', 'vehicles', 'weathering', 'population'],
  vehicles: ['city', 'props', 'water', 'population'],
  fauna: ['biomes', 'water', 'trees', 'sky'],
  weathering: ['sky', 'trees', 'city', 'grass'],
  sky: ['weathering', 'biomes', 'water', 'fauna'],
  heightfield: ['grass', 'scatter', 'biomes'],
}

// Search titles and descriptions for the built demo pages: file -> [package short, title, description].
const DEMOS = {
  'demos.html': [null, 'Live demos · threejs-worldgen procedural worlds for three.js', 'Every threejs-worldgen live demo in one place: WebGPU sandboxes for procedural terrain, biomes, water, forests, grass, cities, traffic, wildlife, weather and sky.'],
  'index.html': ['grass', 'threejs-grass demo · Infinite WebGPU grass for three.js', 'Live three.js WebGPU demo of threejs-grass: infinite, terrain-aware grass with wind, interaction, 12 presets, LOD tiles and a terrain painter.'],
  'r3f.html': ['grass', 'threejs-grass React Three Fiber demo · WebGPU grass in R3F', 'The threejs-grass <Grass /> component in React Three Fiber: infinite WebGPU grass on procedural terrain with wind, presets and a live control panel.'],
  'terrain.html': ['biomes', 'threejs-biomes demo · Procedural terrain, biomes and planets in three.js', 'Live WebGPU sandbox for threejs-biomes: seeded climate, 20 blended biomes, mountains and rivers, and streaming LOD terrain from the ground to a planet.'],
  'scatter.html': ['scatter', 'Procedural forest demo · threejs-scatter and threejs-trees for three.js', 'Stream a procedural forest over terrain in three.js: blue-noise placement of trees, rocks and plants with LODs and impostors, and 29 tree species.'],
  'water.html': ['water', 'threejs-water demo · Oceans, lakes and rivers in three.js WebGPU', 'Live WebGPU sandbox for threejs-water: ocean waves, foam and shallows, lakes and carved rivers with drainage-basin hydrology on procedural terrain.'],
  'city.html': ['city', 'threejs-city demo · Procedural cities and road networks in three.js', 'Live sandbox for threejs-city: procedural settlements with road networks, blocks, lots and buildings that flatten the terrain beneath them.'],
  'population.html': ['population', 'threejs-population demo · Population density on an H3 hex grid', 'Live sandbox for threejs-population: population density, land use, settlement hierarchy and road networks on a hexagonal H3 grid over procedural terrain.'],
  'props.html': ['props', 'threejs-props demo · Procedural street and countryside props for three.js', 'Live sandbox for threejs-props: procedural street lights, traffic lights, power lines, fences, signs and mailboxes placed along generated roads.'],
  'vehicles.html': ['vehicles', 'threejs-vehicles demo · Procedural traffic, trains and boats in three.js', 'Live sandbox for threejs-vehicles: procedural animated cars, bicycles, trains, boats and aircraft on generated road, rail and water networks.'],
  'fauna.html': ['fauna', 'threejs-fauna demo · Procedural fish schools and bird flocks in three.js', 'Live sandbox for threejs-fauna: procedural fish schools, bird flocks and wildlife that live in the biomes and waters that suit them.'],
  'weathering.html': ['weathering', 'threejs-weathering demo · Rain, snow, lightning and wildfire in three.js', 'Live WebGPU sandbox for threejs-weathering: rain, snow, wind and lightning, wildfires that spread and regrow, and wet, snowy and burnt materials.'],
  'world.html': [null, 'Combined world demo · threejs-worldgen procedural world in three.js', 'Every threejs-worldgen package in one WebGPU scene: procedural terrain and biomes, water, forests, grass, cities, traffic, wildlife, weather and sky.'],
  'gallery.html': [null, 'Asset gallery · threejs-worldgen procedural assets for three.js', 'Browse the procedural assets of threejs-worldgen side by side: trees, plants, rocks, buildings, props, vehicles and animals, generated in three.js.'],
  'particles.html': [null, 'threejs-particles demo · GPU particle systems for three.js WebGPU', 'Live sandbox for threejs-particles: compute-shader particle pools with seeded emitters, forces and lifetime curves, plus lit smoke, flames and sparks.'],
  'mpm.html': [null, 'threejs-particles MPM sandbox · Real-time material point method on WebGPU', 'Live sandbox for the threejs-particles MLS-MPM solver: a soft block dropped onto procedural terrain, simulated entirely in WebGPU compute with terrain collision and pluggable materials.'],
  'heightfield.html': ['heightfield', 'threejs-heightfield sandbox · Height lookup, slope and ray-marching', 'Live WebGPU sandbox for threejs-heightfield: a height function and meshes baked into heightfields, sampled on a grid coloured by slope, with ray-marching under the pointer.'],
  'city-r3f.html': ['city', 'threejs-city React Three Fiber demo · Procedural cities in R3F', 'The threejs-city <City> component in React Three Fiber: a procedural settlement on a threejs-biomes world, with every option as a live leva control.'],
  'props-r3f.html': ['props', 'threejs-props React Three Fiber demo · Street and road props in R3F', 'The threejs-props <Props> and <RoadPath> components in React Three Fiber: instanced street lights, fences, signs and power lines along roads, with live controls.'],
  'vehicles-r3f.html': ['vehicles', 'threejs-vehicles React Three Fiber demo · Procedural traffic in R3F', 'The threejs-vehicles <Vehicle> and <Fleet> components in React Three Fiber: a gallery of every vehicle type and live traffic on a street grid, with planes overhead.'],
  'population-r3f.html': ['population', 'threejs-population React Three Fiber demo · H3 population maps in R3F', 'usePopulation and the <PopulationOverlay> hex map of threejs-population in React Three Fiber: density, land use and night lights, with every option live.'],
  'fauna-r3f.html': ['fauna', 'threejs-fauna React Three Fiber demo · Fish schools and bird flocks in R3F', 'The threejs-fauna <Fish> and <Fauna> components in React Three Fiber: all 12 fish species side by side, then fish schools and bird flocks at a river mouth.'],
  'sky.html': ['sky','threejs-sky demo · Day/night cycle, clouds and stars in three.js', 'Live sandbox for threejs-sky: a day/night cycle with sun and moon phases, clouds, the Milky Way, shooting stars and a Keplerian solar system.'],
}

// Package order: ORDER in landing/seo.mjs. threejs-heightfield gets a lander but no homepage card: the homepage links
// it from the foundations note.
const pkgs = await Promise.all(readdirSync(join(root, 'landing/packages')).filter((f) => f.endsWith('.mjs'))
  .map(async (f) => (await import(pathToFileURL(join(root, 'landing/packages', f)))).default))
pkgs.sort((a, b) => ORDER.indexOf(a.short) - ORDER.indexOf(b.short))
const cards = pkgs.filter((p) => p.short !== 'heightfield')

// ---------- helpers ----------

const warnings = []
const mediaFile = (p) => [join(root, 'landing/media', p), join(root, 'media', p)].find(existsSync)
const hasMedia = (p) => !!mediaFile(p)
// ` width="…" height="…"` for a JPEG or PNG under media/, so images reserve their space before they load.
function dims(p) {
  const file = p && mediaFile(p)
  if (!file) return ''
  const b = readFileSync(file)
  if (b.readUInt32BE(0) === 0x89504e47) return ` width="${b.readUInt32BE(16)}" height="${b.readUInt32BE(20)}"`
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff || b[i + 1] === 0xff) { i++; continue }
    const m = b[i + 1]
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ` width="${b.readUInt16BE(i + 7)}" height="${b.readUInt16BE(i + 5)}"`
    i += 2 + b.readUInt16BE(i + 2)
  }
  return ''
}
const ogImage = (short) => `${SITE}media/og/${short && existsSync(join(root, 'landing/media/og', `${short}.jpg`)) ? short : 'home'}.jpg`
const pkgJson = (p) => { try { return JSON.parse(readFileSync(join(root, 'packages', p.short, 'package.json'), 'utf8')) } catch { return {} } }
const hasDemo = (href) => existsSync(join(root, 'example', href.split(/[?#]/)[0] || 'index.html'))
const demosOf = (p) => (p.demos ?? []).filter((d) => hasDemo(d.href))
const docsOf = (p) => `docs/modules/${p.name}.html`
const reactDocsOf = (p) => `docs/modules/${p.name}_react.html`

// Tiny highlighter for the code cards: comments, strings, numbers, keywords, Types, calls and JSX tags.
const TOKENS = /(\/\/[^\n]*)|('[^'\n]*'|"[^"\n]*"|`[^`]*`)|\b(import|from|export|const|let|var|await|async|function|return|new|for|of|if|else|type|interface)\b|((?<=<\/?)[a-z][\w.]*)|\b([A-Z][A-Za-z0-9_]*)\b|\b([a-z_$][\w$]*)(?=\()|(\b\d[\d_.]*(?:e-?\d+)?\b)/g
function highlight(src) {
  let html = ''
  let last = 0
  for (const m of src.matchAll(TOKENS)) {
    html += esc(src.slice(last, m.index))
    const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'k' : m[4] || m[5] ? 't' : m[6] ? 'f' : 'n'
    html += `<span class="${cls}">${esc(m[0])}</span>`
    last = m.index + m[0].length
  }
  return html + esc(src.slice(last))
}

const iconSvg = (p, size = '') => `<svg viewBox="0 0 32 32" aria-hidden="true"${size} style="color:${p.accent}">${p.icon}</svg>`
const favicon = (p) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" style="color:${p.accent}">${p.icon}</svg>`)}`

// Abstract blueprint still for packages without screenshots: a grid, contour lines and the package mark. No fake renders.
function sketch(p, label = 'in development') {
  const id = `g-${p.short}`
  const contours = [0, 1, 2, 3, 4, 5].map((i) => `<ellipse cx="${560 + i * 18}" cy="${170 + i * 6}" rx="${120 + i * 70}" ry="${50 + i * 28}" />`).join('')
  return `<svg viewBox="0 0 1050 450" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${esc(p.name)}: ${esc(label)} (illustration)">
  <defs><pattern id="${id}" width="30" height="30" patternUnits="userSpaceOnUse"><path d="M30 0H0V30" fill="none" stroke="rgba(244,241,232,.07)"/></pattern>
  <radialGradient id="${id}-r" cx="50%" cy="40%" r="70%"><stop offset="0" stop-color="${p.accent}" stop-opacity=".55"/><stop offset="1" stop-color="${p.accent}" stop-opacity="0"/></radialGradient></defs>
  <rect width="1050" height="450" fill="url(#${id}-r)"/><rect width="1050" height="450" fill="url(#${id})"/>
  <g fill="none" stroke="rgba(244,241,232,.16)" stroke-dasharray="4 7">${contours}</g>
  <g transform="translate(445 95) scale(6.6)" style="color:#f4f1e8" opacity=".92">${p.icon}</g>
  <text x="525" y="365" text-anchor="middle" fill="rgba(244,241,232,.75)" font-family="ui-monospace, Menlo, monospace" font-size="20" letter-spacing="6">${esc(label.toUpperCase())}</text>
</svg>`
}

// A feature/hero media item. Paths are relative to site/media/ (sources: media/ and landing/media/).
function media(m, p, prefix) {
  if (m.stack) return `<div class="stack reveal">${m.stack.map((s) => media({ ...s, inStack: true }, p, prefix)).join('')}</div>`
  const cls = `frame${m.natural ? ' natural' : ''}${m.inStack ? '' : ' reveal'}`
  const tag = m.tag ? `<span class="tag">${esc(m.tag)}</span>` : ''
  const file = m.video ?? m.img
  if (!file || !hasMedia(file) || (m.poster && !hasMedia(m.poster))) {
    if (file) warnings.push(`${p.short}: missing media ${file}`)
    return `<div class="${cls}">${sketch(p, 'screenshot soon')}${tag}</div>`
  }
  if (m.video) return `<div class="${cls}"><video muted loop playsinline preload="none" poster="${prefix}media/${m.poster}" data-src="${prefix}media/${m.video}"${dims(m.poster)} aria-label="${esc(m.alt)}"></video>${tag}</div>`
  return `<div class="${cls}"><img loading="lazy" decoding="async" src="${prefix}media/${m.img}"${dims(m.img)} alt="${esc(m.alt)}" />${tag}</div>`
}

// `P` is the relative path to the site root; `hero` is preloaded; `ld` is the page's JSON-LD.
const head = ({ title, description, url, ogAlt, short, accent, icon, P, hero, ld }) => `<!doctype html>
<html lang="en" class="no-js">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  ${seoTags({ title, description, url, image: ogImage(short), imageAlt: ogAlt, themeColor: accent })}
  <link rel="icon" href="${icon}" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="${P}apple-touch-icon.png" />
  <link rel="manifest" href="${P}site.webmanifest" />
  ${hero ? `<link rel="preload" as="image" href="${P}media/${hero}" fetchpriority="high" />` : ''}
  <link rel="stylesheet" href="${P}site.css" />
  ${jsonLd(ld)}
</head>
<body style="--accent:${accent}">
  <a class="skip" href="#main">Skip to content</a>`

// Reveal-on-scroll, lazy video playback and (optionally) a live demo iframe in the hero.
const script = (embed, prefix) => `
  <script>
    document.documentElement.classList.remove('no-js')
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.target.tagName === 'VIDEO') {
          const v = e.target
          if (e.isIntersecting) {
            if (!v.src) v.src = v.dataset.src
            v.play().catch(() => {})
          } else v.pause()
        } else if (e.isIntersecting) {
          e.target.classList.add('in')
          io.unobserve(e.target)
        }
      }
    }, { threshold: 0.15 })
    document.querySelectorAll('.reveal, video[data-src]').forEach((el) => io.observe(el))
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) document.querySelectorAll('video[data-src]').forEach((v) => io.unobserve(v))${embed ? `

    // Live WebGPU demo in the hero viewport. The still image stays when WebGPU is unavailable or motion is reduced.
    const stage = document.getElementById('stage')
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
    if ('gpu' in navigator && !reduceMotion && innerWidth > 700) {
      const frame = document.createElement('iframe')
      frame.src = ${JSON.stringify(prefix + 'demo/' + embed.src)}
      frame.title = ${JSON.stringify(embed.title)}
      frame.tabIndex = -1
      frame.setAttribute('aria-hidden', 'true')
      stage.appendChild(frame)
      addEventListener('message', (e) => {
        if (e.source === frame.contentWindow && e.data === ${JSON.stringify(embed.ns + ':ready')}) frame.classList.add('ready')
      })
      // Pause rendering while the viewport is off-screen.
      new IntersectionObserver(([e]) => {
        frame.contentWindow?.postMessage(e.isIntersecting ? ${JSON.stringify(embed.ns + ':play')} : ${JSON.stringify(embed.ns + ':pause')}, '*')
      }).observe(stage)
    }` : ''}
  </script>
</body>
</html>
`

const footer = (left, links) => `
  <footer>
    <div class="wrap">
      <span>${left}</span>
      <span>${links.map(([t, h]) => `<a href="${h}">${t}</a>`).join('')}</span>
    </div>
  </footer>`

// ---------- package lander ----------

function lander(p) {
  const P = '../'
  const dev = p.status === 'dev'
  const demos = demosOf(p)
  const main = demos[0]
  const heroImg = p.hero?.img && hasMedia(p.hero.img) ? p.hero.img : null
  const shortName = p.name.replace(/^threejs/, '')
  const docs = P + docsOf(p)
  const reactDocs = existsSync(join(root, `packages/${p.short}/src/react.tsx`)) ? P + reactDocsOf(p) : null
  const barText = p.hero?.embed && main ? '<span class="live">live · rendered in your browser</span>'
    : heroImg ? `<span class="live">${main ? `screenshot · ${esc(main.href.split(/[?#]/)[0])}` : 'screenshot'}</span>`
    : '<span class="live dev">in development</span>'
  const stage = heroImg ? `<img src="${P}media/${heroImg}"${dims(heroImg)} fetchpriority="high" alt="${esc(p.hero.alt)}" />` : sketch(p)
  let side = 0 // alternate text left/right, counting only non-wide rows (as on the original grass lander)
  const row = (f, i) => {
    const n = String(i + 1).padStart(2, '0')
    const planned = f.planned ? '<span class="planned">planned</span>' : ''
    const chips = f.chips ? `<ul class="chips" aria-label="${esc(f.title)}">${f.chips.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''
    const m = f.media ? media(f.media, p, P) : `<div class="frame reveal">${sketch(p, f.planned ? 'planned' : p.name)}</div>`
    if (f.wide) return `
        <div class="row wide">
          <div class="text reveal">
            <div><span class="num">${n}</span>${planned}<h3>${f.title}</h3><p class="sub">${f.sub}</p></div>
            <div><p class="body">${f.body}</p>${chips}</div>
          </div>
          ${m}
        </div>`
    return `
        <div class="row${side++ % 2 ? ' flip' : ''}">
          <div class="text reveal">
            <span class="num">${n}</span>${planned}
            <h3>${f.title}</h3>
            <p class="sub">${f.sub}</p>
            <p class="body">${f.body}</p>${chips}
          </div>
          ${m}
        </div>`
  }
  const codeCard = (c, title, sub) => c ? `
          <div class="code">
            <header><b>${title}</b><span>${esc(c.file ?? sub)}</span></header>
<pre><code>${highlight(c.src.replace(/^\n/, '').replace(/\s+$/, ''))}</code></pre>
          </div>` : ''
  const finalLinks = [
    ...demos.map((d, i) => `<a class="btn ${i ? 'btn-line' : 'btn-amber'}" href="${P}demo/${d.href}">${esc(d.label)}</a>`),
    `<a class="btn ${demos.length ? 'btn-line' : 'btn-amber'}" href="${docs}">Documentation</a>`,
    ...(dev ? [`<a class="btn btn-line" href="${GITHUB}/tree/main/packages/${p.short}">Follow on GitHub</a>`] : []),
  ]
  const url = `${SITE}${p.short}/`
  const related = (RELATED[p.short] ?? []).map((s) => pkgs.find((q) => q.short === s)).filter(Boolean)
  const ld = { '@graph': [
    { '@type': 'SoftwareSourceCode', '@id': `${url}#software`, name: p.name, description: p.description, url,
      codeRepository: `${GITHUB}/tree/main/packages/${p.short}`, programmingLanguage: 'TypeScript', runtimePlatform: 'Web browser (WebGPU)',
      license: 'https://www.apache.org/licenses/LICENSE-2.0', version: pkgJson(p).version, image: ogImage(p.short), author: AUTHOR,
      keywords: (pkgJson(p).keywords ?? ['three.js', 'WebGPU', 'React Three Fiber', 'procedural generation']).join(', '),
      ...(dev ? { creativeWorkStatus: 'in development' } : {}) },
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'threejs-worldgen', item: SITE },
      { '@type': 'ListItem', position: 2, name: p.name, item: url },
    ] },
  ] }
  return `${head({ title: p.title, description: p.description, url, ogAlt: `${p.name}: ${plain(p.pitch)}`, short: p.short, accent: p.accent, icon: favicon(p), P, hero: heroImg, ld })}
  <header class="site">
    <div class="wrap">
      <div class="brand">
        <a class="home" href="${P}">threejs-worldgen</a><span class="sep" aria-hidden="true">/</span>
        <a class="logo" href="./" aria-label="${esc(p.name)} home">${iconSvg(p)}<span>threejs<i>${esc(shortName)}</i></span></a>
      </div>
      <nav aria-label="Main">
        <a class="hide-sm" href="#features">Features</a>
        ${main ? `<a class="hide-sm" href="${P}demo/${main.href}">Demo</a>` : ''}
        <a href="${docs}">Docs</a>
        <a class="hide-sm" href="${P}">All packages</a>
        <a class="hide-sm" href="${GITHUB}">GitHub</a>
        <a class="btn btn-accent" href="${docs}">Get started</a>
      </nav>
    </div>
  </header>

  <main id="main">
    <section class="hero">
      <div class="wrap">
        <div class="hero-top">
          <div>
            <span class="label">${esc(p.label)}</span>${dev ? '<span class="badge">In development</span>' : ''}
            <h1><span class="sr-only">${esc(p.name)}: </span>${p.headline}</h1>
          </div>
          <div class="hero-side">
            <p>${p.lede}</p>
            <div class="cta">
              ${main ? `<a class="btn btn-amber" href="${P}demo/${main.href}">Open the live demo</a>` : `<a class="btn btn-amber" href="#features">${dev ? "See what's planned" : 'See what it does'}</a>`}
              <a class="btn btn-line" href="${docs}">Read the docs</a>
            </div>
          </div>
        </div>

        <div class="viewport">
          <div class="bar">
            <span class="lights" aria-hidden="true"><span></span><span></span><span></span></span>
            ${barText}
            ${main ? `<a href="${P}demo/${main.href}">open ↗</a>` : `<a href="${GITHUB}/tree/main/packages/${p.short}">source ↗</a>`}
          </div>
          <div class="stage" id="stage">
            ${stage}
          </div>
        </div>
        <div class="strip">
          ${p.stats.map(([b, s]) => `<div><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('\n          ')}
        </div>
      </div>
    </section>

    <section class="code-band">
      <div class="wrap">
        <span class="label reveal">Getting started</span>
        <h2 class="reveal">${p.code.heading}</h2>
        <p class="intro reveal">${p.code.intro}</p>
        <div class="code-grid${p.code.r3f ? '' : ' one'} reveal">${codeCard(p.code.three, 'three.js', p.name)}${codeCard(p.code.r3f, 'React Three Fiber', `${p.name}/react`)}
        </div>
        <div class="install reveal">Install <code>${esc(p.install)}</code> <a href="${docs}">Full API reference →</a>${reactDocs ? ` <a href="${reactDocs}">React components →</a>` : ''}</div>
      </div>
    </section>

    <section id="features">
      <div class="wrap">
        <div class="features-head">
          <div>
            <span class="label reveal">What's in the box</span>
            <h2 class="reveal">${p.features.heading}</h2>
          </div>
          <p class="intro reveal">${p.features.intro}</p>
        </div>
${p.features.rows.map(row).join('\n')}
      </div>
    </section>
${related.length ? `
    <section class="related" aria-labelledby="works-with">
      <div class="wrap">
        <h2 id="works-with" class="reveal">Works with</h2>
        <ul class="reveal">${related.map((q) => `
          <li style="--accent:${q.accent}"><a href="${P}${q.short}/">${iconSvg(q)}<div><b>threejs<i>${esc(q.name.replace(/^threejs/, ''))}</i></b><span>${q.pitch}</span></div></a></li>`).join('')}
        </ul>
      </div>
    </section>
` : ''}
    <section class="final">
      <div class="wrap">
        <h2 class="reveal">${p.final.heading}</h2>
        <p class="reveal">${p.final.text}</p>
        <div class="cta reveal">
          ${finalLinks.join('\n          ')}
        </div>
      </div>
    </section>
  </main>
${footer(`${esc(p.name)} · part of <a href="${P}" style="margin:0">threejs-worldgen</a> · Apache-2.0`, [['Docs', docs], ...demos.map((d) => [esc(d.label.replace(/ demo$/, '')) + ' demo', `${P}demo/${d.href}`]), ['All packages', P], ['GitHub', `${GITHUB}/tree/main/packages/${p.short}`]])}
${script(p.hero?.embed && main ? p.hero.embed : null, P)}`
}

// ---------- homepage ----------

const FLOW = [
  ['Ground', ['biomes'], 'Seeded climate, height and 20 blended biomes on a flat world or a whole planet, with streaming LOD terrain.'],
  ['Water and growth', ['water', 'scatter', 'trees', 'grass'], 'Oceans, lakes and rivers carved into that ground, then forests, rocks and grass placed where the biome wants them.'],
  ['People', ['city', 'population'], 'Population density decides where towns grow; settlements lay roads, lots and buildings and flatten the terrain under them.'],
  ['Life and things', ['props', 'vehicles', 'fauna'], 'Street furniture beside the roads, vehicles on the networks and animals in the biomes and waters that suit them.'],
  ['Weather and sky', ['weathering', 'sky'], 'Rain, snow, lightning and wildfire wear everything down; the sky turns day into night over a Keplerian solar system.'],
]

function home() {
  const by = Object.fromEntries(pkgs.map((p) => [p.short, p]))
  const card = (p) => {
    const demos = demosOf(p)
    const thumb = p.thumb && hasMedia(p.thumb) ? p.thumb : p.hero?.img && hasMedia(p.hero.img) ? p.hero.img : null
    const alt = p.hero?.alt && thumb === p.hero.img ? p.hero.alt : `${p.name} screenshot`
    const img = thumb ? `<img loading="lazy" decoding="async" src="media/${thumb}"${dims(thumb)} alt="${esc(`${p.name}: ${alt}`)}" />` : sketch(p)
    return `
        <li class="card reveal" style="--accent:${p.accent}">
          <div class="thumb">${img}</div>
          ${p.status === 'dev' ? '<span class="badge">In development</span>' : ''}
          <div class="body">
            <h3><a href="${p.short}/">threejs<i>${esc(p.name.replace(/^threejs/, ''))}</i></a></h3>
            <p>${p.pitch}</p>
            <code>npm i ${esc(p.name)}</code>
            <div class="links">
              <a href="${p.short}/">Overview</a>
              ${demos.length ? `<a href="demo/${demos[0].href}">Demo</a>` : '<span>Demo soon</span>'}
              <a href="${docsOf(p)}">Docs</a>
            </div>
          </div>
        </li>`
  }
  const step = ([title, shorts, text]) => `
        <li class="reveal">
          <b>${title}</b>
          <div class="pkgs">${shorts.filter((s) => by[s]).map((s) => `<a href="${s}/" style="background:${by[s].accent}">${s}</a>`).join('')}</div>
          <p>${text}</p>
        </li>`
  // Homepage hero: a dedicated planet still if one has been captured, else the biomes orbit shot.
  const hero = ['biomes/planet.jpg', 'biomes/orbit.jpg'].find(hasMedia) ?? 'biomes/planet.jpg'
  const home = HOME
  const heroImg = hasMedia(hero) ? hero : 'hero.jpg'
  const title = 'threejs-worldgen · Procedural worlds for three.js, from an ant to the solar system'
  const description = 'Procedural worlds for three.js and React Three Fiber: biomes, terrain, water, forests, grass, cities, weather and sky, as small packages that share one idea of where the ground is.'
  const ld = { '@graph': [
    { '@type': 'WebSite', '@id': `${SITE}#website`, name: 'threejs-worldgen', url: SITE, description, inLanguage: 'en', author: { '@id': AUTHOR['@id'] }, publisher: { '@id': AUTHOR['@id'] } },
    { ...AUTHOR, sameAs: [GITHUB] },
    { '@type': 'ItemList', name: 'threejs-worldgen packages', numberOfItems: pkgs.length, itemListElement: pkgs.map((p, i) => (
      { '@type': 'ListItem', position: i + 1, name: p.name, description: p.description, url: `${SITE}${p.short}/` })) },
  ] }
  return `${head({ title, description, url: SITE, ogAlt: `threejs-worldgen: screenshots of ${cards.length} procedural world packages for three.js`, short: 'home', accent: home.accent, icon: 'favicon.svg', P: '', hero: heroImg, ld })}
  <header class="site">
    <div class="wrap">
      <a class="logo" href="./" aria-label="threejs-worldgen home">${iconSvg(home)}<span>threejs<i>-worldgen</i></span></a>
      <nav aria-label="Main">
        <a class="hide-sm" href="#packages">Packages</a>
        <a class="hide-sm" href="grass/">Grass</a>
        <a href="demo/demos.html">Demos</a>
        <a href="docs/">Docs</a>
        <a class="hide-sm" href="${GITHUB}">GitHub</a>
        <a class="btn btn-accent" href="#packages">Explore</a>
      </nav>
    </div>
  </header>

  <main id="main">
    <section class="hero">
      <div class="wrap">
        <div class="hero-top">
          <div>
            <span class="label">WebGPU · three.js · React Three Fiber</span>
            <h1><span class="sr-only">threejs-worldgen: </span>Procedural <em>worlds,</em> from an ant to the solar system.</h1>
          </div>
          <div class="hero-side">
            <p>Climate, terrain and biomes, water, forests and grass, cities and their people, weather and the sky. Each is a small package that works on its own, and every one of them agrees on where the ground is.</p>
            <div class="cta">
              <a class="btn btn-amber" href="demo/demos.html">Explore the demos</a>
              <a class="btn btn-line" href="grass/">Start with threejs-grass</a>
            </div>
          </div>
        </div>

        <div class="viewport">
          <div class="bar">
            <span class="lights" aria-hidden="true"><span></span><span></span><span></span></span>
            <span class="live">screenshot · terrain.html</span>
            <a href="demo/terrain.html">open ↗</a>
          </div>
          <div class="stage" id="stage">
            <img src="media/${heroImg}"${dims(heroImg)} fetchpriority="high" alt="${hasMedia(hero) ? 'A whole procedural planet seen from orbit, from the threejs-biomes demo' : 'A dense meadow on rolling hills'}" />
          </div>
        </div>
        <div class="strip">
          <div><b>${cards.length}</b><span>packages</span></div>
          <div><b>20</b><span>blended biomes</span></div>
          <div><b>1 cm → 1 AU</b><span>one camera, every scale</span></div>
          <div><b>1</b><span>seed per world</span></div>
        </div>
      </div>
    </section>

    <section id="packages">
      <div class="wrap">
        <div class="features-head">
          <div>
            <span class="label reveal">The packages</span>
            <h2 class="reveal">Take one, or <em>take the world.</em></h2>
          </div>
          <p class="intro reveal">Every package is plain three.js first, with an optional React Three Fiber component, fully parametric and deterministic from a seed. New here? <a href="grass/" style="color:var(--accent);font-weight:600">threejs-grass</a> is the most complete.</p>
        </div>
        <ul class="cards">${cards.map(card).join('')}
        </ul>
        <div class="foundations reveal">
          <div><b>Foundations: threejs-heightfield</b>Bakes any mesh into a fast <code>(x, z) =&gt; y</code> lookup with slope and ray-marching. It's the ground every other package stands on. <a href="heightfield/">Overview →</a> <a href="docs/modules/threejs-heightfield.html">Docs →</a></div>
          <div><b>Umbrella: threejs-worldgen</b>One <code>&lt;World&gt;</code> that composes all of the above with biome-driven grass and a scale-aware camera. Work in progress. <a href="docs/modules/threejs-worldgen.html">Docs →</a></div>
        </div>
      </div>
    </section>

    <section class="code-band">
      <div class="wrap">
        <span class="label reveal">How they fit together</span>
        <h2 class="reveal">Each layer reads <em>the one above.</em></h2>
        <p class="intro reveal">Everything is a function of a seed and a world position, so worlds stream in tiles and look the same on every machine. Every package takes a <code>Terrain</code> (a mesh or an <code>(x, z) =&gt; y</code> function) the same way.</p>
        <ol class="flow">${FLOW.map(step).join('')}
        </ol>
        <div class="install reveal">Install what you need <code>npm i three threejs-biomes threejs-water threejs-scatter threejs-trees threejs-grass</code> <a href="docs/">API reference →</a></div>
      </div>
    </section>

    <section class="final">
      <div class="wrap">
        <h2 class="reveal">Build a <em>world.</em></h2>
        <p class="reveal">Every package has a live sandbox with every parameter on a panel. Start there, or go straight to the API reference.</p>
        <div class="cta reveal">
          <a class="btn btn-amber" href="demo/demos.html">All demos</a>
          <a class="btn btn-line" href="docs/">Documentation</a>
          <a class="btn btn-line" href="${GITHUB}">GitHub</a>
        </div>
      </div>
    </section>
  </main>
${footer('threejs-worldgen · Apache-2.0', [['Demos', 'demo/demos.html'], ['Docs', 'docs/'], ['threejs-grass', 'grass/'], ['GitHub', GITHUB]])}
${script(null, '')}`
}

// ---------- write ----------

mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'index.html'), home())
for (const p of pkgs) {
  mkdirSync(join(out, p.short), { recursive: true })
  writeFileSync(join(out, p.short, 'index.html'), lander(p))
}
cpSync(join(root, 'landing/site.css'), join(out, 'site.css'))
cpSync(join(root, 'media'), join(out, 'media'), { recursive: true })
cpSync(join(root, 'landing/media'), join(out, 'media'), { recursive: true })
for (const f of ['favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) {
  if (existsSync(join(root, 'landing', f))) cpSync(join(root, 'landing', f), join(out, f))
  else warnings.push(`missing landing/${f} (run node landing/og.mjs)`)
}
writeFileSync(join(out, 'site.webmanifest'), JSON.stringify({
  name: 'threejs-worldgen', short_name: 'worldgen', description: 'Procedural worlds for three.js and React Three Fiber',
  start_url: './', scope: './', display: 'browser', background_color: '#f4f1e8', theme_color: HOME.accent,
  icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' }, { src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }],
}, null, 2) + '\n')

// Demo pages (built by Vite into <out>/demo): inject the same head tags between <!-- seo --> markers (idempotent).
const demoDir = join(out, 'demo')
const demos = existsSync(demoDir) ? readdirSync(demoDir).filter((f) => f.endsWith('.html')).sort() : []
for (const f of demos) {
  let html = readFileSync(join(demoDir, f), 'utf8').replace(/\n\s*<!-- seo -->[\s\S]*?<!-- \/seo -->/, '')
  const current = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? f
  if (!DEMOS[f]) warnings.push(`demo/${f}: no entry in DEMOS, using a generic title and description`)
  const [short, title, description] = DEMOS[f] ?? [null, `${current} · threejs-worldgen live demo`, `${current}: a live WebGPU demo from threejs-worldgen, procedural worlds for three.js and React Three Fiber.`]
  const p = pkgs.find((q) => q.short === short)
  const tags = seoTags({ title, description, url: `${SITE}demo/${f}`, image: ogImage(short), imageAlt: `${p?.name ?? 'threejs-worldgen'} live demo`, themeColor: p?.accent ?? HOME.accent })
  html = html.replace(/<html(?![^>]*\blang=)/, '<html lang="en"').replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>
    <!-- seo -->
    ${tags.replace(/\n  /g, '\n    ')}
    <link rel="icon" href="../favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="../apple-touch-icon.png" />
    <!-- /seo -->`)
  writeFileSync(join(demoDir, f), html)
}

// sitemap.xml: homepage, landers, demos and the docs entry pages. TypeDoc writes docs/sitemap.xml with every API page.
const docsModules = existsSync(join(out, 'docs/modules')) ? readdirSync(join(out, 'docs/modules')).filter((f) => f.endsWith('.html')).sort().map((f) => `docs/modules/${f}`) : []
const docsIndex = existsSync(join(out, 'docs/index.html')) ? ['docs/'] : []
const today = new Date().toISOString().slice(0, 10)
const urls = ['', ...pkgs.map((p) => `${p.short}/`), ...demos.map((f) => `demo/${f}`), ...docsIndex, ...docsModules]
writeFileSync(join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${SITE}${u}</loc><lastmod>${today}</lastmod></url>`).join('\n')}
</urlset>
`)
writeFileSync(join(out, 'robots.txt'), `User-agent: *
Allow: /

Sitemap: ${SITE}sitemap.xml
${existsSync(join(out, 'docs/sitemap.xml')) ? `Sitemap: ${SITE}docs/sitemap.xml\n` : ''}`)

for (const w of warnings) console.warn('warning:', w)
console.log(`landing: wrote ${out}/index.html and ${pkgs.length} landers (${pkgs.map((p) => p.short).join(', ')})`)
