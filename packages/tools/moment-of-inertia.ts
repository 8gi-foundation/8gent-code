/**
 * Calculate moment of inertia for a solid sphere about an axis through its center or offset.
 * @param mass - Mass in kg
 * @param radius - Radius in meters
 * @param offset - Distance from center of mass to the axis in meters (default 0)
 * @returns Moment of inertia in kg*m^2
 */
export function solidSphere(mass: number, radius: number, offset: number = 0): number {
  return (2 / 5) * mass * radius ** 2 + mass * offset ** 2;
}

/**
 * Calculate moment of inertia for a hollow sphere about an axis through its center or offset.
 * @param mass - Mass in kg
 * @param radius - Radius in meters
 * @param offset - Distance from center of mass to the axis in meters (default 0)
 * @returns Moment of inertia in kg*m^2
 */
export function hollowSphere(mass: number, radius: number, offset: number = 0): number {
  return (2 / 3) * mass * radius ** 2 + mass * offset ** 2;
}

/**
 * Calculate moment of inertia for a solid cylinder about its central axis or offset.
 * @param mass - Mass in kg
 * @param radius - Radius in meters
 * @param height - Height in meters
 * @param offset - Distance from center of mass to the axis in meters (default 0)
 * @returns Moment of inertia in kg*m^2
 */
export function solidCylinder(mass: number, radius: number, height: number, offset: number = 0): number {
  return (1 / 2) * mass * radius ** 2 + mass * offset ** 2;
}

/**
 * Calculate moment of inertia for a hollow cylinder about its central axis or offset.
 * @param mass - Mass in kg
 * @param radius - Radius in meters
 * @param height - Height in meters
 * @param offset - Distance from center of mass to the axis in meters (default 0)
 * @returns Moment of inertia in kg*m^2
 */
export function hollowCylinder(mass: number, radius: number, height: number, offset: number = 0): number {
  return mass * radius ** 2 + mass * offset ** 2;
}

/**
 * Calculate moment of inertia for a thin rod about its center or offset.
 * @param mass - Mass in kg
 * @param length - Length in meters
 * @param offset - Distance from center of mass to the axis in meters (default 0)
 * @returns Moment of inertia in kg*m^2
 */
export function thinRod(mass: number, length: number, offset: number = 0): number {
  return (1 / 12) * mass * length ** 2 + mass * offset ** 2;
}

/**
 * Calculate moment of inertia for a rectangular plate about an axis through its center or offset.
 * @param mass - Mass in kg
 * @param width - Width in meters
 * @param height - Height in meters
 * @param offset - Distance from center of mass to the axis in meters (default 0)
 * @returns Moment of inertia in kg*m^2
 */
export function rectangularPlate(mass: number, width: number, height: number, offset: number = 0): number {
  return (1 / 12) * mass * (width ** 2 + height ** 2) + mass * offset ** 2;
}