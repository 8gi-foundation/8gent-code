/**
 * Bolometric correction values for different luminosity classes.
 */
export const BOLMETRIC_CORRECTION = {
  V: 0.1,
  III: 1.0,
  I: 1.5,
  II: 0.5,
  IV: 0.8,
  VI: 2.0,
};

/**
 * Compute distance modulus m - M.
 * @param m Apparent magnitude
 * @param M Absolute magnitude
 * @returns Distance modulus
 */
export function computeDistanceModulus(m: number, M: number): number {
  return m - M;
}

/**
 * Compute distance from apparent and absolute magnitude.
 * @param m Apparent magnitude
 * @param M Absolute magnitude
 * @returns Distance in parsecs
 */
export function computeDistance(m: number, M: number): number {
  return Math.pow(10, 1 + (m - M) / 5);
}

/**
 * Compute apparent magnitude from absolute and distance.
 * @param M Absolute magnitude
 * @param distance Distance in parsecs
 * @returns Apparent magnitude
 */
export function computeApparentMagnitude(M: number, distance: number): number {
  return M + 5 * Math.log10(distance / 10);
}

/**
 * Compute absolute magnitude from apparent and distance.
 * @param m Apparent magnitude
 * @param distance Distance in parsecs
 * @returns Absolute magnitude
 */
export function computeAbsoluteMagnitude(m: number, distance: number): number {
  return m - 5 * Math.log10(distance / 10);
}

/**
 * Compute flux ratio from magnitude difference.
 * @param m1 Magnitude 1
 * @param m2 Magnitude 2
 * @returns Flux ratio F1/F2
 */
export function fluxRatioFromMagnitude(m1: number, m2: number): number {
  return Math.pow(10, (m2 - m1) / 2.5);
}

/**
 * Compute magnitude difference from flux ratio.
 * @param fluxRatio Flux ratio F1/F2
 * @returns Magnitude difference m2 - m1
 */
export function magnitudeFromFluxRatio(fluxRatio: number): number {
  return -2.5 * Math.log10(fluxRatio);
}

/**
 * Get bolometric correction for a luminosity class.
 * @param luminosityClass Luminosity class (e.g., 'V', 'III')
 * @returns Bolometric correction
 */
export function bolometricCorrection(luminosityClass: string): number {
  return BOLMETRIC_CORRECTION[luminosityClass] || 0;
}