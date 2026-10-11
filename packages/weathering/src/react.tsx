/**
 * React Three Fiber entry point: `<Weather>` (provides the weather, a clock and an optional state
 * field), `<Precipitation>`, `<Lightning>`, `<Wildfire>` and hooks, plus everything from
 * `threejs-weathering` (the classes are re-exported as `WeatherImpl`, `PrecipitationImpl`,
 * `LightningImpl` and `WildfireImpl`).
 *
 * @module threejs-weathering/react
 */
import { createContext, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3 } from 'three/webgpu'
import type { World } from 'threejs-biomes'
import { Weather as WeatherImpl, createWeatherSample, type Strike, type WeatherInput, type WeatherSample } from './weather.ts'
import { StateField, type StateFieldOptions } from './state-field.ts'
import { Precipitation as PrecipitationImpl, type PrecipitationInput } from './precipitation.ts'
import { Lightning as LightningImpl, type LightningInput } from './lightning.ts'
import { Wildfire as WildfireImpl, type WildfireInput } from './fire-render.ts'
import type { FireLandscape } from './fire-sim.ts'

export * from './index.ts'
/** The imperative {@link WeatherImpl | Weather} class (`Weather` is the component here). */
export { Weather as WeatherImpl } from './weather.ts'
/** The imperative {@link PrecipitationImpl | Precipitation} class. */
export { Precipitation as PrecipitationImpl } from './precipitation.ts'
/** The imperative {@link LightningImpl | Lightning} class. */
export { Lightning as LightningImpl } from './lightning.ts'
/** The imperative {@link WildfireImpl | Wildfire} class. */
export { Wildfire as WildfireImpl } from './fire-render.ts'

/** Shared simulation clock of a `<Weather>` tree. Read `time` in your own `useFrame`. */
export interface WeatherClock {
  /** Weather time, seconds. */
  time: number
}

/** What `<Weather>` provides to its children (see {@link useWeather}). */
export interface WeatherContextValue {
  /** The weather. */
  weather: WeatherImpl
  /** The clock every child animates to. */
  clock: WeatherClock
  /** The state field fed with wetness and snow, if `field` was given. */
  field: StateField | null
  /** Frame position at render-space zero (floating origin). */
  origin: readonly number[]
}

const WeatherContext = createContext<WeatherContextValue | null>(null)

/** Props of `<Weather>`: every {@link WeatherInput} setting plus the ones below. */
export interface WeatherProps extends WeatherInput {
  /** World whose climate drives the weather. */
  world?: World | null
  /** Controlled time, seconds. Omit to let the clock run at `timeScale`. */
  time?: number
  /** Weather seconds per real second when uncontrolled (3600 = an hour per second). */
  timeScale?: number
  /** Starting time when uncontrolled, seconds. */
  startTime?: number
  /** A state field (or its options) to fill with wetness and snow from the weather. */
  field?: Partial<StateFieldOptions> | StateField | null
  /** Milliseconds per frame spent updating the field. */
  fieldBudget?: number
  /** Keep the field centred on the camera. */
  followCamera?: boolean
  /** Frame position at render-space zero `[x, y, z]` (floating origin). */
  origin?: readonly number[]
  /** Receives the {@link WeatherImpl} instance. */
  ref?: Ref<WeatherImpl | null>
  /** Weather-driven children (`<Precipitation>`, `<Lightning>`, `<Wildfire>`, …). */
  children?: ReactNode
}

/**
 * Seeded, time-driven weather for a react-three-fiber scene. Children read it with {@link useWeather}.
 *
 * @example
 * ```tsx
 * <Weather world={world} timeScale={60} field={{ size: 512 }}>
 *   <Precipitation />
 *   <Lightning onStrike={(s) => console.log('strike', s)} />
 *   <Wildfire size={1024} ignitions={[[0, 0, 10, 4]]} />
 * </Weather>
 * ```
 */
export function Weather({ world = null, time, timeScale = 1, startTime = 0, field, fieldBudget = 2, followCamera = true, origin = ZERO, ref, children, ...options }: WeatherProps): React.JSX.Element {
  const { camera } = useThree()
  const weather = useMemo(() => new WeatherImpl(options, world), [world])
  useEffect(() => void weather.reset(options))
  const clock = useRef<WeatherClock>({ time: time ?? startTime }).current

  const ownField = !!field && !(field instanceof StateField)
  const stateField = useMemo(() => (field instanceof StateField ? field : field ? new StateField(field) : null), [field instanceof StateField ? field : ownField])
  useEffect(() => (ownField && stateField ? () => stateField.dispose() : undefined), [stateField, ownField])
  useEffect(() => {
    if (stateField && field && !(field instanceof StateField)) stateField.set(field)
  })

  const latest = useRef({ time, timeScale, followCamera, fieldBudget, origin })
  latest.current = { time, timeScale, followCamera, fieldBudget, origin }
  useFrame((_, delta) => {
    const p = latest.current
    clock.time = p.time ?? clock.time + delta * p.timeScale
    if (!stateField) return
    stateField.setOrigin(p.origin)
    if (p.followCamera) {
      const c = camera.getWorldPosition(_v)
      stateField.set({ center: [c.x + (p.origin[0] ?? 0), c.z + (p.origin[2] ?? 0)] })
    }
    stateField.updateFromWeather(weather, clock.time, p.fieldBudget)
    stateField.update()
  }, -1) // before children animate

  useImperativeHandle(ref, () => weather, [weather])
  const value = useMemo(() => ({ weather, clock, field: stateField, origin }), [weather, clock, stateField, origin])
  return <WeatherContext.Provider value={value}>{children}</WeatherContext.Provider>
}

/** The weather, clock and state field of the nearest `<Weather>`. Throws outside one. */
export function useWeather(): WeatherContextValue {
  const ctx = useContext(WeatherContext)
  if (!ctx) throw new Error('useWeather: needs a <Weather> ancestor')
  return ctx
}

/** The state field of the nearest `<Weather>` (or null). */
export function useStateField(): StateField | null {
  return useContext(WeatherContext)?.field ?? null
}

/** The weather at frame position (x, z), refreshed every `interval` milliseconds (null until the first read). */
export function useWeatherSample(x: number, z: number, interval = 250): WeatherSample | null {
  const { weather, clock } = useWeather()
  const [sample, setSample] = useState<WeatherSample | null>(null)
  const last = useRef(-Infinity)
  useFrame(() => {
    const now = performance.now()
    if (now - last.current < interval) return
    last.current = now
    setSample(weather.at(x, z, clock.time, createWeatherSample()))
  })
  return sample
}

/** Props of `<Precipitation>`: every {@link PrecipitationInput} setting plus the ones below. */
export interface PrecipitationProps extends PrecipitationInput {
  /** Ground height for splashes (frame coordinates). Default: the weather's world. */
  ground?: ((x: number, z: number) => number) | null
  /** Receives the {@link PrecipitationImpl} instance. */
  ref?: Ref<PrecipitationImpl | null>
}

/** Rain, sleet and snow around the camera, driven by the nearest `<Weather>`. */
export function Precipitation({ ground, ref, ...options }: PrecipitationProps): React.JSX.Element {
  const { weather, clock, origin } = useWeather()
  const { camera } = useThree()
  const groundRef = useRef(ground)
  groundRef.current = ground
  const impl = useMemo(() => new PrecipitationImpl({ weather, camera, ground: ground === undefined ? undefined : (x, z) => groundRef.current?.(x, z) ?? 0, ...options }), [weather, camera, ground === undefined])
  useEffect(() => () => impl.dispose(), [impl])
  useEffect(() => void impl.reset(options))
  useFrame(() => impl.setOrigin(origin).update(clock.time))
  useImperativeHandle(ref, () => impl, [impl])
  return <primitive object={impl.object} />
}

/** Props of `<Lightning>`: every {@link LightningInput} setting plus the ones below. */
export interface LightningProps extends LightningInput {
  /** Called once per strike as time passes it. */
  onStrike?: (strike: Strike) => void
  /** Ground height (frame coordinates). Default: the weather's world. */
  ground?: ((x: number, z: number) => number) | null
  /** Receives the {@link LightningImpl} instance. */
  ref?: Ref<LightningImpl | null>
}

/** Lightning bolts and flashes from the nearest `<Weather>`'s thunderstorms. */
export function Lightning({ onStrike, ground, ref, ...options }: LightningProps): React.JSX.Element {
  const { weather, clock, origin } = useWeather()
  const { camera } = useThree()
  const impl = useMemo(() => new LightningImpl({ weather, camera, ground, ...options }), [weather, camera, ground])
  useEffect(() => () => impl.dispose(), [impl])
  useEffect(() => void impl.reset(options))
  const strike = useRef(onStrike)
  strike.current = onStrike
  useEffect(() => impl.onStrike((s) => strike.current?.(s)), [impl])
  useFrame(() => impl.setOrigin(origin).update(clock.time))
  useImperativeHandle(ref, () => impl, [impl])
  return <primitive object={impl.object} />
}

/** Props of `<Wildfire>`: every {@link WildfireInput} setting plus the ones below. */
export interface WildfireProps extends WildfireInput {
  /** World for terrain and fuel. Default: the weather's world. */
  world?: World | null
  /** Custom terrain and fuel instead of a world. */
  landscape?: FireLandscape | null
  /** Receives the {@link WildfireImpl} instance (call `ignite` on it). */
  ref?: Ref<WildfireImpl | null>
}

/**
 * A wildfire driven by the nearest `<Weather>` (wind, fuel moisture, lightning). Writes burn scars into
 * the weather's state field. Props are the full truth (`reset` on every render); scheduled ignitions
 * added with `ignite()` are kept unless you pass `ignitions`.
 */
export function Wildfire({ world, landscape, ref, ...options }: WildfireProps): React.JSX.Element {
  const { weather, clock, field, origin } = useWeather()
  const impl = useMemo(() => new WildfireImpl({ world: world === undefined ? weather.world : world, weather, landscape, field, ...options }), [weather, world, landscape, field])
  useEffect(() => () => impl.dispose(), [impl])
  useEffect(() => void impl.reset(options))
  useFrame(() => impl.setOrigin(origin).update(clock.time))
  useImperativeHandle(ref, () => impl, [impl])
  return <primitive object={impl.object} />
}

const ZERO: readonly number[] = [0, 0, 0]
const _v = new Vector3()
