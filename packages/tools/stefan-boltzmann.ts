/**
 * Constants for blackbody radiation calculations
 */
const h = 6.62607015e-34; // Planck constant
const c = 299792458; // Speed of light
const k = 1.380649e-23; // Boltzmann constant
const sigma = 5.670374419e-8; // Stefan-Boltzmann constant
const b = 2.8977719e-3; // Wien displacement constant

/**
 * Calculate total blackbody power
 * @param epsilon Emissivity (0-1)
 * @param A Surface area (m²)
 * @param T Temperature (K)
 * @returns Power in Watts
 */
export function power(epsilon: number, A: number, T: number): number {
  return epsilon * sigma * A * Math.pow(T, 4);
}

/**
 * Calculate peak wavelength using Wien's law
 * @param T Temperature (K)
 * @returns Peak wavelength in meters
 */
export function wien(T: number): number {
  return b / T;
}

/**
 * Calculate Planck spectral radiance
 * @param lambda Wavelength (m)
 * @param T Temperature (K)
 * @returns Radiance in W/(sr·m²·Hz)
 */
export function planck(lambda: number, T: number): number {
  const x = (h * c) / (lambda * k * T);
  return (2 * h * Math.pow(c, 2)) / (Math.pow(lambda, 5) * (Math.exp(x) - 1));
}

/**
 * Calculate stellar luminosity
 * @param R Radius (m)
 * @param T Temperature (K)
 * @returns Luminosity in Watts
 */
export function luminosity(R: number, T: number): number {
  return 4 * Math.PI * Math.pow(R, 2) * sigma * Math.pow(T, 4);
}