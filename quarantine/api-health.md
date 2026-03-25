# Quarantine: API Health Checker

## Problem

No visibility into whether external APIs (Ollama, OpenRouter, GitHub, Telegram) are reachable or degraded. Agents discover failures mid-task instead of proactively.

## What it does

`packages/proactive/api-health-checker.ts` pings 4 external endpoints and reports:

- **Status** - up or down
- **Latency** - round-trip ms per service
- **HTTP status code** or error message
- **Summary** - count of up/down, average latency

## Endpoints monitored

| Service | URL | Auth required |
|---------|-----|---------------|
| Ollama | `http://127.0.0.1:11434/api/tags` | No (local) |
| OpenRouter | `https://openrouter.ai/api/v1/models` | No (public) |
| GitHub | `https://api.github.com/zen` | No |
| Telegram Bot | `https://api.telegram.org/bot{token}/getMe` | Yes - `TELEGRAM_BOT_TOKEN` env var |

## Usage

```bash
# One-shot check (exit code 1 if any service is down)
bun run packages/proactive/api-health-checker.ts

# Cron mode - repeat every 60s (default)
bun run packages/proactive/api-health-checker.ts --cron

# Cron mode - custom interval (30s)
bun run packages/proactive/api-health-checker.ts --cron 30000
```

## Programmatic API

```ts
import { checkAllHealth, startCron } from "./packages/proactive/api-health-checker.ts";

// One-shot
const report = await checkAllHealth();
console.log(report.summary); // { up: 3, down: 1, avgLatencyMs: 142 }

// Cron with callback
const stop = startCron(60_000, (report) => {
  if (report.summary.down > 0) alertSomewhere(report);
});
// later: stop();
```

## Constraints

- No new dependencies - uses native `fetch` and `performance.now()`
- 8s timeout per endpoint
- Does not modify any existing files
- Telegram check requires bot token in env (gracefully fails without it)

## Not doing

- Alerting/notifications (consumer's responsibility via `onReport` callback)
- Historical storage or dashboards
- Deep health checks (model availability, rate limits)

## Success metric

Running `bun run packages/proactive/api-health-checker.ts` returns latency and status for all 4 services with exit code 0 (all up) or 1 (any down).

## Graduation criteria

Wire into the cron-manager (`packages/proactive/cron-manager.ts`) as a scheduled job. Add to TUI status bar or dashboard. Then move out of quarantine.
