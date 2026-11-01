# shell-escape

**Package:** `packages/tools/shell-escape.ts`
**Status:** Quarantine - ready for integration review
**Size:** ~150 lines, zero dependencies

## What it does

Safely escapes strings for shell command arguments. Prevents injection when
passing dynamic values to shell commands. Provides command building and a
simple shell string lexer.

## API

| Export | Signature | Description |
|--------|-----------|-------------|
| `escapeArg` | `(str: string) => string` | Escape a single argument for POSIX shell |
| `escapeArgs` | `(args: string[]) => string[]` | Escape an array of arguments |
| `buildCommand` | `(cmd: string, args: string[]) => string` | Build a full shell command string |
| `shellQuote` | `(str: string) => string` | Wrap a value in double quotes with escaping |
| `shellSplit` | `(input: string) => string[]` | Parse a command string into argument array |

## Usage

```ts
import { escapeArg, escapeArgs, buildCommand, shellQuote, shellSplit } from "./packages/tools/shell-escape";

// Escape a single arg
escapeArg("hello world");      // => "'hello world'"
escapeArg("it's fine");        // => "'it'\\''s fine'"
escapeArg("safe123");          // => "safe123"

// Build a full command
buildCommand("git", ["commit", "-m", "fix: my bug"]);
// => "git commit -m 'fix: my bug'"

// Double-quote embedding
shellQuote('say "hello" $USER');
// => '"say \\"hello\\" \\$USER"'

// Parse a command string
shellSplit("git commit -m 'fix: my bug'");
// => ["git", "commit", "-m", "fix: my bug"]
```

## Notes

- POSIX-only escaping. Windows cmd.exe escaping is not handled.
- `shellSplit` is a lexer - it does NOT expand variables, globs, or process substitutions.
- `shellSplit` throws on unterminated quotes.
- Safe to use with `child_process.execSync`, `Bun.spawn`, or any shell exec utility.

## Integration targets

- `packages/eight/tools.ts` - exec tool argument building
- `packages/orchestration/` - sub-agent command construction
- Any place that currently builds shell strings via string interpolation
