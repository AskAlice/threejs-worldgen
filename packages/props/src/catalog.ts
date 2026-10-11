import { hash4, mulberry32, seedOf } from 'threejs-biomes'
import type { ShapeId } from './geometry.ts'

/** Every prop kind. */
export type PropKind =
  | 'mailbox-us' | 'mailbox-eu' | 'power-pole' | 'pylon' | 'street-light' | 'fence' | 'sign' | 'bench' | 'bin'
  | 'hydrant' | 'traffic-light' | 'bus-stop' | 'hay-bale' | 'well'

/** Materials parts are drawn with (one shared TSL material each, tinted per instance). */
export type PropMaterialId = 'paint' | 'steel' | 'wood' | 'concrete' | 'stone' | 'adobe' | 'hay' | 'glass' | 'lamp' | 'plastic' | 'cable'

/** Every material id. */
export const PROP_MATERIALS: readonly PropMaterialId[] = ['paint', 'steel', 'wood', 'concrete', 'stone', 'adobe', 'hay', 'glass', 'lamp', 'plastic', 'cable']

/** Lamp glow kinds (`Part.glow[0]`): street lamp (night only), then traffic red, amber, green. */
export const GLOW = { none: 0, street: 1, red: 2, amber: 3, green: 4 } as const

/** One prop instance. Plain JSON. Local axes: +y up, +z front (towards the road), fences run along x. */
export interface PropPlacement {
  /** What it is. */
  kind: PropKind
  /** Position (frame-local), metres. */
  x: number
  /** Ground height (local y), metres. */
  y: number
  /** Position (frame-local), metres. */
  z: number
  /** Rotation about up, radians (0: front faces +z). */
  yaw: number
  /** Per-instance seed: size, colour and detail variety. */
  seed: number
  /** One of the kind's {@link PROP_KINDS} variants (default: the first). */
  variant?: string
  /** Fence segment length, metres (fences only; default 2.5). */
  length?: number
  /** Power line id: poles and pylons with the same id are strung together, in placement order. */
  line?: number
}

/** Catalogue entry of a kind. */
export interface PropKindInfo {
  /** Display name. */
  name: string
  /** Variants (styles); the first is the default. */
  variants: readonly string[]
  /** How far it leans when damaged, 0 (never) … 1 (fully). */
  lean: number
  /** Search tags. */
  tags: readonly string[]
}

/** The catalogue: names, variants, lean and tags of every kind. */
export const PROP_KINDS: Readonly<Record<PropKind, PropKindInfo>> = {
  'mailbox-us': { name: 'Mailbox (US)', variants: ['post', 'pedestal'], lean: 1, tags: ['mail', 'letterbox', 'rural', 'house', 'american'] },
  'mailbox-eu': { name: 'Mailbox (EU)', variants: ['post', 'pillar'], lean: 0.7, tags: ['mail', 'letterbox', 'post box', 'european', 'british'] },
  'power-pole': { name: 'Power pole', variants: ['wood', 'concrete'], lean: 1, tags: ['utility pole', 'electricity', 'telegraph', 'wire', 'cable'] },
  pylon: { name: 'Transmission pylon', variants: ['lattice'], lean: 0.15, tags: ['tower', 'electricity', 'high voltage', 'power line', 'cable'] },
  'street-light': { name: 'Street light', variants: ['cobra', 'post'], lean: 1, tags: ['lamp', 'lamppost', 'night', 'lighting', 'urban'] },
  fence: { name: 'Fence', variants: ['picket', 'rail', 'adobe', 'stone'], lean: 0.5, tags: ['wall', 'boundary', 'farm', 'garden', 'wooden', 'adobe', 'stone wall'] },
  sign: { name: 'Road sign', variants: ['stop', 'yield', 'speed', 'warning', 'name'], lean: 1, tags: ['traffic sign', 'street sign', 'stop sign'] },
  bench: { name: 'Bench', variants: ['wood', 'concrete'], lean: 0, tags: ['seat', 'park', 'street furniture'] },
  bin: { name: 'Bin', variants: ['metal', 'wheelie'], lean: 0, tags: ['trash', 'litter', 'garbage', 'rubbish', 'street furniture'] },
  hydrant: { name: 'Fire hydrant', variants: ['us', 'pillar'], lean: 0.2, tags: ['fire', 'water', 'urban', 'sidewalk'] },
  'traffic-light': { name: 'Traffic light', variants: ['post', 'mast'], lean: 0.6, tags: ['signal', 'stoplight', 'junction', 'intersection'] },
  'bus-stop': { name: 'Bus stop', variants: ['shelter', 'pole'], lean: 0.1, tags: ['shelter', 'transit', 'street furniture'] },
  'hay-bale': { name: 'Hay bale', variants: ['round', 'square'], lean: 0, tags: ['farm', 'straw', 'field', 'rural', 'agriculture'] },
  well: { name: 'Well', variants: ['stone', 'adobe'], lean: 0, tags: ['water', 'farm', 'village', 'rural'] },
}

/** Every kind. */
export const PROP_KIND_IDS = Object.keys(PROP_KINDS) as PropKind[]

/** One primitive of a prop: a unit shape scaled, rotated and moved in the prop's local frame (pivot at the shape's base). */
export interface Part {
  /** Unit shape. */
  shape: ShapeId
  /** Material. */
  material: PropMaterialId
  /** Base position. */
  p: [number, number, number]
  /** Rotation quaternion (x, y, z, w). */
  q: [number, number, number, number]
  /** Size (width, height, depth). */
  s: [number, number, number]
  /** Tint, sRGB 0…1. */
  color: [number, number, number]
  /** Lamp glow: kind ({@link GLOW}) and phase 0…1. */
  glow?: [number, number]
}

/** A built prop: parts plus wire attachment points (power poles and pylons). */
export interface PropModel {
  /** Primitives. */
  parts: Part[]
  /** Local points cables hang from, in a fixed order (the same index on the next pole is strung to). */
  attach: [number, number, number][]
}

type V3 = [number, number, number]
type Q = [number, number, number, number]

function hex(c: string): V3 {
  const n = parseInt(c.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Quaternion of Euler angles in three.js 'XYZ' order. */
export function quatFromEuler(x: number, y: number, z: number): Q {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2)
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2)
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3]
}

/** Rotates v by unit quaternion q. */
export function rotate(q: Q, v: V3): V3 {
  const [x, y, z, w] = q
  const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2]
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x]
}

/** Quaternion turning +y onto unit vector d. */
export function quatFromUp(dx: number, dy: number, dz: number): Q {
  if (dy < -0.999999) return [1, 0, 0, 0]
  // q = (up × d, 1 + up·d), normalised.
  const x = dz, y = 0, z = -dx, w = 1 + dy
  const l = Math.hypot(x, y, z, w)
  return [x / l, y / l, z / l, w / l]
}

class Kit {
  parts: Part[] = []
  attach: V3[] = []
  /** A part with its base at `p`, rotated by Euler angles. */
  add(shape: ShapeId, material: PropMaterialId, color: V3 | string, p: V3, s: V3, rx = 0, ry = 0, rz = 0, glow?: [number, number]): this {
    this.parts.push({ shape, material, p, q: quatFromEuler(rx, ry, rz), s, color: typeof color === 'string' ? hex(color) : color, glow })
    return this
  }
  /** A part centred at `c` (rotation about its centre). */
  centred(shape: ShapeId, material: PropMaterialId, color: V3 | string, c: V3, s: V3, rx = 0, ry = 0, rz = 0, glow?: [number, number]): this {
    const q = quatFromEuler(rx, ry, rz)
    const o = rotate(q, [0, s[1] / 2, 0])
    this.parts.push({ shape, material, p: [c[0] - o[0], c[1] - o[1], c[2] - o[2]], q, s, color: typeof color === 'string' ? hex(color) : color, glow })
    return this
  }
  /** A beam of `shape` from a to b, `w` thick. */
  beam(shape: ShapeId, material: PropMaterialId, color: V3 | string, a: V3, b: V3, w: number, d = w): this {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2]
    const l = Math.hypot(dx, dy, dz) || 1e-6
    this.parts.push({ shape, material, p: a, q: quatFromUp(dx / l, dy / l, dz / l), s: [w, l, d], color: typeof color === 'string' ? hex(color) : color })
    return this
  }
  /** A cylinder lying along x, centred at c. */
  lying(material: PropMaterialId, color: V3 | string, c: V3, length: number, diameter: number, shape: ShapeId = 'cylinder'): this {
    return this.centred(shape, material, color, c, [diameter, length, diameter], 0, 0, Math.PI / 2)
  }
}

const pick = <T>(r: () => number, a: readonly T[]): T => a[Math.floor(r() * a.length) % a.length]
const jit = (r: () => number, v: number, amount = 0.1) => v * (1 + (r() * 2 - 1) * amount)

const WOOD = ['#6b4f36', '#7a5c40', '#5e4632', '#806347']
const GREY_WOOD = ['#7d7466', '#8a8070', '#6f675c', '#857a69']
const DARK_PAINT = ['#24292e', '#1e3a2f', '#3a3f45', '#14202e', '#2c2a28']
const STEEL = ['#8d9399', '#7f858b', '#979ca1']

/** Builds a prop from its placement (seeded: the same placement always gives the same prop). */
export function buildProp(p: Pick<PropPlacement, 'kind' | 'seed' | 'variant' | 'length'>): PropModel {
  const info = PROP_KINDS[p.kind]
  const variant = p.variant && info.variants.includes(p.variant) ? p.variant : info.variants[0]
  const r = mulberry32(hash4(seedOf(p.seed), PROP_KIND_IDS.indexOf(p.kind), 0x51ed, 7))
  const k = new Kit()
  BUILDERS[p.kind](k, r, variant, p)
  return { parts: k.parts, attach: k.attach }
}

type BuildFn = (k: Kit, r: () => number, variant: string, p: Pick<PropPlacement, 'length'>) => void

const BUILDERS: Record<PropKind, BuildFn> = {
  'mailbox-us'(k, r, v) {
    const body = pick(r, ['#2a2a2a', '#9aa0a6', '#1f3b63', '#2f5d3a', '#7a1f1f', '#2a2a2a'])
    const h = jit(r, 1.02, 0.06)
    if (v === 'pedestal') k.add('cylinder', 'steel', '#3a3d40', [0, 0, 0], [0.08, h, 0.08]).add('box', 'steel', '#3a3d40', [0, h - 0.02, 0.05], [0.22, 0.02, 0.4])
    else k.add('box', r() < 0.4 ? 'paint' : 'wood', r() < 0.4 ? '#e8e4da' : pick(r, WOOD), [0, 0, 0], [0.1, h, 0.1])
    const len = jit(r, 0.48, 0.08)
    k.add('box', 'paint', body, [0, h, 0.08], [0.22, 0.13, len]).add('arch', 'paint', body, [0, h + 0.13, 0.08], [0.22, 0.1, len])
    // Flag, up or down.
    const up = r() < 0.35
    k.centred('box', 'paint', '#c8231e', [0.12, h + (up ? 0.25 : 0.12), 0.02], [0.015, 0.22, 0.04], up ? 0 : Math.PI / 2 - 0.1, 0, 0)
  },
  'mailbox-eu'(k, r, v) {
    const body = pick(r, ['#f2c200', '#c8102e', '#1d4f91', '#2e7d32', '#f6d000'])
    if (v === 'pillar') {
      const red = '#c8102e'
      k.add('cylinder', 'paint', red, [0, 0, 0], [0.48, 1.3, 0.48]).add('cylinder', 'paint', red, [0, 1.3, 0], [0.56, 0.08, 0.56])
        .add('sphere', 'paint', red, [0, 1.25, 0], [0.5, 0.3, 0.5]).add('box', 'paint', '#111111', [0, 1.05, 0.22], [0.26, 0.04, 0.04])
      return
    }
    const h = jit(r, 0.95, 0.05)
    k.add('cylinder', 'steel', pick(r, STEEL), [0, 0, 0], [0.07, h, 0.07])
      .add('box', 'paint', body, [0, h - 0.05, 0.02], [0.34, 0.42, 0.17]).add('arch', 'paint', body, [0, h + 0.37, 0.02], [0.36, 0.06, 0.19])
      .add('box', 'paint', '#1a1a1a', [0, h + 0.24, 0.105], [0.2, 0.02, 0.01])
  },
  'power-pole'(k, r, v) {
    const h = jit(r, 10.5, 0.1)
    const concrete = v === 'concrete'
    k.add(concrete ? 'cylinder8' : 'cylinder', concrete ? 'concrete' : 'wood', concrete ? '#a8a59f' : pick(r, GREY_WOOD), [0, 0, 0], [concrete ? 0.3 : jit(r, 0.28, 0.08), h, concrete ? 0.3 : 0.28])
    const arm = h - 0.65
    k.centred('box', concrete ? 'steel' : 'wood', concrete ? '#7f858b' : pick(r, GREY_WOOD), [0, arm, 0], [2.3, 0.11, 0.11])
    const ins = r() < 0.5 ? '#8fa89a' : '#d9d6cc'
    for (const x of [-1.05, 1.05]) {
      k.add('cylinder', 'glass', ins, [x, arm + 0.055, 0], [0.09, 0.2, 0.09])
      k.attach.push([x, arm + 0.255, 0])
    }
    k.add('cylinder', 'glass', ins, [0, h, 0], [0.09, 0.2, 0.09])
    k.attach.push([0, h + 0.2, 0])
    // Braces under the arm.
    for (const s of [-1, 1]) k.beam('box', 'steel', '#5a5d60', [0, arm - 0.55, 0.08], [s * 0.6, arm - 0.05, 0.08], 0.04)
    if (r() < 0.25) k.add('cylinder', 'steel', '#8d9399', [0, h - 2.6, -0.36], [0.48, 0.8, 0.48]).add('cylinder', 'steel', '#6d7277', [0, h - 1.8, -0.36], [0.5, 0.05, 0.5])
  },
  pylon(k, r) {
    const H = jit(r, 30, 0.1), b = jit(r, 3.6, 0.1), t = 0.75, top = H * 0.86
    const steel = pick(r, STEEL)
    const hw = (y: number) => b + ((t - b) * y) / top
    const corners: [number, number][] = [[1, 1], [1, -1], [-1, -1], [-1, 1]]
    for (const [sx, sz] of corners) {
      k.beam('box', 'steel', steel, [sx * b, 0, sz * b], [sx * t, top, sz * t], 0.2)
      k.beam('box', 'steel', steel, [sx * t, top, sz * t], [0, H, 0], 0.12)
    }
    const levels = [0, 0.18, 0.36, 0.52, 0.66, 0.78, 1].map((f) => f * top)
    for (let i = 1; i < levels.length; i++) {
      const y0 = levels[i - 1], y1 = levels[i], w0 = hw(y0), w1 = hw(y1)
      for (let c = 0; c < 4; c++) {
        const [ax, az] = corners[c], [bx, bz] = corners[(c + 1) % 4]
        k.beam('box', 'steel', steel, [ax * w1, y1, az * w1], [bx * w1, y1, bz * w1], 0.08)
        k.beam('box', 'steel', steel, [ax * w0, y0, az * w0], [bx * w1, y1, bz * w1], 0.06)
        k.beam('box', 'steel', steel, [bx * w0, y0, bz * w0], [ax * w1, y1, az * w1], 0.06)
      }
    }
    // Cross arms with hanging insulator strings; an earth wire on the peak.
    for (const [f, reach] of [[0.66, 5.6], [0.78, 4.4]] as const) {
      const y = f * top, w = hw(y)
      for (const s of [-1, 1]) {
        for (const z of [-w, w]) k.beam('box', 'steel', steel, [s * w, y, z], [s * reach, y, 0], 0.1)
        k.beam('box', 'steel', steel, [s * reach, y, 0], [s * hw(y + 2.2), y + 2.2, 0], 0.07)
        k.add('cylinder', 'glass', '#9fb0a8', [s * (reach - 0.25), y - 1.9, 0], [0.16, 1.9, 0.16])
        k.attach.push([s * (reach - 0.25), y - 1.9, 0])
      }
    }
    k.attach.push([0, H, 0])
  },
  'street-light'(k, r, v) {
    if (v === 'post') {
      const h = jit(r, 3.9, 0.06), c = pick(r, ['#1d2b24', '#151515', '#26313b'])
      k.add('cylinder8', 'paint', c, [0, 0, 0], [0.3, 0.75, 0.3]).add('cylinder', 'paint', c, [0, 0, 0], [0.12, h, 0.12])
        .add('cylinder8', 'paint', c, [0, h, 0], [0.22, 0.06, 0.22])
        .add('sphere', 'lamp', '#ffe2b0', [0, h + 0.04, 0], [0.38, 0.42, 0.38], 0, 0, 0, [1, 0])
        .add('cylinder8', 'paint', c, [0, h + 0.44, 0], [0.44, 0.08, 0.44]).add('sphere', 'paint', c, [0, h + 0.5, 0], [0.08, 0.12, 0.08])
      return
    }
    const h = jit(r, 8, 0.1), reach = jit(r, 1.9, 0.12), c = pick(r, STEEL)
    k.add('cylinder', 'steel', c, [0, 0, 0], [0.3, 0.5, 0.3]).add('cylinder', 'steel', c, [0, 0, 0], [0.2, h * 0.45, 0.2]).add('cylinder', 'steel', c, [0, h * 0.45, 0], [0.15, h * 0.55, 0.15])
    k.beam('cylinder', 'steel', c, [0, h - 0.15, 0], [0, h + 0.3, reach], 0.08)
    k.centred('box', 'steel', c, [0, h + 0.3, reach + 0.25], [0.3, 0.13, 0.65], -0.08)
    k.centred('box', 'lamp', '#ffd9a0', [0, h + 0.225, reach + 0.25], [0.22, 0.02, 0.45], -0.08, 0, 0, [1, 0])
  },
  fence(k, r, v, p) {
    const L = Math.max(0.5, p.length ?? 2.5), half = L / 2
    if (v === 'adobe' || v === 'stone') {
      const adobe = v === 'adobe'
      const mat = adobe ? 'adobe' : 'stone'
      const c = adobe ? pick(r, ['#c9a27a', '#b88d63', '#d1ae86']) : pick(r, ['#8b8680', '#9a948c', '#7a756f'])
      const h = jit(r, adobe ? 1.3 : 0.85, 0.08), d = adobe ? 0.32 : 0.5
      k.centred('box', mat, c, [0, h / 2, 0], [L, h, d]).centred('box', mat, c, [0, h + 0.04, 0], [L + 0.02, 0.08, d + 0.06])
      return
    }
    if (v === 'rail') {
      const c = pick(r, GREY_WOOD)
      for (const x of [-half, half]) k.add('box', 'wood', c, [x, 0, 0], [0.14, jit(r, 1.25, 0.05), 0.14], 0, r() * 0.6)
      for (const y of [0.4, 0.75, 1.1]) k.lying('wood', c, [0, jit(r, y, 0.04), 0.09], L + 0.2, jit(r, 0.1, 0.15))
      return
    }
    const white = r() < 0.6
    const c = white ? pick(r, ['#ece8df', '#f2efe8', '#e0dcd2']) : pick(r, WOOD)
    const mat = white ? 'paint' : 'wood'
    for (const x of [-half, half]) k.add('box', mat, c, [x, 0, 0], [0.1, 1.15, 0.1])
    for (const y of [0.3, 0.85]) k.centred('box', mat, c, [0, y, -0.06], [L, 0.07, 0.035])
    const n = Math.max(1, Math.floor(L / 0.16))
    for (let i = 0; i < n; i++) k.add('box', mat, c, [-half + ((i + 0.5) / n) * L, 0.08, -0.02], [0.075, jit(r, 0.95, 0.02), 0.02])
  },
  sign(k, r, v) {
    const h = v === 'name' ? 2.6 : jit(r, 2.1, 0.05)
    k.add('box', 'steel', pick(r, STEEL), [0, 0, 0], [0.06, h + (v === 'name' ? 0.1 : 0.35), 0.06])
    const y = h + 0.1
    switch (v) {
      case 'stop':
        k.add('cylinder8', 'paint', '#c8102e', [0, y, 0.035], [0.75, 0.025, 0.75], Math.PI / 2, Math.PI / 8)
        break
      case 'yield':
        k.add('cylinder3', 'paint', '#c8102e', [0, y + 0.1, 0.035], [0.9, 0.02, 0.9], Math.PI / 2)
          .add('cylinder3', 'paint', '#f4f4f0', [0, y + 0.1, 0.055], [0.55, 0.01, 0.55], Math.PI / 2)
        break
      case 'speed':
        k.centred('box', 'paint', '#f4f4f0', [0, y, 0.045], [0.6, 0.75, 0.02]).centred('box', 'paint', '#1a1a1a', [0, y, 0.035], [0.64, 0.79, 0.01])
        break
      case 'warning':
        k.centred('box', 'paint', '#f2c200', [0, y, 0.045], [0.6, 0.6, 0.02], 0, 0, Math.PI / 4)
        break
      default:
        k.centred('box', 'paint', pick(r, ['#1e6b3a', '#1d4f91']), [0, h + 0.05, 0], [0.9, 0.18, 0.025])
          .centred('box', 'paint', pick(r, ['#1e6b3a', '#1d4f91']), [0, h - 0.17, 0], [0.9, 0.18, 0.025], 0, Math.PI / 2)
    }
  },
  bench(k, r, v) {
    const L = jit(r, 1.7, 0.1)
    if (v === 'concrete') {
      k.centred('box', 'concrete', pick(r, ['#a8a59f', '#b5b2ab', '#9c9890']), [0, 0.22, 0], [L, 0.44, 0.5])
      return
    }
    const frame = pick(r, DARK_PAINT), wood = pick(r, WOOD)
    for (const s of [-1, 1]) {
      k.add('box', 'paint', frame, [s * (L / 2 - 0.15), 0, 0], [0.06, 0.44, 0.5])
      k.beam('box', 'paint', frame, [s * (L / 2 - 0.15), 0.44, -0.22], [s * (L / 2 - 0.15), 0.92, -0.3], 0.05)
    }
    for (const z of [-0.15, 0, 0.15]) k.centred('box', 'wood', wood, [0, 0.46, z], [L, 0.04, 0.12])
    for (const y of [0.64, 0.84]) k.centred('box', 'wood', wood, [0, y, -0.25 - (y - 0.64) * 0.15], [L, 0.11, 0.03], -0.17)
  },
  bin(k, r, v) {
    if (v === 'wheelie') {
      const c = pick(r, ['#2e6b30', '#3a3a3a', '#1f4f8f', '#8a6d1f', '#6b6b6b'])
      k.add('box', 'plastic', c, [0, 0.05, 0], [0.58, 0.93, 0.7]).add('box', 'plastic', c, [0, 0.98, -0.01], [0.62, 0.05, 0.76], 0.03)
      for (const s of [-1, 1]) k.lying('plastic', '#1a1a1a', [s * 0.27, 0.1, -0.3], 0.05, 0.2)
      return
    }
    const c = pick(r, ['#2f4f3a', '#333333', '#1f3b63', '#6b6b6b'])
    k.add('cylinder', 'paint', c, [0, 0, 0], [0.5, jit(r, 0.85, 0.06), 0.5]).add('cylinder', 'steel', '#4a4e52', [0, 0.85, 0], [0.54, 0.06, 0.54])
  },
  hydrant(k, r, v) {
    const c = r() < 0.65 ? '#b3201c' : r() < 0.7 ? '#d4a017' : '#c9c9c9'
    if (v === 'pillar') {
      k.add('cylinder', 'paint', '#b3201c', [0, 0, 0], [0.2, 0.85, 0.2]).add('sphere', 'paint', '#b3201c', [0, 0.75, 0], [0.22, 0.22, 0.22])
        .add('cylinder', 'paint', '#e8e4da', [0, 0.55, 0], [0.205, 0.08, 0.205])
      return
    }
    k.add('cylinder', 'paint', c, [0, 0, 0], [0.32, 0.06, 0.32]).add('cylinder', 'paint', c, [0, 0.06, 0], [0.24, 0.52, 0.24])
      .add('sphere', 'paint', c, [0, 0.48, 0], [0.26, 0.24, 0.26]).add('cylinder8', 'paint', c, [0, 0.71, 0], [0.06, 0.05, 0.06])
      .lying('paint', c, [0.16, 0.42, 0], 0.12, 0.08).lying('paint', c, [-0.16, 0.42, 0], 0.12, 0.08)
      .centred('cylinder', 'paint', c, [0, 0.4, 0.15], [0.13, 0.1, 0.13], Math.PI / 2)
  },
  'traffic-light'(k, r, v) {
    const pole = pick(r, ['#2b2f33', '#8d9399', '#3b4a3f'])
    const phase = r()
    const head = (x: number, y: number, z: number, yaw: number) => {
      const s = Math.sin(yaw), c = Math.cos(yaw)
      const at = (lx: number, ly: number, lz: number): V3 => [x + lx * c + lz * s, y + ly, z - lx * s + lz * c]
      k.centred('box', 'paint', '#1a1c1e', at(0, 0, 0), [0.32, 0.95, 0.26], 0, yaw)
      k.centred('box', 'paint', '#111214', at(0, 0, -0.14), [0.5, 1.15, 0.02], 0, yaw)
      ;([[0.3, '#ff2a1a', GLOW.red], [0, '#ffb000', GLOW.amber], [-0.3, '#19e07a', GLOW.green]] as const).forEach(([dy, col, g]) => {
        k.centred('sphere', 'lamp', col, at(0, dy, 0.12), [0.2, 0.2, 0.08], 0, 0, 0, [g, phase])
      })
    }
    if (v === 'mast') {
      const h = jit(r, 6.2, 0.05), reach = jit(r, 5.5, 0.1)
      k.add('cylinder', 'steel', pole, [0, 0, 0], [0.26, h, 0.26]).beam('cylinder', 'steel', pole, [0, h - 0.4, 0], [-reach, h - 0.2, 0], 0.14)
      head(-reach + 0.3, h - 0.95, 0, 0)
      head(-reach * 0.45, h - 0.85, 0, 0)
      return
    }
    k.add('cylinder', 'paint', pole, [0, 0, 0], [0.14, 2.9, 0.14])
    head(0, 3.0, 0, 0)
  },
  'bus-stop'(k, r, v) {
    const sign = pick(r, ['#1d4f91', '#1e6b3a', '#f2c200', '#c8102e'])
    k.add('cylinder', 'steel', '#8d9399', [v === 'pole' ? 0 : 2.0, 0, v === 'pole' ? 0 : 0.5], [0.07, 2.7, 0.07])
      .centred('box', 'paint', sign, [v === 'pole' ? 0 : 2.0, 2.45, v === 'pole' ? 0.05 : 0.55], [0.45, 0.45, 0.03])
    if (v === 'pole') return
    const roof = pick(r, ['#3a3f45', '#1e3a2f', '#8d9399', '#6b2a2a'])
    for (const x of [-1.5, 1.5]) for (const z of [-0.6, 0.55]) k.add('cylinder', 'steel', '#8d9399', [x, 0, z], [0.08, 2.4, 0.08])
    k.centred('box', 'paint', roof, [0, 2.45, 0], [3.3, 0.1, 1.5])
    k.add('box', 'glass', '#5a6a72', [0, 0.25, -0.6], [3.0, 2.0, 0.02])
    for (const x of [-1.5, 1.5]) k.add('box', 'glass', '#5a6a72', [x, 0.25, -0.02], [0.02, 2.0, 1.1])
    k.centred('box', 'steel', '#6d7277', [0, 0.45, -0.38], [2.0, 0.05, 0.35])
    for (const x of [-0.9, 0.9]) k.add('box', 'steel', '#6d7277', [x, 0, -0.38], [0.05, 0.43, 0.3])
  },
  'hay-bale'(k, r, v) {
    const hay = pick(r, ['#d8b96a', '#cfae5c', '#c4a25a', '#bfa365'])
    if (v === 'square') {
      const w = jit(r, 1.0, 0.08), h = jit(r, 0.45, 0.06), d = jit(r, 0.5, 0.06)
      k.add('box', 'hay', hay, [0, 0, 0], [w, h, d])
      if (r() < 0.4) k.add('box', 'hay', hay, [jit(r, 0.05, 1), h, jit(r, 0.03, 1)], [w, h, d], 0, (r() - 0.5) * 0.4)
      return
    }
    const d = jit(r, 1.5, 0.08), w = jit(r, 1.2, 0.06)
    const wrapped = r() < 0.25
    k.lying(wrapped ? 'plastic' : 'hay', wrapped ? pick(r, ['#e9ece6', '#2a2a2a', '#7ea36a']) : hay, [0, d / 2, 0], w, d)
  },
  well(k, r, v) {
    const adobe = v === 'adobe'
    const wall = adobe ? pick(r, ['#c9a27a', '#b88d63']) : pick(r, ['#8b8680', '#9a948c', '#7a756f'])
    const d = jit(r, 1.5, 0.08), h = jit(r, 0.8, 0.08)
    k.add('ring', adobe ? 'adobe' : 'stone', wall, [0, 0, 0], [d, h, d]).add('cylinder', 'glass', '#18222a', [0, h - 0.35, 0], [d * 0.78, 0.02, d * 0.78])
    const wood = pick(r, adobe ? GREY_WOOD : WOOD)
    for (const s of [-1, 1]) k.add('box', 'wood', wood, [s * d * 0.45, 0, 0], [0.12, adobe ? 1.95 : 2.3, 0.12])
    k.lying('wood', wood, [0, 1.65, 0], d * 1.05, 0.1)
    k.add('cylinder', 'steel', '#6d7277', [0, 1.0, 0], [0.24, 0.24, 0.24]).add('wire', 'cable', '#6b5a40', [0, 1.24, 0], [0.015, 0.36, 0.015])
    if (!adobe) for (const s of [-1, 1]) k.centred('box', 'wood', wood, [0, 2.12, s * 0.32], [d + 0.4, 0.04, 0.82], s * 0.68)
  },
}
