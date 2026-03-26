/**
 * Calculate price using cost-plus pricing strategy.
 * @param cogs - Cost of goods sold
 * @param marginPercent - Desired margin percentage (e.g. 0.2 for 20%)
 * @returns Calculated price
 */
export function costPlus(cogs: number, marginPercent: number): number {
  return cogs * (1 + marginPercent);
}

/**
 * Calculate price using value-based pricing strategy.
 * @param perceivedValue - Customer's perceived value
 * @param capturePercent - Percentage of value to capture (e.g. 0.7 for 70%)
 * @returns Calculated price
 */
export function valueBased(perceivedValue: number, capturePercent: number): number {
  return perceivedValue * capturePercent;
}

/**
 * Calculate price using competitive pricing strategy.
 * @param competitorPrice - Competitor's price
 * @param positioningOffset - Positioning offset (negative for discount, positive for premium)
 * @returns Calculated price
 */
export function competitive(competitorPrice: number, positioningOffset: number): number {
  return competitorPrice * (1 + positioningOffset);
}

/**
 * Generate tiered pricing structure with feature gates.
 * @param basePrice - Base price for the lowest tier
 * @param tiers - Array of tier definitions with minQuantity and features
 * @returns Tiered pricing configuration
 */
export function buildTiers(basePrice: number, tiers: { minQuantity: number; features: string[] }[]): { basePrice: number; tiers: { minQuantity: number; features: string[] }[] } {
  return { basePrice, tiers };
}

/**
 * Compare all pricing strategies with given inputs.
 * @param inputs - Strategy parameters including COGS, value, competition data and tiers
 * @returns Object containing all four pricing strategy results
 */
export function compareStrategies(inputs: {
  cogs: number;
  marginPercent: number;
  perceivedValue: number;
  capturePercent: number;
  competitorPrice: number;
  positioningOffset: number;
  basePrice: number;
  tiers: { minQuantity: number; features: string[] }[];
}): {
  costPlus: number;
  valueBased: number;
  competitive: number;
  tiered: { basePrice: number; tiers: { minQuantity: number; features: string[] }[] };
} {
  return {
    costPlus: costPlus(inputs.cogs, inputs.marginPercent),
    valueBased: valueBased(inputs.perceivedValue, inputs.capturePercent),
    competitive: competitive(inputs.competitorPrice, inputs.positioningOffset),
    tiered: buildTiers(inputs.basePrice, inputs.tiers),
  };
}