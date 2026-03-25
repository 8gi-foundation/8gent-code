# dotenv-parser

## Tool Name
`dotenv-parser`

## Description
Parses `.env` files into key/value objects. Supports quoted values (single and double), multiline double-quoted strings, inline and full-line comments, the `export` prefix, and variable expansion using `$VAR` / `${VAR}` syntax. Expansion resolves references against already-parsed keys first, then falls back to `process.env`.

## Status
`quarantine` - standalone, not yet wired into the agent tool registry.

## Integration Path
1. Add to `packages/tools/index.ts` exports.
2. Register as an agent tool in `packages/eight/tools.ts` under the `fs` category.
3. Use in `packages/self-autonomy/` and `packages/daemon/` anywhere config files are loaded from disk - replace ad-hoc `Bun.env` lookups with `loadDotenv()` for explicit, reproducible config loading.
4. Optionally expose via CLI: `8gent env load <file>` to inspect parsed values during debugging.

## API

```ts
import { parseDotenv, loadDotenv } from "../packages/tools/dotenv-parser";

// Parse from string
const vars = parseDotenv('FOO=bar\nBAR=$FOO/baz');

// Load from file (async, Bun)
const vars = await loadDotenv('.env.local');
```

## Files
- `packages/tools/dotenv-parser.ts` - implementation (~130 lines)
