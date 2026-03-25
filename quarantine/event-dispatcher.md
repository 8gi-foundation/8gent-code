# event-dispatcher

**Tool name:** EventDispatcher

**Description:**
Typed synchronous event dispatcher with priority-ordered listeners. Supports on/off/once/emit API, numeric priority per listener (higher fires first), once-semantics with re-entrant safety, and listener introspection via `listeners()` and `listenerCount()`. No external dependencies.

**Status:** quarantine

**Location:** `packages/tools/event-dispatcher.ts`

**Exports:**
- `EventDispatcher<EventMap>` class
- `Listener<T>` type

**API surface:**
| Method | Signature | Description |
|--------|-----------|-------------|
| `on` | `(event, fn, priority?)` | Register a persistent listener; default priority 0 |
| `once` | `(event, fn, priority?)` | Register a one-time listener; auto-removes after first fire |
| `off` | `(event, fn)` | Remove a listener by reference |
| `emit` | `(event, data)` | Fire all listeners in descending priority order |
| `listeners` | `(event)` | Array of listener functions in fire order |
| `listenerCount` | `(event)` | Count of listeners for event |
| `removeAllListeners` | `(event?)` | Clear one event or all events |
| `eventNames` | `()` | All events with at least one listener |

**Usage example:**
```ts
import { EventDispatcher } from "./packages/tools/event-dispatcher.ts";

type MyEvents = {
  "tool:start": { name: string };
  "tool:end": { name: string; ms: number };
};

const dispatch = new EventDispatcher<MyEvents>();

dispatch.on("tool:start", ({ name }) => console.log("started", name), 10);
dispatch.once("tool:end", ({ name, ms }) => console.log("done", name, ms));

dispatch.emit("tool:start", { name: "bash" });
dispatch.emit("tool:end", { name: "bash", ms: 42 });
```

**Integration path:**
1. Import into `packages/eight/agent.ts` or any tool package.
2. Instantiate once per agent session as the internal event bus.
3. Replace ad hoc callback props with typed dispatch calls.
4. Wire into activity monitor for real-time tool-event surfacing.
5. Use priority to ensure policy/permission listeners fire before downstream handlers.

**Promotion criteria:**
- [ ] Wired into agent loop as the internal event bus for at least 3 event types
- [ ] Priority ordering covered by at least one test
- [ ] `once` re-entrant safety verified under nested emit
- [ ] No regressions in existing tool tests
