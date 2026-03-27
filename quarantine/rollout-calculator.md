# rollout-calculator

Progressive rollout planner: calculates staged rollout percentages, timing, and go/no-go criteria.

## Requirements
- plan({ stages, totalUsers, startDate, stageDuration }): returns stage plan
- evaluate(stage, { errorRate, latency, complaints }): go | no-go decision
- nextStage(rollout): advances to next stage or halts
- renderPlan(rollout): ASCII Gantt-style rollout timeline

## Status

Quarantine - pending review.

## Location

`packages/tools/rollout-calculator.ts`
