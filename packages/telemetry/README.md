# @8gent/telemetry

Per-tenant attribution telemetry. **Wave 4 GATE** — every LLM call, every
vessel call, every storage byte must carry `tenantId`. Without this
firing across the system, no tenant beyond James lights up.

## What it does

- Stamps every LLM/vessel/storage operation with `tenantId`
- Emits structured JSON to stdout, one event per line
- Adds OpenTelemetry-compatible `traceId` / `spanId` / `parentSpanId`
- Estimates per-call USD cost (cloud) or 0 (local)
- Refuses to emit any event missing `tenantId` (loud `TelemetryAttributionError`)

Vector tails stdout, validates the gate, and ships off-box to Loki.

## Install

Workspace package — already linked. Import directly:

```ts
import { telemetry } from "@8gent/telemetry";
```

## Usage

### Wrap an LLM call

```ts
const result = await telemetry.llm(
  { tenantId, sessionId, channel: "telegram", provider: "openrouter", model: "qwen3.5:14b" },
  async (ctx) => {
    const r = await openrouter.chat(req);
    return { result: r, usage: { promptTokens: r.usage.in, completionTokens: r.usage.out } };
  },
);
```

The wrapper times the call, captures errors, and emits one `llm` event.

### Wrap a vessel RPC

```ts
const reply = await telemetry.vessel(
  { tenantId, sessionId, channel: "api", endpoint: "/agent/chat" },
  async () => boardVessel.invoke(input),
);
```

### Wrap a storage op

```ts
await telemetry.storage(
  { tenantId, op: "write", store: "memory.db" },
  async () => {
    const bytes = JSON.stringify(payload).length;
    await store.put(payload);
    return { result: undefined, bytes };
  },
);
```

### Manual record (already-finished op)

```ts
telemetry.recordLLM({
  tenantId,
  provider: "8gent",
  model: "eight-1.0-q3:14b",
  promptTokens: 1234,
  completionTokens: 567,
  latencyMs: 342,
});
```

## Event shape

```json
{
  "kind": "llm",
  "tenantId": "james",
  "sessionId": "sess-abc",
  "channel": "telegram",
  "provider": "openrouter",
  "model": "qwen3.5:14b",
  "promptTokens": 1234,
  "completionTokens": 567,
  "totalTokens": 1801,
  "latencyMs": 342,
  "costUsd": 0.001467,
  "ts": "2026-04-26T16:23:08.412Z",
  "traceId": "4f1c7c2e9b3a8d6f1c2b3a4d5e6f7a8b",
  "spanId": "9a1b2c3d4e5f6a7b",
  "startTimeUnixNano": 1745688188412000000,
  "endTimeUnixNano": 1745688188754000000
}
```

## Vector config

`vector.toml` ships in this package. Run:

```bash
vector --config packages/telemetry/vector.toml
```

It reads `/var/log/8gent/telemetry.log` (production) or stdin (dev),
gates on `tenantId + kind`, ships to Loki, and dumps un-attributed
events to `/var/log/8gent/telemetry-deadletter.log` so the gap can be
fixed at the source.

`LOKI_ENDPOINT` defaults to `http://loki:3100`.

## Testing

```bash
bun test packages/telemetry
```

Tests use `MemorySink` to capture events without touching stdout.

## Wired-in

- `packages/providers/usage-monitor.ts` — `recordWithAttribution()` mirrors token usage to a telemetry event
- `packages/daemon/agent-pool.ts` — sessions carry `tenantId`, used as default attribution
