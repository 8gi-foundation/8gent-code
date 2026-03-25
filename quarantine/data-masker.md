# Quarantine: Sensitive Data Masker

**Status:** Quarantine
**File:** `packages/tools/data-masker.ts`
**Pattern:** Deep object traversal with pattern-based field masking

---

## What it does

`maskSensitive` deep-traverses any object and replaces sensitive field values with masked strings for safe logging. Designed to sanitize request/response objects, config blobs, and memory entries before they hit logs or telemetry.

- Pattern-matched keys: password, secret, token, key, auth, credential, private, ssn, credit card, cvv, pin
- Partial masking: shows last 4 chars by default (configurable)
- Type preservation hint: non-string values prefixed with `[type]` so log consumers know the original type
- Deep traversal: handles nested objects and arrays
- Configurable: custom patterns, mask char, show-last-N-chars, max depth
- Zero deps: pure TypeScript

---

## API

```ts
import { maskSensitive } from "./packages/tools/data-masker.ts";

// Basic usage
maskSensitive({ user: "alice", password: "hunter2", token: "abc123xyz" });
// => { user: "alice", password: "****er2", token: "****3xyz" }

// Custom patterns
maskSensitive({ cardNumber: "4111111111111111" }, { patterns: [/card/i] });
// => { cardNumber: "****1111" }

// Full mask, custom char
maskSensitive({ secret: "topsecret" }, { showLastChars: 0, maskChar: '#' });
// => { secret: "########" }

// Nested
maskSensitive({ db: { host: "localhost", password: "dbpass123" } });
// => { db: { host: "localhost", password: "****s123" } }
```

---

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `patterns` | `(string \| RegExp)[]` | built-in list | Field name patterns to mask |
| `maskChar` | `string` | `'*'` | Character used for masking |
| `showLastChars` | `number` | `4` | Visible trailing chars. `0` = full mask |
| `maxDepth` | `number` | `20` | Max recursion depth guard |

---

## Integration path

- `packages/eight/agent.ts` - mask tool call args before debug logging
- `packages/memory/store.ts` - sanitize memory entries before writing to SQLite
- `packages/daemon/` - mask inbound WebSocket payloads in access logs
- Any structured logger (pino, consola) as a serializer hook

---

## What it is NOT

- Not a redaction library for PII in free text (use a regex scrubber for that)
- Not a streaming sanitizer (operates on already-parsed objects)
- Not a schema-aware masker (pattern-matched, not type-aware)

---

## Checklist before promotion

- [ ] Unit tests: nested objects, arrays, zero-length values, non-string values, custom patterns, full mask mode
- [ ] Wire into agent debug logger as default serializer
- [ ] Confirm `maxDepth` guard prevents stack overflow on circular refs (add cycle detection)
- [ ] Benchmark: overhead should be negligible vs. JSON.stringify cost
