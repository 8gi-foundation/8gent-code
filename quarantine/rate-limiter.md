# Rate Limiter (API Token Bucket)

## Status: Quarantine

**File:** `packages/tools/rate-limiter-api.ts`

## Problem

API providers (OpenRouter, GitHub, Telegram) enforce rate limits. Without client-side throttling, bursts from the agent loop or orchestration hit 429s and waste retries.

## What it does

Token bucket rate limiter with per-endpoint configuration and async request queuing.

- **Token bucket algorithm** - capacity + refill rate per endpoint
- **Built-in presets** for OpenRouter (60/min), GitHub (30/min), Telegram (30/min)
- **Async queuing** - `acquire()` returns a promise that resolves when a token is available
- **AbortSignal support** - queued requests can be cancelled
- **Custom configs** - pass overrides at construction, or add new endpoint names on the fly

## How it differs from existing rate-limiter.ts

The existing `packages/tools/rate-limiter.ts` is a sliding-window counter for internal tool calls (read_file, run_command, etc.). This new limiter is a token bucket for external API calls with request queuing - different purpose, no overlap.

## Usage

```ts
import { ApiRateLimiter } from './rate-limiter-api';

const limiter = new ApiRateLimiter({
  openrouter: { capacity: 100, refillRate: 2 }, // override preset
});

// Before each API call
await limiter.acquire('openrouter');
const res = await fetch('https://openrouter.ai/api/v1/chat/completions', ...);
```

## Graduation criteria

- Wire into OpenRouter provider and confirm 429s drop to zero under burst load
- Add unit tests covering burst, queue drain, and abort
- Confirm no regressions in benchmark harness timing

## Size

~110 lines, 1 new file, 0 existing files modified.
