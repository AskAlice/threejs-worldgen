import { InstancedBufferAttribute, type BufferGeometry, type Node } from 'three/webgpu'
import { instancedBufferAttribute } from 'three/tsl'
import { STATE_CHANNELS, type MaterialStates, type StateChannel } from './states.ts'
import type { StateField, StateNodes } from './state-field.ts'

/** Options of {@link InstanceStates.sampleField}. */
export interface SampleFieldOptions {
  /** Floats per instance in `positions` (x at 0, z at 2). Default 3. */
  stride: number
  /** Channels to copy. Default: all four. */
  channels: readonly StateChannel[]
  /** `max` keeps the larger value (scars stay), `replace` copies the field. Default `max`. */
  mode: 'max' | 'replace'
}

/**
 * Per-instance material states for instanced meshes (trees, rocks, buildings, props): four floats per
 * instance (wetness, snow, burn, damage) in an `InstancedBufferAttribute`, read in the shader through
 * {@link InstanceStates.node}.
 *
 * @example
 * ```ts
 * const states = new InstanceStates(trees.count)
 * applyMaterialStatesTo(barkMaterial, { ...states.node(), wetness: field.node().wetness })
 * states.set(12, { burn: 1 })                        // tree 12 burnt down
 * states.sampleField(field, treePositions)           // pick up burn scars and storm damage
 * ```
 */
export class InstanceStates {
  /** Number of instances. */
  readonly count: number
  /** The states, 4 floats per instance (wetness, snow, burn, damage). */
  readonly array: Float32Array
  /** The GPU attribute (item size 4). */
  readonly attribute: InstancedBufferAttribute
  private nodes: StateNodes | null = null

  /** Creates `count` instances, all starting at `initial` (default all 0). */
  constructor(count: number, initial: Partial<MaterialStates> = {}) {
    this.count = count
    this.array = new Float32Array(count * 4)
    this.attribute = new InstancedBufferAttribute(this.array, 4)
    this.setAll(initial)
  }

  /** States of instance `i`. */
  get(i: number, out: MaterialStates = { wetness: 0, snow: 0, burn: 0, damage: 0 }): MaterialStates {
    for (let c = 0; c < 4; c++) out[STATE_CHANNELS[c]] = this.array[i * 4 + c]
    return out
  }

  /** One state of instance `i`. */
  value(i: number, channel: StateChannel): number {
    return this.array[i * 4 + STATE_CHANNELS.indexOf(channel)]
  }

  /** Sets states of instance `i` (clamped to 0…1); missing channels are kept. */
  set(i: number, values: Partial<MaterialStates>): this {
    for (let c = 0; c < 4; c++) {
      const v = values[STATE_CHANNELS[c]]
      if (v !== undefined) this.array[i * 4 + c] = clamp01(v)
    }
    return this.changed()
  }

  /** Adds `amount` to one state of instance `i` (clamped to 0…1). */
  add(i: number, channel: StateChannel, amount: number): this {
    const k = i * 4 + STATE_CHANNELS.indexOf(channel)
    this.array[k] = clamp01(this.array[k] + amount)
    return this.changed()
  }

  /** Sets the given channels on every instance. */
  setAll(values: Partial<MaterialStates>): this {
    for (let c = 0; c < 4; c++) {
      const v = values[STATE_CHANNELS[c]]
      if (v === undefined) continue
      for (let k = c; k < this.array.length; k += 4) this.array[k] = clamp01(v)
    }
    return this.changed()
  }

  /** Relaxes states towards 0 at `rates` per second (e.g. drying: `{ wetness: 1 / 7200 }`). */
  decay(dt: number, rates: Partial<MaterialStates>): this {
    for (let c = 0; c < 4; c++) {
      const r = rates[STATE_CHANNELS[c]]
      if (!r) continue
      for (let k = c; k < this.array.length; k += 4) this.array[k] = Math.max(0, this.array[k] - r * dt)
    }
    return this.changed()
  }

  /**
   * Copies states from a {@link StateField} at each instance position (frame coordinates, x and z read
   * from `positions` with `stride`), so trees pick up fire scars, storm damage, wetness and snow.
   */
  sampleField(field: StateField, positions: ArrayLike<number>, options: Partial<SampleFieldOptions> = {}): this {
    const { stride = 3, channels = STATE_CHANNELS, mode = 'max' } = options
    const idx = channels.map((c) => STATE_CHANNELS.indexOf(c))
    for (let i = 0; i < this.count; i++) {
      const x = positions[i * stride], z = positions[i * stride + 2]
      for (let n = 0; n < channels.length; n++) {
        const k = i * 4 + idx[n]
        const v = field.value(channels[n], x, z)
        this.array[k] = mode === 'max' ? Math.max(this.array[k], v) : v
      }
    }
    return this.changed()
  }

  /** Adds the attribute to a geometry under `name` (for `InstancedBufferGeometry` setups). */
  attach(geometry: BufferGeometry, name = 'instanceStates'): this {
    geometry.setAttribute(name, this.attribute)
    return this
  }

  /** The four states as TSL nodes for the current instance. Works with `InstancedMesh` and instanced geometry. */
  node(): StateNodes {
    if (!this.nodes) {
      const s = instancedBufferAttribute<'vec4'>(this.attribute, 'vec4') as Node<'vec4'>
      this.nodes = { wetness: s.x, snow: s.y, burn: s.z, damage: s.w }
    }
    return this.nodes
  }

  // ponytail: re-uploads the whole buffer on change (16 bytes/instance); add update ranges if 100k+ instances change often.
  private changed(): this {
    this.attribute.needsUpdate = true
    return this
  }
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
