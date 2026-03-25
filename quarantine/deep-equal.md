# deep-equal

## Tool Name
`deep-equal`

## Description
Deep structural equality comparison with circular reference handling, support for Date, Map, Set, RegExp, Buffer/Uint8Array, strict/loose mode, and custom comparators. Zero dependencies.

## Exported API

| Function | Signature | Purpose |
|----------|-----------|---------|
| `deepEqual` | `(a: unknown, b: unknown, options?: DeepEqualOptions) => boolean` | Returns true if a and b are deeply equal |
| `notEqual` | `(a: unknown, b: unknown, options?: DeepEqualOptions) => boolean` | Inverse of deepEqual |

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `strict` | `boolean` | `true` | Strict mode: no type coercion, NaN === NaN, +0 !== -0 |
| `comparator` | `(a, b) => boolean \| undefined` | no-op | Custom comparator; return `undefined` to fall through to built-in logic |

## Supported Types
- Primitives (string, number, boolean, null, undefined, symbol, bigint)
- Date - compared by `.getTime()`
- RegExp - compared by `.source` and `.flags`
- Buffer / Uint8Array - byte-by-byte comparison
- Map - key/value deep equality
- Set - element deep equality (O(n^2) for non-primitive elements)
- Array - index-by-index deep equality
- Plain objects - own enumerable key comparison

## Status
**quarantine** - isolated, not wired into the agent tool registry yet.

## Integration Path

1. Review API surface for completeness (symbol keys, non-enumerable props if needed).
2. Add to `packages/eight/tools.ts` under a `deepEqual` tool definition.
3. Wire the tool call handler so the agent can invoke `deepEqual` for assertion tasks or memory deduplication checks.
4. Consider using in `packages/memory/store.ts` for semantic dedup before inserting new memories.
5. Add a test in `benchmarks/categories/abilities/` verifying circular ref, Date, Map, and Set cases.
6. Graduate from quarantine - remove this file and update tool inventory.

## Notes
- Circular references are handled via a `Map`-based seen-set. The entry is cleaned up after each branch via `finally`, so the same sub-object can be compared independently elsewhere in the tree.
- Strict mode default matches Node.js `assert.deepStrictEqual` semantics.
- Loose mode uses `==` for primitive comparison only - useful for comparing user-provided config where `"1" == 1` is acceptable.
- Set comparison is O(n * m) for complex elements. Avoid on large Sets with object elements in hot paths.
