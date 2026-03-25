# Quarantine: env-guard

## What

Validates required environment variables at startup with type coercion, defaults, and custom validation. Collects all missing/invalid vars before throwing so the caller sees every problem in one error message rather than one at a time.

## File

`packages/tools/env-guard.ts` (~140 lines)

## Status

**quarantine** - new file, untested in CI, not yet wired into tool registry.

## API

```ts
import { envGuard, getEnv, requireEnv } from './packages/tools/env-guard.ts';

// Full schema validation - returns typed config object
const cfg = envGuard({
  PORT:         { type: "number", default: "3000" },
  DATABASE_URL: { type: "url", description: "Postgres connection string" },
  NODE_ENV:     { type: "string", default: "development" },
  DEBUG:        { type: "boolean", required: false, default: "false" },
  API_KEY:      {
    validate: (v) => v.length < 32 ? "must be at least 32 chars" : null,
  },
});
cfg.PORT         // number
cfg.DATABASE_URL // string (URL-validated)
cfg.DEBUG        // boolean | undefined

// Single optional read
getEnv("NODE_ENV")           // string | undefined
getEnv("PORT", "number")     // number | undefined

// Single required read - throws if absent
requireEnv("DATABASE_URL")
requireEnv("MAX_RETRIES", "number")
```

## Schema fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `required` | boolean | `true` | Throw if absent and no default |
| `type` | `"string" \| "number" \| "boolean" \| "url"` | `"string"` | Coerce and validate value type |
| `default` | string \| number \| boolean | - | Used when var is absent and `required: false` or when providing a fallback |
| `validate` | `(value: string) => string \| null` | - | Custom validation; return error string to fail |
| `description` | string | - | Shown in error output to aid debugging |

## Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `envGuard` | `(schema: EnvSchema) => EnvConfig` | Validate full schema, return typed config |
| `getEnv` | `(key, type?) => T \| undefined` | Read single var, undefined if absent |
| `requireEnv` | `(key, type?) => T` | Read single var, throw if absent |

## Integration path

- [ ] Add export to `packages/tools/index.ts`
- [ ] Register as an agent-callable tool in `packages/eight/tools.ts`
- [ ] Add unit tests: missing required var, bad number/boolean/url, custom validate, defaults, multi-error accumulation
- [ ] Use in `packages/daemon/` startup to validate daemon config vars
- [ ] Use in `packages/kernel/` training proxy config validation
- [ ] Consider `envGuardFromFile(path)` helper to load a `.env` file first then validate
