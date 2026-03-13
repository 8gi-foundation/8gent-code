# CLAUDE.md

## Project

8gent Code — autonomous coding agent TUI powered by local LLMs (Ollama) or cloud models (OpenRouter).

- **Runtime:** Bun
- **TUI:** Ink v6 (React for CLI)
- **Monorepo:** `apps/tui/` (frontend), `packages/` (agent, providers, tools, etc.)

## Commands

```bash
bun install          # install deps
bun run tui          # launch TUI
bun run benchmarks/autoresearch/harness.ts  # run benchmarks
```

## TUI Color Rules

Terminal users have wildly different themes (dark, light, Solarized, etc.). Follow these rules strictly:

**NEVER use these colors in JSX props:**
- `color="gray"` — maps to ANSI bright-black, invisible on Solarized Dark
- `color="white"` — invisible on light backgrounds
- `color="black"` — invisible on dark backgrounds
- `borderColor="gray"` — same problem as color="gray"

**Instead:**
- De-emphasized text → `dimColor` (no color prop). Dims relative to user's fg.
- Emphasized text → `bold` (no color prop). Uses user's fg + bold.
- Borders → `borderColor="blue"` or `borderColor="cyan"`
- High-contrast badges → `inverse` prop (swaps fg/bg, always readable)

**Safe named colors:** `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`

**Hex/RGB colors** are OK for decorative animations (rainbow, gradients) but never for readable text — they degrade unpredictably on terminals without truecolor.

| Purpose | Props |
|---------|-------|
| Secondary/muted text | `dimColor` |
| Primary emphasis | `bold` |
| Brand/assistant | `color="cyan"` |
| User text | `color="yellow"` |
| Success | `color="green"` |
| Error | `color="red"` |
| Warning | `color="yellow"` |
| Accent | `color="magenta"` |
| Info/borders | `color="blue"` |
| Status badges | `inverse color="green"` etc. |
