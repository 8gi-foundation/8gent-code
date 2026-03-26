# nps-calculator

NPS (Net Promoter Score) calculator with cohort segmentation and trend analysis.

## Requirements
- calculate(scores[]): returns { nps, promoters, passives, detractors, counts }
- trend(scoresByPeriod{}): returns NPS per period and MoM delta
- segmentBySource(responses[], sourceKey): NPS broken down by segment
- renderSummary(result): formatted NPS report with benchmark comparison

## Status

Quarantine - pending review.

## Location

`packages/tools/nps-calculator.ts`
