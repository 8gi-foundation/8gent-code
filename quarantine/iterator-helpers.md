# iterator-helpers

## Tool Name
`iterator-helpers`

## Description
TC39 iterator helpers polyfill. Wraps any iterable (arrays, Sets, Maps, generators, custom iterables) with chainable functional methods: `map`, `filter`, `take`, `drop`, `flatMap`, `reduce`, `toArray`, `forEach`, `some`, `every`, `find`.

Mirrors the TC39 Iterator Helpers proposal (Stage 4), providing a stable, self-contained implementation until native runtime support is universal across all target environments (Bun, Node, browser).

## Status
**quarantine** - implemented, not yet integrated into core toolchain.

## Integration Path
1. Evaluate against native `Iterator.prototype` availability in target Bun version.
2. If native support is absent or incomplete, export `iter()` from `packages/tools/index.ts`.
3. Wire into agent tool pipeline for any sequence-processing tasks (e.g., memory query result processing, orchestration task filtering).
4. Add unit tests under `packages/tools/__tests__/iterator-helpers.test.ts`.
5. Remove polyfill and use native once TC39 spec is fully available in runtime.

## Usage
```ts
import { iter } from '../packages/tools/iterator-helpers';

const result = iter([1, 2, 3, 4, 5])
  .filter(x => x % 2 === 0)
  .map(x => x * 10)
  .toArray(); // [20, 40]

const found = iter(new Set(['a', 'bb', 'ccc']))
  .find(s => s.length > 2); // 'ccc'
```
