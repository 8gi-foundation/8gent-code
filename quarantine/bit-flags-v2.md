# bit-flags-v2

**Tool:** `packages/tools/bit-flags-v2.ts`
**Status:** quarantine

## Description

Enhanced named bit flags with typed flag set operations. Provides a typed
registry from plain constant definitions (`{ READ: 1, WRITE: 2, EXEC: 4 }`)
and returns a `FlagSet` with a full set of combinatorial operations and a
human-readable `toString()`. Zero dependencies, 130 lines.

## API

### `createFlags(defs)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `defs` | `Record<string, number>` | Map of flag names to power-of-two values |

Returns a `FlagRegistry` that spreads all flag constants plus:

| Helper | Signature | Purpose |
|--------|-----------|---------|
| `create` | `(initial?: number) => FlagSet` | Create a FlagSet from an initial value |
| `names` | `() => (keyof T)[]` | All defined flag names |
| `all` | `() => number` | Bitwise OR of all defined flags (universe) |
| `none` | `() => FlagSet` | Zero / empty flag set |

### `FlagSet`

| Method | Signature | Purpose |
|--------|-----------|---------|
| `add` | `(flag: number) => FlagSet` | Set bits - returns new FlagSet |
| `remove` | `(flag: number) => FlagSet` | Clear bits - returns new FlagSet |
| `has` | `(flag: number) => boolean` | All bits of flag are set |
| `hasAll` | `(...flags: number[]) => boolean` | Every provided flag is set |
| `hasAny` | `(...flags: number[]) => boolean` | At least one flag is set |
| `toggle` | `(flag: number) => FlagSet` | XOR bits - returns new FlagSet |
| `valueOf` | `() => number` | Raw numeric value |
| `toString` | `() => string` | Pipe-separated flag names, e.g. `"READ|WRITE"` |
| `toArray` | `() => (keyof T)[]` | Active flag names as array |

FlagSet is immutable - every mutating operation returns a new instance. Combine
flags with bitwise OR (`|`) using the registry constants; check with bitwise AND
(`&`) or the `has`/`hasAll`/`hasAny` methods.

## Usage

```ts
import { createFlags } from '../../packages/tools/bit-flags-v2';

const Perms = createFlags({ READ: 1, WRITE: 2, EXEC: 4 });

const rw = Perms.create(Perms.READ | Perms.WRITE);
rw.has(Perms.READ);              // true
rw.hasAll(Perms.READ, Perms.WRITE); // true
rw.hasAny(Perms.EXEC);          // false
rw.toString();                   // "READ|WRITE"
rw.toArray();                    // ["READ", "WRITE"]

const rwx = rw.add(Perms.EXEC);
rwx.toString();                  // "READ|WRITE|EXEC"

const rx = rwx.remove(Perms.WRITE);
rx.toString();                   // "READ|EXEC"
```

## Integration Path

1. **Immediate** - import directly wherever permission bitmasks or feature flags
   are needed:
   ```ts
   import { createFlags } from '../../packages/tools/bit-flags-v2';
   ```
2. **Policy engine** - `packages/permissions/policy-engine.ts` uses numeric
   permission masks; `createFlags` gives them named constants and readable logs.
3. **Agent tools** - `packages/eight/tools.ts` can expose capability flags
   (file read, network, shell) as a named FlagSet for cleaner policy checks.
4. **Re-export** - add to `packages/tools/index.ts` once a production callsite
   is confirmed.

## Notes

- No external dependencies.
- All operations are pure and synchronous.
- FlagSet is immutable - every operation returns a new instance.
- `toString()` returns `"NONE"` for zero value.
- Only single-bit (power-of-two) values appear in `toString()` / `toArray()`.
  Composite constants (e.g. `RW: READ | WRITE`) work for checks but won't
  show as a combined name in string output.
