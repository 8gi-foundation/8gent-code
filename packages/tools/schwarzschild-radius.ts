/**
 * Calculate Schwarzschild radius for a black hole.
 * @param mass - Mass in kg
 * @returns Radius in meters
 */
function calculateSchwarzschildRadius(mass: number): number {
  return (2 * G * mass) / (c ** 2);
}

/**
 * Calculate Hawking temperature for a black hole.
 * @param mass - Mass in kg
 * @returns Temperature in Kelvin
 */
function calculateHawkingTemperature(mass: number): number {
  return (hbar * c ** 3) / (8 * Math.PI * G * mass * k_B);
}

/**
 * Estimate evaporation time due to Hawking radiation.
 * @param mass - Mass in kg
 * @returns Time in seconds
 */
function calculateEvaporationTime(mass: number): number {
  return (5120 * Math.PI * G ** 2 * mass ** 3) / (hbar * c ** 4);
}

/**
 * Calculate tidal acceleration per unit length at event horizon.
 * @param mass - Mass in kg
 * @returns Tidal acceleration in m/s² per meter
 */
function calculateTidalForceAtEventHorizon(mass: number): number {
  return (c ** 6) / (4 * G ** 2 * mass ** 2);
}

const G = 6.6743e-11; // m³ kg⁻¹ s⁻²
const c = 299792458; // m/s
const hbar = 1.0545718e-34; // J·s
const k_B = 1.380649e-23; // J/K

export {
  calculateSchwarzschildRadius,
  calculateHawkingTemperature,
  calculateEvaporationTime,
  calculateTidalForceAtEventHorizon
};