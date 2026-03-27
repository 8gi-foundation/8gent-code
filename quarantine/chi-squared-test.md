# chi-squared-test

Chi-squared test for independence and goodness of fit with critical value lookup.

## Requirements
- goodnessOfFit(observed[], expected[]): returns { chi2, df, pValue }
- independence(contingencyTable): chi-squared test for 2D table
- pValue(chi2, df): approximates p-value using chi-squared CDF
- criticalValue(df, alpha): returns critical value for rejection
- renderReport(result): markdown test result with interpretation

## Status

Quarantine - pending review.

## Location

`packages/tools/chi-squared-test.ts`
