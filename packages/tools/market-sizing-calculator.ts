/**
 * Market sizing calculator utility
 * @module MarketSizing
 */

/**
 * Calculate TAM/SAM/SOM using top-down approach
 * @param totalMarket - Total available market size
 * @param targetSegmentPercent - Target segment percentage (0-1)
 * @param capturePercent - Market capture percentage (0-1)
 * @returns TAM/SAM/SOM values
 */
export function topDown(totalMarket: number, targetSegmentPercent: number, capturePercent: number): { tam: number; sam: number; som: number } {
  return {
    tam: totalMarket,
    sam: totalMarket * targetSegmentPercent,
    som: totalMarket * targetSegmentPercent * capturePercent
  };
}

/**
 * Calculate SOM using bottom-up approach
 * @param unitPrice - Price per unit
 * @param targetCustomers - Number of target customers
 * @param penetrationRate - Expected penetration rate (0-1)
 * @returns Calculated SOM
 */
export function bottomUp(unitPrice: number, targetCustomers: number, penetrationRate: number): number {
  return unitPrice * targetCustomers * penetrationRate;
}

/**
 * Compare top-down and bottom-up approaches
 * @param topDown - Top-down sizing result
 * @param bottomUp - Bottom-up SOM value
 * @returns Delta and recommendation
 */
export function compareApproaches(topDown: { som: number }, bottomUp: number): { delta: number; recommendation: string } {
  const delta = Math.abs(topDown.som - bottomUp);
  const recommendation = topDown.som > bottomUp 
    ? "Focus on market capture optimization" 
    : "Consider customer base expansion";
  return { delta, recommendation };
}

/**
 * Generate markdown report from sizing data
 * @param sizing - Contains top-down and bottom-up results
 * @returns Formatted markdown summary
 */
export function renderReport(sizing: { topDown: { tam: number; sam: number; som: number }; bottomUp: number }): string {
  return `# Market Sizing Report

**TAM**: $${sizing.topDown.tam.toLocaleString()}
**SAM**: $${sizing.topDown.sam.toLocaleString()}
**SOM (Top-down)**: $${sizing.topDown.som.toLocaleString()}
**SOM (Bottom-up)**: $${sizing.bottomUp.toLocaleString()}

**Delta**: $${Math.abs(sizing.topDown.som - sizing.bottomUp).toLocaleString()}
**Recommendation**: ${compareApproaches(sizing.topDown, sizing.bottomUp).recommendation}`;
}