/**
 * Interface for a single step in the conversion funnel
 */
interface FunnelStep {
  name: string;
  users: number;
}

/**
 * Interface for the conversion funnel
 */
interface Funnel {
  steps: FunnelStep[];
}

/**
 * Build a conversion funnel from an array of steps
 * @param steps - Array of FunnelStep objects
 * @returns Funnel object
 */
function buildFunnel(steps: FunnelStep[]): Funnel {
  return { steps };
}

/**
 * Calculate conversion rate between steps in the funnel
 * @param funnel - The funnel object
 * @param fromStep - Index of starting step
 * @param toStep - Index of ending step
 * @returns Conversion rate percentage
 */
function conversionRate(funnel: Funnel, fromStep: number, toStep: number): number {
  if (fromStep < 0 || toStep >= funnel.steps.length || fromStep >= toStep) {
    return 0;
  }
  const fromUsers = funnel.steps[fromStep].users;
  const toUsers = funnel.steps[toStep].users;
  return (toUsers / fromUsers) * 100;
}

/**
 * Find the step with the highest drop-off
 * @param funnel - The funnel object
 * @returns Object with step index and drop-off value, or null
 */
function biggestDropOff(funnel: Funnel): { step: number; dropOff: number } | null {
  let maxDrop = 0;
  let maxStep = -1;
  for (let i = 0; i < funnel.steps.length - 1; i++) {
    const drop = funnel.steps[i].users - funnel.steps[i + 1].users;
    if (drop > maxDrop) {
      maxDrop = drop;
      maxStep = i;
    }
  }
  return maxStep === -1 ? null : { step: maxStep, dropOff: maxDrop };
}

/**
 * Calculate projected revenue based on conversion value
 * @param funnel - The funnel object
 * @param conversionValue - Value per conversion
 * @returns Projected revenue
 */
function projectRevenue(funnel: Funnel, conversionValue: number): number {
  return funnel.steps[funnel.steps.length - 1].users * conversionValue;
}

/**
 * Render funnel as ASCII visualization
 * @param funnel - The funnel object
 * @returns ASCII string representation
 */
function renderFunnel(funnel: Funnel): string {
  const lines = [];
  for (let i = 0; i < funnel.steps.length; i++) {
    lines.push(`${funnel.steps[i].name}: ${funnel.steps[i].users} users`);
    if (i < funnel.steps.length - 1) {
      lines.push('  -->');
    }
  }
  return lines.join('\n');
}

export { buildFunnel, conversionRate, biggestDropOff, projectRevenue, renderFunnel };