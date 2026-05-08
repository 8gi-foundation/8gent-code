# dcf-valuation

Discounted cash flow (DCF) valuation model with terminal value, sensitivity table, and equity value.

## Requirements
- calculate({ cashFlows[], discountRate, terminalGrowthRate }): returns { npv, terminalValue, enterpriseValue }
- terminalValue(lastCashFlow, growthRate, discountRate): Gordon Growth Model
- sensitivityTable(base, rates[], growths[]): NPV matrix across rate/growth combos
- perShare(value, netDebt, shares): equity value per share
- renderReport(result): markdown DCF valuation summary

## Status

Quarantine - pending review.

## Location

`packages/tools/dcf-valuation.ts`
