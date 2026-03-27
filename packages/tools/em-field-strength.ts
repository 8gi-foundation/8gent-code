/**
 * Calculate electric field from a point charge.
 * @param charge - Charge in coulombs
 * @param distance - Distance from charge in meters
 * @returns Object with magnitude (N/C) and direction description
 */
export function electricField(charge: number, distance: number): { magnitude: number; direction: string } {
  const k = 8.988e9;
  const magnitude = k * Math.abs(charge) / (distance ** 2);
  const direction = charge > 0 ? 'away from the charge' : 'toward the charge';
  return { magnitude, direction };
}

/**
 * Calculate magnetic field from an infinite current-carrying wire.
 * @param current - Current in amperes
 * @param distance - Distance from wire in meters
 * @param currentDirection - Direction of current ('up' or 'down')
 * @param positionRelative - Position relative to wire ('east' or 'west')
 * @returns Object with magnitude (tesla) and direction description
 */
export function magneticField(current: number, distance: number, currentDirection: 'up' | 'down', positionRelative: 'east' | 'west'): { magnitude: number; direction: string } {
  const mu0 = 4 * Math.PI * 1e-7;
  const magnitude = mu0 * Math.abs(current) / (2 * Math.PI * distance);
  const direction = currentDirection === 'up' 
    ? (positionRelative === 'east' ? 'into the page' : 'out of the page') 
    : (positionRelative === 'east' ? 'out of the page' : 'into the page');
  return { magnitude, direction };
}