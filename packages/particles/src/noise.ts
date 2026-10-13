import { Data3DTexture, LinearFilter, RepeatWrapping, RGBAFormat, UnsignedByteType } from 'three/webgpu'
import { texture3DLevel, vec3 } from 'three/tsl'

/**
 * Bakes a tileable 3D noise volume, `size³` texels × 4 channels (bytes): r, g, b are independent fBm
 * fields (a vector potential for curl noise), a is billowy fBm (smoke and flame density). Value noise
 * on an integer lattice that wraps at `size`, `octaves` octaves starting at a `base`-texel period.
 * Deterministic in `seed`. Pure (no GPU); see {@link noiseVolume} for the cached texture.
 */
export function bakeNoiseVolume(size: number, seed: number, octaves = 4, base = 8): Uint8Array {
  const n = Math.max(2, Math.floor(size))
  const out = new Uint8Array(n * n * n * 4)
  const lattice = (ch: number, period: number, x: number, y: number, z: number) => {
    const i = ((x % period) + period) % period, j = ((y % period) + period) % period, k = ((z % period) + period) % period
    let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(k, 0x9e3779b1) ^ Math.imul(ch + 1, 0x85ebca6b) ^ Math.imul(period, 0xc2b2ae35) ^ seed
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296
  }
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
  const value = (ch: number, period: number, x: number, y: number, z: number) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z)
    const fx = fade(x - x0), fy = fade(y - y0), fz = fade(z - z0)
    const l = (a: number, b: number, t: number) => a + (b - a) * t
    const c = (dx: number, dy: number, dz: number) => lattice(ch, period, x0 + dx, y0 + dy, z0 + dz)
    return l(l(l(c(0, 0, 0), c(1, 0, 0), fx), l(c(0, 1, 0), c(1, 1, 0), fx), fy), l(l(c(0, 0, 1), c(1, 0, 1), fx), l(c(0, 1, 1), c(1, 1, 1), fx), fy), fz)
  }
  const periods: number[] = []
  for (let o = 0, p = Math.max(1, Math.round(n / base)); o < octaves && p <= n; o++, p *= 2) periods.push(p)
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const k = ((z * n + y) * n + x) * 4
    for (let ch = 0; ch < 4; ch++) {
      let sum = 0, amp = 0.5, norm = 0
      for (const p of periods) {
        const s = p / n
        let v = value(ch, p, x * s, y * s, z * s)
        if (ch === 3) v = 1 - Math.abs(v * 2 - 1) // billows
        sum += v * amp
        norm += amp
        amp *= 0.5
      }
      out[k + ch] = Math.round((sum / norm) * 255)
    }
  }
  return out
}

const cache = new Map<string, Data3DTexture>()

/** A shared, cached {@link bakeNoiseVolume} texture (linear filtered, repeating). */
export function noiseVolume(seed = 1, size = 64): Data3DTexture {
  const key = `${seed}|${size}`
  let tex = cache.get(key)
  if (!tex) {
    tex = new Data3DTexture(bakeNoiseVolume(size, seed), size, size, size)
    tex.format = RGBAFormat
    tex.type = UnsignedByteType
    tex.minFilter = tex.magFilter = LinearFilter
    tex.wrapS = tex.wrapT = tex.wrapR = RepeatWrapping
    tex.unpackAlignment = 1
    tex.needsUpdate = true
    cache.set(key, tex)
  }
  return tex
}

/** The noise volume at `p` (texture space, 1 = one tile), all four channels 0…1. Works in any stage. */
export function sampleNoise(tex: Data3DTexture, p: any): any {
  return texture3DLevel(tex, p, 0)
}

/**
 * Divergence-free curl noise at `p` (texture space): the curl of the volume's rgb vector potential by
 * central differences (six taps). Roughly unit amplitude.
 */
export function curlNoise(tex: Data3DTexture, p: any): any {
  const e = 1 / 64
  const s = (o: any) => sampleNoise(tex, p.add(o))
  const dx0 = s(vec3(-e, 0, 0)), dx1 = s(vec3(e, 0, 0))
  const dy0 = s(vec3(0, -e, 0)), dy1 = s(vec3(0, e, 0))
  const dz0 = s(vec3(0, 0, -e)), dz1 = s(vec3(0, 0, e))
  // curl ψ = (∂ψz/∂y − ∂ψy/∂z, ∂ψx/∂z − ∂ψz/∂x, ∂ψy/∂x − ∂ψx/∂y)
  return vec3(
    dy1.z.sub(dy0.z).sub(dz1.y.sub(dz0.y)),
    dz1.x.sub(dz0.x).sub(dx1.z.sub(dx0.z)),
    dx1.y.sub(dx0.y).sub(dy1.x.sub(dy0.x)),
  ).mul(1 / (2 * e) / 6)
}
