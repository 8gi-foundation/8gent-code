# safe-stringify

## Description

JSON.stringify that never throws. Handles circular references, BigInt, Error, RegExp, Map, Set, undefined, functions, symbols, NaN, and Infinity - all the types that make native JSON.stringify blow up or silently drop data.

## Status

**quarantine** - self-contained, not yet wired into the agent tool registry.

## Exports

| Function | Signature | Purpose |
|----------|-----------|---------|
| `safeStringify` | `(value, options?) => string` | Serialize any value to JSON without throwing |

### Options

| Option | Type | Default | Purpose |
|--------|------|---------|---------|
| `replacer` | `((key, value) => unknown) \| null` | `null` | Standard JSON.stringify replacer, applied before type handling |
| `space` | `number \| string` | `undefined` | Indentation passed through to JSON.stringify |
| `maxDepth` | `number` | `50` | Max nesting depth before values are replaced with `[MaxDepth]` |

### Special Type Serialization

| Input type | Output |
|------------|--------|
| Circular ref | `"[Circular]"` |
| `undefined` | `{ __type: "undefined" }` |
| `BigInt` | `{ __type: "BigInt", value: "123" }` |
| `function` | `{ __type: "function", name: "fnName" }` |
| `symbol` | `{ __type: "symbol", value: "Symbol(foo)" }` |
| `Error` | `{ __type: "Error", name, message, stack }` |
| `RegExp` | `{ __type: "RegExp", source, flags }` |
| `Map` | `{ __type: "Map", entries: [...] }` |
| `Set` | `{ __type: "Set", values: [...] }` |
| `NaN` | `"[NaN]"` |
| `Infinity` | `"[Infinity]"` |
| `-Infinity` | `"[-Infinity]"` |
| `Date` | ISO string (native JSON.stringify behavior) |

## Integration Path

1. Wire into `packages/tools/index.ts` export barrel.
2. Use in `packages/eight/agent.ts` for serializing checkpoints - agent state often contains Error objects and circular tool refs.
3. Use in `packages/memory/store.ts` when persisting episodic memory records that may carry nested Error or Map values.
4. Use in `packages/daemon/` for safe WebSocket message serialization.
5. Replace any raw `JSON.stringify` calls that touch agent-produced output.

## Source

`packages/tools/safe-stringify.ts` - 143 lines, zero dependencies, pure TypeScript.
