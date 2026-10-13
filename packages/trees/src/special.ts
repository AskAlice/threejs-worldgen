import type { TreeParams } from './species.ts'
import { icosphere } from './rock.ts'
import { addStrip, addTube, cross, linearColor, normalize, pushVertex, type MeshArrays, type Vec3 } from './tube-mesh.ts'

/** Points along a quadratic Bézier. */
export function bezier(a: Vec3, b: Vec3, c: Vec3, steps: number): Vec3[] {
  const out: Vec3[] = []
  for (let k = 0; k <= steps; k++) {
    const t = k / steps
    const u = 1 - t
    out.push([u * u * a[0] + 2 * u * t * b[0] + t * t * c[0], u * u * a[1] + 2 * u * t * b[1] + t * t * c[1], u * u * a[2] + 2 * u * t * b[2] + t * t * c[2]])
  }
  return out
}

/** A drooping curve from `start` in direction `dir`: each step bends down by `droop`. */
function arch(start: Vec3, dir: Vec3, length: number, droop: number, steps: number): Vec3[] {
  const pts: Vec3[] = [start]
  let d = normalize(dir)
  const step = length / steps
  for (let k = 0; k < steps; k++) {
    const p = pts[pts.length - 1]
    pts.push([p[0] + d[0] * step, p[1] + d[1] * step, p[2] + d[2] * step])
    d = normalize([d[0], d[1] - droop * step / Math.max(length, 1e-3) * 3, d[2]])
  }
  return pts
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5))

/** Detail-scaled segment count, at least `min`. */
const segs = (n: number, detail: number, min = 3) => Math.max(min, Math.round(n * (0.4 + 0.6 * detail)))

/** Palm: a curved, ringed trunk and a crown of arching pinnate fronds. */
export function generatePalm(p: TreeParams, rand: () => number, detail: number, trunk: MeshArrays, leaves: MeshArrays): void {
  const lean = p.trunkLean * (0.4 + 0.6 * rand())
  const az = rand() * Math.PI * 2
  const top: Vec3 = [Math.sin(lean) * Math.cos(az) * p.height, p.height * Math.cos(lean * 0.6), Math.sin(lean) * Math.sin(az) * p.height]
  const mid: Vec3 = [top[0] * 0.25, p.height * 0.5, top[2] * 0.25]
  const steps = Math.max(6, Math.round((p.height / 0.35) * detail))
  const pts = bezier([0, -0.3, 0], mid, top, steps)
  const radii = pts.map((_, k) => {
    const t = k / steps
    return p.baseRadius * (1.25 - 0.4 * t) * (1 + 0.07 * Math.sin(t * p.height * 9)) * (k === 0 ? 1.3 : 1)
  })
  addTube(trunk, pts, radii, { segments: segs(p.radialSegments, detail), color: linearColor(p.barkColor), shade: (k) => 0.75 + 0.25 * (k / steps) })

  const fronds = Math.max(3, Math.round(p.leafDensity * (0.5 + 0.5 * detail)))
  const color = linearColor(p.leafColor)
  for (let f = 0; f < fronds; f++) {
    const a = f * GOLDEN + rand() * 0.3
    const age = f / fronds
    const elevation = 0.95 - age * 1.35 + (rand() - 0.5) * 0.2
    const dir: Vec3 = [Math.cos(a) * Math.cos(elevation), Math.sin(elevation), Math.sin(a) * Math.cos(elevation)]
    const length = p.leafSize * (0.75 + 0.25 * rand())
    const vary = 1 + (rand() * 2 - 1) * p.leafColorVariation
    const tint = 1 - age * 0.25 // older, lower fronds are darker
    addStrip(leaves, arch(top, dir, length, 0.6 + age, Math.max(4, Math.round(10 * detail))), {
      width: (v) => length * 0.42 * Math.sin(Math.PI * Math.min(1, v * 0.9 + 0.08)),
      color: [color[0] * vary * tint, color[1] * vary * tint, color[2] * vary * tint],
      fold: 0.3,
      card: rand(),
    })
  }
}

/** Saguaro-style cactus: a ribbed column with rounded tops and `stems` upturned arms. */
export function generateCactus(p: TreeParams, rand: () => number, detail: number, trunk: MeshArrays): void {
  const color = linearColor(p.barkColor)
  const ribs = 12
  const rib = (_k: number, theta: number) => 1 + 0.08 * Math.cos(theta * ribs)
  const segments = segs(p.radialSegments, detail, 8)
  const column = (pts: Vec3[], r: number) => {
    // Round the top off with a few shrinking rings.
    const last = pts[pts.length - 1]
    const capped = pts.slice(0, -1)
    const radii = capped.map(() => r)
    for (let k = 0; k <= 4; k++) {
      const a = (k / 4) * (Math.PI / 2)
      capped.push([last[0], last[1] - r + Math.sin(a) * r, last[2]])
      radii.push(Math.max(r * Math.cos(a), 1e-3))
    }
    addTube(trunk, capped, radii, { segments, color, shape: rib, shade: (_k, q) => 0.8 + 0.2 * Math.min(1, q[1] / p.height) })
  }
  const steps = Math.max(4, Math.round(p.height / 0.5))
  column(Array.from({ length: steps + 1 }, (_, k) => [0, -0.3 + (k / steps) * (p.height + 0.3), 0] as Vec3), p.baseRadius)
  for (let s = 0; s < Math.round(p.stems); s++) {
    const a = (s / Math.max(1, p.stems)) * Math.PI * 2 + rand() * 1.5
    const h = p.height * (0.3 + 0.3 * rand())
    const out = p.baseRadius * (2 + rand())
    const up = p.height * (0.2 + 0.25 * rand())
    const dx = Math.cos(a)
    const dz = Math.sin(a)
    const pts: Vec3[] = []
    for (let k = 0; k <= 8; k++) {
      const t = k / 8
      const angle = t * Math.PI / 2
      pts.push([dx * out * Math.sin(angle), h + out * (1 - Math.cos(angle)) * 0.9, dz * out * Math.sin(angle)])
    }
    const elbow = pts[pts.length - 1]
    for (let k = 1; k <= 4; k++) pts.push([elbow[0], elbow[1] + (up * k) / 4, elbow[2]])
    column(pts, p.baseRadius * 0.72)
  }
}

/** Fern: a rosette of arching fronds around a small stub. */
export function generateFern(p: TreeParams, rand: () => number, detail: number, trunk: MeshArrays, leaves: MeshArrays): void {
  addTube(trunk, [[0, -0.05, 0], [0, 0.06, 0]], [p.baseRadius * 4, p.baseRadius * 2], { segments: 4, color: linearColor(p.barkColor), closeEnd: true })
  const fronds = Math.max(3, Math.round(p.leafDensity * (0.5 + 0.5 * detail)))
  const color = linearColor(p.leafColor)
  for (let f = 0; f < fronds; f++) {
    const a = f * GOLDEN + rand() * 0.4
    const elevation = 0.75 + rand() * 0.45
    const dir: Vec3 = [Math.cos(a) * Math.cos(elevation), Math.sin(elevation), Math.sin(a) * Math.cos(elevation)]
    const length = p.leafSize * (0.7 + 0.3 * rand()) * (p.height / 0.9)
    const vary = 1 + (rand() * 2 - 1) * p.leafColorVariation
    addStrip(leaves, arch([0, 0.04, 0], dir, length, 0.7, Math.max(4, Math.round(8 * detail))), {
      width: () => length * 0.42,
      color: [color[0] * vary, color[1] * vary, color[2] * vary],
      fold: 0.2,
      card: rand(),
    })
  }
}

/** Reeds: a clump of thin stalks (some with cattail heads) and long arching blades. */
export function generateReed(p: TreeParams, rand: () => number, detail: number, trunk: MeshArrays, leaves: MeshArrays): void {
  const stem = linearColor(p.barkColor)
  const head = linearColor('#4a3222')
  const color = linearColor(p.leafColor)
  const stalks = Math.max(1, Math.round(p.stems * (0.5 + 0.5 * detail)))
  for (let s = 0; s < stalks; s++) {
    const a = rand() * Math.PI * 2
    const r = Math.sqrt(rand()) * 0.35
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    const h = p.height * (0.7 + 0.35 * rand())
    const tilt: Vec3 = [x * 0.25 + (rand() - 0.5) * 0.15, 1, z * 0.25 + (rand() - 0.5) * 0.15]
    const top: Vec3 = [x + tilt[0] * h, h, z + tilt[2] * h]
    addTube(trunk, [[x, -0.1, z], [(x + top[0]) / 2, h / 2, (z + top[2]) / 2], top], [p.baseRadius, p.baseRadius * 0.8, p.baseRadius * 0.3], { segments: 3, color: stem })
    if (rand() < 0.5) {
      const at = (t: number): Vec3 => [x + tilt[0] * h * t, h * t, z + tilt[2] * h * t]
      addTube(trunk, [at(0.76), at(0.78), at(0.9), at(0.92)], [p.baseRadius, p.baseRadius * 3.5, p.baseRadius * 3.5, p.baseRadius], { segments: 5, color: head })
    }
    const blades = Math.max(1, Math.round(p.leafDensity))
    for (let b = 0; b < blades; b++) {
      const ba = a + (rand() - 0.5) * 2.5
      const length = p.leafSize * (0.6 + 0.4 * rand())
      const dir: Vec3 = [Math.cos(ba) * 0.35, 1, Math.sin(ba) * 0.35]
      const vary = 1 + (rand() * 2 - 1) * p.leafColorVariation
      addStrip(leaves, arch([x, 0, z], dir, length, 0.5 + rand() * 0.6, Math.max(3, Math.round(6 * detail))), {
        width: (v) => length * 0.08 * (1 - v * 0.5),
        color: [color[0] * vary, color[1] * vary, color[2] * vary],
        fold: 0.4,
        card: rand(),
      })
    }
  }
}

const FRUIT_SPHERE = icosphere(1)

/** Appends a small low-poly sphere (an apple, a berry). */
export function addFruit(out: MeshArrays, center: Vec3, radius: number, color: Vec3, card: number): void {
  const base = out.positions.length / 3
  const p = FRUIT_SPHERE.positions
  for (let i = 0; i < p.length; i += 3) {
    // Slightly squashed, like most fruit.
    const shade = 0.75 + 0.25 * Math.max(0, p[i + 1]) // lighter on top
    pushVertex(out, center[0] + p[i] * radius, center[1] + p[i + 1] * radius * 0.9, center[2] + p[i + 2] * radius, p[i], p[i + 1], p[i + 2],
      0.5 + p[i] * 0.5, 0.5 + p[i + 1] * 0.5, color[0] * shade, color[1] * shade, color[2] * shade, card)
  }
  const idx = FRUIT_SPHERE.indices
  for (let i = 0; i < idx.length; i += 3) out.indices.push3(base + idx[i], base + idx[i + 1], base + idx[i + 2])
}

/**
 * Appends a flower head facing `up`: `petals` rounded petals around a centre disc, cupped upward by `cup` (0 = flat).
 * Petals take `color`; the centre is golden.
 */
export function addFlowerHead(out: MeshArrays, center: Vec3, up: Vec3, radius: number, color: Vec3, petals: number, cup: number, card: number): void {
  const n = normalize(up)
  const t = normalize(Math.abs(n[1]) < 0.9 ? cross(n, [0, 1, 0]) : cross(n, [1, 0, 0]))
  const b = cross(n, t)
  const disc: Vec3 = linearColor('#d6a21e')
  const at = (r: number, a: number, lift: number): Vec3 => {
    const c = Math.cos(a) * r
    const s = Math.sin(a) * r
    return [center[0] + t[0] * c + b[0] * s + n[0] * lift, center[1] + t[1] * c + b[1] * s + n[1] * lift, center[2] + t[2] * c + b[2] * s + n[2] * lift]
  }
  const push = (pos: Vec3, col: Vec3) => {
    pushVertex(out, pos[0], pos[1], pos[2], n[0], n[1], n[2], 0.5, 0.5, col[0], col[1], col[2], card)
    return out.positions.length / 3 - 1
  }
  const mid = push(at(0, 0, radius * 0.08), disc)
  for (let k = 0; k < petals; k++) {
    const a = (k / petals) * Math.PI * 2
    const w = Math.PI / petals
    // Each petal: a fan of three triangles from the centre, widest two thirds out.
    const i0 = push(at(radius * 0.18, a - w * 0.5, 0), color)
    const i1 = push(at(radius * 0.7, a - w * 0.9, radius * cup * 0.5), color)
    const i2 = push(at(radius, a, radius * cup), color.map((c) => c * 1.08) as Vec3)
    const i3 = push(at(radius * 0.7, a + w * 0.9, radius * cup * 0.5), color)
    const i4 = push(at(radius * 0.18, a + w * 0.5, 0), color)
    out.indices.push3(mid, i0, i1)
    out.indices.push3(mid, i1, i2)
    out.indices.push3(mid, i2, i3)
    out.indices.push3(mid, i3, i4)
  }
}

/** Picks a palette colour (linear) with a little brightness variation. */
function pick(colors: string[], rand: () => number): Vec3 {
  const c = linearColor(colors[Math.floor(rand() * colors.length) % colors.length] ?? '#ffffff')
  const v = 0.9 + 0.2 * rand()
  return [c[0] * v, c[1] * v, c[2] * v]
}

/** Wildflowers: a few thin stalks with grassy leaves and seeded flower heads. */
export function generateFlowers(p: TreeParams, rand: () => number, detail: number, trunk: MeshArrays, leaves: MeshArrays, fruit: MeshArrays): void {
  const stem = linearColor(p.barkColor)
  const leaf = linearColor(p.leafColor)
  const stalks = Math.max(1, Math.round(p.stems * (0.5 + 0.5 * detail)))
  for (let s = 0; s < stalks; s++) {
    const a = rand() * Math.PI * 2
    const r = Math.sqrt(rand()) * 0.12
    const base: Vec3 = [Math.cos(a) * r, -0.02, Math.sin(a) * r]
    const h = p.height * (0.6 + 0.4 * rand())
    const lean: Vec3 = [Math.cos(a) * 0.25 + (rand() - 0.5) * 0.3, 1, Math.sin(a) * 0.25 + (rand() - 0.5) * 0.3]
    const pts = arch(base, lean, h, 0.15, 4)
    addTube(trunk, pts, pts.map((_, k) => p.baseRadius * (1 - k * 0.12)), { segments: 3, color: stem, card: rand() })
    if (rand() < p.fruit) {
      const top = pts[pts.length - 1]
      addFlowerHead(fruit, top, [lean[0] * 0.6, 1, lean[2] * 0.6], p.fruitSize * (0.7 + 0.5 * rand()), pick(p.fruitColors, rand), 5 + Math.floor(rand() * 4), 0.25, rand())
    }
    for (let b = 0; b < Math.round(p.leafDensity); b++) {
      const ba = rand() * Math.PI * 2
      const length = p.leafSize * (0.6 + 0.4 * rand())
      addStrip(leaves, arch(base, [Math.cos(ba) * 0.5, 1, Math.sin(ba) * 0.5], length, 0.8, 4), { width: () => length * 0.1, color: leaf, fold: 0.4, card: rand() })
    }
  }
}

/** A tuft of tall grass: blades fanning out from one root. */
export function generateTuft(p: TreeParams, rand: () => number, detail: number, trunk: MeshArrays, leaves: MeshArrays): void {
  addTube(trunk, [[0, -0.05, 0], [0, 0.04, 0]], [p.baseRadius * 4, p.baseRadius * 3], { segments: 4, color: linearColor(p.barkColor), closeEnd: true })
  const color = linearColor(p.leafColor)
  const blades = Math.max(3, Math.round(p.leafDensity * (0.4 + 0.6 * detail)))
  for (let b = 0; b < blades; b++) {
    const a = rand() * Math.PI * 2
    const spread = 0.15 + rand() * 0.5
    const length = p.leafSize * (0.55 + 0.45 * rand()) * (p.height / 0.9)
    const vary = 1 + (rand() * 2 - 1) * p.leafColorVariation
    const dry = rand() < 0.15 ? 1.25 : 1 // a few straw-coloured blades
    addStrip(leaves, arch([Math.cos(a) * 0.04, 0, Math.sin(a) * 0.04], [Math.cos(a) * spread, 1, Math.sin(a) * spread], length, 0.4 + rand() * 0.8, Math.max(3, Math.round(5 * detail))), {
      width: (v) => length * 0.035 * (1 - v * 0.6),
      color: [color[0] * vary * dry, color[1] * vary, color[2] * vary * (2 - dry)],
      fold: 0.5,
      card: rand(),
    })
  }
}

/** A succulent rosette (echeveria / agave): thick pointed leaves spiralling out from the centre. */
export function generateSucculent(p: TreeParams, rand: () => number, detail: number, trunk: MeshArrays): void {
  const color = linearColor(p.barkColor)
  const count = Math.max(5, Math.round(p.leafDensity * (0.5 + 0.5 * detail)))
  for (let k = 0; k < count; k++) {
    const age = 1 - k / count // outer leaves are older: longer and flatter
    const a = k * GOLDEN
    const elevation = 0.25 + (1 - age) * 1.0
    const dir: Vec3 = [Math.cos(a) * Math.cos(elevation), Math.sin(elevation), Math.sin(a) * Math.cos(elevation)]
    const length = p.leafSize * (0.45 + 0.55 * age) * (p.height / 0.3)
    const pts = arch([0, 0.02 + (1 - age) * 0.03, 0], dir, length, 0.15, 5)
    const thick = p.baseRadius * (0.7 + 0.6 * age) * (p.height / 0.3)
    const radii = pts.map((_, i) => thick * Math.sin(Math.PI * Math.min(0.98, 0.25 + (i / (pts.length - 1)) * 0.75)))
    const tint = 0.85 + 0.25 * (1 - age)
    addTube(trunk, pts, radii, {
      segments: segs(p.radialSegments, detail, 4),
      color: [color[0] * tint, color[1] * tint, color[2] * tint],
      // Flattened, keeled cross-section.
      shape: (_i, theta) => 0.55 + 0.45 * Math.abs(Math.cos(theta)),
      closeEnd: true,
      card: rand(),
    })
  }
}

/** A bamboo clump: straight segmented culms with node rings and sprays of slender leaves up top. */
export function generateBamboo(p: TreeParams, rand: () => number, detail: number, trunk: MeshArrays, leaves: MeshArrays): void {
  const culm = linearColor(p.barkColor)
  const leaf = linearColor(p.leafColor)
  const culms = Math.max(1, Math.round(p.stems * (0.5 + 0.5 * detail)))
  for (let c = 0; c < culms; c++) {
    const a = rand() * Math.PI * 2
    const r = Math.sqrt(rand()) * 0.9
    const base: Vec3 = [Math.cos(a) * r, -0.2, Math.sin(a) * r]
    const h = p.height * (0.6 + 0.4 * rand())
    const lean: Vec3 = [Math.cos(a) * 0.08 + (rand() - 0.5) * 0.06, 1, Math.sin(a) * 0.08 + (rand() - 0.5) * 0.06]
    const pts = arch(base, lean, h, 0.25, Math.max(8, Math.round((h / 0.3) * detail)))
    const nodeEvery = 0.35 + rand() * 0.15
    const radius = p.baseRadius * (0.7 + 0.5 * rand())
    let along = 0
    const radii = pts.map((q, i) => {
      if (i) along += Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1], q[2] - pts[i - 1][2])
      const ring = Math.abs(((along / nodeEvery) % 1) - 0.5) > 0.44 ? 1.12 : 1 // swollen nodes
      return radius * (1 - 0.5 * (i / pts.length)) * ring
    })
    const tint = 0.85 + 0.3 * rand()
    addTube(trunk, pts, radii, { segments: segs(p.radialSegments, detail), color: [culm[0] * tint, culm[1] * tint, culm[2] * tint], closeEnd: true, card: rand() })
    // Leaf sprays along the upper half.
    for (let i = Math.floor(pts.length * 0.45); i < pts.length; i++) {
      for (let k = 0; k < Math.round(p.leafDensity * (0.4 + 0.6 * detail)); k++) {
        if (rand() > 0.5) continue
        const la = rand() * Math.PI * 2
        const length = p.leafSize * (0.7 + 0.5 * rand())
        addStrip(leaves, arch(pts[i], [Math.cos(la), 0.3 + rand() * 0.4, Math.sin(la)], length, 1.2, 3), {
          width: (v) => length * 0.16 * Math.sin(Math.PI * Math.min(1, v * 0.85 + 0.15)),
          color: leaf,
          fold: 0.3,
          card: rand(),
        })
      }
    }
  }
}

/** Water lilies: flat notched pads floating at y = 0, a few with cupped flowers. */
export function generateLilyPads(p: TreeParams, rand: () => number, detail: number, trunk: MeshArrays, fruit: MeshArrays): void {
  const color = linearColor(p.barkColor)
  const pads = Math.max(1, Math.round(p.leafDensity))
  const sides = Math.max(8, Math.round(20 * detail))
  for (let k = 0; k < pads; k++) {
    const a = rand() * Math.PI * 2
    const d = Math.sqrt(rand()) * p.leafSize * 1.6
    const c: Vec3 = [Math.cos(a) * d, 0.01 + rand() * 0.01, Math.sin(a) * d]
    const radius = (p.leafSize / 2) * (0.6 + 0.4 * rand())
    const notch = rand() * Math.PI * 2
    const tint = 0.85 + 0.3 * rand()
    const col: Vec3 = [color[0] * tint, color[1] * tint, color[2] * tint]
    const card = rand()
    const base = trunk.positions.length / 3
    pushVertex(trunk, c[0], c[1], c[2], 0, 1, 0, 0.5, 0.5, col[0] * 0.8, col[1] * 0.8, col[2] * 0.8, card)
    // The pad is a disc with a wedge cut out towards the centre (the notch).
    for (let s = 0; s <= sides; s++) {
      const t = notch + 0.25 + (s / sides) * (Math.PI * 2 - 0.5)
      const rim = radius * (1 + 0.04 * Math.sin(t * 7))
      pushVertex(trunk, c[0] + Math.cos(t) * rim, c[1] + 0.005, c[2] + Math.sin(t) * rim, 0, 1, 0, 0.5 + Math.cos(t) * 0.5, 0.5 + Math.sin(t) * 0.5, col[0], col[1], col[2], card)
      if (s) trunk.indices.push3(base, base + s + 1, base + s)
    }
    if (rand() < p.fruit) {
      addFlowerHead(fruit, [c[0] + radius * 0.2, c[1] + 0.03, c[2]], [0, 1, 0], p.fruitSize * (0.8 + 0.4 * rand()), pick(p.fruitColors, rand), 12, 0.9, rand())
    }
  }
}
