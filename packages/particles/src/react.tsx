/**
 * React Three Fiber entry point: `<Particles>`, `<ParticleGrid>` and `<MPM>`, plus everything from
 * `threejs-particles` (the classes are re-exported as `ParticleSystemImpl`, `ParticleGridImpl` and `MPMSolverImpl`).
 *
 * @module threejs-particles/react
 */
import { createContext, useContext, useEffect, useImperativeHandle, useMemo, type ReactNode, type Ref } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Renderer } from 'three/webgpu'
import { ParticleGrid as ParticleGridImpl, type GridOptions } from './grid.ts'
import { ParticleLighting, ParticleSystem as ParticleSystemImpl } from './system.ts'
import { MPMSolver as MPMSolverImpl } from './mpm.ts'
import type { MPMEmit, MPMHeightFn, MPMInput } from './mpm-reference.ts'
import type { DeepPartial, ParticleInput } from './options.ts'

export * from './index.ts'
/** The imperative {@link ParticleSystemImpl | ParticleSystem} class. */
export { ParticleSystem as ParticleSystemImpl } from './system.ts'
/** The imperative {@link ParticleGridImpl | ParticleGrid} class. */
export { ParticleGrid as ParticleGridImpl } from './grid.ts'
/** The imperative {@link MPMSolverImpl | MPMSolver} class. */
export { MPMSolver as MPMSolverImpl } from './mpm.ts'

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
 * self-shadowing). Splats are up to you (see `ParticleGrid.splat`); the grid resolves once per frame
 * after its children update.
 */
export function ParticleGrid({ ref, children, ...options }: ParticleGridProps): React.JSX.Element {
  const { gl } = useThree()
  const grid = useMemo(() => new ParticleGridImpl(options), [JSON.stringify(options.resolution)])
  useEffect(() => () => grid.dispose(), [grid])
  useEffect(() => void grid.set(options))
  useFrame((_, dt) => grid.resolve(gl as unknown as Renderer, dt), 1)
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
  /** Receives the {@link MPMSolverImpl} instance. */
  ref?: Ref<MPMSolverImpl | null>
}

/**
 * An MLS-MPM solver stepped every frame. Props merge into its settings (`set`); `capacity`, `resolution`,
 * `cellSize` and the set of `materials` rebuild it.
 */
export function MPM({ height = null, emit, ref, ...options }: MPMProps): React.JSX.Element {
  const { gl } = useThree()
  const structure = JSON.stringify([options.capacity, options.resolution, options.cellSize, Object.keys(options.materials ?? {})])
  const impl = useMemo(() => new MPMSolverImpl(gl as unknown as Renderer, { ...options, height }), [structure, gl])
  useEffect(() => () => impl.dispose(), [impl])
  useEffect(() => void impl.set(options))
  useEffect(() => void impl.setHeight(height), [impl, height])
  useEffect(() => { for (const e of emit ?? []) impl.emit(e) }, [impl])
  useFrame((_, dt) => impl.step(dt))
  useImperativeHandle(ref, () => impl, [impl])
  return <primitive object={impl.object} />
}
