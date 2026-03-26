/**
 * Linear interpolation between a and b using factor t.
 * @param a - Start value.
 * @param b - End value.
 * @param t - Interpolation factor (0 to 1).
 * @returns Interpolated value.
 */
export function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a)
}

/**
 * Linear interpolation with t clamped to [0, 1].
 * @param a - Start value.
 * @param b - End value.
 * @param t - Interpolation factor.
 * @returns Interpolated value.
 */
export function lerpClamped(a: number, b: number, t: number): number {
  return lerp(a, b, Math.max(0, Math.min(1, t)))
}

/**
 * Returns interpolation factor t between a and b for given value.
 * @param a - Start value.
 * @param b - End value.
 * @param value - Value to find t for.
 * @returns t between 0 and 1.
 */
export function inverseLerp(a: number, b: number, value: number): number {
  return (value - a) / (b - a)
}

/**
 * Remaps value from [inMin, inMax] to [outMin, outMax].
 * @param value - Value to remap.
 * @param inMin - Input range minimum.
 * @param inMax - Input range maximum.
 * @param outMin - Output range minimum.
 * @param outMax - Output range maximum.
 * @returns Remapped value.
 */
export function remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return outMin + inverseLerp(inMin, inMax, value) * (outMax - outMin)
}

/**
 * Bilinear interpolation between four corners.
 * @param q11 - Top-left corner.
 * @param q12 - Top-right corner.
 * @param q21 - Bottom-left corner.
 * @param q22 - Bottom-right corner.
 * @param tx - X interpolation factor (0 to 1).
 * @param ty - Y interpolation factor (0 to 1).
 * @returns Interpolated value.
 */
export function bilinear(q11: number, q12: number, q21: number, q22: number, tx: number, ty: number): number {
  const top = lerp(q11, q12, tx)
  const bottom = lerp(q21, q22, tx)
  return lerp(top, bottom, ty)
}