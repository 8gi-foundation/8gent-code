# compound-interest

Compound interest calculator with period options, contribution schedules, and growth projections.

## Requirements
- calculate({ principal, rate, periods, compounds?, contributions? }): returns FV
- futureValue(principal, rate, n): standard compound formula
- withContributions(principal, rate, n, contrib, start?): PMT-adjusted FV
- growthTable(inputs, periods[]): FV at each period
- renderReport(result): formatted investment projection

## Status

Quarantine - pending review.

## Location

`packages/tools/compound-interest.ts`
