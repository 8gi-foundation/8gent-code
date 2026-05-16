# Quarantine: async-gate

## What

`packages/tools/async-gate.ts` - open/close gate that blocks or allows async operations.

Two exported classes:

- **AsyncGate** - manually controlled gate. Callers `await gate.wait()` and block until `gate.open()` is called.
- **AutoCloseGate** - extends AsyncGate. Auto-closes after N passes, then blocks again until `open()` is called.

## API

### AsyncGate

| Method/Property | Description |
|-----------------|-------------|
| `new AsyncGate(initiallyOpen?)` | Create gate, closed by default |
| `open()` | Open gate, release all waiters |
| `close()` | Close gate, future waiters will block |
| `toggle()` | Flip gate state |
| `wait(): Promise<void>` | Resolves immediately if open, else blocks |
| `isOpen: boolean` | Current gate state |

### AutoCloseGate

| Method/Property | Description |
|-----------------|-------------|
| `new AutoCloseGate(passesPerOpen)` | N passes allowed per open cycle |
| `open()` | Open gate, reset pass counter |
| `wait(): Promise<void>` | Counts pass; closes after N passes |
| `passesRemaining: number` | Passes left before auto-close |

## Usage examples

```ts
import { AsyncGate, AutoCloseGate } from "./packages/tools/async-gate.ts";

// Basic gate - pause/resume a worker
const gate = new AsyncGate();
gate.open();
await gate.wait(); // passes through immediately
gate.close();
// gate.wait() will now block

// AutoCloseGate - let exactly 2 workers through per cycle
const throttle = new AutoCloseGate(2);
throttle.open();
await throttle.wait(); // pass 1
await throttle.wait(); // pass 2 - gate closes
// throttle.wait() now blocks until throttle.open() again
```

## Quarantine status

- Not wired into any agent loop yet
- No imports in existing packages
- Safe to promote once a consumer is identified (e.g. orchestration rate-limiting, permission approval gates)
