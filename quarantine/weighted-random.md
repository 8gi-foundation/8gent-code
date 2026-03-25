# Quarantine: weighted-random

**Status:** quarantine - unreviewed, not wired into any index

**File:** `packages/tools/weighted-random.ts`

---

## What it does

Weighted random selection from a typed pool of items. Higher weight means higher probability of selection. Supports unique multi-picks (without replacement), dynamic weight adjustment, normalization, and an optional seeded PRNG for reproducible results.

| Export | Signature | Description |
|--------|-----------|-------------|
| `WeightedPool<T>` | `new WeightedPool(seed?)` | Pool of items with weights. Optional integer seed for reproducibility. |
| `.add` | `(value: T, weight: number) => this` | Add an item with a positive weight. Adding the same value accumulates weight. |
| `.remove` | `(value: T) => this` | Remove an item from the pool. |
| `.setWeight` | `(value: T, weight: number) => this` | Replace an item's weight entirely. |
| `.adjustWeight` | `(value: T, delta: number) => this` | Nudge weight by delta. Clamped to minimum 0.001. |
| `.normalize` | `() => this` | Scale all weights so they sum to 1.0. |
| `.pick` | `() => T \| null` | Select one item by weight. Returns null on empty pool. |
| `.pickMany` | `(n: number) => T[]` | Select N unique items without replacement. |
| `.entries` | `() => ReadonlyArray<WeightedItem<T>>` | Snapshot of all items and current weights. |
| `.totalWeight` | `() => number` | Sum of all weights. |
| `.size` | `number` | Number of items in the pool. |

`WeightedItem<T>` type:

```ts
interface WeightedItem<T> {
  value: T;
  weight: number;
}
```

---

## Features

| Feature | Notes |
|---------|-------|
| Weighted single pick | O(n) scan, proportional to weight |
| Unique multi-pick | Without replacement via internal clone |
| Dynamic weight adjustment | `setWeight` / `adjustWeight` |
| Normalization | Weights summed to 1.0 |
| Seeded PRNG | mulberry32 - deterministic output per seed |
| Generic type | Works with strings, numbers, objects, or any `T` |
| Zero dependencies | Pure TypeScript, no external packages |

---

## CLI usage

```bash
# Run the built-in demo (seeded, loot table example)
bun packages/tools/weighted-random.ts
```

---

## Example

```ts
import { WeightedPool } from './packages/tools/weighted-random.ts';

// Seeded for reproducibility
const loot = new WeightedPool<string>(42);
loot.add('common', 60).add('uncommon', 30).add('rare', 9).add('legendary', 1);

loot.pick();         // e.g. "common"
loot.pickMany(2);    // e.g. ["uncommon", "common"]

// Boost rare drop rates mid-session
loot.adjustWeight('rare', +5);

// Normalize so weights sum to 1.0
loot.normalize();
```

---

## Integration path

Not wired into `packages/tools/index.ts` or any agent tool registry. Export and register when needed.

Potential uses:
- `packages/self-autonomy/` - stochastic strategy selection during reflection/evolution
- `packages/orchestration/` - weighted sub-agent delegation based on past performance
- `packages/proactive/` - opportunity sampling from ranked pipeline
- `packages/music/` - weighted genre/station selection based on play history
- Benchmark harness - random but reproducible task sampling from category pools
