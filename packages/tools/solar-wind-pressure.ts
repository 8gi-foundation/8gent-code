/**
 * Calculate solar wind dynamic pressure at a given heliocentric distance.
 * @param distanceAu - Heliocentric distance in astronomical units.
 * @returns Dynamic pressure in Pascals.
 */
function dynamicPressure(distanceAu: number): number {
  const n1au = 5e6; // protons per cubic meter
  const v1au = 400e3; // meters per second
  const n = n1au / (distanceAu ** 2);
  const v = v1au / distanceAu;
  const mp = 1.67e-27; // kg
  return 0.5 * n * mp * v ** 2;
}

/**
 * Estimate magnetopause standoff distance based on pressure balance.
 * @param Bp - Planetary magnetic field at surface in Tesla.
 * @param Rp - Planetary radius in meters.
 * @param P - Solar wind dynamic pressure in Pascals.
 * @returns Standoff distance in meters.
 */
function magnetopauseStandoff(Bp: number, Rp: number, P: number): number {
  const mu0 = 4 * Math.PI * 1e-7; // H/m
  return Rp * Math.pow(Bp / Math.sqrt(2 * mu0 * P), 1/3);
}

/**
 * Estimate planetary bow shock distance assuming 3x magnetopause standoff.
 * @param Bp - Planetary magnetic field at surface in Tesla.
 * @param Rp - Planetary radius in meters.
 * @param P - Solar wind dynamic pressure in Pascals.
 * @returns Bow shock distance in meters.
 */
function planetaryBowShock(Bp: number, Rp: number, P: number): number {
  return 3 * magnetopauseStandoff(Bp, Rp, P);
}

export { dynamicPressure, magnetopauseStandoff, planetaryBowShock };