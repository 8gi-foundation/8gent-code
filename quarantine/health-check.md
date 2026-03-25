# health-check

**Tool name:** health-check
**Package path:** `packages/tools/health-check.ts`
**Status:** quarantine

## Description

Composable health check system for agent services. Register named checks by name, run all checks concurrently, aggregate status (healthy / degraded / unhealthy), enforce a per-check timeout, track service dependencies, and expose results as HTTP endpoint data.

Exports `HealthChecker` class and `httpDependency` convenience factory.

## Integration path

1. Import `HealthChecker` from `packages/tools/health-check.ts`.
2. Register checks with `.register(name, fn, { timeoutMs, tags })`.
3. Call `.run()` or `.toHttpPayload()` from any HTTP handler (e.g. Hono / Bun serve).
4. Wire into the Eight daemon (`packages/daemon/`) as a `/health` route.
5. Optionally surface aggregated status in the TUI status bar via a polling hook.

## Example

```ts
import { HealthChecker, httpDependency } from "../packages/tools/health-check.ts";

const checker = new HealthChecker({ defaultTimeoutMs: 3000 });

checker
  .register("db", async () => ({ status: "healthy" }), { tags: ["core"] })
  .register("llm-gateway", httpDependency("https://eight-vessel.fly.dev/ping"), { tags: ["core"] });

const payload = await checker.toHttpPayload({ tags: ["core"] });
// { status: "healthy", http_status: 200, checks: [...], durationMs: 42, checkedAt: "..." }
```
