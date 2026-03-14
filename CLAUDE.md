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

## AI Judging Rule

**NEVER use string matching** (regex, `.includes()`, substring checks) to evaluate agent output, detect completion, classify results, or make decisions about success/failure. Always use the **Vercel AI SDK (`ai` package) as a judge** — call a model with a structured prompt to evaluate the output semantically. String matching is brittle, breaks on paraphrasing, and produces false positives/negatives. An LLM judge handles ambiguity, synonyms, and edge cases correctly.

This applies to: harness validation, loop detection heuristics, completion verification, test result parsing, session analysis, and any other situation where you need to interpret or classify natural-language or semi-structured output.

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

## Versioning & Release Rules

**Every agent working on this repo MUST follow these rules:**

1. **Version lives in 3 places** — keep them in sync:
   - `package.json` → `"version"` (source of truth)
   - `bin/8gent.ts` → `const VERSION`
   - `README.md` → version badge
2. **CHANGELOG.md is mandatory** — every PR or significant batch of work must add an entry under `[Unreleased]` or a new version section. Follow [Keep a Changelog](https://keepachangelog.com/) format.
3. **SemVer strictly:**
   - PATCH (0.3.x): bug fixes, minor tweaks
   - MINOR (0.x.0): new features, new benchmarks, new packages
   - MAJOR (x.0.0): breaking changes to CLI, session format, or API
4. **Never ship without updating the changelog.** If you add a feature, fix a bug, or refactor something significant — document it in CHANGELOG.md before committing.
5. **Tag releases** with `git tag v0.x.0` after version bumps.

## TUI Design System

The TUI follows a **design-system-first** architecture. Never use raw Ink `<Text>` or `<Box>` in screens — use the primitive layer.

### Structure

```
apps/tui/src/
  theme/          # tokens → semantic → ThemeProvider
  components/
    primitives/   # AppText, MutedText, Heading, Label, Stack, Inline, Card, Badge, etc.
    feedback/     # Alert, SpinnerRow, ProgressBar
    forms/        # TextField, SelectField
    data-display/ # Table, KeyValueList
    navigation/   # Header, Footer
    (existing)    # All legacy components refactored to use primitives
  hooks/          # useHotkeys, useViewport, useAsyncTask, useSelection, useGhostSuggestion
  lib/            # text (truncate, wrapText), layout (clamp, columnWidth), format (formatTokens, formatDuration)
  screens/        # ChatScreen, OnboardingScreen — compose components, no raw styling
  app/            # providers.tsx (ThemeProvider + ADHDMode)
```

### Rules

1. **No raw colors in app code** — use tokens/semantic or primitives (`<MutedText>`, `<ErrorText>`, etc.)
2. **No `<Text>` or `<Box>` in screens** — compose from primitives and widgets
3. **Formatting lives in `lib/`** — use `formatTokens()`, `formatDuration()`, `truncate()`, not inline logic
4. **Layouts use primitives** — `<Stack>` for vertical, `<Inline>` for horizontal, `<Spacer>` for flex fill, `<Divider>` for separators
5. **All reusable UI in `components/`** — screens only compose, never implement raw UI
6. **Loading/error/empty are standard components** — never ad hoc
7. **Every width-sensitive display uses `truncate()`** from lib
