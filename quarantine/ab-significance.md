# ab-significance

A/B test statistical significance calculator using chi-squared and z-test for conversion rates.

## Requirements
- zTest(controlConversions, controlTotal, treatmentConversions, treatmentTotal): returns { zScore, pValue, significant }
- chiSquared(contingencyTable): chi-squared statistic and p-value
- requiredSampleSize(baseRate, mde, alpha?, power?): minimum detectable effect sample size
- renderReport(result): markdown A/B test result summary

## Status

Quarantine - pending review.

## Location

`packages/tools/ab-significance.ts`
