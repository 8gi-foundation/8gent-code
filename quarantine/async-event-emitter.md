# async-event-emitter

**Tool name:** AsyncEventEmitter

**Description:**
Typed event emitter where every listener is awaited before `emit` resolves. Supports two emission modes: `parallel` (all handlers run concurrently via `Promise.all`) and `serial` (handlers run one after another in registration order). Safe `once` handling - once-listeners are drained atomically before invocation so they fire exactly once even under concurrent emits.

**Status:** quarantine

**Location:** `packages/tools/async-event-emitter.ts`

**Exports:**
- `AsyncEventEmitter<Events>` class
- `AsyncHandler<T>` type
- `EmitMode` type (`"parallel" | "serial"`)

**API surface:**
| Method | Signature | Description |
|--------|-----------|-------------|
| `on` | `(event, handler) => this` | Register a persistent async listener |
| `once` | `(event, handler) => this` | Register a one-shot async listener |
| `off` | `(event, handler) => this` | Remove a specific listener |
| `emit` | `(event, data) => Promise<void>` | Emit using the instance default mode |
| `emitParallel` | `(event, data) => Promise<void>` | Await all handlers concurrently |
| `emitSerial` | `(event, data) => Promise<void>` | Await each handler in order |
| `listenerCount` | `(event) => number` | Count listeners for an event |
| `eventNames` | `() => (keyof Events)[]` | All events with active listeners |
| `removeAllListeners` | `(event?) => this` | Remove listeners for one or all events |

**Usage example:**
```ts
import { AsyncEventEmitter } from "./packages/tools/async-event-emitter.ts";

type AppEvents = {
  "task:done": { id: string; duration: number };
  "agent:error": { message: string };
};

const emitter = new AsyncEventEmitter<AppEvents>("serial");

emitter.on("task:done", async ({ id, duration }) => {
  await saveToDb(id, duration);
});

emitter.once("agent:error", async ({ message }) => {
  await notifyUser(message);
});

await emitter.emit("task:done", { id: "abc", duration: 120 });
```

**Integration path:**
1. Import into `packages/eight/agent.ts` to replace any fire-and-forget event patterns.
2. Use `emitSerial` for ordered side-effects (memory writes, checkpoints).
3. Use `emitParallel` for fan-out notifications (logging, analytics, UI updates).
4. Type the `Events` map at the agent level for compile-time event safety.

**Promotion criteria:**
- [ ] Wired into at least one agent lifecycle event (e.g. `session:end`, `tool:complete`)
- [ ] `emitSerial` used for checkpoint writes to prevent race conditions
- [ ] `emitParallel` used for observability fan-out
- [ ] No regressions in existing agent loop tests
