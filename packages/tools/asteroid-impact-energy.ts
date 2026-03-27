/**
 * Calculate kinetic energy and convert to megatons TNT
 * @param mass - mass in kg
 * @param velocity - velocity in m/s
 * @returns object with energy in joules and megatons
 */
export function calculateKineticEnergy(mass: number, velocity: number): { energyJ: number; energyMt: number } {
  const keJ = 0.5 * mass * velocity ** 2;
  const keMt = keJ / 4.184e15;
  return { energyJ: keJ, energyMt: keMt };
}

/**
 * Estimate crater diameter using Pi-group scaling law
 * @param energyJ - energy in joules
 * @returns crater diameter in meters
 */
export function estimateCraterDiameter(energyJ: number): number {
  return 0.5 * energyJ ** 0.38;
}

/**
 * Estimate airburst altitude based on energy
 * @param energyJ - energy in joules
 * @returns altitude in kilometers
 */
export function estimateAirburstAltitude(energyJ: number): number {
  return 0.01 * energyJ ** 0.3;
}

/**
 * Impact benchmarks: Tunguska and Chicxulub
 */
export function getImpactBenchmarks(): { [key: string]: { energyMt: number; craterDiameterM: number; airburstAltitudeKm: number } } {
  return {
    Tunguska: {
      energyMt: 15,
      craterDiameterM: 0,
      airburstAltitudeKm: 8
    },
    Chicxulub: {
      energyMt: 1e8,
      craterDiameterM: 150000,
      airburstAltitudeKm: 0
    }
  };
}