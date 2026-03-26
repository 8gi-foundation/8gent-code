/**
 * Calculate simple ROI as a percentage.
 * @param gain - Total gain from investment
 * @param cost - Initial investment cost
 * @returns ROI as a percentage
 */
export function simpleROI(gain: number, cost: number): number {
  return ((gain - cost) / cost) * 100
}

/**
 * Calculate payback period in years.
 * @param initialCost - Initial investment cost
 * @param annualCashFlow - Annual cash flow
 * @returns Years to break even
 */
export function paybackPeriod(initialCost: number, annualCashFlow: number): number {
  return initialCost / annualCashFlow
}

/**
 * Calculate net present value.
 * @param rate - Discount rate
 * @param cashFlows - Array of cash flows (first item is initial cost)
 * @returns Net present value
 */
export function npv(rate: number, cashFlows: number[]): number {
  return cashFlows.reduce((sum, cf, i) => sum + cf / Math.pow(1 + rate, i), 0)
}

/**
 * Calculate internal rate of return using Newton-Raphson.
 * @param cashFlows - Array of cash flows (first item is initial cost)
 * @returns IRR as a percentage
 */
export function irr(cashFlows: number[]): number {
  let guess = 0.1
  for (let i = 0; i < 100; i++) {
    const npv = cashFlows.reduce((s, cf, j) => s + cf / Math.pow(1 + guess, j), 0)
    const dn = cashFlows.reduce((s, cf, j) => s - j * cf / Math.pow(1 + guess, j + 1), 0)
    if (Math.abs(npv) < 1e-6) return guess * 100
    guess -= npv / dn
  }
  return NaN
}

/**
 * Render investment analysis report.
 * @param params - { cost, cashFlows, rate }
 * @returns Formatted investment summary
 */
export function renderReport(params: { cost: number; cashFlows: number[]; rate: number }): string {
  const { cost, cashFlows, rate } = params
  const totalGain = cashFlows.slice(1).reduce((s, x) => s + x, 0)
  const roi = simpleROI(totalGain, cost)
  const payback = paybackPeriod(cost, cashFlows.slice(1).reduce((s, x) => s + x, 0) / cashFlows.length)
  const npvVal = npv(rate, cashFlows)
  const irrVal = irr(cashFlows)
  return `Investment Summary:\nROI: ${roi.toFixed(2)}%\nPayback: ${payback.toFixed(2)} years\nNPV: $${npvVal.toFixed(2)}\nIRR: ${irrVal.toFixed(2)}%`
}