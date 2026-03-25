# Quarantine: Token Bucket Rate Limiter

**Status:** Ready for review
**File:** `packages/tools/rate-limiter.ts`
**Pattern:** Token bucket with per-key limits and queuing

---

## What it does

`RateLimiter` enforces per-key token bucket rate limits across any async operation. Designed for calls to Ollama, OpenRouter, and GitHub APIs - but generic enough to wrap any key-identified resource.

- Token bucket algorithm: steady refill rate + burst capacity
- Per-key isolation: each key (e.g. `"ollama"`, `"github"`) has its own bucket
- Request queuing: when bucket is empty, requests queue up to `maxQueue` depth
- Queue drain: a `setTimeout` loop drains the queue as tokens refill
- Zero deps: plain TypeScript, no npm packages

---

## API

```ts
import { RateLimiter, PRESETS, RateLimitError } from "./packages/tools/rate-limiter.ts";

const limiter = new RateLimiter();

// Option 1: use a preset
limiter.preset("myOllama", "ollama");

// Option 2: custom config
limiter.configure("myKey", { rate: 2, burst: 5, maxQueue: 10 });

// Acquire a token
const { granted, wait, estimatedWaitMs } = limiter.acquire("myOllama");
await wait; // resolves immediately if granted, or after delay if queued

// Check without consuming
if (limiter.canAcquire("myOllama")) { ... }

// Observability
console.log(limiter.stats());
// => { myOllama: { tokens: 4, queue: 0 } }
```

---

## Presets

| Preset | Rate | Burst | Max Queue | Notes |
|--------|------|-------|-----------|-------|
| `ollama` | 5 rps | 10 | 20 | Local inference - generous |
| `openrouter-free` | 0.33 rps | 3 | 10 | 20 req/min free tier |
| `openrouter-paid` | 3.33 rps | 20 | 50 | 200 req/min paid tier |
| `github` | 1.39 rps | 30 | 15 | 5000 req/hr authenticated |
| `github-search` | 0.5 rps | 5 | 10 | 30 req/min search API |
| `llm` | 1 rps | 5 | 20 | Generic LLM fallback |

---

## Error handling

`RateLimitError` is thrown (via rejected `wait` promise) when the queue is full:

```ts
try {
  const { wait } = limiter.acquire("openrouter-free");
  await wait;
} catch (err) {
  if (err instanceof RateLimitError) {
    console.error(err.message);
    // err.key, err.config, err.queueDepth, err.estimatedWaitMs
  }
}
```

---

## Integration points

Pure utility - no wiring to existing files needed. Consumers import directly:

- `packages/eight/agent.ts` - wrap provider calls before `streamText`
- `packages/providers/` - inject at the provider level for transparent limiting
- Any tool that calls external APIs

---

## What it is NOT

- Not a distributed rate limiter (in-process only, single node)
- Not a sliding window (token bucket, intentional)
- Not a retry wrapper (callers decide what to do with `wait`)

---

## Checklist before promotion

- [ ] Unit tests: burst consumed, queue drain timing, queue overflow rejection, reset
- [ ] Integrate with at least one provider (Ollama or OpenRouter)
- [ ] Confirm `setTimeout` drain does not leak on process exit (call `resetAll()` on shutdown)
- [ ] Benchmark: overhead per `acquire()` call should be <0.1ms
