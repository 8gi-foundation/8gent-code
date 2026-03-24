# CLAUDE.md

## Project

8gent Code - the kernel of the 8gent ecosystem. Open source autonomous coding agent TUI powered by local LLMs (Ollama) or free cloud models (OpenRouter). The free on-ramp to 8gent OS.

- **Domain:** 8gent.dev
- **Runtime:** Bun
- **TUI:** Ink v6 (React for CLI)
- **Monorepo:** `apps/` (tui, clui, dashboard, debugger, demos, installer) + `packages/` (agent, providers, tools, etc.)
- **Default model:** Ollama (Qwen 3.5 local) or OpenRouter free models (cloud). Task router auto-selects.
- **Deployment:** Eight kernel as persistent daemon on Fly.io Amsterdam ([eight-vessel.fly.dev](https://eight-vessel.fly.dev))

### Ecosystem

6 products, 6 domains.

| Product | Domain | Role |
|---------|--------|------|
| **8gent OS** | 8gentos.com | Parent site. Paid product. Revenue engine. |
| **8gent Code** | 8gent.dev | Open source developer agent. Free on-ramp. (this repo) |
| **8gent** | 8gent.app | Consumer GUI client for the OS. |
| **8gent World** | 8gent.world | Ecosystem story, docs, media. |
| **8gent Games** | 8gent.games | Agent simulation playground. |
| **8gent Jr** | 8gentjr.com | AI assistant for kids. Accessibility first. Free. |

The [8gent Constitution](https://8gent.world/constitution) governs all decisions.

See [BRAND.md](BRAND.md) for all design, color, typography, and brand rules.

### Eight Kernel (Vessel Daemon)

The Eight kernel runs as a persistent daemon on **Fly.io** (Amsterdam region).

- **URL:** [eight-vessel.fly.dev](https://eight-vessel.fly.dev)
- **Protocol:** Daemon Protocol v1.0 (WebSocket, auth, sessions, streaming)
- **Package:** `packages/daemon/` - always-on process with `AgentPool`
- **Retry:** 4-strategy retry loop

## Commands

```bash
# Users
npm install -g @podjamz/8gent-code       # install globally
8gent                                     # launch anywhere

# Contributors (from source)
bun install                              # install deps
bun run tui                              # launch TUI
bun run benchmark:v2                     # single benchmark pass
CATEGORY=battle-test bun run benchmark:loop  # autoresearch loop
bun run benchmarks/autoresearch/harness.ts   # run harness directly
```

## Key Files

| File | What it does |
|------|--------------|
| `packages/eight/tools.ts` | Core tool definitions for the agent |
| `packages/eight/agent.ts` | Agent loop, abort, checkpoint restore |
| `packages/eight/prompts/system-prompt.ts` | System prompt with user context injection |
| `packages/permissions/policy-engine.ts` | NemoClaw policy engine (YAML-based, deny-by-default) |
| `packages/memory/store.ts` | Memory store (SQLite + FTS5, episodic + semantic) |
| `packages/self-autonomy/` | Evolution, reflection, HyperAgent meta-mutation, persona mutation |
| `packages/daemon/` | Persistent vessel daemon |
| `packages/kernel/` | RL fine-tuning pipeline (GRPO, off by default) |
| `docs/HYPERAGENT-SPEC.md` | HyperAgent metacognitive self-modification spec |
| `docs/MODEL-SHOOTOUT.md` | Local vs cloud model comparison |
| `docs/KERNEL-FINETUNING.md` | RL fine-tuning architecture |

## Absolute Prohibitions (NON-NEGOTIABLE)

1. **No em dashes.** Never. Use hyphens (-) or rewrite. No exceptions.
2. **No purple/pink/violet colors.** Hues 270-350 are banned. See BRAND.md for approved palette.
3. **No dollar values on benchmarks.** Describe what tasks test, not what they'd cost.
4. **No stat padding.** Never pad descriptions with arbitrary numbers (package counts, benchmark counts, commit counts). Only state what actually exists with evidence.
5. **No enthusiasm inflation.** Don't oversell. State what was done, what works, what doesn't.

## Writing Rules

- **No em dashes.** Use hyphens or rewrite.
- **NOW/NEXT/LATER** for timelines, not Q1/Q2/Q3/Q4.
- **Evidence over vibes.** Every claim needs a benchmark score, test count, or link.
- **No stat padding.** If unsure about a feature's status, say "specified" or "in progress" rather than "implemented."

## Brand

- **Typography:** Fraunces (serif, weight 800) for brand wordmark. Inter (sans) for UI text. JetBrains Mono for code.
- **Accent color:** #E8610A (orange). No purple.
- **Full brand rules:** [BRAND.md](BRAND.md)

## No-BS Mode (ALWAYS ON)

**Every agent working on this repo MUST follow these rules:**

1. **One thing at a time.** Finish what you started before proposing anything new.
2. **Import concepts, not code.** Read external projects - abstract the pattern - rebuild in <200 lines inside existing architecture. No wholesale foreign code merges.
3. **No speculative branches.** Don't create branches unless explicitly asked to build something.
4. **Force constraints before building.** State: problem (1 sentence), constraint, what you're NOT doing, success metric.
5. **Minimize blast radius.** If touching >3 files, pause and confirm scope.
6. **Prove value before expanding.** Every feature needs a measurable outcome.
7. **Call out complexity debt.** More moving parts than removed = red flag.
8. **Scope creep detection.** If the conversation drifted from A to F, stop and ask.
9. **Default to the smallest thing that works.** Not the most impressive - the smallest thing that ships.

## First Principles (ALWAYS ON)

**These are not features. They are defaults.**

1. **Design first, not last.** Before writing code, think about the interaction. Friction is the enemy. The best interface is the minimum that serves the user.
2. **Free and local by default.** No API keys to start. Local models first. Cloud is opt-in. Privacy is the foundation.
3. **Self-evolving.** Eight gets better every session. Lessons persist. Skills accumulate.
4. **Hyper-personal.** Learn the user's patterns, preferences, codebase, style. Two users should have different experiences after a week.
5. **Accessible.** Key docs have audio. Voice input works. Screen readers work. Adapt to the user, not the reverse.
6. **Orchestrate by default.** Delegate to sub-agents. Decompose complexity. Use worktrees.
7. **Reduce friction, increase truth.** Prefer voice and conversation over forms.
8. **The work speaks for itself.** Expertise is process, design, communication, and what ships - not credentials or enthusiasm.

## Core Ability Packages (9 Powers)

Eight's 9 Powers. Each is self-contained, CLI-callable, and usable by any agent.

| Package | Power | Key capabilities |
|---------|-------|-----------------|
| `packages/memory/` | Memory | SQLite + FTS5 + Ollama embeddings, procedural memory, health monitoring, contradiction detection, consolidation, lease-based job queue |
| `packages/music/` | DJ & Music | YouTube streaming (mpv+yt-dlp), 30k+ internet radio, 15-genre sox synth, Replicate MusicGen, mixing, BPM detection, looping, queue |
| `packages/orchestration/` | Worktree | `WorktreePool` - max 4 concurrent, filesystem messaging, macro-actions, delegation |
| `packages/permissions/` | Policy | NemoClaw YAML engine, 11 defaults, approval gates, headless mode, infinite mode |
| `packages/self-autonomy/` | Evolution | Post-session reflection, Bayesian skill confidence, HyperAgent meta-mutation, self-improvement DB |
| `packages/validation/` | Healing | Checkpoint-verify-revert loop, `git stash` atomic snapshots, failure log |
| `packages/proactive/` | Entrepreneurship | GitHub bounty scanner, capability matcher, opportunity pipeline, business agents |
| `packages/ast-index/` | AST | Import dependency graph, test file mapping, change impact estimation |
| `packages/tools/browser/` | Browser | Fetch + DuckDuckGo HTML scraper, HTML-to-text, disk cache, no headless deps |

## Agent CLI Quick Reference

Any agent can call these packages directly. No TUI required.

```bash
# DJ - stream YouTube, radio, produce tracks
bun -e "import {DJ} from './packages/music/dj.ts'; const d=new DJ(); await d.play('lofi hip hop')"
bun -e "import {DJ} from './packages/music/dj.ts'; const d=new DJ(); await d.radio('techno')"
bun -e "import {MusicProducer} from './packages/music/producer.ts'; const p=new MusicProducer(); const t=await p.produce({genre:'house'}); p.loop(t)"

# Memory - query, health, consolidate
bun -e "import {MemoryStore} from './packages/memory/store.ts'; const s=new MemoryStore('.8gent/memory.db'); console.log(s.getStats())"
bun -e "import {memoryHealth} from './packages/memory/health.ts'; import {Database} from 'bun:sqlite'; console.log(memoryHealth(new Database('.8gent/memory.db')))"

# Stop playback
pkill -f mpv; pkill -f afplay
```

## Memory Layer (`packages/memory/`)

Dual-layer episodic + semantic storage:

- **Episodic memories** - timestamped facts extracted from conversations, auto-decayed over 30 days
- **Semantic memories** - consolidated, promoted facts with frequency-based scoring
- **Procedural memory** - learned procedures and workflows (landed)
- **Natural language queries** - FTS5 full-text search + Ollama embeddings for semantic retrieval
- **Auto-injection** - relevant memories injected into system prompt each turn
- **Consolidation** - background process via lease-based job queue (landed)
- **Health monitoring** - in progress
- **Contradiction detection** - in progress

**API reference:** [docs/MEMORY-SPEC.md](docs/MEMORY-SPEC.md)

## Kernel Fine-Tuning (`packages/kernel/`)

The `@8gent/kernel` package handles continuous RL fine-tuning via a training proxy. Key files:

- `proxy.ts` - Training proxy lifecycle and latency monitoring
- `judge.ts` - PRM scoring via Gemini Flash (OpenRouter)
- `training.ts` - GRPO batch collection, checkpoint validation, auto-rollback
- `loop.ts` - MadMax scheduling, auto-promotion into model-router
- `manager.ts` - unified entry point (`KernelManager.fromProjectConfig()`)

**Config:** `config/training-proxy.yaml`
**Docs:** `docs/KERNEL-FINETUNING.md`
**Data dir:** `.8gent/kernel/`

The pipeline is **off by default** - set `"training_proxy": { "enabled": true }` in `.8gent/config.json` to activate.

## Design System Library (MANDATORY)

**Never rely solely on the LLM's taste. Consult the design system before building any UI.**

### Internal Design Assets

| Resource | Path | What It Contains |
|----------|------|-----------------|
| **Design Systems DB** | `packages/design-systems/` | SQLite-backed registry of curated design systems |
| **TUI Theme Tokens** | `apps/tui/src/theme/tokens.ts` | Color, spacing, typography tokens for terminal UI |
| **TUI Semantic Layer** | `apps/tui/src/theme/semantic.ts` | Semantic color mappings (success, error, muted, etc.) |
| **TUI Primitives** | `apps/tui/src/components/primitives/` | AppText, Badge, Card, Stack, Inline, Divider, StatusDot |
| **CLUI (Desktop)** | `apps/clui/` | Tauri 2.0 desktop overlay components |
| **Personality** | `packages/personality/` | Brand voice, "Infinite Gentleman" styling |

### Design Skills Available

These skills are installed and should be consulted for design decisions:

- **DesignExcellence** - design tokens, accessibility, modern UI patterns
- **ui-ux-pro-max** - styles, palettes, font pairings, UX guidelines
- **web-design-guidelines** - Web Interface Guidelines compliance (Vercel)
- **frontend-design** - production-grade frontend with high design quality
- **theme-factory** - pre-set themes for any artifact
- **brand-guidelines** - Anthropic brand application (for Claude-adjacent work)
- **canvas-design** - visual art in PNG/PDF
- **sleek-design-mobile-apps** - mobile app design

### Protocol

1. **Before building any UI component:** Query the design systems DB or check TUI primitives. Don't reinvent what exists.
2. **Before choosing colors/fonts:** Consult the theme tokens. Don't guess.
3. **Before shipping UI:** Review accessibility. Don't skip it.
4. **TUI rule:** Never use `gray`, `white`, or `black` as colors. Use semantic tokens.

## AI Judging Rule

**NEVER use string matching** (regex, `.includes()`, substring checks) to evaluate agent output, detect completion, classify results, or make decisions about success/failure. Always use the **Vercel AI SDK (`ai` package) as a judge** - call a model with a structured prompt to evaluate the output semantically.

This applies to: harness validation, loop detection heuristics, completion verification, test result parsing, session analysis, and any other situation where you need to interpret or classify natural-language or semi-structured output.

## TUI Color Rules

Terminal users have wildly different themes (dark, light, Solarized, etc.). Follow these rules strictly:

**NEVER use these colors in JSX props:**
- `color="gray"` - maps to ANSI bright-black, invisible on Solarized Dark
- `color="white"` - invisible on light backgrounds
- `color="black"` - invisible on dark backgrounds
- `borderColor="gray"` - same problem as color="gray"

**Instead:**
- De-emphasized text: `dimColor` (no color prop). Dims relative to user's fg.
- Emphasized text: `bold` (no color prop). Uses user's fg + bold.
- Borders: `borderColor="blue"` or `borderColor="cyan"`
- High-contrast badges: `inverse` prop (swaps fg/bg, always readable)

**Safe named colors:** `red`, `green`, `yellow`, `blue`, `cyan`

| Purpose | Props |
|---------|-------|
| Secondary/muted text | `dimColor` |
| Primary emphasis | `bold` |
| Brand/assistant | `color="cyan"` |
| User text | `color="yellow"` |
| Success | `color="green"` |
| Error | `color="red"` |
| Warning | `color="yellow"` |
| Info/borders | `color="blue"` |
| Status badges | `inverse color="green"` etc. |

## Versioning & Release Rules

1. **Version lives in 3 places** - keep them in sync:
   - `package.json` - `"version"` (source of truth)
   - `bin/8gent.ts` - `const VERSION`
   - `README.md` - version badge
2. **CHANGELOG.md is mandatory** - every PR or significant batch of work must add an entry. Follow [Keep a Changelog](https://keepachangelog.com/) format.
3. **SemVer strictly:**
   - PATCH (1.0.x): bug fixes, minor tweaks
   - MINOR (1.x.0): new features, new benchmarks, new packages
   - MAJOR (x.0.0): breaking changes to CLI, session format, or API
4. **Tag releases** with `git tag v1.x.0` after version bumps.

## TUI Design System

The TUI follows a **design-system-first** architecture. Never use raw Ink `<Text>` or `<Box>` in screens - use the primitive layer.

### Structure

```
apps/tui/src/
  theme/          # tokens - semantic - ThemeProvider
  components/
    primitives/   # AppText, MutedText, Heading, Label, Stack, Inline, Card, Badge, etc.
    feedback/     # Alert, SpinnerRow, ProgressBar
    forms/        # TextField, SelectField
    data-display/ # Table, KeyValueList
    navigation/   # Header, Footer
  hooks/          # useHotkeys, useViewport, useAsyncTask, useSelection, useGhostSuggestion
  lib/            # text (truncate, wrapText), layout (clamp, columnWidth), format (formatTokens, formatDuration)
  screens/        # ChatScreen, OnboardingScreen - compose components, no raw styling
  app/            # providers.tsx (ThemeProvider + ADHDMode)
```

### Rules

1. **No raw colors in app code** - use tokens/semantic or primitives (`<MutedText>`, `<ErrorText>`, etc.)
2. **No `<Text>` or `<Box>` in screens** - compose from primitives and widgets
3. **Formatting lives in `lib/`** - use `formatTokens()`, `formatDuration()`, `truncate()`, not inline logic
4. **Layouts use primitives** - `<Stack>` for vertical, `<Inline>` for horizontal, `<Spacer>` for flex fill, `<Divider>` for separators
5. **All reusable UI in `components/`** - screens only compose, never implement raw UI
6. **Loading/error/empty are standard components** - never ad hoc
7. **Every width-sensitive display uses `truncate()`** from lib

## Personalization System

5-layer personalization system. Key files:

- `packages/self-autonomy/onboarding.ts` - Smart onboarding with `autoDetect()`, 3-question flow
- `packages/self-autonomy/preferences-sync.ts` - Cloud sync via Convex
- `packages/eight/prompts/system-prompt.ts` - `USER_CONTEXT_SEGMENT` for adaptive prompts
- `packages/eight/session-sync.ts` - Checkpoint saving, conversation history, resume
- `packages/eight/agent.ts` - `abort()` for ESC interruption, `restoreFromCheckpoint()` for resume
- `packages/kernel/personal-collector.ts` - Training pair collection for personal LoRA
- `packages/memory/types.ts` - `userId` on `MemoryBase` for user-scoped recall

### ESC Behavior
- During generation: **aborts the AI SDK stream** (calls `agent.abort()`)
- In non-chat views: returns to chat view

## Presentation & Customer-Facing Artifact Rules

**Every HTML presentation, landing page, dashboard, or visual artifact MUST be:**

1. **Mobile-first responsive** - design for 375px first, scale up. Use `clamp()` for all font sizes and spacing.
2. **Touch-friendly** - swipe navigation, 44px minimum touch targets, no hover-only interactions.
3. **Animated** - staggered entrance animations, smooth transitions between states.
4. **Tested before delivery** - mentally verify at 375px (iPhone SE), 393px (iPhone 14), 768px (iPad), 1440px (desktop).
5. **Tables on mobile** - always wrap in horizontal scroll container.
6. **Grids on mobile** - single column below 600px, 2-col at 768px, full grid at 960px+.
7. **No fixed pixel fonts** - always `clamp(min, preferred, max)`.

**Quality bar:** If you wouldn't show it to a $10M investor on their phone, don't ship it.
