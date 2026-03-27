/**
 * Relativistic physics utility functions
 * @module RelativisticPhysics
 */

const c = 299792458; // Speed of light in m/s

/**
 * Calculate Lorentz factor gamma
 * @param v - Velocity in m/s
 * @returns Gamma factor
 */
export const gamma = (v: number): number => 1 / Math.sqrt(1 - Math.pow(v / c, 2));

/**
 * Calculate relativistic kinetic energy
 * @param m - Mass in kg
 * @param v - Velocity in m/s
 * @returns Kinetic energy in joules
 */
export const relativisticKE = (m: number, v: number): number => {
  const γ = gamma(v);
  return (γ - 1) * m * Math.pow(c, 2);
};

/**
 * Calculate total relativistic energy
 * @param m - Mass in kg
 * @param v - Velocity in m/s
 * @returns Total energy in joules
 */
export const totalEnergy = (m: number, v: number): number => {
  const γ = gamma(v);
  return γ * m * Math.pow(c, 2);
};

/**
 * Calculate relativistic momentum
 * @param m - Mass in kg
 * @param v - Velocity in m/s
 * @returns Momentum in kg·m/s
 */
export const relativisticMomentum = (m: number, v: number): number => {
  const γ = gamma(v);
  return γ * m * v;
};

/**
 * Calculate time dilation
 * @param tProper - Proper time in seconds
 * @param v - Velocity in m/s
 * @returns Dilated time in seconds
 */
export const timeDilation = (tProper: number, v: number): number => {
  const γ = gamma(v);
  return γ * tProper;
};

/**
 * Calculate length contraction
 * @param lProper - Proper length in meters
 * @param v - Velocity in m/s
 * @returns Contracted length in meters
 */
export const lengthContraction = (lProper: number, v: number): number => {
  const γ = gamma(v);
  return lProper / γ;
};