/**
 * math-clamp: numeric utility functions for UI layout, animation, and mapping.
 *
 * Functions: clamp, lerp, inverseLerp, remap, roundTo, snap, wrap, distance, sign, isInRange
 */

/**
 * Constrain a value between min and max (inclusive).
 * @example clamp(15, 0, 10) // 10
 */
export function clamp(val: number, min: number, max: number): number {
  if (min > max) throw new RangeError(`clamp: min (${min}) must be <= max (${max})`);
  return Math.min(Math.max(val, min), max);
}

/**
 * Linear interpolation between two values.
 * t=0 returns a, t=1 returns b. t is not clamped.
 * @example lerp(0, 100, 0.5) // 50
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Inverse of lerp. Returns the t that maps val back to the [a, b] range.
 * Throws if a === b (degenerate range).
 * @example inverseLerp(0, 100, 50) // 0.5
 */
export function inverseLerp(a: number, b: number, val: number): number {
  if (a === b) throw new RangeError(`inverseLerp: a and b must be different (both are ${a})`);
  return (val - a) / (b - a);
}

/**
 * Remap val from one range to another. Does not clamp output.
 * @example remap(5, 0, 10, 0, 100) // 50
 */
export function remap(
  val: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number
): number {
  const t = inverseLerp(inMin, inMax, val);
  return lerp(outMin, outMax, t);
}

/**
 * Round val to a given number of decimal places.
 * @example roundTo(3.14159, 2) // 3.14
 */
export function roundTo(val: number, decimals: number): number {
  if (decimals < 0) throw new RangeError(`roundTo: decimals must be >= 0, got ${decimals}`);
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

/**
 * Snap val to the nearest multiple of step.
 * @example snap(7, 5) // 5
 * @example snap(8, 5) // 10
 */
export function snap(val: number, step: number): number {
  if (step <= 0) throw new RangeError(`snap: step must be > 0, got ${step}`);
  return Math.round(val / step) * step;
}

/**
 * Wrap val into the [min, max) range using modular arithmetic.
 * Useful for cyclic values like angles or loop indices.
 * @example wrap(370, 0, 360) // 10
 * @example wrap(-10, 0, 360) // 350
 */
export function wrap(val: number, min: number, max: number): number {
  if (min >= max) throw new RangeError(`wrap: min (${min}) must be < max (${max})`);
  const range = max - min;
  return ((((val - min) % range) + range) % range) + min;
}

/**
 * Euclidean distance between two 1D points.
 * @example distance(3, 7) // 4
 */
export function distance(a: number, b: number): number {
  return Math.abs(b - a);
}

/**
 * Returns -1, 0, or 1 depending on the sign of val.
 * @example sign(-5) // -1
 * @example sign(0)  // 0
 * @example sign(3)  // 1
 */
export function sign(val: number): -1 | 0 | 1 {
  if (val < 0) return -1;
  if (val > 0) return 1;
  return 0;
}

/**
 * Returns true if val is within [min, max] (inclusive by default).
 * @param exclusive - if true, uses strict inequality (excludes endpoints)
 * @example isInRange(5, 0, 10)       // true
 * @example isInRange(0, 0, 10)       // true
 * @example isInRange(0, 0, 10, true) // false
 */
export function isInRange(
  val: number,
  min: number,
  max: number,
  exclusive = false
): boolean {
  if (exclusive) return val > min && val < max;
  return val >= min && val <= max;
}
