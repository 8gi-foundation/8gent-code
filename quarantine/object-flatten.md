# quarantine: object-flatten

Flatten nested objects to dot-notation keys and unflatten back. Zero dependencies. Under 60 lines.

## API

```ts
flatten(obj: Record<string, any>, separator?: string): Record<string, any>
unflatten(obj: Record<string, any>, separator?: string): Record<string, any>
```

Default separator is `.`. Pass `"/"` or `"_"` etc. to override.

## Behavior

- Nested objects are recursed and their keys concatenated with the separator.
- Arrays are treated as leaf values - they are not recursed.
- `null` values are treated as leaf values.
- Empty objects are treated as leaf values.

## Examples

```ts
flatten({ a: { b: { c: 1 } }, d: [1, 2] })
// => { "a.b.c": 1, "d": [1, 2] }

unflatten({ "a.b.c": 1, "d": [1, 2] })
// => { a: { b: { c: 1 } }, d: [1, 2] }

flatten({ x: { y: 1 } }, "/")
// => { "x/y": 1 }
```

## Integration Candidates

- `packages/memory/store.ts` - flatten episodic memory payloads for FTS5 indexing or diff comparisons.
- `packages/self-autonomy/` - flatten preference objects before persisting to SQLite as key-value rows.
- `packages/eight/agent.ts` - flatten checkpoint state for shallow equality checks on resume.
- `packages/permissions/policy-engine.ts` - flatten YAML policy objects for key lookup.

## Promotion Criteria

- Used in at least 2 packages.
- Has a passing test file (`packages/tools/object-flatten.test.ts`).
- Handles edge cases: circular refs detection or documented limitation, empty input, numeric keys.
