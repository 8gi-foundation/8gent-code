# Quarantine: Shell Autocomplete

## Package

`packages/tools/autocomplete.ts`

## What it does

Generates shell completion scripts for bash, zsh, and fish. Completes:
- Top-level 8gent subcommands (tui, chat, agent, session, memory, etc.)
- Nested subcommands (agent list, session resume, memory recall, etc.)
- Global flags (-h, --help)
- File path completion for file-accepting commands (outline, symbol, search)

## Usage

```bash
# Generate and install bash completions
bun run packages/tools/autocomplete.ts bash >> ~/.bashrc

# Generate zsh completions
bun run packages/tools/autocomplete.ts zsh > ~/.zfunc/_8gent

# Generate fish completions
bun run packages/tools/autocomplete.ts fish > ~/.config/fish/completions/8gent.fish
```

Programmatic use:

```ts
import { generateCompletion } from "./packages/tools/autocomplete.ts";
const script = generateCompletion("zsh");
```

## Integration path

- Wire into `8gent completions <shell>` CLI subcommand
- Add to installer flow (apps/installer)
- Auto-detect shell from $SHELL env var

## Size

- 1 file, ~130 lines
- 0 dependencies beyond Bun runtime
- Exports `generateCompletion(shell)` and runs standalone via `import.meta.main`

## Validation

```bash
# Verify it generates valid output for each shell
bun run packages/tools/autocomplete.ts bash | head -5
bun run packages/tools/autocomplete.ts zsh | head -5
bun run packages/tools/autocomplete.ts fish | head -5
```
