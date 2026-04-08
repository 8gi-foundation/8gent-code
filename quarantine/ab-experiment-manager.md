# ab-experiment-manager

A/B experiment lifecycle manager: define variants, assign users, collect results, declare winner.

## Requirements
- createExperiment(exp, { name, variants[], metric })
- assignVariant(exp, userId): deterministic variant assignment via hash
- recordResult(exp, userId, value)
- analyze(exp): returns { winner, confidence, uplift, sampleSize } per variant
- renderReport(exp): markdown experiment results report

## Status

Quarantine - pending review.

## Location

`packages/tools/ab-experiment-manager.ts`
