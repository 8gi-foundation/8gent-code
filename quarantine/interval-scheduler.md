# quarantine: interval-scheduler

**File:** `packages/tools/interval-scheduler.ts`
**Status:** Quarantine - awaiting integration decision

## What it does

Manages multiple named intervals with pause/resume lifecycle and drift correction.
Uses a `setTimeout` chain instead of `setInterval` to stay accurate over long runtimes.

## API

| Method | Signature | Description |
|--------|-----------|-------------|
| `add` | `(name, fn, ms) => this` | Register a named interval, start immediately |
| `remove` | `(name) => boolean` | Cancel and delete a named interval |
| `pause` | `(name) => boolean` | Suspend ticks without losing tick count |
| `resume` | `(name) => boolean` | Restart from now, drift-corrected |
| `pauseAll` | `() => void` | Pause every registered interval |
| `resumeAll` | `() => void` | Resume every paused interval |
| `list` | `() => Array<{name, ms, paused, tickCount}>` | Snapshot of all intervals |
| `clear` | `() => void` | Remove all intervals |

## Drift correction

Each tick measures actual elapsed time and subtracts it from the target delay before scheduling the next `setTimeout`. This prevents cumulative drift on long-running processes.

## Usage example

```ts
import { IntervalScheduler } from './packages/tools/interval-scheduler';

const scheduler = new IntervalScheduler();

scheduler.add('heartbeat', () => console.log('ping'), 5000);
scheduler.add('sweep', async () => { /* async ok */ }, 30_000);

scheduler.pause('sweep');
// ...
scheduler.resume('sweep');

console.log(scheduler.list());
// [{ name: 'heartbeat', ms: 5000, paused: false, tickCount: 3 }, ...]

scheduler.clear();
```

## Integration candidates

- `packages/eight/agent.ts` - periodic checkpoint saves
- `packages/memory/store.ts` - consolidation background job
- `packages/proactive/` - opportunity pipeline polling
- `packages/daemon/` - health-check heartbeat

## Notes

- Async tick errors are caught and logged; they do not cancel the interval.
- `pause` cancels the pending `setTimeout`; tick count is preserved across resume.
- `add` with a duplicate name replaces the existing interval cleanly.
