# Quarantine: event-filter

**Status:** Quarantine - not wired into agent tools yet.

## What it is

A composable event stream filter for any typed event. Chainable operators let you express complex filtering logic in a single readable pipeline without external dependencies.

## Operators

| Operator | Behavior |
|----------|----------|
| `where(predicate)` | Pass only values matching predicate |
| `distinct(keyFn?)` | Drop consecutive duplicates |
| `debounce(ms)` | Ignore events within ms of last emit |
| `throttle(ms)` | Pass at most one event per ms window |
| `take(n)` | Pass first n values only |
| `skip(n)` | Drop first n values |
| `map(fn)` | Transform the event type |
| `buffer(size, onFlush)` | Accumulate into batches |

## Usage

```ts
import { createFilter } from '../packages/tools/event-filter';

const filter = createFilter<{ type: string; payload: unknown }>()
  .where(e => e.type === 'tool_call')
  .debounce(50)
  .distinct(e => e.type)
  .take(100);

const result = filter.push(event);
if (result) handleEvent(result);
```

## Integration candidates

- `packages/eight/agent.ts` - filter tool call events before processing
- `packages/self-autonomy/reflection.ts` - deduplicate reflection triggers
- `packages/orchestration/` - throttle worktree spawn events

## Why quarantine?

Needs an integration point before graduating. Candidate: agent event bus or orchestration layer.

## File

`packages/tools/event-filter.ts` - ~130 lines, zero dependencies.
