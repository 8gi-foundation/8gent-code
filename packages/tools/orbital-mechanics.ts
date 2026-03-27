/**
 * Geostationary orbit altitude in kilometers above Earth's surface.
 */
export const GEOSTATIONARY_ALTITUDE = 35786;

const EARTH_RADIUS = 6371;
const GM = 398600;

/**
 * Computes orbital period in seconds and a human-readable string.
 * @param altitude - Orbital altitude in kilometers.
 * @returns Object with seconds and human-readable string.
 */
export function computeOrbitalPeriod(altitude: number): { seconds: number, human: string } {
  const r = EARTH_RADIUS + altitude;
  const seconds = Math.sqrt((4 * Math.PI ** 2 * r ** 3) / GM);
  return { seconds, human: formatSeconds(seconds) };
}

/**
 * Computes orbital velocity in km/s.
 * @param altitude - Orbital altitude in kilometers.
 * @returns Orbital velocity in km/s.
 */
export function computeOrbitalVelocity(altitude: number): number {
  const r = EARTH_RADIUS + altitude;
  return Math.sqrt(GM / r);
}

/**
 * Computes angular velocity in rad/s.
 * @param altitude - Orbital altitude in kilometers.
 * @returns Angular velocity in rad/s.
 */
export function computeAngularVelocity(altitude: number): number {
  const r = EARTH_RADIUS + altitude;
  return Math.sqrt(GM / (r ** 3));
}

/**
 * Computes orbital parameters.
 * @param altitude - Orbital altitude in kilometers.
 * @returns Object with period, velocity, and angular velocity.
 */
export function computeOrbitalParameters(altitude: number): {
  period: { seconds: number, human: string },
  velocity: number,
  angularVelocity: number
} {
  const r = EARTH_RADIUS + altitude;
  const seconds = Math.sqrt((4 * Math.PI ** 2 * r ** 3) / GM);
  const velocity = Math.sqrt(GM / r);
  const angularVelocity = Math.sqrt(GM / (r ** 3));
  return {
    period: { seconds, human: formatSeconds(seconds) },
    velocity,
    angularVelocity
  };
}

/**
 * Formats seconds into a human-readable string.
 * @param seconds - Total seconds.
 * @returns Formatted string.
 */
function formatSeconds(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const remaining = seconds % 86400;
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const secs = Math.floor(remaining % 60);
  const parts = [];
  if (days > 0) parts.push(`${days} day${days > 1 ? 's' : ''}`);
  if (hours > 0) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
  if (secs > 0) parts.push(`${secs} second${secs > 1 ? 's' : ''}`);
  return parts.length === 0 ? '0 seconds' : parts.join(', ');
}