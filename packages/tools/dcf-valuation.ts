/**
 * Calculate terminal value using Gordon Growth Model
 * @param lastCashFlow - Last projected cash flow
 * @param growthRate - Terminal growth rate
 * @param discountRate - Discount rate
 * @returns Terminal value
 */
export function terminalValue(lastCashFlow: number, growthRate: number, discountRate: number): number {
    return lastCashFlow * (1 + growthRate) / (discountRate - growthRate);
}

/**
 * Calculate DCF valuation
 * @param cashFlows - Array of projected cash flows
 * @param discountRate - Discount rate
 * @param terminalGrowthRate - Terminal growth rate
 * @returns NPV, terminal value, enterprise value
 */
export function calculate(cashFlows: number[], discountRate: number, terminalGrowthRate: number): { npv: number; terminalValue: number; enterpriseValue: number } {
    const lastCashFlow = cashFlows[cashFlows.length - 1];
    const tv = terminalValue(lastCashFlow, terminalGrowthRate, discountRate);
    let npv = 0;
    for (let i = 0; i < cashFlows.length; i++) {
        npv += cashFlows[i] / Math.pow(1 + discountRate, i + 1);
    }
    npv += tv / Math.pow(1 + discountRate, cashFlows.length);
    return { npv, terminalValue: tv, enterpriseValue: npv };
}

/**
 * Generate sensitivity table for NPV across rate/growth combinations
 * @param base - Base parameters
 * @param rates - Discount rates to test
 * @param growths - Terminal growth rates to test
 * @returns 2D array of NPVs
 */
export function sensitivityTable(base: { cashFlows: number[]; discountRate: number; terminalGrowthRate: number }, rates: number[], growths: number[]): number[][] {
    return rates.map(rate => 
        growths.map(growth => calculate(base.cashFlows, rate, growth).npv)
    );
}

/**
 * Calculate equity value per share
 * @param value - Enterprise value
 * @param netDebt - Net debt
 * @param shares - Outstanding shares
 * @returns Equity value per share
 */
export function perShare(value: number, netDebt: number, shares: number): number {
    return (value - netDebt) / shares;
}

/**
 * Render DCF valuation summary in markdown
 * @param result - Calculation result
 * @returns Markdown report
 */
export function renderReport(result: { npv: number; terminalValue: number; enterpriseValue: number }): string {
    return `# DCF Valuation Summary

| Metric          | Value       |
|-----------------|-------------|
| NPV             | $${result.npv.toFixed(2)} |
| Terminal Value  | $${result.terminalValue.toFixed(2)} |
| Enterprise Value| $${result.enterpriseValue.toFixed(2)} |
`;
}