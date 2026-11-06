import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('README documents every corn symbol the package entry point exports', () => {
  const entry = read('../src/index.ts')
  const readme = read('../README.md')
  const exported = entry
    .split('\n')
    .filter((line) => line.startsWith('export') && line.includes("from './corn"))
    .flatMap((line) => line.slice(line.indexOf('{') + 1, line.indexOf('}')).split(','))
    .map((name) => name.trim())
    .filter(Boolean)

  assert.ok(exported.length >= 17, `found ${exported.length} corn exports`)
  for (const name of exported) assert.ok(readme.includes(`\`${name}\``), `README does not document \`${name}\``)
})
