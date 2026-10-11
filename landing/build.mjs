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
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = resolve(root, process.argv[2] ?? 'site')
const GITHUB = 'https://github.com/AskAlice/threejs-worldgen'
const SITE = 'https://askalice.github.io/threejs-worldgen/'

// Package order on the homepage follows the pipeline: ground, then what grows on it, then people, then the sky.
const ORDER = ['biomes', 'water', 'scatter', 'trees', 'grass', 'city', 'population', 'props', 'vehicles', 'fauna', 'weathering', 'sky']
const pkgs = await Promise.all(readdirSync(join(root, 'landing/packages')).filter((f) => f.endsWith('.mjs'))
  .map(async (f) => (await import(pathToFileURL(join(root, 'landing/packages', f)))).default))
pkgs.sort((a, b) => ORDER.indexOf(a.short) - ORDER.indexOf(b.short))

// ---------- helpers ----------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const warnings = []
const hasMedia = (p) => existsSync(join(root, 'landing/media', p)) || existsSync(join(root, 'media', p))
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
  if (m.video) return `<div class="${cls}"><video muted loop playsinline preload="none" poster="${prefix}media/${m.poster}" data-src="${prefix}media/${m.video}" aria-label="${esc(m.alt)}"></video>${tag}</div>`
  return `<div class="${cls}"><img loading="lazy" src="${prefix}media/${m.img}" alt="${esc(m.alt)}" />${tag}</div>`
}

const head = ({ title, description, image, accent, icon, css }) => `<!doctype html>
<html lang="en" class="no-js">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  ${image ? `<meta property="og:image" content="${SITE}media/${image}" />` : ''}
  <meta name="theme-color" content="#f4f1e8" />
  <link rel="icon" href="${icon}" />
  <link rel="stylesheet" href="${css}" />
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
  const stage = heroImg ? `<img src="${P}media/${heroImg}" alt="${esc(p.hero.alt)}" />` : sketch(p)
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
  return `${head({ title: p.title, description: p.description, image: heroImg, accent: p.accent, icon: favicon(p), css: P + 'site.css' })}
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
            <h1>${p.headline}</h1>
          </div>
          <div class="hero-side">
            <p>${p.lede}</p>
            <div class="cta">
              ${main ? `<a class="btn btn-amber" href="${P}demo/${main.href}">Open the live demo</a>` : `<a class="btn btn-amber" href="#features">See what's planned</a>`}
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
    const img = thumb ? `<img loading="lazy" src="media/${thumb}" alt="" />` : sketch(p)
    return `
        <li class="card reveal" style="--accent:${p.accent}">
          <div class="thumb" aria-hidden="true">${img}</div>
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
  const home = { name: 'threejs-worldgen', short: 'worldgen', accent: '#1f5a35', icon: '<circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M6 19c4-3 7 1 10-2s6-6 10-3M9 9c3 2 6 1 8-1" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="27" cy="6" r="2.2" fill="currentColor"/>' }
  return `${head({ title: 'threejs-worldgen · Procedural worlds for three.js, from an ant to the solar system', description: 'Procedural worlds for three.js and React Three Fiber: biomes, terrain, water, forests, grass, cities, weather and sky, as small packages that share one idea of where the ground is.', image: hasMedia(hero) ? hero : 'hero.jpg', accent: home.accent, icon: favicon(home), css: 'site.css' })}
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
            <h1>Procedural <em>worlds,</em> from an ant to the solar system.</h1>
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
            ${hasMedia(hero) ? `<img src="media/${hero}" alt="A whole procedural planet seen from orbit, from the threejs-biomes demo" />` : '<img src="media/hero.jpg" alt="A dense meadow on rolling hills" />'}
          </div>
        </div>
        <div class="strip">
          <div><b>${pkgs.length}</b><span>packages</span></div>
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
        <ul class="cards">${pkgs.map(card).join('')}
        </ul>
        <div class="foundations reveal">
          <div><b>Foundations: threejs-heightfield</b>Bakes any mesh into a fast <code>(x, z) =&gt; y</code> lookup with slope and ray-marching. It's the ground every other package stands on. <a href="docs/modules/threejs-heightfield.html">Docs →</a></div>
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
for (const w of warnings) console.warn('warning:', w)
console.log(`landing: wrote ${out}/index.html and ${pkgs.length} landers (${pkgs.map((p) => p.short).join(', ')})`)
