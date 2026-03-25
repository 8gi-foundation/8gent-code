# command-parser

**Tool name:** command-parser
**Status:** quarantine
**Package:** `packages/tools/command-parser.ts`

## Description

Parses CLI-style command strings into structured arguments and flags. No external dependencies. ~140 lines of TypeScript.

Features:
- Extracts the leading command token
- Positional (non-flag) argument collection
- Long flags: `--flag value`, `--flag=value`, `--boolean-flag`
- Short flags: `-f value`, `-v` (boolean), stacked `-abc` (all boolean)
- Quoted string support: `'single quotes'` and `"double quotes"` preserved as single tokens
- Optional schema for type coercion, short-to-long alias resolution, and default values

## API

```ts
import { parseCommand } from "../packages/tools/command-parser.ts";

parseCommand('deploy --env prod -v --dry-run "my app"')
// => {
//   command: "deploy",
//   positional: ["my app"],
//   flags: { env: "prod", v: true, "dry-run": true },
//   raw: 'deploy --env prod -v --dry-run "my app"'
// }

// With schema for aliases and type hints
parseCommand('push -m "initial commit" -v', {
  message: { short: "m", type: "string" },
  verbose: { short: "v", type: "boolean" },
})
// => { command: "push", positional: [], flags: { message: "initial commit", verbose: true }, raw: "..." }

// Stacked boolean flags
parseCommand('ls -lah')
// => { command: "ls", positional: [], flags: { l: true, a: true, h: true }, raw: "ls -lah" }

// Inline assignment
parseCommand('run --port=3000 --host=localhost')
// => { command: "run", positional: [], flags: { port: "3000", host: "localhost" }, raw: "..." }
```

## Integration Path

1. Wire into `packages/tools/index.ts` exports when promoted from quarantine.
2. Use in the TUI chat input to parse `/slash-commands` with structured arguments (e.g. `/deploy --env prod`).
3. Use in `packages/eight/tools.ts` to add a `parse_command` tool, letting the agent interpret user-typed CLI fragments without regex.
4. Use in `apps/clui/` desktop overlay for command palette argument parsing.

## Promotion Criteria

- [ ] Unit tests passing (positional, long flags, short flags, stacked, quoted strings, schema aliases, defaults, inline `=`)
- [ ] Integrated into at least one consumer (TUI slash commands or agent tool)
- [ ] Fuzz-tested against malformed inputs (unclosed quotes, empty string, flags only)
