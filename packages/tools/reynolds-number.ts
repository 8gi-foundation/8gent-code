/**
 * Computes Reynolds number and classifies flow regime.
 * @param density Fluid density (kg/m³)
 * @param velocity Fluid velocity (m/s)
 * @param length Characteristic length (m)
 * @param viscosity Dynamic or kinematic viscosity
 * @param isKinematic Whether viscosity is kinematic
 * @returns Reynolds number and classification
 */
function computeReynolds(
  density: number,
  velocity: number,
  length: number,
  viscosity: number,
  isKinematic: boolean
): { re: number; classification: string } {
  let re: number;
  if (isKinematic) {
    re = (velocity * length) / viscosity;
  } else {
    re = (density * velocity * length) / viscosity;
  }

  let classification: string;
  if (re < 2300) {
    classification = 'Laminar in pipes, laminar over flat plates';
  } else if (re < 5e5) {
    classification = 'Turbulent in pipes, laminar over flat plates';
  } else if (re < 4000) {
    classification = 'Transitional in pipes, turbulent over flat plates';
  } else {
    classification = 'Turbulent in pipes, turbulent over flat plates';
  }

  return { re, classification };
}

/**
 * Returns fluid properties for common presets.
 * @param name Preset name ('water' or 'air')
 * @returns Density and dynamic viscosity
 */
function getFluidPreset(name: 'water' | 'air'): { density: number; dynamicViscosity: number } {
  switch (name) {
    case 'water':
      return { density: 998, dynamicViscosity: 0.001 };
    case 'air':
      return { density: 1.225, dynamicViscosity: 1.81e-5 };
    default:
      throw new Error('Invalid fluid preset');
  }
}

export { computeReynolds, getFluidPreset };