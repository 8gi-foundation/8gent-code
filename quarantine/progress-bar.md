# Quarantine: progress-bar

**File:** `packages/tools/progress-bar.ts`
**Status:** Quarantine - review before wiring into main codebase
**Deps:** Zero

---

## What it does

Terminal progress bar with:

- ETA and elapsed time display
- Speed measurement (moving average, N=10 samples)
- Color transitions: green (0-60%) -> yellow (60-80%) -> red (80-100%)
- Multi-bar layout for parallel tasks (`MultiProgress`)
- Configurable fill characters, unit labels, bar width
- Auto-finish when `current >= total`

---

## API

### `ProgressBar`

```ts
const bar = new ProgressBar({
  total: 1000,
  label: 'Downloading',
  unit: 'KB',
  width: 40,
});

bar.update(250);     // set absolute value
bar.increment(10);   // add delta
bar.finish();        // force complete + newline
bar.snapshot();      // { current, total, percent, elapsed, eta, speed, done }
```

### `MultiProgress`

```ts
const multi = new MultiProgress({ interval: 80 });

const a = multi.add({ total: 500, label: 'Task A' });
const b = multi.add({ total: 200, label: 'Task B', unit: 'files' });

a.update(300);
b.update(100);

// Auto-stops when all bars done. Or call manually:
multi.stop();
```

---

## Integration notes

- All output goes to `process.stderr` by default (keeps stdout clean for pipes).
- Writes ANSI escape codes - broken on non-TTY. Guard call sites: `if (process.stderr.isTTY)`.
- `MultiProgress` reserves lines on start and uses cursor-up rewrites. Do not interleave other stderr output while active.
- Speed uses a moving average over the last 10 samples - stable for bursty workloads.

---

## Suggested wiring points

| Location | Use case |
|----------|----------|
| `packages/eight/agent.ts` | Progress during long tool chains |
| `packages/orchestration/` | Per-worktree progress in parallel runs |
| `packages/kernel/training.ts` | Training batch progress |
| `apps/tui/` | NOT here - TUI uses Ink/React, use Ink's own render loop instead |

---

## What it is NOT

- Not an Ink component (no React, no JSX)
- Not a streaming logger
- Not a download client

---

## Review checklist

- [ ] Guard `isTTY` at call sites before constructing bars
- [ ] Decide default `unit` per call site (`it`, `KB`, `files`, etc.)
- [ ] Consider exposing `format()` output to memory/logging pipeline
- [ ] `MultiProgress.start()` is private - confirm no need to expose externally
