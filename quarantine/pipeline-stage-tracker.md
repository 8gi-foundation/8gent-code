# pipeline-stage-tracker

Sales or deal pipeline tracker with stages, probabilities, and weighted forecast.

## Requirements
- addDeal(pipeline, { name, value, stage, closeDate })
- moveStage(deal, stage): records stage transition with timestamp
- forecast(pipeline): sum of value * probability for each deal
- stageConversionRate(pipeline, fromStage, toStage): historical conversion %
- renderFunnel(pipeline): ASCII funnel with deal counts and values per stage

## Status

Quarantine - pending review.

## Location

`packages/tools/pipeline-stage-tracker.ts`
