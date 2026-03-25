# quarantine/metrics

## What

System metrics collector for 8gent - gathers CPU, memory, disk, Ollama model status, and daemon uptime into time-series JSONL files.

## File

`packages/proactive/metrics-collector.ts` (~120 lines)

## Problem

No visibility into system resource usage or service health during agent sessions. Need lightweight, local-first telemetry to inform task routing and self-healing decisions.

## API

```ts
import { MetricsCollector, collectAndStore, systemSummary } from "./packages/proactive/metrics-collector.ts";

// Full control
const collector = new MetricsCollector();
const snapshot = await collector.collect();
await collector.store(snapshot);
const history = await collector.query({ last: 60, limit: 50 });

// One-shot
const snap = await collectAndStore();

// Human-readable summary
console.log(await systemSummary());
```

## Storage

- Location: `~/.8gent/metrics/`
- Format: JSONL, one file per day (`2026-03-25.jsonl`)
- Each line is a full `MetricsSnapshot` JSON object
- Query reads today + yesterday to handle day boundaries

## Metrics collected

| Metric | Source |
|--------|--------|
| CPU cores + load averages | `node:os` + `sysctl`/`/proc/loadavg` |
| Memory total/free/used | `node:os` |
| Disk total/used/avail | `df -g /` |
| Ollama running + model list + active models | `ollama list` / `ollama ps` |
| Daemon reachable + uptime | `fetch` to `eight-vessel.fly.dev/health` |

## Not doing

- No cron/interval scheduler (caller decides when to collect)
- No alerting or threshold system
- No dashboard UI
- No remote push - local JSONL only

## Graduation criteria

- Wire into agent loop for pre-task resource checks
- Add interval collection during long sessions
- Feed into self-autonomy reflection for resource-aware decisions
