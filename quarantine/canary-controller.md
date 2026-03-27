# canary-controller

Canary release controller with traffic split percentages, error rate monitoring, and auto-rollback.

## Requirements
- startCanary(config, { canaryVersion, initialPercent })
- promote(canary, incrementPercent): increases canary traffic
- rollback(canary, reason): returns to 0% canary
- shouldRollback(canary, { errorRate, latencyP99 }, thresholds): auto-rollback check
- renderStatus(canary): traffic split and health metrics

## Status

Quarantine - pending review.

## Location

`packages/tools/canary-controller.ts`
