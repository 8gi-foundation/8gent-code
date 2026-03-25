# json-path

**Tool name:** json-path
**Status:** quarantine
**Package:** `packages/tools/json-path.ts`

## Description

Lightweight JSONPath query engine for extracting nested values from JSON objects. No external dependencies. ~130 lines of TypeScript.

Supports:
- Dot notation: `user.address.city`
- Bracket notation: `items[0]`, `data["key"]`
- Wildcards: `users[*].name` - returns array of all matches
- Array slicing: `items[0:3]` - returns subset array
- Negative indexes: `items[-1]` - last element
- Root shorthand: `$.users[0]` or `users[0]`

## API

```ts
import { query, queryAll } from "../packages/tools/json-path.ts";

// Single value
query({ a: { b: 42 } }, "a.b")          // => 42

// Wildcard - all names
query(data, "users[*].name")             // => ["Alice", "Bob"]

// Slice
query(data, "items[0:2]")               // => [item0, item1]

// Always-array variant
queryAll(data, "tags[*]")               // => string[]
```

## Integration Path

1. Wire into `packages/tools/index.ts` exports when promoted from quarantine.
2. Use in agent tool definitions (`packages/eight/tools.ts`) to add a `json_path` tool that lets Eight query structured API responses.
3. Candidate for memory layer: query stored JSON facts with a path expression instead of FTS5 for structured data.

## Promotion Criteria

- [ ] Unit tests passing (dot, bracket, wildcard, slice, negative index, root shorthand)
- [ ] Integrated into at least one agent tool call
- [ ] Benchmark: no measurable latency on objects up to 10k keys
