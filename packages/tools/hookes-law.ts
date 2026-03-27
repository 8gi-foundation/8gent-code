/**
 * Calculate spring force using Hooke's law.
 * @param k Spring constant
 * @param x Displacement from equilibrium
 * @returns Force in newtons
 */
export function calculateForce(k: number, x: number): number {
  return -k * x;
}

/**
 * Calculate elastic potential energy.
 * @param k Spring constant
 * @param x Displacement from equilibrium
 * @returns Energy in joules
 */
export function calculateElasticPotentialEnergy(k: number, x: number): number {
  return 0.5 * k * x * x;
}

/**
 * Calculate oscillation period for simple harmonic motion.
 * @param k Spring constant
 * @param m Mass
 * @returns Period in seconds
 */
export function calculateOscillationPeriod(k: number, m: number): number {
  return 2 * Math.PI * Math.sqrt(m / k);
}

/**
 * Calculate all spring parameters.
 * @param k Spring constant
 * @param m Mass
 * @param x Displacement from equilibrium
 * @returns Object with force, energy, and period
 */
export function calculateSpringParameters(k: number, m: number, x: number): {
  force: number;
  energy: number;
  period: number;
} {
  return {
    force: calculateForce(k, x),
    energy: calculateElasticPotentialEnergy(k, x),
    period: calculateOscillationPeriod(k, m)
  };
}