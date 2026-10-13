// Pure CPU side of the wildfire look: which cells feed flames, smoke and embers (and how much), the
// ground glow, and a Gaussian-plume estimate of how much the smoke dims the sun. No GPU, unit-tested.
import { SOURCE_STRIDE } from 'threejs-particles'
import { FIRE_STATE, type FireSim } from './fire-sim.ts'

/** What {@link collectFireSources} needs of the look. */
export interface FireFrontLook {
  /** Seconds the flaming front lasts in a cell with 1 kg/m² of fuel (scaled by `0.5 + load / 2`). */
  flaming: number
  /** Tree flames spawn up to this high (crown fire), metres. */
  crownHeight: number
  /** Seconds burnt-out cells keep giving off wisps of smoke. */
  linger: number
  /** Ground glow at the front, 0…1. */
  frontGlow: number
  /** Sparse smouldering glow inside the burn, 0…1. */
  smoulderGlow: number
}

/** Spawn sources and per-cell data for one frame of a fire (see {@link collectFireSources}). */
export interface FireSources {
  /** Flame sources, `SOURCE_STRIDE` floats each (x, y, z local to the grid's min corner, weight, size scale, lift, tint, temperature scale). */
  flames: Float32Array
  /** Flame sources in use. */
  flameCount: number
  /** Smoke sources (tint: 0 white … 1 dark brown). */
  smoke: Float32Array
  /** Smoke sources in use. */
  smokeCount: number
  /** Ember sources. */
  embers: Float32Array
  /** Ember sources in use. */
  emberCount: number
  /** Per cell RGBA bytes: glow, burn scar, ash share, front. */
  texture: Uint8Array
  /** Sum of flame weights (front intensity). */
  front: number
  /** Front-weighted centre (local x, elevation, local z), valid when `front > 0`. */
  center: [number, number, number]
  /** Front-weighted wind `[x, z]`, m/s. */
  wind: [number, number]
  /** Sum of smoke weights. */
  smokeTotal: number
}

/** Empty buffers for a sim of `cells` cells. */
export function createFireSources(cells: number): FireSources {
  return {
    flames: new Float32Array(cells * SOURCE_STRIDE), flameCount: 0, smoke: new Float32Array(cells * 2 * SOURCE_STRIDE), smokeCount: 0,
    embers: new Float32Array(cells * SOURCE_STRIDE), emberCount: 0, texture: new Uint8Array(cells * 4), front: 0, center: [0, 0, 0], wind: [0, 0], smokeTotal: 0,
  }
}

/**
 * Front intensity 0…1 of a burning cell: a short flaming phase right after ignition (longer for heavy
 * fuel), then smouldering. `age` is seconds since ignition, `load` the cell's fuel, kg/m².
 */
export function frontIntensity(age: number, load: number, flaming: number): number {
  if (!(age >= 0) || !Number.isFinite(age)) return 0
  // Flaming lasts tens of seconds (longer in heavy fuel), then the cell only smoulders: a Gaussian
  // fall-off keeps the flaming band to rate-of-spread × residence, tens of metres deep.
  const duration = Math.max(1, flaming * (0.5 + Math.min(load, 4) / 2))
  const strength = Math.min(1, 0.35 + load / 3)
  const x = age / duration
  return strength * Math.min(1, (age + 2) / 6) * Math.exp(-x * x)
}

/**
 * Picks this frame's sources from the sim: flames and embers only from the active front (recently
 * ignited cells, by intensity), smoke from the front (dark for heavy woody fuel, white for wet or light
 * fuel) plus faint wisps from smouldering and freshly burnt cells. Writes the per-cell texture too.
 * Deterministic: depends only on the sim state.
 */
export function collectFireSources(sim: FireSim, look: FireFrontLook, out: FireSources): FireSources {
  const n = sim.cols * sim.rows
  const S = SOURCE_STRIDE
  if (out.texture.length !== n * 4) Object.assign(out, createFireSources(n))
  let nf = 0, ns = 0, ne = 0, front = 0, smokeTotal = 0, cx = 0, cy = 0, cz = 0, wx = 0, wz = 0
  const tex = out.texture
  const ext = sim.options.moistureOfExtinction
  const put = (arr: Float32Array, k: number, x: number, y: number, z: number, w: number, a: number, b: number, c: number, d: number) => {
    const o = k * S
    arr[o] = x; arr[o + 1] = y; arr[o + 2] = z; arr[o + 3] = w; arr[o + 4] = a; arr[o + 5] = b; arr[o + 6] = c; arr[o + 7] = d
  }
  for (let i = 0; i < n; i++) {
    const state = sim.state[i]
    const g = sim.capacity[i * 3], s = sim.capacity[i * 3 + 1], t = sim.capacity[i * 3 + 2]
    const load = g + s + t
    const woody = load > 0 ? (s + t) / load : 0
    const tree = load > 0 ? t / load : 0
    const fuelLeft = sim.fuel[i * 3] + sim.fuel[i * 3 + 1] + sim.fuel[i * 3 + 2]
    // Heavy fuel burnt right through leaves white-grey ash; light or wet fuel leaves black char.
    const ash = state === FIRE_STATE.unburnt ? 0 : smooth(0.4, 3, load - fuelLeft)
    let glow = 0, f = 0
    if (state === FIRE_STATE.burning) {
      const age = sim.burningFor(i)
      f = frontIntensity(age, load, look.flaming)
      const smoulder = f < 0.1 ? sim.heat(i) : 0
      // Smouldering glows only in sparse spots (logs, stumps), never as a sheet.
      const spot = cellHash(i, sim.cols) < 0.18 ? 0.5 + cellHash(i + 7919, sim.cols) : 0
      glow = Math.min(1, f * look.frontGlow + smoulder * spot * look.smoulderGlow)
      const [x0, z0] = sim.center(i)
      const lx = x0 - sim.minX, lz = z0 - sim.minZ, y = sim.elevation[i]
      const wet = Math.min(1, sim.moisture[i] / Math.max(1e-3, ext))
      if (f > 0.05) {
        const scale = 1 + 0.8 * (woody - tree) + 2.6 * tree
        put(out.flames, nf++, lx, y, lz, f * (0.6 + 0.4 * Math.min(1, load)), scale, tree * look.crownHeight, 0, 0.92 + 0.12 * f)
        put(out.embers, ne++, lx, y, lz, f * (0.15 + 0.6 * woody + 1.2 * tree), 1, tree * look.crownHeight, 0, 1)
        const w = f * (0.4 + 0.3 * Math.min(4, load))
        put(out.smoke, ns++, lx, y + 1 + tree * look.crownHeight * 0.5, lz, w, 1 + tree, 0, Math.min(1, woody * 0.9 + 0.1) * (1 - 0.6 * wet), 0.9 + 0.2 * f)
        smokeTotal += w
        front += f
        cx += lx * f; cy += y * f; cz += lz * f
        const [vx, vz] = sim.windAt(i)
        wx += vx * f; wz += vz * f
      } else if (smoulder > 0.02) {
        put(out.smoke, ns++, lx, y + 0.5, lz, 0.02 * smoulder, 1.1, 0, 0.35, 0.75)
        smokeTotal += 0.02 * smoulder
      }
    } else if (state === FIRE_STATE.burnt) {
      const age = sim.burntAge(i)
      if (age < look.linger) {
        const [x0, z0] = sim.center(i)
        const w = 0.008 * (1 - age / look.linger)
        put(out.smoke, ns++, x0 - sim.minX, sim.elevation[i] + 0.3, z0 - sim.minZ, w, 1, 0, 0.3, 0.7)
        smokeTotal += w
      }
    }
    tex[i * 4] = Math.round(glow * 255)
    tex[i * 4 + 1] = Math.round(sim.scar(i) * 255)
    tex[i * 4 + 2] = Math.round(ash * 255)
    tex[i * 4 + 3] = Math.round(Math.min(1, f) * 255)
  }
  out.flameCount = nf; out.smokeCount = ns; out.emberCount = ne
  out.front = front; out.smokeTotal = smokeTotal
  if (front > 0) { out.center = [cx / front, cy / front, cz / front]; out.wind = [wx / front, wz / front] }
  return out
}

/**
 * How much a smoke plume dims the sun at a ground point, 0…1: a Gaussian plume from a source of
 * `strength` (sum of smoke weights) at (`sx`, `sz`), carried by wind (`wx`, `wz`), widening downwind.
 * Exposed as {@link Wildfire.smokeOcclusionAt}; cheap enough to call per frame.
 */
export function plumeOcclusion(x: number, z: number, sx: number, sz: number, wx: number, wz: number, strength: number, extinction = 0.0015): number {
  if (!(strength > 0)) return 0
  const u = Math.max(1, Math.hypot(wx, wz))
  const dx = wx / u, dz = wz / u
  const px = x - sx, pz = z - sz
  const along = px * dx + pz * dz
  const across = -px * dz + pz * dx
  const down = Math.max(0, along)
  const sigma = 40 + 0.22 * down
  // Upwind of the source the column is only as wide as the fire.
  const upwind = along < 0 ? Math.exp(-(along * along) / (2 * 60 * 60)) : 1
  const column = (strength / (u * sigma)) * Math.exp(-(across * across) / (2 * sigma * sigma)) * Math.exp(-down / 6000) * upwind
  return 1 - Math.exp(-extinction * column * 100)
}

/** Sunlight transmittance through smoke of occlusion `o` per channel (blue lost first: the sun reddens). */
export function smokeTransmittance(o: number, out: [number, number, number] = [1, 1, 1]): [number, number, number] {
  const tau = -Math.log(Math.max(1e-4, 1 - Math.min(0.9999, Math.max(0, o))))
  out[0] = Math.exp(-tau * 0.75); out[1] = Math.exp(-tau * 1.0); out[2] = Math.exp(-tau * 1.45)
  return out
}

/** Deterministic 0…1 per cell. */
function cellHash(i: number, salt: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt, 0xc2b2ae35)
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2d)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
