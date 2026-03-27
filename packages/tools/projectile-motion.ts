/**
 * Calculates projectile motion parameters.
 * @param velocity Initial velocity in m/s
 * @param angle Launch angle in degrees
 * @param initialHeight Optional initial height above ground (default 0)
 * @param gravity Optional gravity acceleration (default 9.81 m/s²)
 * @returns Object containing range, apex height, flight time, and velocity components
 */
export function projectileMotion(
  velocity: number,
  angle: number,
  initialHeight: number = 0,
  gravity: number = 9.81
): {
  range: number;
  apexHeight: number;
  flightTime: number;
  velocityComponents: { horizontal: number; vertical: number };
} {
  const angleRad = (angle * Math.PI) / 180;
  const vx = velocity * Math.cos(angleRad);
  const vy = velocity * Math.sin(angleRad);
  const flightTime = (vy + Math.sqrt(vy ** 2 + 2 * gravity * initialHeight)) / gravity;
  const range = vx * flightTime;
  const apexHeight = initialHeight + (vy ** 2) / (2 * gravity);
  return {
    range,
    apexHeight,
    flightTime,
    velocityComponents: { horizontal: vx, vertical: vy },
  };
}