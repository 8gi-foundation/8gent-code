# Quarantine: zip-iterator

**Status:** Quarantine review
**Package:** `packages/tools/zip-iterator.ts`
**Lines:** ~140
**Pattern origin:** Python's built-in `zip()` and `itertools.zip_longest()`

## What it does

Python-style zip utilities for parallel iteration over multiple iterables. Four exports:

| Export | Behavior |
|--------|----------|
| `zip(...iterables)` | Yields tuples, stops at shortest iterable |
| `zipLongest(...iterables, { fillValue })` | Yields tuples, pads shorter iterables with `fillValue` |
| `unzip(zipped)` | Inverse of zip - separates tuples into per-column arrays |
| `zipWith(fn, ...iterables)` | Maps a function across zipped tuples |

## Usage examples

```ts
import { zip, zipLongest, unzip, zipWith } from './packages/tools/zip-iterator.ts';

// zip - stops at shortest
[...zip([1, 2, 3], ['a', 'b', 'c'])]
// => [[1,'a'], [2,'b'], [3,'c']]

// zipLongest - pads with fill value
[...zipLongest([1, 2, 3], ['a', 'b'], { fillValue: null })]
// => [[1,'a'], [2,'b'], [3, null]]

// unzip - inverse of zip
unzip([[1,'a'], [2,'b'], [3,'c']])
// => [[1,2,3], ['a','b','c']]

// zipWith - map while zipping
[...zipWith((a, b) => a + b, [1, 2, 3], [10, 20, 30])]
// => [11, 22, 33]
```

## Motivation

No native JS zip. `Array.prototype.map` with index works but is clunky for multi-array parallel iteration. This pattern appears in agent tool pairing (inputs + outputs), memory consolidation (old entries + new entries), and benchmark result alignment.

## Constraints

- No dependencies
- Works with any `Iterable<T>` or `ArrayLike<T>` (arrays, Sets, Maps, generators, strings)
- All functions are generators (lazy) except `unzip` which takes materialized input
- TypeScript generics preserve tuple types through `zip` and `zipWith`

## Review checklist

- [ ] No circular imports with existing tools
- [ ] Types are sound under strict mode
- [ ] Generator laziness is correct (no pre-materialisation leaks)
- [ ] `zipLongest` options detection handles edge cases (plain arrays as last arg)
