# pricing-strategy

Pricing strategy calculator supporting cost-plus, value-based, competitive, and tiered models.

## Requirements
- costPlus(cogs, marginPercent): returns price
- valueBased(perceivedValue, capturePercent): returns price
- competitive(competitorPrice, positioningOffset): returns price
- buildTiers(basePrice, tiers[]): generates tier pricing with feature gates
- compareStrategies(inputs): returns all four prices for comparison

## Status

Quarantine - pending review.

## Location

`packages/tools/pricing-strategy.ts`
