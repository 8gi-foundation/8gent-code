# Quarantine: json-query

**Status:** Quarantine - not wired into agent tools yet

## What it does

Queries JSON data with simple path expressions. Single exported function: `query(data, expr)`.

## Supported syntax

| Expression | Description |
|------------|-------------|
| `a.b.c` | Dot-path access |
| `items[0]` | Array index (negative supported) |
| `items[*].name` | Wildcard - all elements |
| `items[0:3]` | Slice - indices 0 up to (not including) 3 |
| `items[?(@.active==true)]` | Filter - items where field equals value |
| `..name` | Recursive descent - all "name" values at any depth |

## Usage

```ts
import { query } from "../packages/tools/json-query.ts";

query({ a: { b: 1 } }, "a.b");
// => [1]

query({ items: [{ name: "x" }, { name: "y" }] }, "items[*].name");
// => ["x", "y"]

query(data, "..email");
// => all email values anywhere in the tree

query({ items: [{ active: true, id: 1 }, { active: false, id: 2 }] }, "items[?(@.active==true)]");
// => [{ active: true, id: 1 }]

query({ list: [10, 20, 30, 40] }, "list[1:3]");
// => [20, 30]
```

## Constraints

- No external dependencies - pure TypeScript, ~150 lines
- Returns an array of matched values (empty array if no match)
- Filter expressions support `==` equality only (no `!=`, `>`, `<`)
- Recursive descent (`..key`) is a single key lookup only

## Wire-up checklist

- [ ] Add to `packages/tools/index.ts` exports
- [ ] Register as agent tool in `packages/eight/tools.ts`
- [ ] Add tests in `packages/tools/__tests__/json-query.test.ts`
