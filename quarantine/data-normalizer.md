# data-normalizer

Data normalization and standardization: min-max, z-score, log, and robust scaling.

## Requirements
- minMax(values[], featureRange?): scales to [0,1] or custom range
- zScore(values[]): standardizes to mean=0 std=1
- log(values[], base?): log transform with zero-handling
- robust(values[]): median/IQR-based scaling resistant to outliers
- inverse(scaled, params): reverses transformation

## Status

Quarantine - pending review.

## Location

`packages/tools/data-normalizer.ts`
