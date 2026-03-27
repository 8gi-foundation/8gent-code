/**
 * Calculate surface gravity, weight on other worlds, and gravitational acceleration at altitude.
 * @module GravityUtils
 */

const G = 6.6743e-11;
const EARTH_MASS = 5.972e24;
const EARTH_RADIUS = 6.371e6;

/**
 * Represents a celestial body with mass, radius, and rotation period.
 */
class CelestialBody {
  mass: number;
  radius: number;
  rotationPeriod?: number;

  constructor(mass: number, radius: number, rotationPeriod?: number) {
    this.mass = mass;
    this.radius = radius;
    this.rotationPeriod = rotationPeriod;
  }

  /**
   * Predefined gravity multipliers relative to Earth.
   */
  static readonly multipliers: Record<string, number> = {
    Earth: 1.0,
    Moon: 0.165,
    Mars: 0.378,
    Jupiter: 2.528,
    Saturn: 1.065,
    Uranus: 0.889,
    Neptune: 1.14,
    Venus: 0.904,
    Mercury: 0.377,
    Pluto: 0.062,
  };
}

/**
 * Calculate surface gravity considering equatorial rotation effects.
 * @param body - Celestial body properties.
 * @returns Surface gravity in m/s².
 */
function calculateSurfaceGravity(body: CelestialBody): number {
  const g = (G * body.mass) / (body.radius ** 2);
  if (body.rotationPeriod) {
    const omega = (2 * Math.PI) / body.rotationPeriod;
    const centrifugal = omega ** 2 * body.radius;
    return g - centrifugal;
  }
  return g;
}

/**
 * Calculate gravitational acceleration at a given altitude.
 * @param g0 - Surface gravity at sea level.
 * @param R - Planet radius.
 * @param h - Altitude above surface.
 * @returns Gravity at altitude in m/s².
 */
function calculateAltitudeGravity(g0: number, R: number, h: number): number {
  return g0 * (R / (R + h)) ** 2;
}

/**
 * Calculate weight on another world using predefined multipliers.
 * @param earthWeight - Weight on Earth in Newtons.
 * @param bodyName - Name of celestial body.
 * @returns Weight on target body in Newtons.
 */
function calculateWeightOnBody(earthWeight: number, bodyName: string): number {
  const multiplier = CelestialBody.multipliers[bodyName];
  return earthWeight * multiplier;
}

export { CelestialBody, calculateSurfaceGravity, calculateAltitudeGravity, calculateWeightOnBody };