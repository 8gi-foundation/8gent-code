# Event Bus (Typed Pub/Sub)

## Status: Quarantine

**File:** `packages/tools/event-bus.ts`

## Problem

Agent internals (tools, memory, orchestration, daemon) need a decoupled way to communicate events without direct imports or callback spaghetti.

## What it does

Typed event bus with wildcard subscriptions and history replay. Zero dependencies, ~80 lines.

- **Typed events** - generic `Events` map enforces payload types at compile time
- **Wildcard subscriptions** - `"file.*"` matches `"file.open"`, `"file.close"`, etc.
- **once()** - auto-removing single-fire listener
- **Event history** - configurable ring buffer (default 200 entries)
- **replay()** - replay past events to late subscribers, with optional time window filter
- **Unsubscribe** - `off()` or use the disposer returned by `subscribe()`/`on()`

## Usage

```ts
import { EventBus } from './event-bus';

type MyEvents = {
  'tool.start': { name: string };
  'tool.done': { name: string; ms: number };
  'memory.write': { key: string };
};

const bus = new EventBus<MyEvents>();

// Exact subscription
bus.on('tool.done', (p) => console.log(`${p.name} took ${p.ms}ms`));

// Wildcard - catches tool.start and tool.done
bus.subscribe('tool.*', (p) => console.log('tool event', p));

// Once
bus.once('memory.write', (p) => console.log('first write:', p.key));

// Emit
bus.emit('tool.start', { name: 'read_file' });
bus.emit('tool.done', { name: 'read_file', ms: 42 });

// Replay last 5 seconds of tool events to a late subscriber
bus.replay('tool.*', (p) => console.log('replayed:', p), 5000);
```

## Integration path

Wire into the agent loop (`packages/eight/agent.ts`) as the central event backbone. Tools, memory, orchestration, and the TUI activity monitor can all subscribe without coupling to each other.

## Size

- 1 file, ~80 lines
- 0 dependencies
- 0 existing files modified
