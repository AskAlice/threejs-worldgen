import { AdditiveBlending, DoubleSide, MeshBasicNodeMaterial, MeshPhysicalNodeMaterial, type Node, type NodeMaterial } from 'three/webgpu'
import { abs, attribute, float, mix, mx_noise_float, normalGeometry, positionGeometry, positionLocal, smoothstep, time, uniform, uv, vec2, vec3 } from 'three/tsl'
import { applyMaterialStatesTo, type StateLook } from 'threejs-weathering'

/** Creates the live uniforms shared by a fleet's vehicle material (exported so the type is documented). */
export function createVehicleUniforms() {
  return {
    /** Headlights and lit windows, 0…1. */
    lights: uniform(0),
    /** Dent depth at full damage, metres. */
    crumple: uniform(0.12),
  }
}

/** Uniforms of a vehicle material. */
export type VehicleUniforms = ReturnType<typeof createVehicleUniforms>

/**
 * Deforms vertices in the mesh's own space, before instancing (a material's `positionNode` runs after
 * the instance transform and would replace it, so instanced meshes deform here instead).
 */
export function deformBeforeInstancing<M extends NodeMaterial>(material: M, deformed: Node): M {
  const setup = material.setupPosition.bind(material)
  material.setupPosition = (builder) => {
    positionLocal.assign(deformed)
    return setup(builder)
  }
  return material
}

/**
 * The one material every vehicle part shares. Per vertex: `color` (own colour) and `vstyle` (paint,
 * glow, finish). Per instance: `vehicleLook` (tint rgb, heat) and `vehicleStates` (wetness, snow, burn,
 * damage, from threejs-weathering's `InstanceStates`). The tint goes in through `colorNode`, before the
 * weathering states, so snow stays white and ash stays grey on any paint. Painted surfaces are metallic
 * paint under a clear coat (lost under snow, ash and heavy damage); finishes give glass, chrome, brushed
 * stainless steel (anisotropic, brushed along the vehicle) and rubber. Damage also dents the body.
 */
export function createVehicleMaterial(u: VehicleUniforms, look?: StateLook): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial()
  const color = attribute('color', 'vec3') as any
  const style = attribute('vstyle', 'vec3') as any
  const tint = attribute('vehicleLook', 'vec4') as any
  const st = attribute('vehicleStates', 'vec4') as any
  const finish = (k: number): any => smoothstep(0.5, 0, abs(style.z.sub(k)))
  const glass = finish(1), chrome = finish(2), brushed = finish(3), rubber = finish(4)
  const painted = style.x
  m.colorNode = mix(color, tint.xyz, painted)
  let rough: any = mix(float(0.7), float(0.42), painted)
  rough = mix(rough, float(0.04), glass)
  rough = mix(rough, float(0.12), chrome)
  rough = mix(rough, float(0.3), brushed)
  m.roughnessNode = mix(rough, float(0.92), rubber)
  m.metalnessNode = painted.mul(0.45).add(chrome).add(brushed).clamp(0, 1)
  // Clear coat and brushing go under snow (on up-facing surfaces), ash and heavy damage.
  const covered = smoothstep(0.1, 0.6, normalGeometry.y).mul(st.y).oneMinus().mul(st.z.oneMinus()).mul(st.w.mul(0.6).oneMinus())
  m.clearcoatNode = painted.mul(covered)
  m.clearcoatRoughnessNode = float(0.035).add(st.w.mul(0.3))
  m.anisotropyNode = vec2(brushed.mul(0.8).mul(covered), 0)
  m.emissiveNode = color.mul(style.y).mul(u.lights).mul(4)
  const dent = mx_noise_float(positionGeometry.mul(1.3)).mul(0.5).add(0.5).mul(st.w).mul(u.crumple)
  deformBeforeInstancing(m, positionGeometry.sub(normalGeometry.mul(dent)))
  applyMaterialStatesTo(m, { wetness: st.x, snow: st.y, burn: st.z, damage: st.w, heat: tint.w.mul(0.35) }, { look, position: positionGeometry, puddles: false })
  return m
}

/**
 * Flames, rocket plumes and afterburners: additive cones (`fxLook` per instance = colour × intensity,
 * seed) flickering with noise, bright at the nozzle and fading to the tip.
 */
export function createFxMaterial(): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide })
  const fx = attribute('fxLook', 'vec4') as any
  const v = uv().y // 0 at the nozzle, 1 at the tip
  const n = mx_noise_float(vec3(uv().x.mul(6), v.mul(5).sub(time.mul(9)), fx.w.mul(17))).mul(0.5).add(0.5)
  const core = smoothstep(0.35, 0, v)
  m.colorNode = mix(fx.xyz, vec3(1, 0.95, 0.85), core.mul(0.7)).mul(n.mul(0.8).add(0.4))
  m.opacityNode = v.oneMinus().pow(1.4).mul(n.mul(0.6).add(0.4))
  return m
}

/** Foam wakes behind boats: V-shaped arms and a churned centre, fading astern (`wakeLook` = strength, seed). */
export function createWakeMaterial(): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide })
  const w = attribute('wakeLook', 'vec4') as any
  const p = uv()
  const x = abs(p.x.sub(0.5).mul(2))
  const arm = smoothstep(0.16, 0, abs(x.sub(p.y.mul(0.85).add(0.06))))
  const centre = smoothstep(0.35, 0, x).mul(smoothstep(0.7, 0, p.y))
  const n = mx_noise_float(vec3(p.x.mul(9), p.y.mul(14).sub(time.mul(1.2)), w.y)).mul(0.5).add(0.5)
  m.colorNode = vec3(0.92, 0.96, 1)
  m.opacityNode = arm.mul(0.75).add(centre.mul(0.85)).mul(n.mul(0.7).add(0.3)).mul(p.y.oneMinus().pow(1.5)).mul(w.x).clamp(0, 1)
  return m
}
