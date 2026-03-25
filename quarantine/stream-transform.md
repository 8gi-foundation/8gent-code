# Quarantine: stream-transform

## Tool name

`stream-transform`

## Description

Composable async-iterable pipeline for processing agent output. Chain `map`, `filter`, `batch`, `throttle`, `flatMap`, `take`, and `tap` transforms on any async iterable with no external dependencies. Designed to sit between the agent stream and any consumer (TUI renderer, logger, tool dispatcher).

## File

`packages/tools/stream-transform.ts` (~103 lines)

## API

```ts
import {
  pipeline,
  map,
  filter,
  batch,
  throttle,
  flatMap,
  take,
  tap,
  collect,
  fromArray,
} from "./packages/tools/stream-transform.ts";

// Basic chain
const result = await collect(
  pipeline(
    agentOutputStream,
    filter((chunk: string) => chunk.trim().length > 0),
    map((chunk) => chunk.toUpperCase()),
    batch(4),
    throttle(50),
  )
);

// Seed from array for testing
const stream = fromArray(["hello", "world"]);

// Debug without altering stream
const debugged = pipeline(stream, tap(console.log));
```

## Transforms

| Transform | Signature | Description |
|-----------|-----------|-------------|
| `map` | `(fn: T => U) => Transform<T, U>` | Apply fn to every chunk |
| `filter` | `(pred: T => bool) => Transform<T, T>` | Pass only chunks where predicate is true |
| `batch` | `(size: number) => Transform<T, T[]>` | Collect n chunks into arrays |
| `throttle` | `(ms: number) => Transform<T, T>` | Enforce minimum ms gap between yields |
| `flatMap` | `(fn: T => U[]) => Transform<T, U>` | Map then flatten one level |
| `take` | `(n: number) => Transform<T, T>` | Stop after n chunks |
| `tap` | `(fn: T => void) => Transform<T, T>` | Side-effect without mutating stream |

All transforms support async predicates and mapping functions.

## Status

**quarantine** - new file, zero CI coverage, not wired into tool registry.

## Integration path

- [ ] Add unit tests covering map/filter/batch/throttle on a mock agent stream
- [ ] Wire into `packages/tools/index.ts` exports
- [ ] Register as an agent-callable tool in `packages/eight/tools.ts`
- [ ] Benchmark throughput vs naive `for await` loop at 1k, 10k, 100k chunks
- [ ] Validate throttle accuracy under Node/Bun event loop pressure
- [ ] Consider adding a `split(delimiter)` transform for text chunk reassembly
