# Quarantine: Health Endpoint

## Problem

The daemon has no structured health check beyond a basic `/health` 200 response. Operators and monitoring tools need comprehensive status data - Ollama connectivity, memory pressure, disk space, active sessions, cron state, and recent errors - in a single JSON call.

## Constraint

Must not modify existing files. New file only (`packages/daemon/health-check.ts`).

## Not doing

- Not wiring into the gateway (that requires modifying `gateway.ts`)
- Not adding alerting or threshold logic
- Not adding authentication to the health endpoint

## Files

| File | Lines | Purpose |
|------|-------|---------|
| `packages/daemon/health-check.ts` | ~90 | `buildHealthReport(pool?)` returns `HealthReport` JSON |

## API

```ts
import { buildHealthReport } from "./health-check";

const report = await buildHealthReport(pool); // pass AgentPool for session data
// Returns HealthReport with status: "healthy" | "degraded" | "unhealthy"
```

## HealthReport shape

```json
{
  "status": "healthy | degraded | unhealthy",
  "timestamp": "ISO8601",
  "uptimeSeconds": 3600,
  "daemon": { "pid": 1234, "version": "1.0.0", "dataDir": "~/.8gent" },
  "ollama": { "reachable": true, "latencyMs": 42, "error": null },
  "memory": { "rssBytes": 0, "heapUsedBytes": 0, "heapTotalBytes": 0, "externalBytes": 0 },
  "disk": { "dataDir": "~/.8gent", "availableBytes": 0, "usedBytes": 0, "error": null },
  "sessions": { "active": 2, "list": [{ "id": "abc", "channel": "ws", "messages": 5, "busy": false }] },
  "cron": { "total": 3, "enabled": 2, "jobs": [{ "id": "daily-ceo-summary", "name": "...", "enabled": true, "lastRun": null }] },
  "lastError": null
}
```

## Status logic

- **healthy** - Ollama reachable, no errors, disk OK
- **degraded** - Ollama unreachable, or last error present, or disk check failed
- **unhealthy** - reserved for future critical failures

## Integration (next step, requires modifying gateway.ts)

Wire `buildHealthReport(pool)` into the gateway's existing `/health` route to replace the current bare 200 response.
