/**
 * Calculate delta-v using Tsiolkovsky rocket equation
 * @param exhaustVelocity Exhaust velocity in m/s
 * @param massRatio Mass ratio (m0/mf)
 * @returns Delta-v in m/s
 */
export function calculateDeltaV(exhaustVelocity: number, massRatio: number): number {
  return exhaustVelocity * Math.log(massRatio)
}

/**
 * Calculate mass ratio from delta-v and exhaust velocity
 * @param deltaV Delta-v in m/s
 * @param exhaustVelocity Exhaust velocity in m/s
 * @returns Mass ratio (m0/mf)
 */
export function calculateMassRatio(deltaV: number, exhaustVelocity: number): number {
  return Math.exp(deltaV / exhaustVelocity)
}

/**
 * Calculate propellant mass required
 * @param initialMass Initial mass in kg
 * @param massRatio Mass ratio (m0/mf)
 * @returns Propellant mass in kg
 */
export function calculatePropellantMass(initialMass: number, massRatio: number): number {
  return initialMass * (1 - 1 / massRatio)
}

/**
 * Convert specific impulse to exhaust velocity
 * @param isp Specific impulse in seconds
 * @returns Exhaust velocity in m/s
 */
export function convertIspToExhaustVelocity(isp: number): number {
  return isp * 9.80665
}

/**
 * Multi-stage rocket delta-v calculator
 */
export class Rocket {
  /**
   * @param stages Array of stage configurations
   * @param stages.exhaustVelocity Exhaust velocity for stage in m/s
   * @param stages.massRatio Mass ratio for stage (m0/mf)
   */
  constructor(public stages: { exhaustVelocity: number; massRatio: number }[]) {}

  /**
   * Calculate total delta-v for all stages
   * @returns Total delta-v in m/s
   */
  totalDeltaV(): number {
    return this.stages.reduce((sum, stage) => sum + calculateDeltaV(stage.exhaustVelocity, stage.massRatio), 0)
  }
}