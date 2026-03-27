/**
 * Calculate rate constant using Arrhenius equation.
 * @param A Pre-exponential factor
 * @param Ea Activation energy (J/mol)
 * @param T Temperature (K)
 * @returns Rate constant k
 */
export function calculateK(A: number, Ea: number, T: number): number {
  const R = 8.314;
  return A * Math.exp(-Ea / (R * T));
}

/**
 * Calculate activation energy from two rate constants at different temperatures.
 * @param k1 Rate constant at T1
 * @param T1 Temperature 1 (K)
 * @param k2 Rate constant at T2
 * @param T2 Temperature 2 (K)
 * @returns Activation energy Ea (J/mol)
 */
export function calculateEa(k1: number, T1: number, k2: number, T2: number): number {
  const R = 8.314;
  return (Math.log(k2 / k1) * R * T1 * T2) / (T2 - T1);
}

/**
 * Calculate reaction rate for zero-order reaction.
 * @param k Rate constant
 * @returns Reaction rate
 */
export function rateZero(k: number): number {
  return k;
}

/**
 * Calculate reaction rate for first-order reaction.
 * @param concentration Concentration of reactant
 * @param k Rate constant
 * @returns Reaction rate
 */
export function rateFirst(concentration: number, k: number): number {
  return k * concentration;
}

/**
 * Calculate reaction rate for second-order reaction.
 * @param concentration Concentration of reactant
 * @param k Rate constant
 * @returns Reaction rate
 */
export function rateSecond(concentration: number, k: number): number {
  return k * concentration ** 2;
}

/**
 * Calculate half-life for zero-order reaction.
 * @param initialConcentration Initial concentration of reactant
 * @param k Rate constant
 * @returns Half-life
 */
export function halfLifeZero(initialConcentration: number, k: number): number {
  return initialConcentration / k;
}

/**
 * Calculate half-life for first-order reaction.
 * @param k Rate constant
 * @returns Half-life
 */
export function halfLifeFirst(k: number): number {
  return Math.log(2) / k;
}

/**
 * Calculate half-life for second-order reaction.
 * @param initialConcentration Initial concentration of reactant
 * @param k Rate constant
 * @returns Half-life
 */
export function halfLifeSecond(initialConcentration: number, k: number): number {
  return 1 / (k * initialConcentration);
}