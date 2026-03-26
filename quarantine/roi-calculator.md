# roi-calculator

ROI calculator with payback period, NPV, and IRR for project or investment analysis.

## Requirements
- simpleROI(gain, cost): (gain - cost) / cost as percent
- paybackPeriod(initialCost, annualCashFlow): years to break even
- npv(rate, cashFlows[]): net present value
- irr(cashFlows[]): internal rate of return via Newton-Raphson
- renderReport({ cost, cashFlows, rate }): formatted investment summary

## Status

Quarantine - pending review.

## Location

`packages/tools/roi-calculator.ts`
