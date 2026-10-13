/**
 * React Three Fiber entry point: `<Particles>`, `<ParticleGrid>`, `<MPM>` and the MPM surfaces `<MPMSnowSurface>`,
 * `<FluidSurface>` and `<MPMLava>`, plus everything from `threejs-particles` (the classes are re-exported as
 * `ParticleSystemImpl`, `ParticleGridImpl`, `MPMSolverImpl`, `MPMSnowSurfaceImpl`, `FluidSurfaceImpl` and `MPMLavaImpl`).
 *
 * @module threejs-particles/react
 */
import { createContext, useContext, useEffect, useImperativeHandle, useMemo, type ReactNode, type Ref } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Renderer, Texture } from 'three/webgpu'
import { ParticleGrid as ParticleGridImpl, type GridOptions } from './grid.ts'
import { ParticleLighting, ParticleSystem as ParticleSystemImpl } from './system.ts'
import { MPMSolver as MPMSolverImpl } from './mpm.ts'
import { MPMSnowSurface as MPMSnowSurfaceImpl, type SnowSurfaceOptions } from './mpm-snow.ts'
import { FluidSurface as FluidSurfaceImpl, type FluidSource, type FluidSurfaceInput } from './fluid-surface.ts'
import { MPMLava as MPMLavaImpl, type LavaInput } from './mpm-lava.ts'
import type { MPMEmit, MPMHeightFn, MPMInput } from './mpm-reference.ts'
import type { DeepPartial, ParticleInput } from './options.ts'

export * from './index.ts'
/** The imperative {@link ParticleSystemImpl | ParticleSystem} class. */
export { ParticleSystem as ParticleSystemImpl } from './system.ts'
/** The imperative {@link ParticleGridImpl | ParticleGrid} class. */
export { ParticleGrid as ParticleGridImpl } from './grid.ts'
/** The imperative {@link MPMSolverImpl | MPMSolver} class. */
export { MPMSolver as MPMSolverImpl } from './mpm.ts'
/** The imperative {@link MPMSnowSurfaceImpl | MPMSnowSurface} class. */
export { MPMSnowSurface as MPMSnowSurfaceImpl } from './mpm-snow.ts'
/** The imperative {@link FluidSurfaceImpl | FluidSurface} class. */
export { FluidSurface as FluidSurfaceImpl } from './fluid-surface.ts'
/** The imperative {@link MPMLavaImpl | MPMLava} class. */
export { MPMLava as MPMLavaImpl } from './mpm-lava.ts'

const GridContext = createContext<ParticleGridImpl | null>(null)

/** Props of `<ParticleGrid>`: every {@link GridOptions} setting plus children. */
export interface ParticleGridProps extends DeepPartial<GridOptions> {
  /** Receives the {@link ParticleGridImpl} instance. */
  ref?: Ref<ParticleGridImpl | null>
  /** `<Particles>` that read the grid. */
  children?: ReactNode
}

/**
 * A coarse grid shared by the `<Particles>` inside it: they read its heat (lift) and density (smoke
 * self-shadowing). Splats are up to you (see `ParticleGrid.splat`: run them in a `useFrame` of a child
 * after the `<Particles>`); the grid resolves once per frame after its children update.
 */
export function ParticleGrid({ ref, children, ...options }: ParticleGridProps): React.JSX.Element {
  const { gl } = useThree()
  const grid = useMemo(() => new ParticleGridImpl(options), [JSON.stringify(options.resolution)])
  useEffect(() => () => grid.dispose(), [grid])
  useEffect(() => void grid.set(options))
  // Priority 0 (a positive one would take over rendering): children subscribe first, so it runs after them.
  useFrame((_, dt) => grid.resolve(gl as unknown as Renderer, dt))
  useImperativeHandle(ref, () => grid, [grid])
  return <GridContext.Provider value={grid}>{children}</GridContext.Provider>
}

/** Props of `<Particles>`: every {@link ParticleInput} setting plus the ones below. */
export interface ParticlesProps extends ParticleInput {
  /** Shared light (default: one per system, filled from the scene each frame). */
  lighting?: ParticleLighting
  /** Weighted sources (`SOURCE_STRIDE` floats each), for `emitter.shape: 'sources'`. */
  sources?: ArrayLike<number> | null
  /** Most sources. */
  maxSources?: number
  /** Receives the {@link ParticleSystemImpl} instance. */
  ref?: Ref<ParticleSystemImpl | null>
}

/**
 * A GPU particle system. Props are the full truth (`reset` on every render); the structural ones
 * (`capacity`, `render.shading`, `render.blending`, `render.sort`, `render.shadowSteps`,
 * `render.lightSteps`) rebuild it. Inside `<ParticleGrid>` it reads that grid.
 */
export function Particles({ lighting, sources, maxSources, ref, ...options }: ParticlesProps): React.JSX.Element {
  const { gl, scene, camera } = useThree()
  const grid = useContext(GridContext)
  const r = options.render
  const structure = JSON.stringify([options.capacity, r?.shading, r?.blending, r?.sort, r?.shadowSteps, r?.lightSteps, maxSources])
  const impl = useMemo(() => new ParticleSystemImpl({ ...options, grid, lighting, maxSources }), [structure, grid, lighting])
  useEffect(() => () => impl.dispose(), [impl])
  useEffect(() => void impl.reset(options))
  useEffect(() => void (sources && impl.setSources(sources)), [impl, sources])
  useFrame((_, dt) => {
    if (!lighting) impl.lighting.fromScene(scene)
    impl.update(gl as unknown as Renderer, dt, camera)
  })
  useImperativeHandle(ref, () => impl, [impl])
  return <primitive object={impl.object} />
}

/** Props of `<MPM>`: every {@link MPMInput} setting plus the ones below. */
export interface MPMProps extends MPMInput {
  /** Terrain height function, world metres (re-baked when it changes). */
  height?: MPMHeightFn | null
  /** Blocks emitted once, whenever the solver is (re)built. Emit more through the ref. */
  emit?: MPMEmit[]
  /**
   * Seconds simulated per frame: default the frame's delta; a fixed step (e.g. `1 / 60`) is deterministic and slows
   * down rather than going unstable when frames drop. 0: not stepped here (step it through the ref, or let `<MPMLava>`).
   */
  timeStep?: number
  /** Receives the {@link MPMSolverImpl} instance. */
  ref?: Ref<MPMSolverImpl | null>
}

/**
 * An MLS-MPM solver stepped every frame. Props merge into its settings (`set`); `capacity`, `resolution`,
 * `cellSize` and the set of `materials` rebuild it.
 */
export function MPM({ height = null, emit, timeStep, ref, ...options }: MPMProps): React.JSX.Element {
  const { gl } = useThree()
  const structure = JSON.stringify([options.capacity, options.resolution, options.cellSize, Object.keys(options.materials ?? {})])
  const impl = useMemo(() => new MPMSolverImpl(gl as unknown as Renderer, { ...options, height }), [structure, gl])
  useEffect(() => () => impl.dispose(), [impl])
  useEffect(() => void impl.set(options))
  useEffect(() => void impl.setHeight(height), [impl, height])
  useEffect(() => { for (const e of emit ?? []) impl.emit(e) }, [impl])
  useFrame((_, dt) => void ((timeStep ?? dt) > 0 && impl.step(timeStep ?? dt)))
  useImperativeHandle(ref, () => impl, [impl])
  return <primitive object={impl.object} />
}

/** Props of `<MPMSnowSurface>`: every {@link SnowSurfaceOptions} setting plus the ones below. */
export interface MPMSnowSurfaceProps extends Partial<SnowSurfaceOptions> {
  /** The solver whose snow it draws (from `<MPM ref>`). */
  solver: MPMSolverImpl
  /** Receives the {@link MPMSnowSurfaceImpl} instance. */
  ref?: Ref<MPMSnowSurfaceImpl | null>
}

/**
 * A lit snow cover rebuilt from a solver's particles every frame, after the `<MPM>` steps (mount it after that).
 * Props merge into its settings; `detail` rebuilds it.
 */
export function MPMSnowSurface({ solver, ref, ...options }: MPMSnowSurfaceProps): React.JSX.Element {
  const { gl } = useThree()
  const impl = useMemo(() => new MPMSnowSurfaceImpl(gl as unknown as Renderer, solver, options), [gl, solver, options.detail])
  useEffect(() => () => impl.dispose(), [impl])
  useEffect(() => void impl.set(options))
  useFrame(() => impl.update())
  useImperativeHandle(ref, () => impl, [impl])
  return <primitive object={impl.object} />
}

/** What `<FluidSurface>` and `<MPMLava>` take besides their settings. */
interface SurfaceLight {
  /** Sun and sky light (default: one per surface, filled from the scene each frame). */
  lighting?: ParticleLighting
  /** Reflected environment (default: the scene's `environment`, followed each frame; `null`: the lighting's sky colour). */
  envMap?: Texture | null
}

/** Props of `<FluidSurface>`: every {@link FluidSurfaceInput} setting plus the ones below. */
export interface FluidSurfaceProps extends FluidSurfaceInput, SurfaceLight {
  /** The particles it draws: an {@link MPMSolverImpl} (from `<MPM ref>`) or any {@link FluidSource}. */
  source: FluidSource
  /** Receives the {@link FluidSurfaceImpl} instance. */
  ref?: Ref<FluidSurfaceImpl | null>
}

/** A screen-space water surface over a solver's particles, its offscreen passes drawn every frame. Props merge into its settings. */
export function FluidSurface({ source, lighting, envMap, ref, ...options }: FluidSurfaceProps): React.JSX.Element {
  const { gl, scene, camera } = useThree()
  const impl = useMemo(() => new FluidSurfaceImpl(source, { ...options, lighting, envMap: envMap === undefined ? scene.environment : envMap }), [source, lighting])
  useEffect(() => () => impl.dispose(), [impl])
  useEffect(() => void impl.set(options))
  useFrame(() => {
    if (!lighting) impl.lighting.fromScene(scene)
    impl.setEnvironment(envMap === undefined ? scene.environment : envMap)
    impl.render(gl as unknown as Renderer, camera)
  })
  useImperativeHandle(ref, () => impl, [impl])
  return <primitive object={impl.object} />
}

/** Props of `<MPMLava>`: every {@link LavaInput} setting plus the ones below. */
export interface MPMLavaProps extends LavaInput, SurfaceLight {
  /** The solver (from `<MPM ref>`); `materials` must include `material` (default `lava`). */
  solver: MPMSolverImpl
  /** Seconds simulated per frame (default: the frame's delta). */
  timeStep?: number
  /** Receives the {@link MPMLavaImpl} instance (emit through its vent gate with `emit`). */
  ref?: Ref<MPMLavaImpl | null>
}

/**
 * Lava on a solver: each frame it steps the solver with the thermal step (give that `<MPM timeStep={0}>`) and draws
 * the glowing, crusting surface. Props merge into its settings; `material` rebuilds it.
 */
export function MPMLava({ solver, lighting, envMap, timeStep, ref, ...options }: MPMLavaProps): React.JSX.Element {
  const { gl, scene, camera } = useThree()
  const impl = useMemo(() => new MPMLavaImpl(solver, { ...options, lighting, envMap: envMap === undefined ? scene.environment : envMap }), [solver, lighting, options.material])
  useEffect(() => () => impl.dispose(), [impl])
  useEffect(() => void impl.set(options))
  useFrame((_, dt) => {
    if (!lighting) impl.lighting.fromScene(scene)
    impl.setEnvironment(envMap === undefined ? scene.environment : envMap)
    impl.uniforms.environmentIntensity.value = scene.environmentIntensity
    const r = gl as unknown as Renderer
    const passes = impl.prepare(timeStep ?? dt)
    if (passes.length) r.compute(passes) // none while the solver is empty
    impl.render(r, camera)
  })
  useImperativeHandle(ref, () => impl, [impl])
  return <primitive object={impl.object} />
}
