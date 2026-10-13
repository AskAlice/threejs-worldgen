import { Color, MeshStandardNodeMaterial, Vector2, Vector4, type BufferGeometry, type Material } from 'three/webgpu'
import { abs, attribute, cos, float, hue, luminance, mix, normalGeometry, positionGeometry, select, sign, sin, smoothstep, step, uniform, vec3 } from 'three/tsl'
import { DEFAULT_BOIDS, type BoidParams } from './boids.ts'
import { applyStates } from './fish-material.ts'
import { deformBeforeInstancing, prepareRenderer, toGeometry, type DeepPartial, type Predator } from './common.ts'
import { BIRD_SPECIES, birdHabitat, buildBirdMesh, type BirdSpecies } from './bird-species.ts'
import { DEFAULT_LAYER, FaunaLayer, type FaunaGroup, type FaunaLayerOptions, type FaunaLayerSettings } from './layer.ts'
import type { Habitat } from './placement.ts'

/** Creates the uniforms of one bird species' material. Exported so {@link BirdUniforms} is documented. */
export function createBirdUniforms() {
  return {
    /** Back and upper-wing colour. */
    back: uniform(new Color()),
    /** Belly and under-wing colour. */
    belly: uniform(new Color()),
    /** Wing-tip colour. */
    tip: uniform(new Color()),
    /** x = tip length (share of the span), y = flap amplitude, radians. */
    wing: uniform(new Vector2()),
    /** x = wetness, y = snow, z = burn, w = damage. */
    states: uniform(new Vector4()),
  }
}

/** Uniforms of a bird material (one per species). */
export type BirdUniforms = ReturnType<typeof createBirdUniforms>

/**
 * The bird material. Wings flap in the vertex shader: each wing vertex rotates about the body axis by
 * `sin(phase)·amplitude`, more toward the tip, so the wing bends as it beats. Per-instance attributes
 * as for fish: `faunaMotion` = (wing phase, flap scale, 0, 0), `faunaLook` = (hue, brightness, ·, ·).
 */
export function createBirdMaterial(u: BirdUniforms): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial()
  const f = attribute('fauna', 'vec4')
  const motion = attribute('faunaMotion', 'vec4')
  const look = attribute('faunaLook', 'vec4')
  const part = f.z, w = f.w
  const p = positionGeometry
  const isWing = step(4.5, part).mul(step(part, 5.5))
  const angle = sin(motion.x).mul(motion.y).mul(u.wing.y).mul(w.mul(0.5).add(0.5)).mul(isWing)
  const span = abs(p.x)
  deformBeforeInstancing(m, vec3(sign(p.x).mul(span.mul(cos(angle))), p.y.add(span.mul(sin(angle))), p.z))

  // Back vs belly: the body's height channel; the wings' and tail's sheet side.
  const sheet = step(4.5, part)
  const up = select(sheet.greaterThan(0.5), normalGeometry.y, f.y)
  let col: any = mix(u.belly, u.back, smoothstep(-0.2, 0.2, up))
  col = mix(col, u.tip, isWing.mul(smoothstep(float(1).sub(u.wing.x).sub(0.03), float(1).sub(u.wing.x), w)))
  col = hue(col, look.x).mul(look.y)
  const st = u.states
  col = col.mul(float(1).sub(st.x.mul(0.25)))
  col = mix(col, vec3(0.95, 0.96, 1), st.y.mul(smoothstep(0, 0.5, up)).mul(0.8))
  col = mix(col, vec3(0.03, 0.025, 0.02), st.z.mul(0.9))
  col = mix(col, vec3(luminance(col)), st.w.mul(0.6))
  m.colorNode = col
  m.roughnessNode = float(0.8).sub(st.x.mul(0.4))
  return m
}

/** Every setting of {@link BirdFlocks}. */
export interface BirdFlocksSettings extends FaunaLayerSettings {
  /** Species that can spawn, by id (defaults to {@link BIRD_SPECIES}). */
  species: Record<string, BirdSpecies>
}

/** Partial settings for {@link BirdFlocks.create}, `set()` and `<BirdFlocks>`. */
export type BirdFlocksInput = DeepPartial<Omit<BirdFlocksSettings, 'predators' | 'origin'>> & {
  /** Objects birds flee from. */
  predators?: Predator[]
  /** World position that is (0, 0, 0) in render space. */
  origin?: [number, number, number]
}

/** Options for {@link BirdFlocks.create}. */
export interface BirdFlocksOptions extends BirdFlocksInput, FaunaLayerOptions {}

/** Default {@link BirdFlocksSettings}: bigger tiles and range than fish. */
export const DEFAULT_BIRD_FLOCKS: BirdFlocksSettings = {
  ...DEFAULT_LAYER,
  tileSize: 256,
  maxDistance: 900,
  simDistance: 600,
  density: 4,
  minWavelength: 16,
  boids: { ...DEFAULT_LAYER.boids, verticalDamping: 0.8, wander: 1.5, lookAhead: 2 },
  species: structuredClone(BIRD_SPECIES) as Record<string, BirdSpecies>,
}

/**
 * Bird flocks streamed around the camera over the biomes each species likes (gulls over coasts, crows
 * over forests and fields, swallows over meadows, vultures over savanna), flying in a height band above
 * the ground, with wing flapping and gliding in the vertex shader.
 */
export class BirdFlocks extends FaunaLayer<BirdSpecies, BirdFlocksSettings> {
  protected readonly salt = 0xb1d5
  private readonly uniforms = new Map<string, BirdUniforms>()

  /** Creates the flocks and spawns the nearest tiles. */
  static async create(options: BirdFlocksOptions): Promise<BirdFlocks> {
    await prepareRenderer(options.renderer, 'BirdFlocks')
    const b = new BirdFlocks(options)
    b.update(0, 50)
    return b
  }

  /** Prefer {@link BirdFlocks.create}. */
  constructor({ camera, world, scene, renderer, ...input }: BirdFlocksOptions) {
    super({ camera, world, scene, renderer })
    this.object.name = 'BirdFlocks'
    this.set(input)
  }

  /** @inheritDoc */
  override set(input: BirdFlocksInput): this {
    return super.set(input)
  }

  /** @inheritDoc */
  override reset(input: BirdFlocksInput = {}): this {
    return super.reset(input)
  }

  protected defaults(): BirdFlocksSettings { return DEFAULT_BIRD_FLOCKS }
  protected species(): Readonly<Record<string, BirdSpecies>> { return this.settings.species }
  protected habitat(): Habitat<BirdSpecies> { return birdHabitat(this.world.options.biomes.map((b) => b.id)) }
  protected placementOf(sp: BirdSpecies): unknown { return [sp.biomes, sp.flight.altitude, sp.flight.overWater, sp.flock] }
  protected maxPitch(): number { return 0.5 }

  protected boidParams(sp: BirdSpecies): BoidParams {
    const v = sp.flight.speed, spacing = sp.flock.spacing
    return {
      ...DEFAULT_BOIDS,
      separationDistance: spacing, neighborRadius: spacing * 5, minDistance: spacing * 0.4,
      minSpeed: v * 0.6, maxSpeed: v * 1.4, maxAccel: v * 0.8,
      homeRadius: sp.flock.roam, margin: 1,
    }
  }

  protected initMember(sp: BirdSpecies, r: () => number, scale: Float32Array, look: Float32Array, i: number): void {
    const L = sp.length * (1 + (r() - 0.5) * 2 * sp.lengthVariation)
    scale.set([L, L, L], i * 3)
    look.set([(r() - 0.5) * 0.1, 1 + (r() - 0.5) * 0.2, r(), r()], i * 4)
  }

  protected animate(sp: BirdSpecies, g: FaunaGroup, i: number, dt: number, _speed: number, turnRate: number): number {
    const m = g.motion, fl = sp.flight
    // Glide or flap: a slow per-bird cycle (from its random) decides; climbing always flaps.
    const t = this.time * 0.25 + g.look[i * 4 + 3] * 20
    const climbing = g.flock.velocity[i * 3 + 1] > 0.5
    const flapping = climbing || 0.5 + 0.5 * Math.sin(t) + 0.15 * Math.sin(t * 2.7) > fl.glide
    const target = flapping ? 1 : 0.06
    m[i * 4 + 1] += (target - m[i * 4 + 1]) * Math.min(1, dt * 3)
    m[i * 4] += Math.PI * 2 * fl.flapRate * (0.3 + 0.7 * m[i * 4 + 1]) * dt
    return Math.max(-0.7, Math.min(0.7, -turnRate * 0.6))
  }

  protected geometryKey(sp: BirdSpecies): string { return JSON.stringify(sp.shape) }
  protected createGeometry(sp: BirdSpecies): BufferGeometry { return toGeometry(buildBirdMesh(sp.shape)) }

  protected createMaterial(id: string): Material {
    const u = createBirdUniforms()
    this.uniforms.set(id, u)
    return createBirdMaterial(u)
  }

  protected applyLook(id: string, sp: BirdSpecies): void {
    const u = this.uniforms.get(id)
    if (!u) return
    u.back.value.set(sp.colors.back)
    u.belly.value.set(sp.colors.belly)
    u.tip.value.set(sp.colors.tip)
    u.wing.value.set(sp.colors.tipLength, sp.flight.flapAmplitude)
    applyStates(u, this.settings.states)
  }
}
