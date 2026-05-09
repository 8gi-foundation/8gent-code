/**
 * Energy calculator utility
 */
export class EnergyCalculator {
  /**
   * Calculate kinetic energy
   * @param mass - Mass in kg
   * @param velocity - Velocity in m/s
   * @returns Kinetic energy in joules
   */
  static calculateKE(mass: number, velocity: number): number {
    return 0.5 * mass * velocity ** 2;
  }

  /**
   * Calculate potential energy
   * @param mass - Mass in kg
   * @param gravity - Acceleration due to gravity (default 9.81 m/s²)
   * @param height - Height in meters
   * @returns Potential energy in joules
   */
  static calculatePE(mass: number, gravity: number = 9.81, height: number): number {
    return mass * gravity * height;
  }

  /**
   * Calculate total mechanical energy
   * @param ke - Kinetic energy
   * @param pe - Potential energy
   * @returns Total mechanical energy in joules
   */
  static calculateTotalEnergy(ke: number, pe: number): number {
    return ke + pe;
  }

  /**
   * Calculate velocity from height using energy conservation
   * @param gravity - Acceleration due to gravity (default 9.81 m/s²)
   * @param height - Height in meters
   * @returns Velocity in m/s
   */
  static velocityFromHeight(gravity: number = 9.81, height: number): number {
    return Math.sqrt(2 * gravity * height);
  }

  /**
   * Calculate height from velocity using energy conservation
   * @param gravity - Acceleration due to gravity (default 9.81 m/s²)
   * @param velocity - Velocity in m/s
   * @returns Height in meters
   */
  static heightFromVelocity(gravity: number = 9.81, velocity: number): number {
    return velocity ** 2 / (2 * gravity);
  }
}