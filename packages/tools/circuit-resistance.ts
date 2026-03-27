/**
 * Calculate total resistance for series resistors.
 * @param resistors Array of resistor values in ohms
 * @returns Total resistance in ohms
 */
export function seriesResistance(resistors: number[]): number {
  return resistors.reduce((sum, r) => sum + r, 0);
}

/**
 * Calculate total resistance for parallel resistors.
 * @param resistors Array of resistor values in ohms
 * @returns Total resistance in ohms
 */
export function parallelResistance(resistors: number[]): number {
  return 1 / resistors.reduce((sum, r) => sum + 1 / r, 0);
}

/**
 * Calculate total resistance for a nested series/parallel network.
 * @param spec Network specification object
 * @returns Total resistance in ohms
 */
export function combinedNetwork(spec: NetworkSpec): number {
  const { type, resistors } = spec;
  const values = resistors.map(r => 
    typeof r === 'number' ? r : combinedNetwork(r)
  );
  return type === 'series' 
    ? values.reduce((sum, r) => sum + r, 0) 
    : 1 / values.reduce((sum, r) => sum + 1 / r, 0);
}

/**
 * Network specification type for combinedNetwork
 */
export type NetworkSpec = {
  type: 'series' | 'parallel';
  resistors: (number | NetworkSpec)[];
};