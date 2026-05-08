# Quarantine: HTTP Client

## What

Fetch wrapper (`packages/tools/http-client.ts`) providing timeout, exponential-backoff retries, JSON parsing, typed error handling, and request logging via a pluggable callback.

## Why

Multiple packages make HTTP calls with inconsistent error handling and no retry logic. A shared client standardizes this and adds observability.

## API

```ts
import { HttpClient } from "@8gent/tools/http-client";

const client = new HttpClient({
  baseUrl: "https://api.example.com",
  timeout: 5_000,
  retries: 3,
  retryDelay: 300,
  headers: { Authorization: "Bearer ..." },
  logger: (entry) => console.log(entry),
});

const data = await client.get<{ id: string }>("/items/1");
await client.post("/items", { name: "new" });
await client.put("/items/1", { name: "updated" });
await client.del("/items/1");
```

## Design Decisions

- **No external dependencies** - uses runtime `fetch` and `AbortController` only.
- **Exponential backoff** - retryDelay doubles each attempt. 4xx errors are not retried (client mistakes should fail fast).
- **Pluggable logger** - no built-in console output. Caller provides a `logger` callback or gets silence.
- **Generic return types** - `get<T>()` etc. for type-safe responses without a separate schema layer.
- **~120 lines** - minimal surface area.

## Graduation Criteria

- [ ] Used by at least 2 packages (e.g. browser tools, proactive bounty scanner)
- [ ] Integration test against a real or mock endpoint
- [ ] Retry/timeout behavior verified under failure conditions

## Risks

- Bun's `fetch` has minor differences from Node `fetch` in edge cases (redirect handling, stream cancellation). Tested on Bun only.
