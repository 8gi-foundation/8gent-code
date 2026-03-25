# Quarantine: bitmask-flags

**Status:** Quarantine - awaiting integration decision
**Package:** `packages/tools/bitmask-flags.ts`
**Size:** ~140 lines
**Dependencies:** none (zero runtime deps)

## What It Does

Type-safe bitmask flag operations for permission-style flags in TypeScript.

Two exports:

- `defineFlags(names)` - creates a typed `FlagMap` with one power-of-2 bit per name, plus `NONE` (0) and `ALL` (OR of all bits).
- `Flags` class - mutable bitmask container with a fluent API.

## API

```ts
import { defineFlags, Flags } from './packages/tools/bitmask-flags';

const { flags, NONE, ALL } = defineFlags(['READ', 'WRITE', 'EXEC'] as const);
// flags.READ = 1, flags.WRITE = 2, flags.EXEC = 4, ALL = 7

const perms = new Flags(flags.READ | flags.WRITE);

perms.has(flags.READ)            // true
perms.hasAll(flags.READ, flags.WRITE) // true
perms.hasAny(flags.EXEC)         // false

perms.set(flags.EXEC);
perms.unset(flags.WRITE);
perms.toggle(flags.READ);

perms.toArray(flags)             // ['EXEC']
perms.toString(flags)            // 'EXEC'

const snapshot = perms.clone();
perms.clear();

// Serialize/restore
const raw = perms.toJSON();      // number
Flags.fromJSON(raw);
```

## Constraints

- Max 30 flags per definition (safe 32-bit signed range).
- Values are coerced to unsigned 32-bit on construction.
- No runtime dependencies.

## Where It Could Be Used

- `packages/permissions/policy-engine.ts` - replace string-set permission checks with bitmask ops for O(1) lookups.
- Agent tool capability flags.
- Session feature flags.

## Integration Notes

Not wired in anywhere yet. Review the `packages/permissions/` package to see if replacing the current string-set approach makes sense before merging.

## Decision Criteria

- Accept if: permissions package grows beyond 8-10 distinct flags and set-lookup overhead becomes measurable, OR we need serialisable permission snapshots.
- Reject if: string enums remain readable enough and performance is not a concern.
