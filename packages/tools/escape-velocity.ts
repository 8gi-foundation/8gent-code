/**
 * Calculate escape velocity for a celestial body.
 * @param mass - Mass in kg
 * @param radius - Radius in meters
 * @returns Escape velocity in m/s
 */
function escapeVelocity(mass: number, radius: number): number {
  return Math.sqrt(2 * 6.6743e-11 * mass / radius);
}

/**
 * Calculate orbital velocity at given altitude.
 * @param mass - Mass in kg
 * @param radius - Radius in meters
 * @returns Orbital velocity in m/s
 */
function orbitalVelocity(mass: number, radius: number): number {
  return Math.sqrt(6.6743e-11 * mass / radius);
}

/**
 * Get Earth's first, second, and third cosmic velocities.
 * @returns Object with first (orbital), second (escape), third (solar escape) velocities
 */
function getEarthCosmicVelocities(): { first: number; second: number; third: number } {
  const G = 6.6743e-11;
  const EarthMass = 5.972e24;
  const EarthRadius = 6.371e6;
  const SunMass = 1.989e30;
  const EarthOrbitalRadius = 1.496e11;
  return {
    first: orbitalVelocity(EarthMass, EarthRadius),
    second: escapeVelocity(EarthMass, EarthRadius),
    third: escapeVelocity(SunMass, EarthOrbitalRadius)
  };
}

/**
 * Get table of escape velocities for solar system bodies.
 * @returns Array of objects with name and escape velocity
 */
function getEscapeVelocitiesTable(): Array<{ name: string; escapeVelocity: number }> {
  const bodies = [
    { name: 'Earth', mass: 5.972e24, radius: 6.371e6 },
    { name: 'Moon', mass: 7.342e22, radius: 1.737e6 },
    { name: 'Sun', mass: 1.989e30, radius: 6.957e8 },
    { name: 'Mars', mass: 6.417e23, radius: 3.3895e6 },
    { name: 'Jupiter', mass: 1.898e27, radius: 6.9911e7 }
  ];
  return bodies.map(body => ({
    name: body.name,
    escapeVelocity: escapeVelocity(body.mass, body.radius)
  }));
}

export { escapeVelocity, orbitalVelocity, getEarthCosmicVelocities, getEscapeVelocitiesTable };