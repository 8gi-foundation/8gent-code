/**
 * Calculate Bernoulli's constant for a fluid at a given point.
 * @param P - Pressure
 * @param rho - Fluid density
 * @param v - Velocity
 * @param h - Height
 * @param g - Gravitational acceleration
 * @returns Bernoulli's constant
 */
export function calculateBernoulliConstant(P: number, rho: number, v: number, h: number, g: number): number {
  return P + 0.5 * rho * v * v + rho * g * h;
}

/**
 * Calculate velocity at a different cross-sectional area using continuity equation.
 * @param A1 - Initial area
 * @param v1 - Initial velocity
 * @param A2 - New area
 * @returns New velocity
 */
export function calculateVelocityFromArea(A1: number, v1: number, A2: number): number {
  return v1 * (A1 / A2);
}

/**
 * Calculate efflux velocity from a tank using Torricelli's theorem.
 * @param h - Height of fluid
 * @param g - Gravitational acceleration
 * @returns Efflux velocity
 */
export function calculateEffluxVelocity(h: number, g: number): number {
  return Math.sqrt(2 * g * h);
}

/**
 * Compute volumetric flow rate.
 * @param A - Cross-sectional area
 * @param v - Velocity
 * @returns Flow rate
 */
export function computeFlowRate(A: number, v: number): number {
  return A * v;
}

/**
 * Apply Bernoulli's principle to calculate pressure and velocity changes through a constriction.
 * @param P1 - Initial pressure
 * @param v1 - Initial velocity
 * @param h1 - Initial height
 * @param A1 - Initial cross-sectional area
 * @param A2 - Constricted area
 * @param h2 - Constricted height
 * @param rho - Fluid density
 * @param g - Gravitational acceleration
 * @returns Object with pressure, velocity, and flow rate
 */
export function applyBernoulli(
  P1: number,
  v1: number,
  h1: number,
  A1: number,
  A2: number,
  h2: number,
  rho: number,
  g: number
): { pressure: number; velocity: number; flowRate: number } {
  const v2 = calculateVelocityFromArea(A1, v1, A2);
  const pressure = P1 + 0.5 * rho * (v1 ** 2 - v2 ** 2) + rho * g * (h1 - h2);
  const flowRate = computeFlowRate(A2, v2);
  return { pressure, velocity: v2, flowRate };
}