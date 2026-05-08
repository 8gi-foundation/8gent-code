# market-sizing-calculator

TAM/SAM/SOM market sizing calculator with top-down and bottom-up approaches.

## Requirements
- topDown(totalMarket, targetSegmentPercent, capturePercent): returns { tam, sam, som }
- bottomUp(unitPrice, targetCustomers, penetrationRate): returns som with build-up
- compareApproaches(topDown, bottomUp): returns delta and recommendation
- renderReport(sizing): markdown market sizing summary

## Status

Quarantine - pending review.

## Location

`packages/tools/market-sizing-calculator.ts`
