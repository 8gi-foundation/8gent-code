/**
 * Calculate luminosity from radius and temperature using Stefan-Boltzmann law.
 * @param radius - Radius in meters
 * @param temperature - Temperature in Kelvin
 * @returns Luminosity in watts
 */
export function luminosityFromRadiusAndTemperature(radius: number, temperature: number): number {
  const sigma = 5.67e-8;
  return 4 * Math.PI * Math.pow(radius, 2) * sigma * Math.pow(temperature, 4);
}

/**
 * Calculate radius from luminosity and temperature using Stefan-Boltzmann law.
 * @param luminosity - Luminosity in watts
 * @param temperature - Temperature in Kelvin
 * @returns Radius in meters
 */
export function radiusFromLuminosityAndTemperature(luminosity: number, temperature: number): number {
  const sigma = 5.67e-8;
  return Math.sqrt(luminosity / (4 * Math.PI * sigma * Math.pow(temperature, 4)));
}

/**
 * Estimate luminosity from mass using main sequence mass-luminosity relation.
 * @param mass - Mass in solar masses
 * @returns Luminosity in solar luminosities
 */
export function luminosityFromMass(mass: number): number {
  return Math.pow(mass, 3.5);
}

/**
 * Get approximate effective temperature from spectral class.
 * @param spectralClass - Spectral class (O, B, A, F, G, K, M)
 * @returns Effective temperature in Kelvin
 */
export function temperatureFromSpectralClass(spectralClass: string): number {
  const map: Record<string, number> = {
    O: 30000,
    B: 15000,
    A: 7500,
    F: 6000,
    G: 5700,
    K: 4000,
    M: 3000,
  };
  return map[spectralClass] || 5700;
}