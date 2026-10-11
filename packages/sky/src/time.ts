/**
 * Simulation time. Everything in the sky is a pure function of one number: seconds since the J2000
 * epoch (2000-01-01 12:00 UTC). The clock only decides how fast that number moves.
 */

/** Unix time (ms) of the J2000 epoch, 2000-01-01T12:00:00Z. Orbital elements are given at this instant. */
export const J2000_MS = Date.UTC(2000, 0, 1, 12)

/** Converts a date (Date, ISO string or Unix ms) into simulation seconds since J2000. */
export function toSimTime(date: Date | string | number): number {
  const ms = date instanceof Date ? date.getTime() : typeof date === 'number' ? date : Date.parse(date)
  if (!Number.isFinite(ms)) throw new Error(`threejs-sky: invalid date ${String(date)}`)
  return (ms - J2000_MS) / 1000
}

/** Converts simulation seconds since J2000 into a `Date`. */
export function toDate(time: number): Date {
  return new Date(J2000_MS + time * 1000)
}

/** Settings of a {@link SkyClock}. Plain JSON. */
export interface ClockOptions {
  /**
   * Starting instant, as an ISO 8601 string (`'2026-06-21T18:00:00Z'`) or Unix milliseconds. The clock
   * jumps here when created and whenever this value changes; otherwise it keeps running.
   */
  date: string | number
  /** Simulated seconds per real second. 1 = real time, 60 = a minute per second. Negative runs backwards. */
  timeScale: number
  /**
   * Real seconds one solar day of the home planet should take (e.g. 600 for a 10-minute day/night
   * cycle). Overrides `timeScale` when above 0.
   */
  dayLength: number
  /** Freezes simulation time. */
  paused: boolean
  /** Longest real frame step the clock accepts, seconds. Stops a background tab from skipping hours. */
  maxStep: number
}

/** Default clock: a June afternoon, running in real time. */
export const DEFAULT_CLOCK: ClockOptions = {
  date: '2026-06-21T16:00:00Z',
  timeScale: 1,
  dayLength: 0,
  paused: false,
  maxStep: 0.25,
}

/**
 * The simulation clock: time scale, pause, set date/time and a "day length" shortcut. Deterministic:
 * the sky at a given {@link SkyClock.time} is always the same, however you got there.
 *
 * @example
 * ```ts
 * const clock = new SkyClock({ date: '2026-03-20T06:00:00Z', dayLength: 300 }) // 5-minute days
 * clock.update(dt)       // once per frame, real seconds
 * clock.date             // current Date
 * clock.setDate('2026-12-21T12:00:00Z')
 * ```
 */
export class SkyClock {
  /** Simulation seconds since J2000. Change it with {@link SkyClock.setTime} or {@link SkyClock.setDate}. */
  time = 0
  /** Resolved settings. Change them with {@link SkyClock.set} / {@link SkyClock.reset}. */
  settings: ClockOptions = { ...DEFAULT_CLOCK }
  /** Length of the home planet's solar day in simulation seconds, used by `dayLength`. Set by `Sky`. */
  solarDay = 86400
  /** Simulation seconds advanced by the last {@link SkyClock.update}. */
  delta = 0
  /** Real seconds of the last {@link SkyClock.update} (0 while paused). */
  realDelta = 0
  /** Real seconds of the last {@link SkyClock.update}, paused or not (for things like exposure adaptation). */
  frameDelta = 0

  private appliedDate: string | number | undefined
  private last = -1

  /** Creates a clock; anything not given uses {@link DEFAULT_CLOCK}. */
  constructor(input: Partial<ClockOptions> = {}) {
    this.set(input)
  }

  /** Merges settings. Jumps to `date` only if it differs from the last date applied. */
  set(input: Partial<ClockOptions>): this {
    for (const [k, v] of Object.entries(input)) if (v !== undefined) (this.settings as any)[k] = v
    if (this.settings.date !== this.appliedDate) {
      this.appliedDate = this.settings.date
      this.time = toSimTime(this.settings.date)
    }
    return this
  }

  /** Replaces all settings (missing ones go back to defaults). Time only jumps if `date` changed. */
  reset(input: Partial<ClockOptions> = {}): this {
    this.settings = { ...DEFAULT_CLOCK }
    return this.set(input)
  }

  /** Simulated seconds per real second right now (after `dayLength` and `paused`). */
  get rate(): number {
    const s = this.settings
    if (s.paused) return 0
    return s.dayLength > 0 ? this.solarDay / s.dayLength : s.timeScale
  }

  /**
   * Advances time. Call once per frame.
   * @param dt Real seconds since the last call. Omit to measure it with `performance.now()`.
   * @returns Simulation seconds advanced.
   */
  update(dt?: number): number {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (dt === undefined) dt = this.last < 0 ? 0 : (now - this.last) / 1000
    this.last = now
    dt = Math.min(Math.max(dt, 0), this.settings.maxStep)
    this.frameDelta = dt
    const rate = this.rate
    this.realDelta = rate === 0 ? 0 : dt
    this.delta = dt * rate
    this.time += this.delta
    return this.delta
  }

  /** Current simulation instant. */
  get date(): Date {
    return toDate(this.time)
  }

  /** Jumps to simulation seconds since J2000. */
  setTime(time: number): this {
    this.time = time
    return this
  }

  /** Jumps to a date (Date, ISO string or Unix ms). */
  setDate(date: Date | string | number): this {
    this.time = toSimTime(date)
    return this
  }

  /** Moves time by `seconds` (negative goes back). */
  advance(seconds: number): this {
    this.time += seconds
    return this
  }
}
