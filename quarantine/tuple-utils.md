# Quarantine: tuple-utils

**Status:** quarantine - awaiting integration review
**Package:** `packages/tools/tuple-utils.ts`
**Lines:** ~120
**Dependencies:** none (pure TypeScript)

## What it does

Typed tuple creation and manipulation. Fills the gap between plain arrays and heavy functional libraries for callers that need fixed-arity, type-safe positional data.

## API

| Export | Signature | Description |
|--------|-----------|-------------|
| `tuple` | `(...values: T) => T` | Create a typed tuple; TypeScript infers the exact tuple type |
| `first` | `(t) => T[0]` | First element |
| `second` | `(t) => T[1]` | Second element |
| `last` | `(t) => T[number]` | Last element at runtime |
| `mapTuple` | `(t, fn) => R[]` | Map all elements through a transform |
| `zipTuples` | `(a, b) => [A, B][]` | Zip two tuples element-wise |
| `spreadTuple` | `(t, fn) => R` | Spread tuple as positional args into a function |
| `compareTuples` | `(a, b) => boolean` | Strict element-wise equality |

## Usage example

```ts
import { tuple, first, second, last, mapTuple, zipTuples, spreadTuple, compareTuples } from './tuple-utils';

const t = tuple(1, "hello", true);
// t: [number, string, boolean]

first(t);   // 1
second(t);  // "hello"
last(t);    // true

mapTuple(t, String); // ["1", "hello", "true"]

const a = tuple(1, 2, 3);
const b = tuple("a", "b", "c");
zipTuples(a, b); // [[1,"a"],[2,"b"],[3,"c"]]

spreadTuple(tuple(2, 3), (x, y) => x + y); // 5

compareTuples(tuple(1, 2), tuple(1, 2)); // true
compareTuples(tuple(1, 2), tuple(1, 3)); // false
```

## Integration notes

- No external dependencies - drop-in addition to `packages/tools/`
- `spreadTuple` is the highest-value export for agent tool dispatch (unpack recorded arg tuples into function calls)
- `zipTuples` is useful for pairing parameter names with values in tool schema validation
- All functions are pure and synchronous

## Files touched

- `packages/tools/tuple-utils.ts` (new)
- `quarantine/tuple-utils.md` (this file)
