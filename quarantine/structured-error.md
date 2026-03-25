# structured-error

**Status:** Quarantined - awaiting integration review
**File:** `packages/tools/structured-error.ts`
**Lines:** ~140

## What it does

Typed error hierarchy for consistent error handling across the 8gent ecosystem. Replaces ad-hoc `throw new Error(...)` patterns with structured, serializable error objects.

## Classes

| Class | Code | HTTP Status | Purpose |
|-------|------|-------------|---------|
| `AppError` | any | any | Base class - all structured errors extend this |
| `NotFoundError` | `NOT_FOUND` | 404 | Resource lookup failures |
| `ValidationError` | `VALIDATION_FAILED` | 400 | Input validation failures, with per-field messages |
| `TimeoutError` | `TIMEOUT` | 408 | Operation deadline exceeded |
| `AuthError` | `UNAUTHORIZED` | 401 | Missing or invalid credentials |
| `ForbiddenError` | `FORBIDDEN` | 403 | Insufficient permissions |

## Key features

- `code` - machine-readable `ErrorCode` enum string
- `statusCode` - HTTP status code for API surfaces
- `isOperational` - distinguishes expected errors from programmer bugs
- `metadata` - structured key-value context for logging/tracing
- `toJSON()` / `fromJSON()` - full round-trip serialization (useful for IPC, daemon protocol, structured logs)
- Prototype chain preserved for transpiled environments

## Usage example

```ts
import { NotFoundError, ValidationError, isOperationalError } from "./structured-error";

// Throw a typed error
throw new NotFoundError("Agent", agentId);

// With validation fields
throw new ValidationError("Invalid config", {
  model: ["must be a non-empty string"],
  timeout: ["must be a positive number"],
});

// Serialize for IPC or logs
const json = err.toJSON();
const restored = AppError.fromJSON(json);

// Distinguish operational vs programmer errors
if (!isOperationalError(err)) {
  // This is a bug - crash loudly
  process.exit(1);
}
```

## Integration notes

- Replace raw `Error` throws in `packages/eight/agent.ts`, tool handlers, and daemon protocol handlers
- `fromJSON` enables error propagation across WebSocket sessions (daemon protocol)
- `ValidationError.fields` maps directly to form validation APIs
- No external dependencies

## Promotion criteria

- [ ] Replace at least 3 existing `throw new Error(...)` sites in core packages
- [ ] Wire into daemon protocol error responses
- [ ] Add to `packages/tools/index.ts` exports
