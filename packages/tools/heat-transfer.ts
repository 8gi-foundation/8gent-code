/**
 * Calculate conductive heat transfer rate using Fourier's law.
 * @param k Thermal conductivity (W/(m·K))
 * @param area Cross-sectional area (m²)
 * @param deltaT Temperature difference (K)
 * @param thickness Material thickness (m)
 * @returns Heat flux in watts
 */
export function calculateConductive(k: number, area: number, deltaT: number, thickness: number): number {
  return (k * area * deltaT) / thickness
}

/**
 * Calculate convective heat transfer rate using Newton's law.
 * @param h Convective heat transfer coefficient (W/(m²·K))
 * @param area Surface area (m²)
 * @param deltaT Temperature difference (K)
 * @returns Heat flux in watts
 */
export function calculateConvective(h: number, area: number, deltaT: number): number {
  return h * area * deltaT
}

/**
 * Calculate radiative heat transfer rate using Stefan-Boltzmann law.
 * @param emissivity Emissivity (dimensionless)
 * @param area Surface area (m²)
 * @param T1 Temperature of hotter body (K)
 * @param T2 Temperature of colder body (K)
 * @returns Heat flux in watts
 */
export function calculateRadiative(emissivity: number, area: number, T1: number, T2: number): number {
  const sigma = 5.67e-8
  return emissivity * sigma * area * (Math.pow(T1, 4) - Math.pow(T2, 4))
}