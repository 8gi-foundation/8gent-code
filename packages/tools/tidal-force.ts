/**
 * Calculate tidal acceleration.
 * @param G - Gravitational constant
 * @param M - Mass of primary body
 * @param r - Radius of satellite
 * @param d - Distance between centers
 * @returns Tidal acceleration
 */
export function tidalAcceleration(G: number, M: number, r: number, d: number): number {
  return 2 * G * M * r / Math.pow(d, 3);
}

/**
 * Calculate Roche limit for rigid body.
 * @param R - Radius of primary
 * @param densityPrimary - Density of primary
 * @param densitySatellite - Density of satellite
 * @returns Roche limit distance
 */
export function rocheLimitRigid(R: number, densityPrimary: number, densitySatellite: number): number {
  return 2.44 * R * Math.pow(densityPrimary / densitySatellite, 1/3);
}

/**
 * Calculate Roche limit for fluid body.
 * @param R - Radius of primary
 * @param densityPrimary - Density of primary
 * @param densitySatellite - Density of satellite
 * @returns Roche limit distance
 */
export function rocheLimitFluid(R: number, densityPrimary: number, densitySatellite: number): number {
  const ratio = densityPrimary / densitySatellite;
  return 2.44 * R * Math.pow(ratio, 1/3) * (1 + (1/3) * (ratio - 1));
}

/**
 * Estimate tidal heating power.
 * @param k2 - Tidal Love number
 * @param R - Radius of satellite
 * @param omega - Orbital angular velocity
 * @param e - Orbital eccentricity
 * @param d - Distance between centers
 * @returns Estimated tidal heating power
 */
export function tidalHeatingPower(k2: number, R: number, omega: number, e: number, d: number): number {
  return (21/2) * k2 * Math.pow(R, 5) * Math.pow(omega, 2) * Math.pow(e, 2) / Math.pow(d, 6);
}

/**
 * Estimate tidal locking timescale.
 * @param I - Moment of inertia
 * @param omega - Orbital angular velocity
 * @param k2 - Tidal Love number
 * @param R - Radius of satellite
 * @param e - Orbital eccentricity
 * @param d - Distance between centers
 * @returns Tidal locking timescale
 */
export function tidalLockingTimescale(I: number, omega: number, k2: number, R: number, e: number, d: number): number {
  return (I * Math.pow(d, 6)) / ((21/2) * k2 * Math.pow(R, 5) * omega * Math.pow(e, 2));
}