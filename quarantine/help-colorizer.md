# help-colorizer

## Status: Quarantine

CLI help output colorizer. Takes raw `--help` text and applies ANSI colors for terminal readability.

## Location

`packages/tools/help-colorizer.ts`

## What it does

Parses plain text help output line-by-line and applies:

- **Bold** - section headers (e.g. "Usage:", "Options:", "COMMANDS")
- **Cyan** - command/subcommand names in indented lists
- **Yellow** - flags (`--verbose`, `-f`, `--output-dir`)
- **Dim** - description text

## Usage

As a library:

```ts
import { colorizeHelp } from 'packages/tools/help-colorizer';

const raw = execSync('bun --help').toString();
console.log(colorizeHelp(raw));
```

As a pipe filter:

```bash
git --help | bun run packages/tools/help-colorizer.ts
```

## Integration path

- Wire into Eight's tool output display so `--help` results render with color
- Could be used by the TUI shell panel for any subprocess help output

## Graduation criteria

- [ ] Tested against 5+ common CLI help formats (git, bun, docker, curl, npm)
- [ ] Edge cases handled: multi-line descriptions, nested subcommands, no-flag lines
- [ ] Integrated into at least one display path in the TUI or agent output
