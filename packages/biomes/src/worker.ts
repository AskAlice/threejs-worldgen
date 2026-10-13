/**
 * Web Worker entry for terrain chunk builds. Create it with your bundler's worker syntax and pass it to
 * `WorldTerrain.create({ createWorker })`, e.g. with Vite:
 *
 * ```ts
 * import TerrainWorker from 'threejs-biomes/worker?worker'
 * const terrain = await WorldTerrain.create({ world, camera, scene, createWorker: () => new TerrainWorker() })
 * ```
 *
 * @module threejs-biomes/worker
 */
import { buildChunk, type ChunkKey, type ChunkSettings } from './chunk.ts'
import { World } from './world.ts'

let world: World | null = null

/** Handles `world` (new settings) and `build` (one chunk) messages from `WorldTerrain`. */
function handle(msg: { type: string; options?: World['options']; version?: number; id?: number; worker?: number; key?: ChunkKey; settings?: ChunkSettings }) {
  if (msg.type === 'world') {
    world = new World(msg.options)
    world.version = msg.version ?? 0
    return
  }
  if (msg.type === 'build' && world) {
    const data = buildChunk(world, msg.key!, msg.settings!)
    // The index buffer is cached per resolution on both sides; send only whether it is flipped.
    const out = { ...data, index: isFlipped(data.index) }
    ;(self as unknown as Worker).postMessage({ type: 'built', id: msg.id, worker: msg.worker, data: out }, [
      data.positions.buffer, data.normals.buffer, data.colors.buffer, data.climate.buffer, data.biomeColors.buffer,
    ])
  }
}

// chunkIndex(n, false) starts with triangle (0, n, 1); the flipped version with (0, 1, n).
function isFlipped(index: Uint32Array): boolean {
  return index[1] < index[2]
}

self.onmessage = (e: MessageEvent) => handle(e.data)
