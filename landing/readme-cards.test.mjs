import { test } from 'node:test'
import assert from 'node:assert/strict'
import { START, END, grid, packageBlock, replaceBlock } from './readme-cards.mjs'

const SITE = 'https://askalice.github.io/threejs-worldgen/'
const sky = {
  short: 'sky', name: 'threejs-sky', pitch: 'A sky & stars.', hero: { alt: 'Sunset "over" hills' },
  demos: [{ label: 'three.js demo', href: 'sky.html' }], thumb: 'sky/thumb.jpg', heroImg: 'sky/hero.jpg',
}
const trees = {
  short: 'trees', name: 'threejs-trees', pitch: 'Grown trees.', hero: { alt: 'Trees' },
  demos: [{ label: 'Forest demo', href: 'scatter.html' }, { label: 'Species lineup', href: 'scatter.html?lineup' }],
  thumb: null, heroImg: null,
}
const nodemo = { ...sky, short: 'x', name: 'threejs-x', demos: [] }

test('grid: one card per package with a demo, absolute URLs, alt text, escaped', () => {
  const md = grid([sky, trees, nodemo])
  assert.match(md, new RegExp(`<img src="${SITE}media/sky/thumb.jpg" width="\\d+" alt="threejs-sky: Sunset &quot;over&quot; hills" />`))
  assert.ok(md.includes(`href="${SITE}demo/sky.html"`))
  assert.ok(md.includes(`href="${SITE}sky/"`))
  assert.ok(md.includes('A sky &amp; stars.'))
  assert.ok(md.includes('threejs-trees'))
  assert.ok(!md.includes('threejs-x'), 'packages without a demo get no card')
  assert.ok(!/\n\s*\n/.test(md), 'no blank lines inside the HTML block')
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
