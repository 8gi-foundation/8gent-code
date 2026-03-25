# Quarantine: process-env-reader

## What

Structured, typed reader for `process.env`. Eliminates scattered raw `process.env.FOO` access across the codebase and prevents runtime surprises from missing or malformed values. Single class with typed getters, a hard-require guard, and environment detection helpers.

## File

`packages/tools/process-env-reader.ts` (~115 lines)

## Status

**quarantine** - new file, untested in CI, not yet wired into tool registry.

## API

```ts
import { env, EnvReader } from './packages/tools/process-env-reader.ts';

// Typed getters with optional fallback
env.getString('OPENROUTER_API_KEY')          // string | undefined
env.getString('PORT', '3000')                // string
env.getNumber('MAX_RETRIES', 3)             // number
env.getBool('DEBUG', false)                  // boolean
env.getJSON<string[]>('ALLOWED_MODELS', []) // string[]
env.getList('TOOLS', ',', [])               // string[]

// Hard require - throws if absent or empty
env.require('OPENROUTER_API_KEY')            // string or throws

// Environment detection
env.isDev()   // true when NODE_ENV === 'development' or absent
env.isProd()  // true when NODE_ENV === 'production'
env.isTest()  // true when NODE_ENV === 'test'

// Custom source (e.g. for testing)
const reader = new EnvReader({ MY_VAR: '42' });
reader.getNumber('MY_VAR') // 42
```

## Truthy values for getBool

`"1"`, `"true"`, `"yes"`, `"on"` (case-insensitive). All other non-empty strings are falsy.

## Integration path

- [ ] Add exports to `packages/tools/index.ts`
- [ ] Replace direct `process.env` access in `packages/eight/agent.ts`, `packages/daemon/`, `packages/kernel/`
- [ ] Add unit tests: present/absent/malformed values for each getter
- [ ] Consider loading `.env` file via `Bun.env` or dotenv in constructor
