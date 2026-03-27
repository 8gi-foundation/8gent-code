# monte-carlo

Monte Carlo simulation engine for risk modeling, option pricing, and probability estimation.

## Requirements
- simulate(scenarios, iterations, sampleFn): runs iterations of scenario function
- estimate(outcomes[]): mean, stddev, confidence interval
- percentile(outcomes[], p): p-th percentile of simulation results
- riskOfLoss(outcomes[], threshold): probability outcome falls below threshold
- renderHistogram(outcomes[]): ASCII result distribution

## Status

Quarantine - pending review.

## Location

`packages/tools/monte-carlo.ts`
