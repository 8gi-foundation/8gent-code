# bloom-filter

## Description

Probabilistic set membership testing using a Bloom filter. Space-efficient data structure that answers "is this item in the set?" with configurable false positive rates and zero false negatives.

Useful for deduplication checks in agent pipelines, URL deduplication during web scraping, cache miss pre-checks, and any scenario where a small probability of false positives is acceptable in exchange for significant memory savings.

## Status

`quarantine`

Not yet wired into the main tool registry. Functional and tested in isolation.

## API

```ts
import { BloomFilter } from '../packages/tools/bloom-filter.ts';

const filter = new BloomFilter({ capacity: 10_000, falsePositiveRate: 0.01 });

filter.add('https://example.com/page-1');
filter.has('https://example.com/page-1'); // true
filter.has('https://example.com/page-2'); // false (probably)

filter.currentFalsePositiveRate(); // ~0.01 when near capacity

const state = filter.serialize();
const restored = BloomFilter.deserialize(state);
```

## Integration Path

1. Register in `packages/tools/index.ts` export list
2. Expose as a tool callable by the agent via `packages/eight/tools.ts`
3. Wire into memory deduplication pipeline (`packages/memory/store.ts`) to skip duplicate episode inserts
4. Optionally persist serialized state to `.8gent/bloom-cache.json` across sessions
