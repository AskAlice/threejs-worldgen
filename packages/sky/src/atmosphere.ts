/**
 * The sky dome: physically based single scattering (Rayleigh + Mie + ozone) ray-marched per pixel in
 * TSL over a spherical planet, so it works from the ground, from a mountain top and from orbit (where
 * the planet becomes a ball with a glowing limb). Also draws the sun and moon discs.
 *
 * The dome is a sphere pinned to the camera at 98% of its far plane, so it works with any depth mode
 * (standard, reversed or logarithmic) and any camera, including cube cameras for IBL.
 */
import { BackSide, Color, Matrix3, Mesh, NodeMaterial, SphereGeometry, Vector3 } from 'three/webgpu'
import {
  Fn, If, Loop, cameraFar, cameraPosition, cameraProjectionMatrix, cameraViewMatrix, dot, exp, float, fwidth, length, max, min, mix,
  normalize, positionLocal, smoothstep, sqrt, uniform, vec3, vec4,
} from 'three/tsl'
import { moonCoverage, moonRadiance } from './moon.ts'
import { createNightLightUniforms, nightLightsNode } from './night-lights.ts'
import type { SkyState } from './observer.ts'
import type { AtmosphereOptions } from './scattering.ts'
import { hexToLinear } from './util.ts'

/** Creates the uniforms shared by every sky layer. `Sky` owns one set and drives it every frame. */
export function createSkyUniforms() {
  return {
    /** Camera position minus planet centre, render space, metres. */
    cameraToPlanet: uniform(new Vector3(0, 6.371e6, 0)),
    /** Planet radius, metres. */
    planetRadius: uniform(6.371e6),
    /** Atmosphere thickness, metres. */
    atmosphereHeight: uniform(100_000),
    /** Rayleigh scattering per metre (RGB). */
    rayleigh: uniform(new Vector3(5.802e-6, 13.558e-6, 33.1e-6)),
    /** Mie scattering per metre. */
    mie: uniform(3.996e-6),
    /** Mie absorption per metre. */
    mieAbsorption: uniform(4.4e-7),
    /** Mie anisotropy. */
    mieG: uniform(0.8),
    /** Ozone absorption per metre (RGB). */
    ozone: uniform(new Vector3(0.65e-6, 1.881e-6, 0.085e-6)),
    /** Ozone peak altitude, metres. */
    ozoneCenter: uniform(25_000),
    /** Ozone layer half-width, metres. */
    ozoneWidth: uniform(15_000),
    /** Rayleigh scale height, metres. */
    rayleighScaleHeight: uniform(8000),
    /** Mie scale height, metres. */
    mieScaleHeight: uniform(1200),
    /** Density multiplier (0 = no atmosphere). */
    density: uniform(1),
    /** Sun radiance scale. */
    sunIntensity: uniform(20),
    /** Ground albedo seen through the atmosphere where no terrain is drawn (linear RGB). */
    groundColor: uniform(new Color(0.03, 0.045, 0.03)),
    /** Faint night-sky glow (linear RGB radiance). */
    airglow: uniform(new Color(0.00025, 0.0004, 0.0009)),
    /** Towards the sun (render space). */
    sunDirection: uniform(new Vector3(0, 1, 0)),
    /** Apparent sun radius, radians. */
    sunAngularRadius: uniform(0.00465),
    /** Sun disc radiance (HDR; drives bloom). */
    sunDiscIntensity: uniform(60),
    /** Sun disc colour from the star's temperature (linear RGB). */
    sunColor: uniform(new Color(1, 1, 1)),
    /** Towards the moon (render space). */
    moonDirection: uniform(new Vector3(0, -1, 0)),
    /** Apparent moon radius, radians (0 = no moon). */
    moonAngularRadius: uniform(0),
    /** Lit fraction of the moon. */
    moonIllumination: uniform(0),
    /** Render → moon body frame. */
    moonMatrix: uniform(new Matrix3()),
    /** Multiplier on the moon's albedo map. */
    moonAlbedoScale: uniform(1),
    /** Multiplier on the moon disc's sunlit radiance. */
    moonBrightness: uniform(1),
    /** Earthshine radiance factor on the moon's dark side. */
    earthshine: uniform(0.3),
    /** How strongly moonlight lights the sky, relative to the sun. */
    moonSkyIntensity: uniform(0.02),
    /** Local up at the camera (render space). */
    up: uniform(new Vector3(0, 1, 0)),
    /** Render → star frame (fixed stars; turns with sidereal time). */
    celestialMatrix: uniform(new Matrix3()),
    /** 0 by day … 1 at night. Bind it in your own materials (e.g. lit windows). */
    night: uniform(0),
    /** Render → home planet body frame. */
    bodyMatrix: uniform(new Matrix3()),
    /** Airglow shell brightness. */
    airglowBand: uniform(1),
    /** Airglow shell colour (linear). */
    airglowBandColor: uniform(new Vector3(0.3, 1, 0.45)),
    /** Airglow shell bottom and top altitudes, metres (mesopause … Kármán line). */
    airglowShell: uniform(new Vector3(85_000, 100_000, 0)),
    /** Minimum light on the night side of the planet seen from altitude (fraction of `sunIntensity`). */
    nightFloor: uniform(0.0015),
    /** City lights on the night side. */
    nightLights: createNightLightUniforms(),
  }
}

/** The shared sky uniforms (`sky.uniforms`): TSL uniform nodes you can also read in your own materials. */
export type SkyUniforms = ReturnType<typeof createSkyUniforms>

/** Copies the per-frame state into the uniforms. */
export function applySkyState(u: SkyUniforms, s: SkyState) {
  u.cameraToPlanet.value.set(...s.cameraToPlanet)
  u.planetRadius.value = s.planetRadius
  u.sunDirection.value.set(...s.sunDirection)
  u.sunAngularRadius.value = s.sunAngularRadius
  u.moonDirection.value.set(...s.moonDirection)
  u.moonAngularRadius.value = s.moonAngularRadius
  u.moonIllumination.value = s.moonIllumination
  u.moonMatrix.value.fromArray(s.moonMatrix)
  u.celestialMatrix.value.fromArray(s.celestialMatrix)
  u.up.value.set(...s.up)
  u.night.value = s.night
  u.bodyMatrix.value.fromArray(s.bodyMatrix)
  u.nightLights.planetRadius.value = s.planetRadius
}

/** Copies atmosphere options into the uniforms. */
export function applyAtmosphere(u: SkyUniforms, a: AtmosphereOptions) {
  u.atmosphereHeight.value = a.height
  u.rayleigh.value.set(...a.rayleigh)
  u.mie.value = a.mie
  u.mieAbsorption.value = a.mieAbsorption
  u.mieG.value = a.mieG
  u.ozone.value.set(...a.ozone)
  u.ozoneCenter.value = a.ozoneCenter
  u.ozoneWidth.value = Math.max(1, a.ozoneWidth)
  u.rayleighScaleHeight.value = a.rayleighScaleHeight
  u.mieScaleHeight.value = a.mieScaleHeight
  u.density.value = a.enabled ? a.density : 0
  u.sunIntensity.value = a.sunIntensity
  u.groundColor.value.setRGB(...hexToLinear(a.groundColor))
  u.airglow.value.setRGB(...a.airglow)
  u.airglowBand.value = a.enabled ? a.airglowBand : 0
  u.airglowBandColor.value.set(...a.airglowBandColor)
  u.airglowShell.value.set(a.layers.mesosphere, Math.max(a.layers.karman, a.layers.mesosphere * 1.05), 0)
}

/** Clip-space position for a camera-centred sphere at 98% of the far plane (vertex stage). */
export const farDomePosition = (dir: any = positionLocal) =>
  cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(cameraPosition.add(normalize(dir).mul(cameraFar.mul(0.98))), 1))

/** Unit view direction of a far-dome fragment. */
export const domeDirection = () => normalize(positionLocal)

const PI = Math.PI

/** Ray-march settings baked into a sky material. */
export interface SkyMaterialOptions {
  /** Draw the sun and moon discs (off for environment maps). */
  discs: boolean
  /** View-ray samples. */
  steps: number
  /** Sun-ray samples per view sample. */
  lightSteps: number
}

/** Builds the sky colour node for view direction `d` from the shared uniforms. */
export function skyColorNode(u: SkyUniforms, d: any, { discs, steps, lightSteps }: SkyMaterialOptions): any {
  return Fn(() => {
    const R = u.planetRadius, Ra = R.add(u.atmosphereHeight)
    const o = u.cameraToPlanet
    const s = u.sunDirection
    const mieExt = u.mie.add(u.mieAbsorption)
    // Closest approach to the planet centre: stable even from very far away.
    const b = dot(o, d)
    const p = o.sub(d.mul(b))
    const p2 = dot(p, p)
    const hA2 = Ra.mul(Ra).sub(p2)
    const hG2 = R.mul(R).sub(p2)
    const groundT = b.negate().sub(sqrt(max(hG2, 0)))
    const hitsGround = hG2.greaterThan(0).and(groundT.greaterThan(0))

    // Disc edges need derivatives, which WGSL only allows outside per-pixel branches.
    const sunAng = length(d.sub(s)) // chord ≈ angle, precise for tiny discs
    const sunCover = discs ? smoothstep(u.sunAngularRadius.add(max(fwidth(sunAng), 1e-6)), u.sunAngularRadius.sub(max(fwidth(sunAng), 1e-6)), sunAng) : float(0)
    const moon = discs ? moonCoverage(u, d) : null

    const color = vec3(0).toVar()
    const viewT = vec3(1).toVar()
    const sumR = vec3(0).toVar(), sumM = vec3(0).toVar(), moonR = float(0).toVar(), moonM = float(0).toVar()

    const extinctionOf = (odR: any, odM: any, odO: any) => exp(u.rayleigh.mul(odR).add(mieExt.mul(odM)).add(u.ozone.mul(odO)).negate())
    const dens = (h: any) => ({
      r: exp(h.div(u.rayleighScaleHeight).negate()).mul(u.density),
      m: exp(h.div(u.mieScaleHeight).negate()).mul(u.density),
      o: max(float(1).sub(h.sub(u.ozoneCenter).abs().div(u.ozoneWidth)), 0).mul(u.density),
    })
    // Optical depth towards a light from `pos` (relative to the planet centre); 'lit' = 0 in the planet's shadow.
    const lightDepth = (pos: any, l: any) => {
      const bl = dot(pos, l)
      const q2 = dot(pos, pos).sub(bl.mul(bl))
      const exitT = bl.negate().add(sqrt(max(Ra.mul(Ra).sub(q2), 0)))
      const lit = smoothstep(R.mul(R).mul(0.9995), R.mul(R), q2).max(bl.greaterThan(0).select(1, 0))
      const lr = float(0).toVar(), lm = float(0).toVar(), lo = float(0).toVar()
      const lds = exitT.div(lightSteps)
      Loop(lightSteps, ({ i }) => {
        const q = pos.add(l.mul(lds.mul(float(i).add(0.5))))
        const dd = dens(length(q).sub(R))
        lr.addAssign(dd.r.mul(lds)); lm.addAssign(dd.m.mul(lds)); lo.addAssign(dd.o.mul(lds))
      })
      return { lr, lm, lo, lit }
    }

    If(hA2.greaterThan(0).and(b.negate().add(sqrt(max(hA2, 0))).greaterThan(0)).and(u.density.greaterThan(0)), () => {
      const hA = sqrt(hA2)
      const t0 = max(b.negate().sub(hA), 0)
      const t1 = hitsGround.select(groundT, b.negate().add(hA))
      const ds = t1.sub(t0).div(steps)
      const odR = float(0).toVar(), odM = float(0).toVar(), odO = float(0).toVar()
      const md = u.moonDirection
      Loop(steps, ({ i }) => {
        const t = t0.add(ds.mul(float(i).add(0.5)))
        const pos = p.add(d.mul(t.add(b))) // = o + d·t, measured from the closest point for precision
        const r = length(pos)
        const h = r.sub(R)
        const dd = dens(h)
        const dr = dd.r.mul(ds), dm = dd.m.mul(ds), dz = dd.o.mul(ds)
        odR.addAssign(dr.mul(0.5)); odM.addAssign(dm.mul(0.5)); odO.addAssign(dz.mul(0.5))
        const L = lightDepth(pos, s)
        const T = extinctionOf(odR.add(L.lr), odM.add(L.lm), odO.add(L.lo)).mul(L.lit)
        sumR.addAssign(T.mul(dr)); sumM.addAssign(T.mul(dm))
        // Moonlight: cheap airmass estimate instead of a second light march.
        const mu = dot(pos, md).div(r)
        const airmass = float(1).div(max(mu, 0).add(float(0.025).mul(exp(max(mu, 0).mul(-11)))))
        const mT = exp(u.rayleigh.y.mul(u.rayleighScaleHeight).mul(dd.r).add(mieExt.mul(u.mieScaleHeight).mul(dd.m)).mul(airmass).add(u.rayleigh.y.mul(odR)).negate())
        const mLit = smoothstep(-0.08, 0.02, mu)
        moonR.addAssign(mT.mul(mLit).mul(dr)); moonM.addAssign(mT.mul(mLit).mul(dm))
        odR.addAssign(dr.mul(0.5)); odM.addAssign(dm.mul(0.5)); odO.addAssign(dz.mul(0.5))
      })
      const mu = dot(d, s)
      const g = u.mieG, g2 = g.mul(g)
      const phase = (c: any) => ({
        r: float(3 / (16 * PI)).mul(c.mul(c).add(1)),
        m: float(3 / (8 * PI)).mul(float(1).sub(g2).mul(c.mul(c).add(1))).div(g2.add(2).mul(max(g2.add(1).sub(g.mul(2).mul(c)), 1e-6).pow(1.5))),
      })
      const ps = phase(mu)
      color.assign(u.rayleigh.mul(sumR).mul(ps.r).add(sumM.mul(u.mie).mul(ps.m)).mul(u.sunIntensity))
      const pm = phase(dot(d, md))
      const moonI = u.sunIntensity.mul(u.moonSkyIntensity).mul(u.moonIllumination).mul(u.moonAngularRadius.greaterThan(0).select(1, 0))
      color.addAssign(u.rayleigh.mul(moonR).mul(pm.r).add(vec3(moonM.mul(u.mie).mul(pm.m))).mul(moonI))
      viewT.assign(extinctionOf(odR, odM, odO))
    })

    // Airglow: a thin emitting shell at the mesopause, brightest where the ray grazes it (a green line on
    // the limb at night, seen from orbit), dark on the day side.
    If(u.airglowBand.greaterThan(0), () => {
      const tEnd = hitsGround.select(groundT, float(1e30))
      const chord = (r: any) => {
        const h = sqrt(max(r.mul(r).sub(p2), 0))
        return max(min(b.negate().add(h), tEnd).sub(max(b.negate().sub(h), 0)), 0)
      }
      const r0 = R.add(u.airglowShell.x), r1 = R.add(u.airglowShell.y)
      const path = chord(r1).sub(chord(r0))
      const mid = normalize(p.add(d.mul(max(b.negate(), 0).add(b))))
      const dark = smoothstep(0.1, -0.15, dot(mid, s))
      color.addAssign(u.airglowBandColor.mul(path.div(r1.sub(r0)).mul(dark).mul(u.airglowBand).mul(0.0006)))
    })

    If(hitsGround, () => {
      // Ground seen from altitude where no terrain is drawn: Lambert albedo lit through the atmosphere,
      // moonlight and a night floor so the night side is never pitch black, and city lights.
      const gp = p.add(d.mul(groundT.add(b)))
      const n = normalize(gp)
      const L = lightDepth(gp.add(n.mul(1)), s)
      const sunT = extinctionOf(L.lr, L.lm, L.lo)
      const lambert = max(dot(n, s), 0).mul(1 / PI)
      const ambient = smoothstep(-0.2, 0.3, dot(n, s)).mul(0.04)
      const moonLit = max(dot(n, u.moonDirection), 0).mul(u.moonSkyIntensity).mul(u.moonIllumination).mul(1 / PI)
      color.addAssign(viewT.mul(u.groundColor).mul(u.sunIntensity).mul(sunT.mul(lambert).add(ambient).add(moonLit).add(u.nightFloor)))
      const bodyN = normalize(u.bodyMatrix.mul(n)), bodyS = normalize(u.bodyMatrix.mul(s))
      color.addAssign(viewT.mul(nightLightsNode(u.nightLights, bodyN, bodyS)))
    }).Else(() => {
      color.addAssign(u.airglow.mul(smoothstep(-0.1, 0.3, dot(d, u.up)).mul(0.6).add(0.4)))
      if (moon) {
        // Sun disc with limb darkening; the moon passes in front of it (eclipses just happen).
        const r = min(sunAng.div(u.sunAngularRadius), 1)
        const limb = float(1).sub(float(0.6).mul(float(1).sub(sqrt(float(1).sub(r.mul(r))))))
        color.addAssign(viewT.mul(u.sunColor).mul(u.sunDiscIntensity).mul(limb).mul(sunCover).mul(float(1).sub(moon.coverage)))
        If(moon.coverage.greaterThan(0), () => {
          // Sky light scattered in front of the moon stays (that's why a daytime moon looks pale).
          color.addAssign(viewT.mul(moonRadiance(u, d, moon.h2, moon.D)).mul(moon.coverage))
        })
      }
    })
    return color
  })()
}

/** Creates the far-dome sphere mesh with a sky material. */
export function createSkyDome(u: SkyUniforms, options: SkyMaterialOptions): Mesh<SphereGeometry, NodeMaterial> {
  const material = new NodeMaterial()
  material.side = BackSide
  material.depthWrite = false
  material.fog = false
  material.vertexNode = farDomePosition()
  material.colorNode = vec4(skyColorNode(u, domeDirection(), options), 1)
  const mesh = new Mesh(new SphereGeometry(1, 48, 24), material)
  mesh.name = 'SkyDome'
  mesh.frustumCulled = false
  mesh.renderOrder = -1000
  return mesh
}
