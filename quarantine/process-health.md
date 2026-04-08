# process-health

Monitor Node/Bun process health metrics.

## Requirements
- memoryUsage() returns rss, heapUsed, heapTotal in MB
- cpuUsage() returns user and system in ms
- uptime() returns seconds since start
- isUnhealthy(thresholds) checks against limits
- snapshot() returns all metrics at once

## Status

Quarantine - pending review.

## Location

`packages/tools/process-health.ts`
