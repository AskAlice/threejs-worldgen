import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { readdirSync } from 'node:fs'

const src = (p: string) => fileURLToPath(new URL(`../packages/${p}`, import.meta.url))
const packages = [
  'heightfield',
  'biomes',
  'scatter',
  'trees',
  'water',
  'particles',
  'weathering',
  'fauna',
  'city',
  'props',
  'vehicles',
  'sky',
  'grass',
  'worldgen'
]
const name = (dir: string) => (dir === 'worldgen' ? 'threejs-worldgen' : `threejs-${dir}`)

export default defineConfig({
  plugins: [react()],
  // Demos run straight from each package's src/, so edits show up without a build.
  resolve: {
    alias: [
      { find: /^threejs-biomes\/worker(\?worker)?$/, replacement: src('biomes/src/worker.ts') + '$1' },
      ...packages.flatMap((dir) => [
        { find: new RegExp(`^${name(dir)}/react$`), replacement: src(`${dir}/src/react.tsx`) },
        { find: new RegExp(`^${name(dir)}$`), replacement: src(`${dir}/src/index.ts`) }
      ])
    ]
  },
  // Reachable over the tailnet (tailscale serve) as well as localhost. 8460 is deliberately far from
  // Vite's 5173 so this server never collides with another project's dev server; strictPort fails
  // loudly rather than drifting to another port.
  server: { port: 8460, strictPort: true, allowedHosts: ['.ts.net', 'localhost', '127.0.0.1'] },
  worker: { format: 'es' },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: readdirSync(fileURLToPath(new URL('.', import.meta.url))).filter((f) => f.endsWith('.html'))
    }
  }
})
