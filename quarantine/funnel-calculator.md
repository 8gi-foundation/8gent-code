# funnel-calculator

Conversion funnel calculator with per-step rates, drop-off analysis, and optimization scoring.

## Requirements
- buildFunnel(steps[]): each step has { name, users }
- conversionRate(funnel, fromStep, toStep): percentage converted between steps
- biggestDropOff(funnel): step with highest drop-off
- projectRevenue(funnel, conversionValue): revenue at current conversion rates
- renderFunnel(funnel): ASCII funnel visualization

## Status

Quarantine - pending review.

## Location

`packages/tools/funnel-calculator.ts`
