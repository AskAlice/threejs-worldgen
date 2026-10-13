import { Color, Vector4 } from 'three/webgpu'
import { clamp, float, int, mix, uniformArray } from 'three/tsl'
import { CURVE_KEYS } from './options.ts'

/** Value of an evenly spaced key list at `t` in [0, 1] (linear between keys, clamped outside). */
export function evalCurve(keys: readonly number[], t: number): number {
  if (keys.length === 0) return 0
  if (keys.length === 1) return keys[0]
  const x = Math.min(1, Math.max(0, t)) * (keys.length - 1)
  const i = Math.min(keys.length - 2, Math.floor(x))
  return keys[i] + (keys[i + 1] - keys[i]) * (x - i)
}

/** `keys` resampled to `n` evenly spaced keys (the GPU always reads {@link CURVE_KEYS}). */
export function resampleCurve(keys: readonly number[], n = CURVE_KEYS): number[] {
  return Array.from({ length: n }, (_, i) => evalCurve(keys, n === 1 ? 0 : i / (n - 1)))
}

/** Colour keys (`#rrggbb`) resampled to {@link CURVE_KEYS} linear-RGB keys, with opacity keys in `w`. */
export function resampleColorCurve(colors: readonly string[], opacity: readonly number[], out: Vector4[]): Vector4[] {
  const c = colors.map((h) => new Color(h))
  const ch = (k: 'r' | 'g' | 'b') => resampleCurve(c.map((x) => x[k]))
  const r = ch('r'), g = ch('g'), b = ch('b'), a = resampleCurve(opacity)
  for (let i = 0; i < CURVE_KEYS; i++) (out[i] ??= new Vector4()).set(r[i], g[i], b[i], a[i])
  return out
}

/**
 * GPU curves: colour (rgb) + opacity (w) and size, {@link CURVE_KEYS} keys each in uniform arrays, so
 * editing a curve never rebuilds a shader.
 */
export class CurveUniforms {
  /** rgb colour + opacity keys. */
  readonly colorKeys: Vector4[] = Array.from({ length: CURVE_KEYS }, () => new Vector4(1, 1, 1, 1))
  /** Size keys (x used). */
  readonly sizeKeys: Vector4[] = Array.from({ length: CURVE_KEYS }, () => new Vector4(1, 0, 0, 0))
  /** Colour + opacity uniform array. */
  readonly color = uniformArray(this.colorKeys, 'vec4')
  /** Size uniform array. */
  readonly size = uniformArray(this.sizeKeys, 'vec4')

  /** Copies the curves in. */
  set(curves: { size: readonly number[]; opacity: readonly number[]; color: readonly string[] }): void {
    resampleColorCurve(curves.color, curves.opacity, this.colorKeys)
    resampleCurve(curves.size).forEach((v, i) => this.sizeKeys[i].set(v, 0, 0, 0))
  }

  /** Colour (rgb) and opacity (w) at life `t` (0…1). */
  colorAt(t: any): any {
    return sample(this.color, t)
  }

  /** Size multiplier at life `t` (0…1). */
  sizeAt(t: any): any {
    return sample(this.size, t).x
  }
}

function sample(arr: any, t: any): any {
  const x = clamp(t, 0, 1).mul(CURVE_KEYS - 1)
  const i = int(clamp(x.floor(), 0, CURVE_KEYS - 2))
  return mix(arr.element(i), arr.element(i.add(1)), x.sub(float(i)))
}
