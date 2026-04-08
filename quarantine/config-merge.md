# Quarantine: config-merge

**Status:** Quarantined - pending integration decision
**File:** `packages/tools/config-merge.ts`
**Size:** ~130 lines, zero dependencies

## What it does

Four pure utility functions for composing runtime configuration objects:

| Export | Signature | Purpose |
|--------|-----------|---------|
| `mergeConfigs` | `(base, ...overrides) => T` | Deep merge N config objects. Arrays replaced, objects merged. Later overrides win. |
| `withEnvOverrides` | `(config, prefix, env?) => T` | Map `PREFIX_KEY__NESTED=val` env vars onto config paths. Auto-coerces booleans, numbers, null. |
| `withDefaults` | `(config, defaults) => T` | Fill in missing keys without overwriting existing values. |
| `freeze` | `(config) => Readonly<T>` | Recursively `Object.freeze` - immutable at runtime. |

## Env var mapping convention

Double underscores become dots (nested keys). Prefix is stripped and lowercased.

```
APP_DATABASE__HOST=db.prod.internal  ->  config.database.host = "db.prod.internal"
APP_PORT=3000                        ->  config.port = 3000
APP_FEATURE__ENABLED=true            ->  config.feature.enabled = true
```

## Example usage

```ts
import { mergeConfigs, withEnvOverrides, withDefaults, freeze } from "./config-merge";

const defaults = { port: 8080, db: { host: "localhost", port: 5432 } };
const envCfg = withEnvOverrides(defaults, "APP");
const final = freeze(withDefaults(envCfg, { timeout: 30000 }));
```

## Why quarantined

Not yet wired into the main config-loader pipeline. Integration decisions pending:
- Does this replace or augment `packages/tools/config-loader.ts`?
- Should `withEnvOverrides` be the canonical env injection path across all packages?
- Does `freeze` belong at the kernel boundary or at each consumer?

## Integration path (when ready)

1. Import in `packages/tools/config-loader.ts` and expose via the existing loader API.
2. Update `packages/eight/` agent config construction to use `mergeConfigs` + `withEnvOverrides`.
3. Call `freeze()` at the session boundary so runtime mutations throw immediately.

## Tests needed

- Deep merge with overlapping and non-overlapping keys
- `withEnvOverrides` coercion: boolean, number, null, string passthrough
- `withDefaults` does not overwrite existing values
- `freeze` throws on mutation attempt
