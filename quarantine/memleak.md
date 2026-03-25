# Quarantine: Memory Leak Detector

**Status:** quarantined - not wired into main validation index
**Branch:** quarantine/memleak
**File:** `packages/validation/memory-leak-detector.ts`

## Problem

Long-running Eight sessions (daemon, autoresearch loops, overnight tasks) can accumulate heap without releasing it. There was no instrumentation to detect this during a session.

## What this adds

`MemoryLeakDetector` - a lightweight class (~100 lines) that:

1. Periodically samples `process.memoryUsage()` (default every 5s, configurable)
2. Keeps a rolling window of up to 120 samples
3. Detects monotonic heap growth trends (flags when 75%+ of intervals show growth)
4. Reports heap growth rate (bytes/sec), RSS delta, external memory delta
5. Flags suspicious patterns: fast growth, heapTotal expansion, large RSS/external jumps

## Usage

```ts
import { MemoryLeakDetector } from "./packages/validation/memory-leak-detector";

const detector = new MemoryLeakDetector({ intervalMs: 10_000 });
detector.start();

// ... later
const report = detector.report();
if (report.trending) {
  console.warn("Possible memory leak:", report.suspiciousPatterns);
}

detector.stop();
```

## What is NOT included

- No automatic remediation or process restart
- Not wired into the healing loop or daemon yet
- No alert/notification integration
- No per-module attribution (would need heap snapshots)

## Graduation criteria

- Wire into daemon health checks
- Run during one full autoresearch loop and confirm it catches synthetic leaks
- Add unit tests with mock memoryUsage data
