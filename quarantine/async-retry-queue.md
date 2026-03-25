# async-retry-queue

**Tool name:** AsyncRetryQueue

**Description:**
A lightweight async job queue that automatically retries failed operations with configurable exponential backoff. Supports pause/resume and a drain() awaitable for coordinated shutdown.

**Status:** quarantine

**Package path:** `packages/tools/async-retry-queue.ts`

## API

```ts
const queue = new AsyncRetryQueue({
  maxRetries: 3,         // default: 3
  initialDelay: 200,     // ms, default: 200
  maxDelay: 10_000,      // ms cap, default: 10000
  backoffMultiplier: 2,  // default: 2
  onSuccess: (result, attempts) => {},
  onFailure: (error, attempts) => {},
});

queue.enqueue(() => fetchSomething());  // returns Promise
queue.pause();
queue.resume();
await queue.drain();
```

## Integration path

1. Wire into `packages/tools/index.ts` once validated.
2. Use in `packages/eight/agent.ts` for tool call retries on transient provider errors.
3. Optionally expose as a named Eight tool so sub-agents can queue work without blocking.

## Why quarantine

Not yet wired into the agent loop. Needs integration test against a flaky mock provider before promotion. No blast radius - single file, zero external deps.
