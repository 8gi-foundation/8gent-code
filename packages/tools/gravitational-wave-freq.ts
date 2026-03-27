const G = 6.6743e-11;
const c = 299792458;

/**
 * Calculate gravitational wave frequency from orbital frequency.
 * @param orbitalFrequency - Orbital frequency in Hz
 * @returns GW frequency in Hz (2x orbital)
 */
export function gwFrequency(orbitalFrequency: number): number {
  return 2 * orbitalFrequency;
}

/**
 * Calculate chirp mass from component masses.
 * @param m1 - Mass of first object in kg
 * @param m2 - Mass of second object in kg
 * @returns Chirp mass in kg
 */
export function chirpMass(m1: number, m2: number): number {
  return Math.pow(m1 * m2, 3/5) / Math.pow(m1 + m2, 1/5);
}

/**
 * Calculate strain amplitude h at given distance.
 * @param orbitalFrequency - Orbital frequency in Hz
 * @param distance - Distance to source in meters
 * @param chirpMass - Chirp mass in kg
 * @returns Strain amplitude h
 */
export function strain(orbitalFrequency: number, distance: number, chirpMass: number): number {
  return (4 * G / (c ** 2)) * (chirpMass ** (5/3) * (orbitalFrequency ** (2/3))) / distance;
}

/**
 * Calculate time to merger from orbital separation using Peters formula (circular orbit).
 * @param a - Orbital separation in meters
 * @param M_total - Total mass of binary system in kg
 * @returns Time to merger in seconds
 */
export function timeToMerger(a: number, M_total: number): number {
  return (5 / 256) * (Math.pow(c, 5) / (G * M_total)) * Math.pow(a, 4);
}