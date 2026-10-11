import { MeshStandardNodeMaterial, type Node } from 'three/webgpu'
import { abs, attribute, float, fract, max, mix, mx_noise_float, mx_worley_noise_vec2, positionWorld, smoothstep, step, uniform, vec3 } from 'three/tsl'
import { applyMaterialStatesTo, type StateLook } from 'threejs-weathering'
import type { PropMaterialId } from './catalog.ts'

/** TSL node graphs are dynamically typed; this alias keeps shader code readable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type N = any

/** 1 where `a` equals the integer code `b`, else 0. */
export const eq = (a: N, b: number): N => float(1).sub(step(0.5, abs(a.sub(b))))

/** Creates the uniforms every prop material reads (see {@link PropsOptions} for meanings). */
export function createPropUniforms() {
  return {
    /** Wetness floor for every prop, 0…1. */ wetness: uniform(0),
    /** Snow floor, 0…1. */ snow: uniform(0),
    /** Burn floor, 0…1. */ burn: uniform(0),
    /** Damage floor, 0…1. */ damage: uniform(0),
    /** Ember glow, 0…1. */ heat: uniform(0),
    /** 0 day … 1 night (used when no `night` node is given). */ night: uniform(0),
    /** Lamp brightness (emissive multiplier). */ lampIntensity: uniform(6),
    /** Seconds per traffic light cycle. */ trafficCycle: uniform(24),
  }
}

/** Uniforms of {@link createPropUniforms}. */
export type PropUniforms = ReturnType<typeof createPropUniforms>

/** Where a prop material gets its inputs. */
export interface PropMaterialContext {
  /** Shared uniforms. */
  uniforms: PropUniforms
  /** 0 day … 1 night; e.g. `sky.uniforms.night` from threejs-sky. */
  night: Node
  /** Seconds (traffic light cycles, drips, embers). */
  time: Node
  /** Weathering look (default: threejs-weathering's shared look). */
  look?: StateLook
}

/**
 * A prop material: procedural detail by material kind, tinted per instance through the `aTint`
 * attribute in `colorNode` (so snow and ash stay white and grey), weathered by the per-instance `aStates`
 * attribute (wetness, snow, burn, damage; at least the global floors). Lamps glow from `aGlow`
 * (kind, phase): street lamps at night, traffic lights cycling, both dead once badly damaged.
 */
export function createPropMaterial(id: PropMaterialId, ctx: PropMaterialContext): MeshStandardNodeMaterial {
  const u = ctx.uniforms
  const tint = attribute('aTint', 'vec3') as N
  const p = positionWorld as N
  const n = (s: number) => (mx_noise_float(p.mul(s)) as N)
  let color: N = tint
  let roughness: N = float(0.6)
  let metalness: N = float(0)
  switch (id) {
    case 'paint':
      color = tint.mul(n(3).mul(0.04).add(1)); roughness = n(5).mul(0.08).add(0.42); metalness = float(0.1); break
    case 'steel':
      color = tint.mul(n(4).mul(0.06).add(1)); roughness = n(6).mul(0.1).add(0.38); metalness = float(0.75); break
    case 'wood': {
      const grain = mx_noise_float(vec3(p.x.mul(5), p.y.mul(0.5), p.z.mul(5))) as N
      color = tint.mul(grain.mul(0.18).add(0.95).add(n(17).mul(0.05))); roughness = float(0.85); break
    }
    case 'concrete':
      color = tint.mul(n(6).mul(0.06).add(n(0.8).mul(0.05)).add(1)); roughness = float(0.9); break
    case 'stone': {
      const cells = mx_worley_noise_vec2(p.mul(3.5)) as N
      const joint = smoothstep(0, 0.08, cells.y.sub(cells.x))
      color = tint.mul(n(1.7).mul(0.14).add(0.95)).mul(mix(float(0.45), float(1), joint)); roughness = float(0.92); break
    }
    case 'adobe':
      color = tint.mul(n(0.9).mul(0.1).add(n(7).mul(0.04)).add(1)); roughness = float(0.95); break
    case 'hay': {
      const straw = mx_noise_float(vec3(p.x.mul(28), p.y.mul(3), p.z.mul(28))) as N
      color = tint.mul(straw.mul(0.22).add(0.92)); roughness = float(0.95); break
    }
    case 'glass':
      roughness = float(0.08); metalness = float(0.2); break
    case 'plastic':
      color = tint.mul(n(9).mul(0.02).add(1)); roughness = float(0.55); break
    case 'cable':
      roughness = float(0.6); metalness = float(0.3); break
    case 'lamp':
      color = tint.mul(0.25); roughness = float(0.3); break
  }
  const s = attribute('aStates', 'vec4') as N
  const states = { wetness: max(s.x, u.wetness), snow: max(s.y, u.snow), burn: max(s.z, u.burn), damage: max(s.w, u.damage), heat: u.heat }
  const m = new MeshStandardNodeMaterial()
  m.name = `props/${id}`
  m.colorNode = color
  m.roughnessNode = roughness
  m.metalnessNode = metalness
  if (id === 'lamp') {
    const g = attribute('aGlow', 'vec2') as N
    const kind = g.x
    const night = ctx.night as N
    const alive = float(1).sub(smoothstep(0.55, 0.75, states.damage)).mul(float(1).sub(smoothstep(0.4, 0.7, states.burn)))
    const c = fract((ctx.time as N).div(u.trafficCycle).add(g.y))
    const traffic = eq(kind, 2).mul(step(c, 0.5)).add(eq(kind, 4).mul(step(0.5, c)).mul(step(c, 0.9))).add(eq(kind, 3).mul(step(0.9, c)))
    const on = eq(kind, 1).mul(night).add(traffic.mul(mix(float(0.35), float(0.8), night))).mul(alive)
    m.emissiveNode = tint.mul(u.lampIntensity).mul(on)
  }
  return applyMaterialStatesTo(m, states, { look: ctx.look, time: ctx.time as N, puddles: false, streaks: id !== 'cable' && id !== 'lamp' })
}
