#!/usr/bin/env node
// Publish gate: a package's published src must list every `threejs-*` it imports as a dependency or peerDependency
// (a devDependency never installs for consumers), and a package that publishes src/react.tsx must export `./react`.
//
// Usage: node scripts/check-manifests.mjs [--self-test]   (exits 1 when a package would publish broken)

import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname

// shortcut: naive stripping; a string containing `//` truncates its line, and no import lives after one.
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

/** Every `threejs-*` module specifier imported (or re-exported) by a source file. */
function specifiers(text) {
  const found = new Set()
  for (const m of stripComments(text).matchAll(/(?:from|import)\s*\(?\s*['"](threejs-[^'"]+)['"]/g)) {
    found.add(m[1])
  }
  return [...found]
}

/**
 * @param {{ name: string, pkg: object, files: { path: string, text: string }[] }[]} packages
 * @returns {{ name: string, missing: string[] }[]}
 */
function check(packages) {
  return packages.map(({ name, pkg, files }) => {
    const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})])
    const missing = new Set()
    for (const { path, text } of files) {
      if (!/\.tsx?$/.test(path)) continue
      for (const spec of specifiers(text)) {
        const dep = spec.split('/')[0]
        if (dep !== name && !declared.has(dep)) missing.add(dep)
      }
    }
    if (files.some((f) => f.path === 'src/react.tsx') && !pkg.exports?.['./react']) {
      missing.add('./react export for src/react.tsx')
    }
    return { name, missing: [...missing] }
  })
}

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}

async function load() {
  const packages = []
  for (const dir of await readdir(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const base = join(ROOT, 'packages', dir.name)
    const pkg = JSON.parse(await readFile(join(base, 'package.json'), 'utf8'))
    let paths = []
    try {
      paths = await walk(join(base, 'src'))
    } catch {
      continue // no src: nothing published
    }
    const files = await Promise.all(
      paths.filter((p) => /\.tsx?$/.test(p)).map(async (p) => ({ path: relative(base, p), text: await readFile(p, 'utf8') })),
    )
    packages.push({ name: pkg.name, pkg, files })
  }
  return packages
}

function report(results) {
  for (const { name, missing } of results) {
    console.log(`${name.padEnd(22)} ${missing.length ? `missing ${missing.join(', ')}` : 'ok'}`)
  }
  return results.some((r) => r.missing.length) ? 1 : 0
}

function selfTest() {
  const pkg = (dependencies, exports) => ({ dependencies, peerDependencies: {}, exports })
  const results = check([
    {
      name: 'threejs-a',
      pkg: pkg({ 'threejs-b': '^0.1.0' }, { '.': {} }),
      files: [
        {
          path: 'src/index.ts',
          text: [
            "import { b } from 'threejs-b'",
            "// import { c } from 'threejs-dead-line'",
            "/* import { d } from 'threejs-dead-block' */",
            "import { c } from 'threejs-c/sub'",
          ].join('\n'),
        },
        { path: 'src/react.tsx', text: '' },
      ],
    },
    { name: 'threejs-b', pkg: pkg({}, { '.': {}, './react': {} }), files: [{ path: 'src/react.tsx', text: '' }] },
  ])
  const [a, b] = results
  const ok =
    a.missing.length === 2 &&
    a.missing.includes('threejs-c') &&
    a.missing.includes('./react export for src/react.tsx') &&
    b.missing.length === 0
  console.log(
    ok
      ? 'self-test ok: caught undeclared threejs-c and the missing ./react export, ignored both comment forms'
      : `self-test FAILED: ${JSON.stringify(results)}`,
  )
  return ok ? 0 : 1
}

if (process.argv.includes('--self-test')) process.exit(selfTest())
process.exit(report(check(await load())))