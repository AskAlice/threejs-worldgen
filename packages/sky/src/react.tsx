/**
 * React Three Fiber entry point: `<Sky>`, `<Stars>`, `<ShootingStars>`, `<SolarSystem>` and the
 * `useSkyTime()` / `useSky()` hooks, plus everything from `threejs-sky` (the imperative classes are
 * re-exported as `SkyImpl`, `StarsImpl`, `ShootingStarsImpl` and `SolarSystemImpl`).
 *
 * @module threejs-sky/react
 */
import { createContext, useContext, useEffect, useImperativeHandle, useMemo, useReducer, useRef, useState, type ReactNode, type Ref } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Camera, Material, Scene, WebGPURenderer } from 'three/webgpu'
import { Sky as SkyImpl, type SkyInput, type WorldLike } from './sky.ts'
import { Stars as StarsImpl, type StarsInput } from './stars.ts'
import { ShootingStars as ShootingStarsImpl, type ShootingStarsInput } from './shooting-stars.ts'
import { SolarSystem as SolarSystemImpl, type SolarSystemInput } from './solar-system.ts'
import { SkyClock, type ClockOptions } from './time.ts'

export * from './index.ts'
/** The imperative {@link SkyImpl | Sky} class (`Sky` is the component here). */
export { Sky as SkyImpl } from './sky.ts'
/** The imperative {@link StarsImpl | Stars} class. */
export { Stars as StarsImpl } from './stars.ts'
/** The imperative {@link ShootingStarsImpl | ShootingStars} class. */
export { ShootingStars as ShootingStarsImpl } from './shooting-stars.ts'
/** The imperative {@link SolarSystemImpl | SolarSystem} class. */
export { SolarSystem as SolarSystemImpl } from './solar-system.ts'

/** What `<Sky>` and `<SolarSystem>` share with their children. */
export interface SkyContextValue {
  /** The sky, when inside `<Sky>`. */
  sky: SkyImpl | null
  /** The clock driving time. */
  clock: SkyClock
}

const SkyContext = createContext<SkyContextValue | null>(null)

/** The nearest `<Sky>` instance, or `null` outside one (or before it is ready). */
export function useSky(): SkyImpl | null {
  return useContext(SkyContext)?.sky ?? null
}

/** Props of `<Sky>`: every {@link SkyInput} setting plus the ones below. */
export interface SkyProps extends SkyInput {
  /** Receives the underlying Sky instance. */
  ref?: Ref<SkyImpl | null>
  /** A `threejs-biomes` World: sets the planet radius and observer position for planet worlds. */
  world?: WorldLike
  /** Camera the observer follows. Defaults to the R3F default camera. */
  camera?: Camera
  /** Children see the sky through `useSky()` / `useSkyTime()`. Rendered once the sky is ready. */
  children?: ReactNode
}

/**
 * The whole sky for react-three-fiber: atmosphere, sun, moon, stars, meteors and lighting. Needs a
 * WebGPURenderer. Drives `scene.environment` and `scene.fog` (see `lighting`).
 *
 * @example
 * ```tsx
 * <Canvas gl={async (props) => { const r = new WebGPURenderer(props as any); await r.init(); return r }}>
 *   <Sky clock={{ dayLength: 300 }} observer={{ latitude: 52 }} shootingStars={{ shower: 60 }}>
 *     <TimeControls />
 *   </Sky>
 * </Canvas>
 * ```
 */
export function Sky({ ref, world, camera, children, ...options }: SkyProps): React.JSX.Element | null {
  const { gl, scene, camera: defaultCamera } = useThree()
  const activeCamera = camera ?? defaultCamera
  const [sky, setSky] = useState<SkyImpl | null>(null)
  const latest = useRef(options)
  latest.current = options

  useEffect(() => {
    let created: SkyImpl | null = null
    let cancelled = false
    SkyImpl.create({ renderer: gl as unknown as WebGPURenderer, scene: scene as unknown as Scene, camera: activeCamera, world, ...latest.current }).then((s) => {
      if (cancelled) return s.dispose()
      created = s
      setSky(s)
    })
    return () => {
      cancelled = true
      created?.dispose()
      setSky(null)
    }
  }, [gl, scene, world])

  useEffect(() => { if (sky) sky.camera = activeCamera }, [sky, activeCamera])
  // Props are the full truth: reset() reverts removed props. Cheap, and the clock only jumps when `clock.date` changes.
  useEffect(() => { sky?.reset(options) })
  useImperativeHandle(ref, () => sky!, [sky])
  useFrame((_, dt) => sky?.update(dt))

  const value = useMemo(() => (sky ? { sky, clock: sky.clock } : null), [sky])
  return value ? <SkyContext.Provider value={value}>{children}</SkyContext.Provider> : null
}

/** Props of `<Stars>`: every {@link StarsInput} setting plus `ref`. */
export interface StarsProps extends StarsInput {
  /** Receives the underlying Stars instance. */
  ref?: Ref<StarsImpl | null>
}

/**
 * A star field and Milky Way on their own (e.g. a space scene). Inside `<Sky>` it turns and fades with
 * that sky; turn the sky's own off with `<Sky stars={{ enabled: false }}>` to avoid drawing two.
 */
export function Stars({ ref, ...options }: StarsProps): React.JSX.Element | null {
  const ctx = useContext(SkyContext)
  const [stars] = useState(() => new StarsImpl(options))
  useEffect(() => () => stars.dispose(), [stars])
  useEffect(() => { stars.reset(options) })
  useImperativeHandle(ref, () => stars, [stars])
  useFrame(() => stars.update(ctx?.sky?.state))
  return <primitive object={stars.object} />
}

/** Props of `<ShootingStars>`: every {@link ShootingStarsInput} setting plus `ref`. */
export interface ShootingStarsProps extends ShootingStarsInput {
  /** Receives the underlying ShootingStars instance. */
  ref?: Ref<ShootingStarsImpl | null>
}

/**
 * Meteors on their own. Inside `<Sky>` they follow its clock (pausing with it) and only show at night;
 * turn the sky's own off with `<Sky shootingStars={{ enabled: false }}>` to avoid doubling them.
 */
export function ShootingStars({ ref, ...options }: ShootingStarsProps): React.JSX.Element | null {
  const ctx = useContext(SkyContext)
  const [meteors] = useState(() => new ShootingStarsImpl(options))
  useEffect(() => () => meteors.dispose(), [meteors])
  useEffect(() => { meteors.reset(options) })
  useImperativeHandle(ref, () => meteors, [meteors])
  useFrame((_, dt) => {
    const sky = ctx?.sky
    meteors.update(sky ? sky.clock.realDelta : dt, sky?.state)
  })
  return <primitive object={meteors.object} />
}

/** Props of `<SolarSystem>`: every {@link SolarSystemInput} setting plus the ones below. */
export interface SolarSystemProps extends SolarSystemInput {
  /** Receives the underlying SolarSystem instance. */
  ref?: Ref<SolarSystemImpl | null>
  /** Clock settings when used outside `<Sky>` (inside, the sky's clock and star system are used). */
  clock?: Partial<ClockOptions>
  /** Your own materials per body name. */
  materials?: Record<string, Material>
  /** Camera for distance compression. Defaults to the R3F default camera. */
  camera?: Camera
  /** Children see the clock through `useSkyTime()`. */
  children?: ReactNode
}

/**
 * The orbital view of a star system: star, planets, moons, rings and orbit lines, floating-origin safe.
 * Inside `<Sky>` it shows that sky's system at its time; outside it runs its own clock.
 */
export function SolarSystem({ ref, clock: clockOptions, materials, camera, children, ...options }: SolarSystemProps): React.JSX.Element | null {
  const parent = useContext(SkyContext)
  const { camera: defaultCamera } = useThree()
  const activeCamera = camera ?? defaultCamera
  const [ownClock] = useState(() => new SkyClock(clockOptions))
  const sky = parent?.sky ?? null
  const [solar, setSolar] = useState<SolarSystemImpl | null>(null)
  const latest = useRef(options)
  latest.current = options

  useEffect(() => {
    const s = new SolarSystemImpl({ ...latest.current, model: sky?.system, materials })
    setSolar(s)
    return () => s.dispose()
  }, [sky, materials])
  useEffect(() => { solar?.reset(options) })
  const clockKey = JSON.stringify(clockOptions ?? {})
  useEffect(() => { if (!sky) ownClock.reset(clockOptions) }, [clockKey]) // only on change, so useSkyTime() edits stick
  useImperativeHandle(ref, () => solar!, [solar])
  useFrame((_, dt) => {
    if (!solar) return
    if (sky && solar.system !== sky.system) solar.setModel(sky.system)
    if (!sky) ownClock.update(dt)
    solar.update(sky ? sky.clock.time : ownClock.time, activeCamera)
  })

  const value = useMemo(() => (parent ?? { sky: null, clock: ownClock }), [parent, ownClock])
  if (!solar) return null
  return (
    <SkyContext.Provider value={value}>
      <primitive object={solar.object} />
      {children}
    </SkyContext.Provider>
  )
}

/** Live view of the sky clock with setters, from {@link useSkyTime}. */
export interface SkyTime {
  /** The clock itself. */
  clock: SkyClock
  /** Simulation seconds since J2000. */
  time: number
  /** Current simulation instant. */
  date: Date
  /** Simulated seconds per real second right now. */
  rate: number
  /** Whether time is paused. */
  paused: boolean
  /** Local solar time at the observer, hours (inside `<Sky>`; otherwise NaN). */
  solarTime: number
  /** Jumps to a date. */
  setDate: (date: Date | string | number) => void
  /** Sets the time scale (and clears `dayLength`). */
  setTimeScale: (scale: number) => void
  /** Sets real seconds per solar day (0 = use the time scale). */
  setDayLength: (seconds: number) => void
  /** Pauses or resumes. */
  setPaused: (paused: boolean) => void
  /** Moves time by `seconds`. */
  advance: (seconds: number) => void
  /** Jumps to a local solar time, hours (inside `<Sky>` only; otherwise a no-op). */
  setTimeOfDay: (hours: number) => void
}

/**
 * Reads and controls the sky clock from any component inside `<Sky>` or `<SolarSystem>`, re-rendering
 * `fps` times per second (0 = only after its own setters) — enough for a clock display or a slider.
 * Changes made here stick until the `<Sky>`'s `clock` props change.
 */
export function useSkyTime(fps = 4): SkyTime {
  const ctx = useContext(SkyContext)
  if (!ctx) throw new Error('useSkyTime() must be used inside <Sky> or <SolarSystem>.')
  const { clock, sky } = ctx
  const [, rerender] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (fps <= 0) return
    const id = setInterval(rerender, 1000 / fps)
    return () => clearInterval(id)
  }, [fps])
  const act = (f: () => void) => { f(); rerender() }
  return {
    clock,
    time: clock.time,
    date: clock.date,
    rate: clock.rate,
    paused: clock.settings.paused,
    solarTime: sky ? sky.state.solarTime : NaN,
    setDate: (d) => act(() => clock.setDate(d)),
    setTimeScale: (x) => act(() => clock.set({ timeScale: x, dayLength: 0 })),
    setDayLength: (x) => act(() => clock.set({ dayLength: x })),
    setPaused: (p) => act(() => clock.set({ paused: p })),
    advance: (sec) => act(() => clock.advance(sec)),
    setTimeOfDay: (h) => act(() => sky?.setTimeOfDay(h)),
  }
}
