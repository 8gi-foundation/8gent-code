/**
 * Simulates a simple pendulum's motion, returning period, frequency, and angular frequency.
 * @param length - Length of the pendulum in meters.
 * @param gravity - Acceleration due to gravity in m/s².
 * @param mode - 'small' for small-angle approximation, 'large' for elliptic integral approximation.
 * @param angle - Maximum angle in degrees (only used in 'large' mode).
 * @returns Object with period, frequency, and angular frequency.
 */
export function simulateSimplePendulum(length: number, gravity: number, mode: 'small' | 'large', angle: number): { period: number; frequency: number; angularFrequency: number } {
  let period: number;
  if (mode === 'small') {
    period = 2 * Math.PI * Math.sqrt(length / gravity);
  } else {
    const TSmall = 2 * Math.PI * Math.sqrt(length / gravity);
    const theta0 = angle * Math.PI / 180;
    const term1 = (theta0 ** 2) / 16;
    const term2 = (11 * theta0 ** 4) / 3072;
    period = TSmall * (1 + term1 + term2);
  }
  const angularFrequency = 2 * Math.PI / period;
  const frequency = 1 / period;
  return { period, frequency, angularFrequency };
}

/**
 * Simulates a physical pendulum's motion, returning period, frequency, and angular frequency.
 * @param momentOfInertia - Moment of inertia about the pivot in kg·m².
 * @param mass - Mass of the pendulum in kg.
 * @param pivotDistance - Distance from pivot to center of mass in meters.
 * @param gravity - Acceleration due to gravity in m/s².
 * @param mode - 'small' for small-angle approximation, 'large' for elliptic integral approximation.
 * @param angle - Maximum angle in degrees (only used in 'large' mode).
 * @returns Object with period, frequency, and angular frequency.
 */
export function simulatePhysicalPendulum(momentOfInertia: number, mass: number, pivotDistance: number, gravity: number, mode: 'small' | 'large', angle: number): { period: number; frequency: number; angularFrequency: number } {
  const denominator = mass * gravity * pivotDistance;
  const effectiveLength = momentOfInertia / denominator;
  let period: number;
  if (mode === 'small') {
    period = 2 * Math.PI * Math.sqrt(effectiveLength);
  } else {
    const TSmall = 2 * Math.PI * Math.sqrt(effectiveLength);
    const theta0 = angle * Math.PI / 180;
    const term1 = (theta0 ** 2) / 16;
    const term2 = (11 * theta0 ** 4) / 3072;
    period = TSmall * (1 + term1 + term2);
  }
  const angularFrequency = 2 * Math.PI / period;
  const frequency = 1 / period;
  return { period, frequency, angularFrequency };
}