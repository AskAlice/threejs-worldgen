import * as THREE from 'three/webgpu'
import { cameraPosition, distance, float, mix, mx_noise_float, pass, positionWorld, smoothstep, vec3 } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { SkyMesh } from 'three/addons/objects/SkyMesh.js'
import type { Grass, GrassMap } from 'threejs-grass'

/** Rolling hills shared by both demos. */
export const hills = (x: number, z: number) =>
  Math.sin(x * 0.03) * 4 + Math.cos(z * 0.025) * 5 + Math.sin((x + z) * 0.011) * 8

/** Keeps a camera above the terrain. Orbit controls know nothing about hills, so orbiting (or
 *  auto-rotating) at a fixed height can otherwise dip the camera under a rise. */
export function keepAboveGround(camera: THREE.Camera, height: (x: number, z: number) => number, clearance = 0.6) {
  const ground = height(camera.position.x, camera.position.z)
  if (ground === ground && camera.position.y < ground + clearance) camera.position.y = ground + clearance
}

export function hillsGeometry(size = 1000, segments = 320) {
  const geo = new THREE.PlaneGeometry(size, size, segments, segments).rotateX(-Math.PI / 2)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) pos.setY(i, hills(pos.getX(i), pos.getZ(i)))
  geo.computeVertexNormals()
  return geo
}

export const HAZE = new THREE.Color('#aebfcc')

/**
 * Photoreal-ish outdoor setup for a WebGPURenderer: physical sky + clouds, sky-lit IBL,
 * a shadow-casting sun that follows the camera, haze, ACES tone mapping and bloom.
 */
export function createEnvironment(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera) {
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.6
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap

  const sky = new SkyMesh()
  sky.scale.setScalar(4500)
  sky.turbidity.value = 2.4
  sky.rayleigh.value = 2.2
  sky.mieCoefficient.value = 0.004
  sky.mieDirectionalG.value = 0.85
  sky.cloudCoverage.value = 0.35
  sky.cloudDensity.value = 0.5

  const sun = new THREE.DirectionalLight('#fff0d8', 3.4)
  sun.castShadow = true
  sun.shadow.mapSize.set(4096, 4096)
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 400 })
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.03
  scene.add(sun, sun.target)

  scene.fog = new THREE.FogExp2(HAZE, 0.0032)

  // Image-based lighting from the sky itself, so ambient light matches what you see.
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envScene = new THREE.Scene()
  let envTarget: THREE.RenderTarget | null = null
  const sunDir = new THREE.Vector3()

  function setSun(elevationDeg: number, azimuthDeg: number) {
    sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elevationDeg), THREE.MathUtils.degToRad(azimuthDeg))
    sky.sunPosition.value.copy(sunDir)
    envScene.add(sky)
    envTarget?.dispose()
    envTarget = pmrem.fromScene(envScene as any, 0.02)
    scene.add(sky)
    scene.environment = envTarget.texture
    scene.environmentIntensity = 0.22
  }
  setSun(28, 50)

  const pipeline = new THREE.RenderPipeline(renderer)
  const scenePass = pass(scene, camera)
  const color = scenePass.getTextureNode('output')
  const bloomPass = bloom(color, 0.1, 0.25, 4) // subtle: HDR threshold keeps it to the sun and its glints
  pipeline.outputNode = color.add(bloomPass)

  /** Keep the shadow frustum centred on what the camera looks at. Snapped to texels to avoid shimmer. */
  function follow(target: THREE.Vector3) {
    const texel = 80 / sun.shadow.mapSize.x
    const x = Math.round(target.x / texel) * texel
    const z = Math.round(target.z / texel) * texel
    sun.target.position.set(x, target.y, z)
    sun.position.copy(sun.target.position).addScaledVector(sunDir, 150)
  }

  return {
    sky,
    sun,
    pipeline,
    bloomPass,
    setSun,
    follow,
    render: () => pipeline.render(),
    dispose() {
      pipeline.dispose()
      envTarget?.dispose()
      pmrem.dispose()
      scene.remove(sky, sun, sun.target)
    }
  }
}

/** Ground that looks like soil/thatch under grass and turns to a dirt path where the grass map is empty. */
export function createGroundMaterial(grass?: Grass) {
  const p = positionWorld.xz
  const n1 = mx_noise_float(p.mul(0.35)).mul(0.5).add(0.5)
  const n2 = mx_noise_float(p.mul(2.7)).mul(0.5).add(0.5)
  const n3 = mx_noise_float(p.mul(9.0)).mul(0.5).add(0.5)
  // Soil under grass: a darkened version of the grass base colour, so it suits every preset.
  const under: any = grass
    ? grass.uniforms.baseColor.mul(mix(float(0.65), float(0.95), n1.mul(n2)))
    : vec3(0.05, 0.09, 0.02)
  const dirt = mix(vec3(0.3, 0.2, 0.11), vec3(0.58, 0.44, 0.27), n2.mul(0.6).add(n3.mul(0.4)))
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 })
  const coverage = grass ? grass.mapNode(p).coverage : float(1)
  // Far away the field is thinned out, so let the ground itself take on the grass colour: no bare-looking hills.
  let ground = under
  if (grass) {
    const u = grass.uniforms
    const field = mix(u.baseColor, u.tipColor, 0.55).mul(
      float(1).add(mx_noise_float(p.mul(0.05)).mul(u.patchiness).mul(0.7))
    )
    ground = mix(under, field, smoothstep(12, 70, distance(positionWorld, cameraPosition)))
  }
  material.colorNode = mix(dirt, ground, smoothstep(0.15, 0.7, coverage))
  return material
}

/** Erases a winding dirt path into a grass map. */
export function paintPath(map: GrassMap) {
  for (let z = -150; z <= 150; z += 0.5) {
    const x = Math.sin(z * 0.045) * 14 + Math.sin(z * 0.013) * 22 + 6
    map.paint(x, z, { mode: 'erase', radius: 1.9, strength: 1 })
  }
}

/** Top-down preview of a grass map (green = grass, tan = bare). Call `update()` each frame. */
export function createMinimap(map: GrassMap, size = 160) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  Object.assign(canvas.style, {
    position: 'fixed',
    left: '12px',
    bottom: '12px',
    width: `${size}px`,
    height: `${size}px`,
    border: '1px solid #fff6',
    borderRadius: '6px',
    imageRendering: 'pixelated',
    zIndex: '10'
  })
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(128, 128)
  let version = -1
  const marker = { x: 0, z: 0 }
  function update(viewer?: THREE.Vector3) {
    if (viewer) Object.assign(marker, { x: viewer.x, z: viewer.z })
    if (map.texture.version !== version) {
      version = map.texture.version
      const step = map.resolution / 128
      for (let j = 0; j < 128; j++) {
        for (let i = 0; i < 128; i++) {
          const k = (Math.floor(j * step) * map.resolution + Math.floor(i * step)) * 4
          const c = map.data[k] / 255
          const h = map.data[k + 1] / 255
          const o = (j * 128 + i) * 4
          img.data[o] = 150 - c * 110
          img.data[o + 1] = 125 + c * (40 + h * 60)
          img.data[o + 2] = 90 - c * 60
          img.data[o + 3] = 255
        }
      }
    }
    ctx.putImageData(img, 0, 0)
    const mx = ((marker.x - map.minX) / map.size) * 128
    const mz = ((marker.z - map.minZ) / map.size) * 128
    ctx.fillStyle = '#ff3b30'
    ctx.fillRect(mx - 2, mz - 2, 4, 4)
  }
  return { canvas, update }
}
