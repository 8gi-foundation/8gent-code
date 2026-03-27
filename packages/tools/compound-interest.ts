/**
 * Calculates future value using standard compound interest formula.
 * @param principal Initial principal amount
 * @param rate Annual interest rate (as decimal)
 * @param n Number of periods
 * @returns Future value
 */
export function futureValue(principal: number, rate: number, n: number): number {
  return principal * Math.pow(1 + rate, n);
}

/**
 * Calculates future value with periodic contributions.
 * @param principal Initial principal amount
 * @param rate Annual interest rate (as decimal)
 * @param n Number of periods
 * @param contrib Contribution amount per period
 * @param start Whether contributions start at beginning of period
 * @returns Future value including contributions
 */
export function withContributions(principal: number, rate: number, n: number, contrib: number, start?: boolean): number {
  const fvPrincipal = futureValue(principal, rate, n);
  let fvContributions = contrib * ((Math.pow(1 + rate, n) - 1) / rate);
  if (start) fvContributions *= (1 + rate);
  return fvPrincipal + fvContributions;
}

/**
 * Main compound interest calculator with optional parameters.
 * @param principal Initial principal amount
 * @param rate Annual interest rate (as decimal)
 * @param periods Number of years
 * @param compounds Compounding frequency per year
 * @param contributions Contribution details
 * @returns Future value
 */
export function calculate({
  principal,
  rate,
  periods,
  compounds,
  contributions,
}: {
  principal: number;
  rate: number;
  periods: number;
  compounds?: number;
  contributions?: number | { amount: number; start?: boolean };
}): number {
  let fv = 0;
  if (compounds !== undefined) {
    const compoundRate = rate / compounds;
    const totalPeriods = compounds * periods;
    fv = principal * Math.pow(1 + compoundRate, totalPeriods);
  } else {
    fv = futureValue(principal, rate, periods);
  }

  if (contributions !== undefined) {
    const contribAmount = typeof contributions === 'number' ? contributions : contributions.amount;
    const start = typeof contributions === 'number' ? false : contributions.start;
    const contribFv = withContributions(principal, rate, periods, contribAmount, start);
    fv += contribFv;
  }

  return fv;
}

/**
 * Generates growth table showing FV at specified periods.
 * @param inputs Calculator inputs
 * @param periods Array of periods to calculate
 * @returns Array of future values
 */
export function growthTable(inputs: {
  principal: number;
  rate: number;
  periods: number;
  compounds?: number;
  contributions?: number | { amount: number; start?: boolean };
}, periods: number[]): number[] {
  return periods.map(p => calculate({ ...inputs, periods: p }));
}

/**
 * Formats investment projection report.
 * @param result Future value result
 * @param inputs Calculator inputs
 * @returns Formatted investment report
 */
export function renderReport(result: number, inputs: {
  principal: number;
  rate: number;
  periods: number;
  compounds?: number;
  contributions?: number | { amount: number; start?: boolean };
}): string {
  return `Final Value: $${result.toFixed(2)}\nPrincipal: $${inputs.principal}\nRate: ${inputs.rate * 100}%\nPeriods: ${inputs.periods}`;
}