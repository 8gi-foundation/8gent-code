# optional-chain

## Description

Safe optional chaining with fallbacks for deep object access. Fluent builder API (`chain(obj).get('a.b[0].c').or(default)`) plus standalone utilities for path resolution (`tryGet`) and method calls (`tryCall`). Supports dot-notation, bracket array indexing, type narrowing, and transform mapping - without throwing on null or undefined at any depth.

## Status

**quarantine** - self-contained, not yet wired into the agent tool registry.

## Exports

| Export | Signature | Purpose |
|--------|-----------|---------|
| `chain` | `(value: T) => ChainBuilder<T>` | Start a fluent optional chain |
| `ChainBuilder#get` | `(path: string) => ChainBuilder<unknown>` | Resolve a dot/bracket path from current value |
| `ChainBuilder#or` | `(fallback: F) => T \| F` | Return value or fallback if null/undefined |
| `ChainBuilder#narrow` | `(guard) => ChainBuilder<N>` | Apply a type guard, propagate undefined on failure |
| `ChainBuilder#map` | `(fn) => ChainBuilder<R>` | Transform value if it exists |
| `ChainBuilder#exists` | `() => boolean` | Check if value is non-null/undefined |
| `ChainBuilder#unwrap` | `() => T \| undefined` | Raw access to the current value |
| `tryGet` | `(obj, path, fallback?) => unknown` | One-shot path resolution with fallback |
| `tryCall` | `(obj, method, args, fallback?) => unknown` | Safe method invocation with fallback on missing or throwing |

## Usage

```ts
import { chain, tryGet, tryCall } from './packages/tools/optional-chain';

// Fluent API
const city = chain(user).get('address.city').or('Unknown');
const first = chain(list).get('[0].name').or(null);
const upper = chain(str).map(s => s.toUpperCase()).or('');

// Type narrowing
const typed = chain(value)
  .narrow((v): v is string => typeof v === 'string')
  .or('default');

// Standalone utilities
tryGet(response, 'data.items[2].id', null);
tryCall(document, 'querySelector', ['.btn'], null);
```

## Integration Path

1. Wire into `packages/tools/index.ts` export barrel.
2. Use in `packages/eight/agent.ts` checkpoint restore logic to safely navigate nested session state.
3. Use in `packages/memory/store.ts` when reading partial episodic memory records.
4. Use in `packages/permissions/policy-engine.ts` to traverse YAML policy trees without defensive null checks scattered across call sites.

## Source

`packages/tools/optional-chain.ts` - 130 lines, zero dependencies, pure TypeScript.
