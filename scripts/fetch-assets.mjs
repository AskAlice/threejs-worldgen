#!/usr/bin/env node
// Downloads the CC0 tree, plant, rock, bark and leaf assets listed in packages/trees/cc0-assets.json into example/public/cc0/
// (committed, served by the demos at ./cc0/) and writes example/public/cc0/manifest.json, which the demos and `loadAssetLibrary()` read.
//
//   node scripts/fetch-assets.mjs                     fetch everything missing (checksums verified)
//   node scripts/fetch-assets.mjs --only fern_02,pine_bark
//   node scripts/fetch-assets.mjs --out some/dir      another target directory
//   node scripts/fetch-assets.mjs --write-checksums   record sha256 of new downloads in the committed manifest
//
// No dependencies: Node's fetch, crypto and zlib (ambientCG ships zips; only the listed maps are kept).
// Every asset is CC0 (Poly Haven, ambientCG). Files are downloaded once and self-hosted, never hotlinked.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'packages/trees/cc0-assets.json')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const out = resolve(root, option('--out') ?? 'example/public/cc0')
const only = option('--only')?.split(',')
const writeChecksums = flag('--write-checksums')
// Poly Haven asks API clients for an identifying user agent; we use it for file downloads too.
const USER_AGENT = 'threejs-worldgen-fetch-assets/1.0 (+https://github.com/AskAlice/threejs-worldgen)'

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const assets = manifest.assets.filter((a) => !only || only.includes(a.id))
if (only && assets.length !== only.length) fail(`unknown asset id in --only: ${only.filter((id) => !assets.some((a) => a.id === id)).join(', ')}`)
for (const a of assets) if (a.license !== 'CC0-1.0') fail(`${a.id}: only CC0 assets may be listed (got ${a.license})`)

const digest = (algo, buf) => createHash(algo).update(buf).digest('hex')
function fail(message) {
  console.error(`fetch-assets: ${message}`)
  process.exit(1)
}

/** Entries of a zip archive (no zip64, stored or deflated), by name. */
function unzip(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('not a zip file')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const files = new Map()
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory')
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLength = buf.readUInt16LE(p + 28)
    const skip = buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength)
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    files.set(name.split('/').pop(), () => {
      const data = buf.subarray(start, start + size)
      if (method === 0) return data
      if (method === 8) return inflateRawSync(data)
      throw new Error(`unsupported zip compression ${method} for ${name}`)
    })
    p += 46 + nameLength + skip
  }
  return files
}

async function download(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (e) {
      if (attempt >= 3) throw new Error(`${url}: ${e.message}`)
      await new Promise((r) => setTimeout(r, 1000 * attempt))
    }
  }
}

/** Paths a file entry leaves on disk (zips are unpacked, the archive itself is not kept). */
const targets = (f) => (f.extract ? Object.values(f.extract) : [f.path])
const present = (f) => targets(f).every((p) => existsSync(join(out, p)))

let changedManifest = false
let fetched = 0
async function fetchFile(asset, f) {
  if (present(f) && (f.extract || !f.size || statSync(join(out, f.path)).size === f.size)) return
  const buf = await download(f.url)
  if (f.md5 && digest('md5', buf) !== f.md5) throw new Error(`${asset.id}: md5 mismatch for ${f.path}`)
  const sha = digest('sha256', buf)
  if (f.sha256 && f.sha256 !== sha) throw new Error(`${asset.id}: sha256 mismatch for ${f.path} (expected ${f.sha256}, got ${sha})`)
  if (!f.sha256) {
    if (!writeChecksums) console.warn(`  ${f.path}: no sha256 in the manifest (run with --write-checksums to pin it)`)
    else { f.sha256 = sha; changedManifest = true }
  }
  if (f.extract) {
    const zip = unzip(buf)
    for (const [name, path] of Object.entries(f.extract)) {
      const entry = zip.get(name)
      if (!entry) throw new Error(`${asset.id}: ${name} missing from ${f.url}`)
      mkdirSync(dirname(join(out, path)), { recursive: true })
      writeFileSync(join(out, path), entry())
    }
  } else {
    mkdirSync(dirname(join(out, f.path)), { recursive: true })
    writeFileSync(join(out, f.path), buf)
  }
  fetched += buf.length
}

// A small pool: a few parallel downloads, one asset's files at a time per worker.
const queue = assets.flatMap((a) => a.files.map((f) => [a, f]))
const errors = []
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let job = queue.shift(); job; job = queue.shift()) {
    try {
      await fetchFile(...job)
    } catch (e) {
      errors.push(e.message)
    }
  }
}))
if (changedManifest) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`)

// The runtime manifest lists only complete assets, so loaders can trust every path in it.
const complete = manifest.assets.filter((a) => a.files.every(present))
const bytes = complete.reduce((n, a) => n + a.files.flatMap(targets).reduce((m, p) => m + statSync(join(out, p)).size, 0), 0)
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify({ version: manifest.version, generated: new Date().toISOString(), bytes, assets: complete.map(({ files, ...a }) => a) }, null, 1)}\n`)

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`
console.log(`fetch-assets: ${complete.length}/${manifest.assets.length} assets in ${out} (${mb(bytes)} on disk, ${mb(fetched)} downloaded now)`)
if (bytes > manifest.budgetMB * 1e6) console.warn(`fetch-assets: over the ${manifest.budgetMB} MB budget`)
if (errors.length) fail(`${errors.length} file(s) failed:\n  ${errors.join('\n  ')}`)
