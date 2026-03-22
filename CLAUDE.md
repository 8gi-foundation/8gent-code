# CLAUDE.md

## Project

8gent Code - the brain of the 8gent ecosystem. Open source autonomous coding agent TUI powered by local LLMs (Ollama) or cloud models (OpenRouter). The free on-ramp to 8gent OS.

- **Domain:** 8gent.dev
- **Runtime:** Bun
- **TUI:** Ink v6 (React for CLI)
- **Monorepo:** `apps/tui/` (frontend), `packages/` (agent, providers, tools, etc.)

### Ecosystem

| Product | Domain | Role |
|---------|--------|------|
| **8gent OS** | 8gentos.com | Parent platform - the paid product |
| **8gent Code** | 8gent.dev | Open source coding agent (this repo) - the free on-ramp |
| **8gent** | 8gent.app | GUI client |
| **8gent Jr** | 8gentjr.com | AI OS for neurodivergent children |
| **8gent World** | 8gent.world | Documentation and ecosystem hub |
| **8gent Games** | 8gent.games | AI civilisation playground |

See [BRAND.md](BRAND.md) for all design, color, typography, and brand rules.

## Commands

```bash
bun install          # install deps
bun run tui          # launch TUI
bun run benchmarks/autoresearch/harness.ts  # run benchmarks
```

## Absolute Prohibitions (NON-NEGOTIABLE)

1. **No em dashes.** Never. Use hyphens (-) or rewrite. No exceptions.
2. **No purple/pink/violet/magenta colors.** Hues 270-350 are banned. See BRAND.md for approved palette.
3. **No dollar values on benchmarks.** Describe what tasks test, not what they'd cost.

## No-BS Mode (ALWAYS ON)

**Every agent working on this repo MUST follow these rules:**

1. **One thing at a time.** Finish what you started before proposing anything new.
2. **Import concepts, not code.** Read external projects → abstract the pattern → rebuild in <200 lines inside existing architecture. No wholesale foreign code merges.
3. **No speculative branches.** Don't create branches unless explicitly asked to build something.
4. **Force constraints before building.** State: problem (1 sentence), constraint, what you're NOT doing, success metric.
5. **Minimize blast radius.** If touching >3 files, pause and confirm scope.
6. **Prove value before expanding.** Every feature needs a measurable outcome.
7. **Call out complexity debt.** More moving parts than removed = red flag.
8. **Scope creep detection.** If the conversation drifted from A to F, stop and ask.
9. **Default to the smallest thing that works.** Not the most impressive — the smallest thing that ships.

## First Principles (ALWAYS ON)

**These are not features. They are defaults.**

1. **Design first, not last.** Before writing code, think about the interaction. Does this need a UI? Could it be voice? Could it be nothing? Friction is the enemy. The best interface is the minimum that serves the user.
2. **Free and local by default.** No API keys to start. Local models first. Cloud is opt-in. Privacy is the foundation.
3. **Self-evolving.** Eight gets better every session. Lessons persist. Skills accumulate.
4. **Hyper-personal.** Learn the user's patterns, preferences, codebase, style. Two users should have different experiences after a week.
5. **Accessible.** Key docs have audio. Voice input works. Screen readers work. Adapt to the user, not the reverse.
6. **Orchestrate by default.** Delegate to sub-agents. Decompose complexity. Use worktrees. Work like a CTO who is also the best IC.
7. **Reduce friction, increase truth.** Prefer voice and conversation over forms. People give more truth when it's easy.
8. **The work speaks for itself.** Expertise is process, design, communication, and what ships — not credentials or enthusiasm.

## Design System Library (MANDATORY)

**Never rely solely on the LLM's taste. Consult the design system before building any UI.**

### Internal Design Assets

| Resource | Path | What It Contains |
|----------|------|-----------------|
| **Design Systems DB** | `packages/design-systems/` | SQLite-backed registry of curated design systems, queryable by style/mood/project type |
| **TUI Theme Tokens** | `apps/tui/src/theme/tokens.ts` | Color, spacing, typography tokens for terminal UI |
| **TUI Semantic Layer** | `apps/tui/src/theme/semantic.ts` | Semantic color mappings (success, error, muted, etc.) |
| **TUI Primitives** | `apps/tui/src/components/primitives/` | AppText, Badge, Card, Stack, Inline, Divider, StatusDot |
| **CLUI (Desktop)** | `apps/clui/` | Tauri 2.0 desktop overlay components |
| **Personality** | `packages/personality/` | Brand voice, "Infinite Gentleman" styling |

### Design Skills Available

These skills are installed and should be consulted for design decisions:

- **DesignExcellence** — design tokens, accessibility, modern UI patterns
- **ui-ux-pro-max** — 50 styles, 97 palettes, 57 font pairings, 99 UX guidelines, 9 stacks
- **web-design-guidelines** — Web Interface Guidelines compliance (Vercel)
- **frontend-design** — production-grade frontend with high design quality
- **theme-factory** — 10 pre-set themes for any artifact
- **brand-guidelines** — Anthropic brand application (for Claude-adjacent work)
- **canvas-design** — visual art in PNG/PDF
- **sleek-design-mobile-apps** — mobile app design

### Protocol

1. **Before building any UI component:** Query the design systems DB or check TUI primitives. Don't reinvent what exists.
2. **Before choosing colors/fonts:** Consult ui-ux-pro-max or the theme tokens. Don't guess.
3. **Before shipping UI:** Run web-design-guidelines review. Don't skip accessibility.
4. **TUI rule (from existing CLAUDE.md below):** Never use `gray`, `white`, or `black` as colors. Use semantic tokens.

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

## Core Ability Packages

Eight's native skills live in these packages. Each is self-contained and can be enabled/disabled independently.

| Package | Ability | Key entry point |
|---------|---------|-----------------|
| `packages/memory/` | Persistent recall | SQLite + FTS5 + Ollama embeddings, 30-day decay, frequency promotion |
| `packages/orchestration/` | Worktree agents | `WorktreePool` — max 4 concurrent, filesystem-based inter-agent messaging |
| `packages/permissions/` | Policy engine | YAML rules, 11 defaults, approval gates for secrets/destructive/network/git/files |
| `packages/self-autonomy/` | Evolution | Post-session reflection, Bayesian skill confidence, self-improvement DB |
| `packages/validation/` | Healing | Checkpoint-verify-revert loop, `git stash` atomic snapshots, failure log |
| `packages/proactive/` | Entrepreneurship | GitHub bounty scanner, capability matcher, opportunity pipeline tracker |
| `packages/ast-index/` | Blast radius | Import dependency graph, test file mapping, change impact estimation |
| `packages/tools/browser/` | Browser | Fetch + DuckDuckGo HTML scraper, HTML-to-text, disk cache, no headless deps |

## Kernel Fine-Tuning (`packages/kernel/`)

The `@8gent/kernel` package handles continuous RL fine-tuning via a training proxy. Key files:

- `proxy.ts` — Training proxy lifecycle and latency monitoring
- `judge.ts` — PRM scoring via Gemini Flash (OpenRouter)
- `training.ts` — GRPO batch collection, checkpoint validation, auto-rollback
- `loop.ts` — MadMax scheduling, auto-promotion into model-router
- `manager.ts` — unified entry point (`KernelManager.fromProjectConfig()`)

**Config:** `config/training-proxy.yaml` (proxy, RL, scheduler settings)
**Docs:** `docs/KERNEL-FINETUNING.md` (full architecture and API reference)
**Data dir:** `.8gent/kernel/` (score history, training batches, checkpoints)

Agent loop integration:
```typescript
const kernel = KernelManager.fromProjectConfig();
await kernel.start();
await kernel.processTurn(sessionId, turn, model, prompt, response);
```

The pipeline is **off by default** — set `"training_proxy": { "enabled": true }` in `.8gent/config.json` to activate.

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

## Personalization System

8gent has a 5-layer personalization system. Key files:

- `packages/self-autonomy/onboarding.ts` — Smart onboarding with `autoDetect()`, 3-question flow
- `packages/self-autonomy/preferences-sync.ts` — Cloud sync via Convex (`syncOnLogin`, `pushToCloud`)
- `packages/eight/prompts/system-prompt.ts` — `USER_CONTEXT_SEGMENT` for adaptive prompts
- `packages/eight/session-sync.ts` — Checkpoint saving, conversation history, resume
- `packages/eight/agent.ts` — `abort()` for ESC interruption, `restoreFromCheckpoint()` for resume
- `packages/kernel/personal-collector.ts` — Training pair collection for personal LoRA
- `packages/memory/types.ts` — `userId` on `MemoryBase` for user-scoped recall
- `packages/db/convex/conversations.ts` — Conversation history persistence
- `apps/tui/src/screens/HistoryScreen.tsx` — Session browser UI

### New Slash Commands
| Command | Purpose |
|---------|---------|
| `/history` | Browse past sessions |
| `/continue` | Resume most recent session |
| `/resume` | Pick from last 5 sessions |
| `/compact` | Compress conversation history |
| `/debug` | Open debug CLI with real-time session log viewer |
| `/music` | Toggle ACE-Step lofi music generation (ADHD mode) |
| `/router` | Show current task router classification and model selection |
| `/github` | GitHub auth status and issue/PR integration |
| `/rename` | Rename the current session |

### ESC Behavior
- During generation: **aborts the AI SDK stream** (calls `agent.abort()`)
- In non-chat views: returns to chat view

## Presentation & Customer-Facing Artifact Rules

**Every HTML presentation, landing page, dashboard, or visual artifact MUST be:**

1. **Mobile-first responsive** — design for 375px first, scale up. Use `clamp()` for all font sizes and spacing. Never use fixed pixel values for padding/margins on any layout element.
2. **Touch-friendly** — swipe navigation, 44px minimum touch targets, no hover-only interactions.
3. **Animated** — staggered entrance animations, smooth transitions between states, number counters animate to value. Static = unacceptable.
4. **Tested before delivery** — mentally verify at 375px (iPhone SE), 393px (iPhone 14), 768px (iPad), 1440px (desktop) before sending to James.
5. **Tables on mobile** — always wrap in horizontal scroll container with `-webkit-overflow-scrolling: touch`.
6. **Grids on mobile** — single column below 600px, 2-col at 768px, full grid at 960px+.
7. **No fixed pixel fonts** — always `clamp(min, preferred, max)` e.g. `clamp(28px, 5vw, 56px)`.

**Quality bar:** If you wouldn't show it to a $10M investor on their phone, don't ship it.
