# Quarantine: Daemon Health Endpoint

**Status:** quarantine - ready for integration review

## What it does

Adds a lightweight HTTP server to the Eight daemon that exposes three standard
probe endpoints on a dedicated port (default 18790, separate from the WebSocket
gateway on 18789).

| Endpoint | Purpose | HTTP status |
|----------|---------|-------------|
| `GET /health` | Liveness - is the process alive? | 200 always |
| `GET /ready` | Readiness - is the daemon ready to accept work? | 200 ready / 503 not ready |
| `GET /metrics` | Runtime snapshot: sessions, memory, uptime, PID | 200 always |

## Files

- `packages/daemon/health-endpoint.ts` - implementation, zero deps, uses only `Bun.serve`

## Integration (NOT done in this PR)

To wire into the daemon, add to `packages/daemon/index.ts`:

```ts
import { createHealthServer } from "./health-endpoint";

// inside main(), after pool is created:
const health = createHealthServer({ pool, port: 18790 });

// inside shutdown():
health.stop();
```

The `pool` passed in must expose `getActiveSessions()`. Optionally expose
`getSessions()` on `AgentPool` for per-session detail in `/metrics`.

## Why quarantined

- Does not modify any existing files - safe to merge at any time
- Integration into `index.ts` is a 3-line change but requires a daemon restart
  to test - left for a dedicated integration PR

## Testing

```bash
# Start daemon (or test in isolation)
bun -e "
import { createHealthServer } from './packages/daemon/health-endpoint.ts';
const s = createHealthServer({ port: 19999 });
setTimeout(() => s.stop(), 5000);
"

curl http://localhost:19999/health
curl http://localhost:19999/ready
curl http://localhost:19999/metrics
```

Expected `/health` response:
```json
{ "status": "ok", "uptime_seconds": 0, "timestamp": "..." }
```

Expected `/metrics` response includes `sessions`, `memory` (rss_mb, heap), and
`process` (pid, node_version).

## Constraints

- Zero external dependencies
- No modifications to existing daemon files
- Port 18790 is reserved for health - does not conflict with WS gateway (18789)
- Readiness logic is intentionally simple: process alive = ready. Can be
  extended to check pool health, model availability, etc. in a follow-up.
