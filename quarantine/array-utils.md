# array-utils

Utility functions for common array operations.

## Location

`packages/tools/array-utils.ts`

## Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `unique` | `(arr: T[]) => T[]` | Remove duplicate values. |
| `uniqueBy` | `(arr: T[], fn: (item: T) => unknown) => T[]` | Remove duplicates by key function. |
| `flatten` | `(arr: (T \| T[])[], depth?: number) => T[]` | Flatten nested array up to depth (default 1). |
| `chunk` | `(arr: T[], size: number) => T[][]` | Split into chunks of given size. |
| `compact` | `(arr: mixed[]) => T[]` | Remove falsy values. |
| `zip` | `(...arrays) => tuple[]` | Zip multiple arrays into tuples (stops at min length). |
| `unzip` | `(pairs: T[]) => arrays` | Unzip array of tuples into separate arrays. |
| `intersection` | `(a: T[], b: T[]) => T[]` | Elements present in both arrays (unique). |
| `difference` | `(a: T[], b: T[]) => T[]` | Elements in `a` not in `b`. |
| `last` | `(arr: T[]) => T \| undefined` | Last element or undefined. |
| `first` | `(arr: T[]) => T \| undefined` | First element or undefined. |
| `sample` | `(arr: T[]) => T \| undefined` | Random element or undefined. |
| `shuffle` | `(arr: T[]) => T[]` | New array in random order (Fisher-Yates). |

## Status

Quarantined - not yet wired into any consumer. Import directly:

```ts
import { unique, chunk, shuffle } from "../packages/tools/array-utils.ts";
```

## Notes

- `zip` stops at the shortest input array.
- `shuffle` returns a new array - does not mutate the input.
- `compact` uses truthiness filtering; removes `false`, `null`, `undefined`, `0`, `""`, `NaN`.
- `uniqueBy` last-write-wins on key collision.
