/**
 * Deterministic boids: separation, alignment, cohesion, wander, a home leash, a vertical band to stay
 * inside (between the riverbed and the water surface for fish, between two heights above the ground
 * for birds), look-ahead obstacle avoidance and predators. Fixed time step, seeded, pure JS in float64:
 * the same seed, start and step count give the same flock on every machine.
 */
import { mulberry32 } from 'threejs-biomes'

/** Steering weights and limits of a flock. All plain numbers (JSON). */
export interface BoidParams {
  /** Weight of steering away from close neighbours. */
  separation: number
  /** Weight of matching the neighbours' velocity. */
  alignment: number
  /** Weight of steering towards the neighbours' centre. */
  cohesion: number
  /** Weight of the random-walk wander force. */
  wander: number
  /** How fast the wander heading drifts, radians per second. */
  wanderRate: number
  /** Neighbours closer than this (metres) count for alignment and cohesion. */
  neighborRadius: number
  /** Neighbours closer than this (metres) push each other apart. */
  separationDistance: number
  /** Hard minimum distance between two members (metres), enforced after every step. 0 = off. */
  minDistance: number
  /** Slowest speed, m/s. */
  minSpeed: number
  /** Fastest speed, m/s. */
  maxSpeed: number
  /** Largest acceleration, m/s². */
  maxAccel: number
  /** Members past this distance (metres, horizontal) from home are pulled back. */
  homeRadius: number
  /** Strength of the pull back home. */
  homeStrength: number
  /** Distance (metres) members keep from the floor and the top of their band. */
  margin: number
  /** Strength of the push away from the floor, the top and obstacles. */
  avoid: number
  /** Seconds of travel probed ahead for obstacles (dry land, shallows, cliffs). */
  lookAhead: number
  /** 0…1: how strongly vertical motion is damped (fish and birds mostly move level). */
  verticalDamping: number
  /** Strength of fleeing from predators. */
  flee: number
}

/** Default boid weights (a loose fish school, scaled for ~0.3 m fish). */
export const DEFAULT_BOIDS: BoidParams = {
  separation: 2.2,
  alignment: 1.1,
  cohesion: 0.7,
  wander: 0.6,
  wanderRate: 1.5,
  neighborRadius: 1.6,
  separationDistance: 0.45,
  minDistance: 0.2,
  minSpeed: 0.15,
  maxSpeed: 1.2,
  maxAccel: 2.5,
  homeRadius: 12,
  homeStrength: 1.5,
  margin: 0.3,
  avoid: 4,
  lookAhead: 1.2,
  verticalDamping: 0.6,
  flee: 6,
}

/** Something flocks flee from: a position (in the flock's coordinates) and a radius of fear. */
export interface PredatorPoint {
  /** Position, metres. */
  x: number
  /** Position, metres. */
  y: number
  /** Position, metres. */
  z: number
  /** Members inside this distance flee. */
  radius: number
}

/** The usable band at a horizontal position. */
export interface Band {
  /** Lowest usable height. */
  floor: number
  /** Highest usable height. */
  top: number
}

/** Where a flock may be: a usable vertical band per horizontal position, or none (an obstacle). */
export interface Environment {
  /** Fills `out` and returns `true` where (x, z) is usable; returns `false` for obstacles. */
  band(x: number, z: number, out: Band): boolean
}

/** No obstacles; one band everywhere. Handy for tests and open sky. */
export class OpenEnvironment implements Environment {
  /** Lowest usable height. */
  floor: number
  /** Highest usable height. */
  top: number
  /** Creates an environment with the same band (`floor` … `top`) everywhere. */
  constructor(floor = -Infinity, top = Infinity) {
    this.floor = floor
    this.top = top
  }
  /** Always usable. */
  band(_x: number, _z: number, out: Band): boolean {
    out.floor = this.floor
    out.top = this.top
    return true
  }
}

/**
 * A usable band sampled on a small square grid (e.g. riverbed and water surface around a school's
 * home). Conservative: each cell's floor is the highest of its four corners, its top the lowest, and a
 * cell is usable only if all four corners are and the band is at least `minThickness` thick. Outside the
 * grid is an obstacle, so flocks never wander off what was sampled.
 */
export class GridEnvironment implements Environment {
  /** World x of the grid's first corner. */
  readonly x0: number
  /** World z of the grid's first corner. */
  readonly z0: number
  /** Cell size, metres. */
  readonly cell: number
  /** Cells per side. */
  readonly cells: number
  /** Per-cell floor (row-major, z then x). NaN = obstacle. */
  readonly floor: Float64Array
  /** Per-cell top. */
  readonly top: Float64Array

  /**
   * Builds the conservative per-cell bands from per-sample floors and tops.
   * @param x0 World x of the grid's first corner.
   * @param z0 World z of the grid's first corner.
   * @param cell Cell size, metres.
   * @param n Samples per side (cells per side + 1).
   * @param floors Floor at each sample (row-major, `n × n`); NaN where unusable.
   * @param tops Top at each sample; NaN where unusable.
   * @param minThickness Thinnest usable band.
   */
  constructor(x0: number, z0: number, cell: number, n: number, floors: ArrayLike<number>, tops: ArrayLike<number>, minThickness: number) {
    this.x0 = x0
    this.z0 = z0
    this.cell = cell
    const c = (this.cells = n - 1)
    this.floor = new Float64Array(c * c)
    this.top = new Float64Array(c * c)
    for (let j = 0; j < c; j++) {
      for (let i = 0; i < c; i++) {
        const k = [j * n + i, j * n + i + 1, (j + 1) * n + i, (j + 1) * n + i + 1]
        let f = -Infinity, t = Infinity
        for (const q of k) {
          f = Math.max(f, floors[q])
          t = Math.min(t, tops[q])
        }
        const usable = t - f >= minThickness // NaN compares false
        this.floor[j * c + i] = usable ? f : NaN
        this.top[j * c + i] = usable ? t : NaN
      }
    }
  }

  /** Usable band of the cell containing (x, z). */
  band(x: number, z: number, out: Band): boolean {
    const i = Math.floor((x - this.x0) / this.cell)
    const j = Math.floor((z - this.z0) / this.cell)
    if (i < 0 || j < 0 || i >= this.cells || j >= this.cells) return false
    const f = this.floor[j * this.cells + i]
    if (f !== f) return false
    out.floor = f
    out.top = this.top[j * this.cells + i]
    return true
  }

  /** Number of usable cells. */
  usableCells(): number {
    let n = 0
    for (const f of this.floor) if (f === f) n++
    return n
  }
}

const _b: Band = { floor: 0, top: 0 }

/**
 * A flock (fish school, bird flock, herd) simulated with boids on the CPU. Positions and velocities
 * are float64 in whatever coordinates the environment uses (a world's local frame). Pure, seeded and
 * fixed-step: call {@link Flock.step} with the same `dt` and you get the same flock everywhere.
 *
 * O(n²) neighbour search per step.
 */
// ponytail: O(n²) neighbours, fine for schools of a few hundred; add a spatial hash for thousands.
export class Flock {
  /** Members. */
  readonly count: number
  /** Positions, xyz per member. */
  readonly position: Float64Array
  /** Velocities, xyz per member. */
  readonly velocity: Float64Array
  /** Wander heading per member, radians. */
  readonly heading: Float64Array
  /** Home position the flock is leashed to. */
  readonly home: [number, number, number]
  /** Steering parameters (may be changed between steps). */
  params: BoidParams
  /** Where the flock may be. */
  environment: Environment
  /** Steps taken so far. */
  steps = 0

  private readonly rand: () => number
  private readonly acc: Float64Array

  /**
   * Creates `count` members around `home`, each placed where the environment is usable (else at home),
   * swimming in random horizontal directions. Everything is drawn from `seed`.
   */
  constructor(seed: number, count: number, home: [number, number, number], params: BoidParams, environment: Environment, spread = params.separationDistance * Math.cbrt(count) * 1.5) {
    this.count = count
    this.home = [home[0], home[1], home[2]]
    this.params = params
    this.environment = environment
    this.rand = mulberry32(seed)
    this.position = new Float64Array(count * 3)
    this.velocity = new Float64Array(count * 3)
    this.heading = new Float64Array(count)
    this.acc = new Float64Array(count * 3)
    const r = this.rand
    const mainHeading = r() * Math.PI * 2
    for (let i = 0; i < count; i++) {
      let x = home[0], z = home[2]
      for (let tries = 0; tries < 6; tries++) {
        const a = r() * Math.PI * 2, d = Math.sqrt(r()) * spread
        const tx = home[0] + Math.cos(a) * d, tz = home[2] + Math.sin(a) * d
        if (environment.band(tx, tz, _b)) { x = tx; z = tz; break }
      }
      const y = home[1] + (r() - 0.5) * spread * 0.4
      this.position.set([x, y, z], i * 3)
      const h = mainHeading + (r() - 0.5) * 0.8
      const speed = (params.minSpeed + params.maxSpeed) * 0.5
      this.velocity.set([Math.cos(h) * speed, 0, Math.sin(h) * speed], i * 3)
      this.heading[i] = h
      this.clampVertical(i)
    }
  }

  /** Advances the flock by one fixed step of `dt` seconds. `predators` are fled from. */
  step(dt: number, predators: readonly PredatorPoint[] = []): void {
    const p = this.params, pos = this.position, vel = this.velocity, acc = this.acc, n = this.count
    const env = this.environment
    const nr2 = p.neighborRadius * p.neighborRadius
    const sd2 = p.separationDistance * p.separationDistance
    const r = this.rand

    for (let i = 0; i < n; i++) {
      const ix = pos[i * 3], iy = pos[i * 3 + 1], iz = pos[i * 3 + 2]
      let sx = 0, sy = 0, sz = 0, ax = 0, ay = 0, az = 0, cx = 0, cy = 0, cz = 0, k = 0
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        const dx = ix - pos[j * 3], dy = iy - pos[j * 3 + 1], dz = iz - pos[j * 3 + 2]
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 > nr2) continue
        if (d2 < sd2) {
          const w = 1 / Math.max(d2, 1e-6)
          sx += dx * w; sy += dy * w; sz += dz * w
        }
        ax += vel[j * 3]; ay += vel[j * 3 + 1]; az += vel[j * 3 + 2]
        cx += pos[j * 3]; cy += pos[j * 3 + 1]; cz += pos[j * 3 + 2]
        k++
      }
      let fx = sx * p.separation * p.separationDistance, fy = sy * p.separation * p.separationDistance, fz = sz * p.separation * p.separationDistance
      if (k > 0) {
        fx += (ax / k - vel[i * 3]) * p.alignment + (cx / k - ix) * p.cohesion
        fy += (ay / k - vel[i * 3 + 1]) * p.alignment + (cy / k - iy) * p.cohesion
        fz += (az / k - vel[i * 3 + 2]) * p.alignment + (cz / k - iz) * p.cohesion
      }
      // Wander: a slowly drifting preferred heading, drawn in a fixed order (deterministic).
      this.heading[i] += (r() - 0.5) * 2 * p.wanderRate * dt
      fx += Math.cos(this.heading[i]) * p.wander
      fz += Math.sin(this.heading[i]) * p.wander
      fy += (r() - 0.5) * p.wander * 0.3

      // Home leash.
      const hx = this.home[0] - ix, hz = this.home[2] - iz
      const hd = Math.hypot(hx, hz)
      if (hd > p.homeRadius * 0.6) {
        const s = (p.homeStrength * (hd / p.homeRadius - 0.6)) / hd
        fx += hx * s; fz += hz * s
      }

      // Vertical band: soft push inside the margins.
      if (env.band(ix, iz, _b)) {
        const lo = _b.floor + p.margin * 2, hi = _b.top - p.margin * 2
        if (lo < hi) {
          if (iy < lo) fy += p.avoid * Math.min(1, (lo - iy) / p.margin)
          else if (iy > hi) fy -= p.avoid * Math.min(1, (iy - hi) / p.margin)
        } else fy += p.avoid * Math.sign((_b.floor + _b.top) * 0.5 - iy)
      }
      // Look ahead: turn back towards home before reaching an obstacle.
      const px = ix + vel[i * 3] * p.lookAhead, pz = iz + vel[i * 3 + 2] * p.lookAhead
      if (!env.band(px, pz, _b) || iy < _b.floor + p.margin || iy > _b.top - p.margin) {
        const s = p.avoid / Math.max(hd, 1e-6)
        fx += hx * s; fz += hz * s
        // and away from the blocked direction
        fx -= vel[i * 3] * p.avoid * 0.5; fz -= vel[i * 3 + 2] * p.avoid * 0.5
      }

      for (const q of predators) {
        const dx = ix - q.x, dy = iy - q.y, dz = iz - q.z
        const d = Math.hypot(dx, dy, dz)
        if (d < q.radius && d > 1e-6) {
          const s = (p.flee * (1 - d / q.radius)) / d
          fx += dx * s; fy += dy * s * 0.5; fz += dz * s
        }
      }

      const fl = Math.hypot(fx, fy, fz)
      const lim = fl > p.maxAccel ? p.maxAccel / fl : 1
      acc[i * 3] = fx * lim; acc[i * 3 + 1] = fy * lim; acc[i * 3 + 2] = fz * lim
    }

    // Integrate (all accelerations were computed from the same state, so member order doesn't matter).
    for (let i = 0; i < n; i++) {
      let vx = vel[i * 3] + acc[i * 3] * dt
      let vy = (vel[i * 3 + 1] + acc[i * 3 + 1] * dt) * (1 - Math.min(1, p.verticalDamping * dt * 4))
      let vz = vel[i * 3 + 2] + acc[i * 3 + 2] * dt
      const s = Math.hypot(vx, vy, vz)
      const t = s > p.maxSpeed ? p.maxSpeed / s : s < p.minSpeed ? p.minSpeed / Math.max(s, 1e-9) : 1
      vx *= t; vy *= t; vz *= t
      const ox = pos[i * 3], oz = pos[i * 3 + 2]
      const nx = ox + vx * dt, nz = oz + vz * dt
      if (env.band(nx, nz, _b)) {
        pos[i * 3] = nx; pos[i * 3 + 2] = nz
      } else {
        // Hard wall: stay, and turn around.
        vx = -vx; vz = -vz
      }
      pos[i * 3 + 1] += vy * dt
      vel[i * 3] = vx; vel[i * 3 + 1] = vy; vel[i * 3 + 2] = vz
      this.clampVertical(i)
    }
    if (p.minDistance > 0) this.separate()
    this.steps++
  }

  /** Hard constraint: pushes apart members closer than `minDistance` (two Gauss–Seidel passes). */
  private separate() {
    const pos = this.position, n = this.count, md = this.params.minDistance, md2 = md * md
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let dx = pos[j * 3] - pos[i * 3], dy = pos[j * 3 + 1] - pos[i * 3 + 1], dz = pos[j * 3 + 2] - pos[i * 3 + 2]
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 >= md2) continue
          let d = Math.sqrt(d2)
          if (d < 1e-9) { dx = 1; dy = 0; dz = 0; d = 1e-9 } else { dx /= d; dy /= d; dz /= d }
          const push = (md - d) * 0.5
          this.nudge(i, -dx * push, -dy * push, -dz * push)
          this.nudge(j, dx * push, dy * push, dz * push)
        }
      }
    }
  }

  /** Moves a member, but never into an obstacle or out of its band. */
  private nudge(i: number, dx: number, dy: number, dz: number) {
    const pos = this.position
    const nx = pos[i * 3] + dx, nz = pos[i * 3 + 2] + dz
    if (this.environment.band(nx, nz, _b)) { pos[i * 3] = nx; pos[i * 3 + 2] = nz }
    pos[i * 3 + 1] += dy
    this.clampVertical(i)
  }

  /** Keeps member `i` inside its band (minus margins), or mid-band if the band is too thin. */
  private clampVertical(i: number) {
    const pos = this.position
    if (!this.environment.band(pos[i * 3], pos[i * 3 + 2], _b)) return
    const m = this.params.margin
    const lo = _b.floor + m, hi = _b.top - m
    const y = pos[i * 3 + 1]
    pos[i * 3 + 1] = lo <= hi ? Math.min(hi, Math.max(lo, y)) : (_b.floor + _b.top) * 0.5
    if (pos[i * 3 + 1] !== y) this.velocity[i * 3 + 1] *= 0.3
  }
}
