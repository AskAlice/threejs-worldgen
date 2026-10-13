import { test } from 'node:test'
import assert from 'node:assert/strict'
import { START, END, MAP_START, MAP_END, grid, packageBlock, replaceBlock, pairDemos, demoOwners, docsMap, missingFromMap } from './readme-cards.mjs'

const SITE = 'https://askalice.github.io/threejs-worldgen/'
const sky = {
  short: 'sky', name: 'threejs-sky', pitch: 'A sky & stars.', hero: { img: 'sky/hero.jpg', alt: 'Sunset "over" hills' },
  thumbAlt: 'Golden "clouds"', demos: [{ label: 'three.js demo', href: 'sky.html' }], thumb: 'sky/thumb.jpg', heroImg: 'sky/hero.jpg',
}
const trees = {
  short: 'trees', name: 'threejs-trees', pitch: 'Grown trees.', hero: { alt: 'Trees' },
  demos: [{ label: 'Forest demo', href: 'scatter.html' }, { label: 'Species lineup', href: 'scatter.html?lineup' }],
  thumb: null, heroImg: null,
}
const nodemo = { ...sky, short: 'x', name: 'threejs-x', demos: [] }

test('grid: one card per package with a demo, absolute URLs, alt text, escaped', () => {
  const md = grid([sky, trees, nodemo])
  assert.match(md, new RegExp(`<img src="${SITE}media/sky/thumb.jpg" width="\\d+" alt="threejs-sky: Golden &quot;clouds&quot;" />`))
  assert.ok(md.includes(`href="${SITE}demo/sky.html"`))
  assert.ok(md.includes(`href="${SITE}sky/"`))
  assert.ok(md.includes('A sky &amp; stars.'))
  assert.ok(md.includes('threejs-trees'))
  assert.ok(!md.includes('threejs-x'), 'packages without a demo get no card')
  assert.ok(!/\n\s*\n/.test(md), 'no blank lines inside the HTML block')
})

test('grid: the alt text belongs to the image shown (hero alt only when the card shows the hero)', () => {
  assert.ok(!grid([sky]).includes('Sunset'), 'a thumbnail card must not describe the hero')
  assert.ok(grid([{ ...sky, thumb: 'sky/hero.jpg' }]).includes('alt="threejs-sky: Sunset &quot;over&quot; hills"'))
  assert.ok(grid([{ ...sky, thumbAlt: undefined }]).includes('alt="threejs-sky: A sky &amp; stars."'), 'no thumbAlt: the pitch')
})

test('grid: a package without a thumbnail gets a text-only card', () => {
  const md = grid([trees])
  assert.ok(!md.includes('<img'))
  assert.ok(md.includes(`href="${SITE}demo/scatter.html"`))
  assert.ok(md.includes(`href="${SITE}trees/"`))
})

test('packageBlock: hero links to the demo, link row has demos, landing page and API docs', () => {
  const md = packageBlock(sky)
  assert.ok(md.includes(`<a href="${SITE}demo/sky.html"><img src="${SITE}media/sky/hero.jpg" alt="threejs-sky: Sunset &quot;over&quot; hills" /></a>`))
  assert.ok(md.includes(`<a href="${SITE}sky/">Landing page</a>`))
  assert.ok(md.includes(`<a href="${SITE}docs/modules/threejs-sky.html">API docs</a>`))
  assert.ok(md.includes('>Live demo</a>'))
})

test('packageBlock: extra demos by label, no image without a thumbnail', () => {
  const md = packageBlock(trees)
  assert.ok(!md.includes('<img'))
  assert.ok(md.includes(`<a href="${SITE}demo/scatter.html?lineup">Species lineup</a>`))
  assert.ok(!packageBlock(nodemo).includes('Live demo'))
})

test('replaceBlock: replaces between markers and is idempotent', () => {
  const src = `# t\n\nintro\n\n${START}\nold\n${END}\n\nrest\n`
  const once = replaceBlock(src, 'new')
  assert.equal(once, `# t\n\nintro\n\n${START}\nnew\n${END}\n\nrest\n`)
  assert.equal(replaceBlock(once, 'new'), once)
})

test('replaceBlock: inserts under the title when there are no markers', () => {
  const once = replaceBlock('# threejs-sky\n\nSkies.\n', 'B')
  assert.equal(once, `# threejs-sky\n\n${START}\nB\n${END}\n\nSkies.\n`)
  assert.equal(replaceBlock(once, 'B'), once)
})

// ---------- docs map ----------

const pkg = (short, demos, more) => ({ name: `threejs-${short}`, short, pitch: `${short} pitch.`, react: true, landing: true, demos: demos.map((href) => ({ label: href, href })), ...more })
const mapPkgs = [
  pkg('heightfield', ['heightfield.html'], { react: false }),
  pkg('scatter', ['scatter.html']),
  pkg('trees', ['scatter.html', 'scatter.html?lineup']),
  pkg('grass', ['index.html', 'r3f.html']),
  pkg('city', ['city.html', 'city-r3f.html', 'population.html']),
  pkg('particles', [], { landing: false }), // no lander: its demos come from DEMOS in landing/seo.mjs
  pkg('worldgen', [], { landing: false }),
]
const files = ['city-r3f.html', 'city.html', 'heightfield.html', 'index.html', 'mpm.html', 'particles.html', 'population.html', 'props-r3f.html', 'r3f.html', 'scatter.html', 'world.html']
const fullMap = () => `# t\n\n${MAP_START}\n${docsMap(mapPkgs, pairDemos(files))}\n${MAP_END}\n`

test('pairDemos: <name>.html pairs with <name>-r3f.html, grass index.html with r3f.html, missing twins are null', () => {
  const byName = Object.fromEntries(pairDemos(files).map((d) => [d.name, d]))
  assert.deepEqual(byName.city, { name: 'city', three: 'city.html', r3f: 'city-r3f.html' })
  assert.deepEqual(byName.grass, { name: 'grass', three: 'index.html', r3f: 'r3f.html' })
  assert.deepEqual(byName.heightfield, { name: 'heightfield', three: 'heightfield.html', r3f: null })
  assert.deepEqual(byName.props, { name: 'props', three: null, r3f: 'props-r3f.html' })
  assert.equal(pairDemos(files).length, 9, 'one pair per demo')
})

test('demoOwners: lander demos first (first package wins), then DEMOS, else no owner', () => {
  const owners = new Map([...demoOwners(mapPkgs, pairDemos(files))].map(([d, p]) => [d.name, p?.short ?? null]))
  assert.equal(owners.get('scatter'), 'scatter', 'scatter lists it before trees')
  assert.equal(owners.get('population'), 'city')
  assert.equal(owners.get('grass'), 'grass')
  assert.equal(owners.get('mpm'), 'particles', 'from DEMOS')
  assert.equal(owners.get('props'), null, 'DEMOS names props, which is not in this map')
  assert.equal(owners.get('world'), null)
})

test('docsMap: API, /react and landing links, three.js and R3F side by side, "not yet" for a missing twin', () => {
  const html = docsMap(mapPkgs, pairDemos(files))
  assert.ok(html.includes(`<a href="${SITE}docs/modules/threejs-city.html">threejs-city</a><br /><a href="${SITE}docs/modules/threejs-city_react.html">threejs-city/react</a><br /><a href="${SITE}city/">Landing page</a>`))
  assert.ok(!html.includes('threejs-heightfield_react'), 'no /react module, no link')
  assert.ok(!html.includes(`${SITE}particles/`), 'no lander, no landing link')
  assert.ok(html.includes(`grass: <a href="${SITE}demo/index.html">three.js</a> · <a href="${SITE}demo/r3f.html">R3F</a>`))
  assert.ok(html.includes(`heightfield: <a href="${SITE}demo/heightfield.html">three.js</a> · R3F: not yet`))
  assert.ok(html.includes(`props: three.js: not yet · <a href="${SITE}demo/props-r3f.html">R3F</a>`))
  assert.ok(/city: .*<br \/>population: /.test(html), 'lander order within a package')
  assert.ok(/particles: .*<br \/>mpm: /.test(html), "the package's own demo first")
  assert.ok(html.includes('See threejs-scatter'), 'trees points at the package that lists its demo')
  assert.ok(html.includes('No demo yet'))
  assert.ok(/Everything together \/ tools.*props: .*world: /.test(html))
  assert.ok(!/\n\s*\n/.test(html), 'no blank lines inside the HTML block')
  for (const f of files) assert.equal(html.split(`href="${SITE}demo/${f}"`).length - 1, 1, `${f} linked exactly once`)
})

test('missingFromMap: a complete map passes; removing a package or a demo from it fails', () => {
  const pages = files.filter((f) => f !== 'index.html')
  assert.deepEqual(missingFromMap(fullMap(), mapPkgs, pages), [])

  const noCity = fullMap().replace(/<tr><td valign="top"><b>threejs-city<\/b>.*\n/, '')
  assert.deepEqual(missingFromMap(noCity, mapPkgs, pages), [
    `${SITE}docs/modules/threejs-city.html`, `${SITE}docs/modules/threejs-city_react.html`,
    `${SITE}demo/city-r3f.html`, `${SITE}demo/city.html`, `${SITE}demo/population.html`,
  ])
  const noMpm = fullMap().replace(/<br \/>mpm: <a [^>]*>three.js<\/a>[^<]*/, '')
  assert.deepEqual(missingFromMap(noMpm, mapPkgs, pages), [`${SITE}demo/mpm.html`])
  const noReact = fullMap().replace(/<br \/><a [^>]*>threejs-grass\/react<\/a>/, '')
  assert.deepEqual(missingFromMap(noReact, mapPkgs, pages), [`${SITE}docs/modules/threejs-grass_react.html`])
  assert.equal(missingFromMap(fullMap(), [...mapPkgs, pkg('new', [])], [...pages, 'new.html']).length, 3, 'new until regenerated')
})

test('missingFromMap: only links between the docs-map markers count', () => {
  const unmarked = fullMap().replace(MAP_START, '').replace(MAP_END, '')
  assert.equal(missingFromMap(unmarked, mapPkgs, ['city.html']).length, 7 + 6 + 1) // modules, /react modules, the page
})

test('docs map: replaceBlock with the map markers is idempotent and leaves the demo cards alone', () => {
  const src = `# t\n\n${MAP_START}\nold\n${MAP_END}\n\n${START}\ncards\n${END}\n`
  const map = docsMap(mapPkgs, pairDemos(files))
  const once = replaceBlock(src, map, MAP_START, MAP_END)
  assert.equal(replaceBlock(once, map, MAP_START, MAP_END), once)
  assert.ok(once.includes(`${START}\ncards\n${END}`))
})
