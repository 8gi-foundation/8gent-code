interface OhmsLawResult {
  voltage: { value: number; unit: string };
  current: { value: number; unit: string };
  resistance: { value: number; unit: string };
  power: { value: number; unit: string };
}

/**
 * Solve Ohm's law for missing variable given two of voltage, current, resistance.
 * @param params - Object with two of V, I, R (voltage, current, resistance)
 * @returns Object with all three values and power (VI) with units
 */
function solveOhmsLaw(params: { V?: number; I?: number; R?: number }): OhmsLawResult {
  const provided = Object.keys(params).filter(k => params[k as keyof typeof params] !== undefined).length;
  if (provided !== 2) throw new Error('Exactly two of V, I, R must be provided');

  let v: number | undefined;
  let i: number | undefined;
  let r: number | undefined;

  if (params.V !== undefined) v = params.V;
  if (params.I !== undefined) i = params.I;
  if (params.R !== undefined) r = params.R;

  if (v !== undefined && i !== undefined) {
    r = v / i;
  } else if (v !== undefined && r !== undefined) {
    i = v / r;
  } else if (i !== undefined && r !== undefined) {
    v = i * r;
  } else {
    throw new Error('Invalid parameters');
  }

  const power = v! * i!;

  return {
    voltage: { value: v!, unit: 'V' },
    current: { value: i!, unit: 'A' },
    resistance: { value: r!, unit: 'Ω' },
    power: { value: power, unit: 'W' },
  };
}

/**
 * Calculate total resistance for series combination.
 * @param resistors - Array of resistor values in ohms
 * @returns Total resistance in ohms
 */
function calculateSeriesResistance(resistors: number[]): { value: number; unit: string } {
  const total = resistors.reduce((sum, r) => sum + r, 0);
  return { value: total, unit: 'Ω' };
}

/**
 * Calculate total resistance for parallel combination.
 * @param resistors - Array of resistor values in ohms
 * @returns Total resistance in ohms
 */
function calculateParallelResistance(resistors: number[]): { value: number; unit: string } {
  const total = 1 / resistors.reduce((sum, r) => sum + 1 / r, 0);
  return { value: total, unit: 'Ω' };
}

export { OhmsLawResult, solveOhmsLaw, calculateSeriesResistance, calculateParallelResistance };