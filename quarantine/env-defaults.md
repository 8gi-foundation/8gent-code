# quarantine: env-defaults

**Status:** quarantine - awaiting integration review

## What

Typed, default-safe environment variable access. Replaces `process.env.X || fallback` one-liners with a consistent API that auto-coerces to the correct type.

## API

```ts
import { env } from '../packages/tools/env-defaults';

// String - returns undefined if unset
env.string('APP_NAME')               // string | undefined
env.string('APP_NAME', '8gent')      // string

// Number - NaN-safe, warns on bad input
env.number('PORT', 3000)             // number

// Boolean - accepts 1/0, true/false, yes/no, on/off
env.boolean('DEBUG', false)          // boolean

// JSON - parsed object, falls back on parse error
env.json<Config>('APP_CONFIG', {})   // Config

// List - comma-separated, trimmed
env.list('ALLOWED_ORIGINS', [])      // string[]

// Required - throws EnvMissingError if absent
env.required('DATABASE_URL')         // string (or throws)
```

## Why

- `process.env` is always `string | undefined` - callers must cast manually
- Coercion bugs (NaN ports, string "false" being truthy) are common
- `required()` gives a clear error at startup rather than a cryptic downstream failure

## Constraints

- No dependencies - pure Node/Bun compatible
- Does not mutate `process.env`
- All functions are overloaded so TypeScript infers the return type correctly

## Integration points

- Replace ad-hoc `process.env.X || default` patterns repo-wide
- Useful in `packages/eight/agent.ts`, `packages/daemon/`, and anywhere config is read at startup

## File

`packages/tools/env-defaults.ts` - 125 lines
