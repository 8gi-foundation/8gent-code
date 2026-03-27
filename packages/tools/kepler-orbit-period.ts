/**
 * Computes orbital period using Kepler's third law.
 * @param a - Semi-major axis
 * @param GM - Gravitational parameter (G*M)
 * @returns Orbital period T
 */
export function computeOrbitalPeriod(a: number, GM: number): number {
  return Math.sqrt((4 * Math.PI ** 2 * a ** 3) / GM);
}

/**
 * Computes semi-major axis from orbital period.
 * @param T - Orbital period
 * @param GM - Gravitational parameter (G*M)
 * @returns Semi-major axis a
 */
export function computeSemiMajorAxis(T: number, GM: number): number {
  return Math.pow((T ** 2 * GM) / (4 * Math.PI ** 2), 1/3);
}

/**
 * Computes orbital speed using vis-viva equation.
 * @param r - Distance from central body
 * @param a - Semi-major axis
 * @param GM - Gravitational parameter (G*M)
 * @returns Orbital speed v
 */
export function computeOrbitalSpeed(r: number, a: number, GM: number): number {
  return Math.sqrt(GM * (2 / r - 1 / a));
}

/**
 * Computes ellipse parameters from periapsis and apoapsis.
 * @param q - Periapsis distance
 * @param Q - Apoapsis distance
 * @returns Object with semi-major axis, eccentricity, semi-minor axis
 */
export function computeEllipseParams(q: number, Q: number): {a: number; e: number; b: number} {
  const a = (q + Q) / 2;
  const e = (Q - q) / (Q + q);
  const b = a * Math.sqrt(1 - e ** 2);
  return { a, e, b };
}

/**
 * Computes synodic period from two orbital periods.
 * @param P1 - First orbital period
 * @param P2 - Second orbital period
 * @returns Synodic period
 */
export function computeSynodicPeriod(P1: number, P2: number): number {
  return 1 / Math.abs(1 / P1 - 1 / P2);
}