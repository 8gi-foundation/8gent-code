/**
 * Clamps a value between min and max.
 * @param value - The value to clamp.
 * @param min - The minimum value.
 * @param max - The maximum value.
 * @returns The clamped value.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Linear interpolation between a and b.
 * @param a - Start value.
 * @param b - End value.
 * @param t - Interpolation factor (0 to 1).
 * @returns Interpolated value.
 */
export function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

/**
 * Remaps a value from input range to output range.
 * @param value - The value to remap.
 * @param inMin - Input range minimum.
 * @param inMax - Input range maximum.
 * @param outMin - Output range minimum.
 * @param outMax - Output range maximum.
 * @returns Remapped value.
 */
export function remap(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number
): number {
  return outMin + (value - inMin) * (outMax - outMin) / (inMax - inMin);
}

/**
 * Wraps a value within the specified range.
 * @param value - The value to wrap.
 * @param min - Minimum value of the range.
 * @param max - Maximum value of the range.
 * @returns Wrapped value.
 */
export function wrap(value: number, min: number, max: number): number {
  const range = max - min;
  return ((value - min) % range + range) % range + min;
}

/**
 * Smoothly interpolates between 0 and 1.
 * @param edge0 - Lower edge.
 * @param edge1 - Upper edge.
 * @param x - Value to interpolate.
 * @returns Smooth interpolation result.
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return 3 * t * t - 2 * t * t * t;
}