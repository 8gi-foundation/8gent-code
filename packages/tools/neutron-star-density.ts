/**
 * Calculate the ratio of neutron star central density to nuclear density
 * @param M - Mass in solar masses
 * @param R - Radius in kilometers
 * @returns Central density / nuclear density
 */
export function calculateCentralDensityRatio(M: number, R: number): number {
  const solarMass = 1.98847e30; // kg
  const nuclearDensity = 2.3e17; // kg/m³
  const M_kg = M * solarMass;
  const R_m = R * 1000;
  const centralDensity = (3 * M_kg) / (4 * Math.PI * Math.pow(R_m, 3));
  return centralDensity / nuclearDensity;
}

/**
 * Calculate surface gravity of a neutron star
 * @param M - Mass in solar masses
 * @param R - Radius in kilometers
 * @returns Surface gravity in m/s²
 */
export function surfaceGravity(M: number, R: number): number {
  const G = 6.6743e-11; // m³ kg⁻¹ s⁻²
  const solarMass = 1.98847e30; // kg
  const M_kg = M * solarMass;
  const R_m = R * 1000;
  return (G * M_kg) / Math.pow(R_m, 2);
}

/**
 * Calculate escape velocity of a neutron star
 * @param M - Mass in solar masses
 * @param R - Radius in kilometers
 * @returns Escape velocity in m/s
 */
export function escapeVelocity(M: number, R: number): number {
  const G = 6.6743e-11; // m³ kg⁻¹ s⁻²
  const solarMass = 1.98847e30; // kg
  const M_kg = M * solarMass;
  const R_m = R * 1000;
  return Math.sqrt(2 * G * M_kg / R_m);
}

/**
 * Calculate breakup rotation rate (equatorial velocity = orbital velocity)
 * @param M - Mass in solar masses
 * @param R - Radius in kilometers
 * @returns Breakup angular velocity in rad/s
 */
export function breakupRotationRate(M: number, R: number): number {
  const G = 6.6743e-11; // m³ kg⁻¹ s⁻²
  const solarMass = 1.98847e30; // kg
  const M_kg = M * solarMass;
  const R_m = R * 1000;
  return Math.sqrt(G * M_kg / Math.pow(R_m, 3));
}