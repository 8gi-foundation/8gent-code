# CONVENTIONS.md

Detailed conventions for 8gent-code. The lean overview lives in [AGENTS.md](AGENTS.md).

---

## Repository Structure

```
apps/
  tui/              # Main terminal UI (Ink/React)
  clui/             # Desktop overlay (Tauri 2.0)
  lil-eight/        # macOS dock pet (Swift)
  dashboard/        # Web dashboard
  debugger/         # Debug tools
  demos/            # Example demos
  installer/        # Install wizard

packages/
  eight/            # Core agent loop, tools, system prompt
  providers/        # LLM provider abstraction (Ollama, OpenRouter)
  memory/           # SQLite + FTS5 dual-layer memory
  permissions/      # NemoClaw YAML policy engine
  self-autonomy/    # Evolution, reflection, HyperAgent
  orchestration/    # Worktree pool, parallel agents
  validation/       # Checkpoint-verify-revert loop
  computer/         # Desktop automation (screenshot, click, type)
  tools/            # Browser, web, actuators, utilities
  music/            # DJ, radio, synth, MusicGen
  pet/              # Companion system (terminal + dock)
  daemon/           # Persistent vessel daemon (Fly.io)
  kernel/           # RL fine-tuning pipeline (GRPO)
  ast-index/        # Import graph, change impact estimation
  proactive/        # GitHub bounty scanner, opportunity pipeline
  mcp/              # Model Context Protocol client
  lsp/              # Language Server Protocol integration
  hooks/            # Pre/post tool hooks
  personality/      # Brand voice, persona
  ai/               # Vercel AI SDK integration
  telegram/         # Telegram bot
  voice/            # Voice input/output
```

---

## Core Ability Packages (9 Powers)

| Package | Power | Key capabilities |
|---------|-------|-----------------|
| `packages/memory/` | Memory | SQLite + FTS5 + Ollama embeddings, procedural memory, health monitoring, contradiction detection, consolidation, lease-based job queue |
| `packages/music/` | DJ & Music | YouTube streaming (mpv+yt-dlp), internet radio, sox synth, Replicate MusicGen, mixing, BPM detection, looping, queue |
| `packages/orchestration/` | Worktree | `WorktreePool` - max 4 concurrent, filesystem messaging, macro-actions, delegation |
| `packages/permissions/` | Policy | NemoClaw YAML engine, approval gates, headless mode, infinite mode |
| `packages/self-autonomy/` | Evolution | Post-session reflection, Bayesian skill confidence, HyperAgent meta-mutation, self-improvement DB |
| `packages/validation/` | Healing | Checkpoint-verify-revert loop, `git stash` atomic snapshots, failure log |
| `packages/proactive/` | Entrepreneurship | GitHub bounty scanner, capability matcher, opportunity pipeline |
| `packages/ast-index/` | AST | Import dependency graph, test file mapping, change impact estimation |
| `packages/tools/browser/` | Browser | Fetch + DuckDuckGo HTML scraper, HTML-to-text, disk cache, no headless deps |

---

## Memory Layer (`packages/memory/`)

Dual-layer episodic + semantic storage:

- **Episodic memories** - timestamped facts, auto-decayed over 30 days
- **Semantic memories** - consolidated, promoted facts with frequency-based scoring
- **Procedural memory** - learned procedures and workflows
- **Natural language queries** - FTS5 full-text search + Ollama embeddings
- **Auto-injection** - relevant memories injected into system prompt each turn
- **Consolidation** - background process via lease-based job queue
- **Health monitoring** - in progress
- **Contradiction detection** - in progress

API reference: [docs/MEMORY-SPEC.md](docs/MEMORY-SPEC.md)

---

## Kernel Fine-Tuning (`packages/kernel/`)

Continuous RL fine-tuning via training proxy. Key files:

- `proxy.ts` - Training proxy lifecycle and latency monitoring
- `judge.ts` - PRM scoring via Gemini Flash (OpenRouter)
- `training.ts` - GRPO batch collection, checkpoint validation, auto-rollback
- `loop.ts` - MadMax scheduling, auto-promotion into model-router
- `manager.ts` - unified entry point (`KernelManager.fromProjectConfig()`)

Config: `config/training-proxy.yaml` | Docs: `docs/KERNEL-FINETUNING.md` | Data: `.8gent/kernel/`

**Off by default** - set `"training_proxy": { "enabled": true }` in `.8gent/config.json` to activate.

---

## Policy Engine

NemoClaw evaluates every tool call:

- Policies: `packages/permissions/default-policies.yaml`
- User overrides: `~/.8gent/policies.yaml`
- Three decisions: `allow`, `require_approval`, `block`
- Desktop automation requires approval for mutations, allows reads

---

## Personalization System

5-layer system:

- `packages/self-autonomy/onboarding.ts` - Smart onboarding with `autoDetect()`, 3-question flow
- `packages/self-autonomy/preferences-sync.ts` - Cloud sync via Convex
- `packages/eight/prompts/system-prompt.ts` - `USER_CONTEXT_SEGMENT` for adaptive prompts
- `packages/eight/session-sync.ts` - Checkpoint saving, conversation history, resume
- `packages/eight/agent.ts` - `abort()` for ESC interruption, `restoreFromCheckpoint()` for resume
- `packages/kernel/personal-collector.ts` - Training pair collection for personal LoRA
- `packages/memory/types.ts` - `userId` on `MemoryBase` for user-scoped recall

ESC during generation: aborts the AI SDK stream. In non-chat views: returns to chat view.

---

## TUI Design System

Design-system-first architecture. Never use raw Ink `<Text>` or `<Box>` in screens.

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
3. **Formatting lives in `lib/`** - use `formatTokens()`, `formatDuration()`, `truncate()`
4. **Layouts use primitives** - `<Stack>` for vertical, `<Inline>` for horizontal, `<Spacer>` for flex fill, `<Divider>` for separators
5. **All reusable UI in `components/`** - screens only compose, never implement raw UI
6. **Loading/error/empty are standard components** - never ad hoc
7. **Every width-sensitive display uses `truncate()`** from lib

---

## TUI Color Rules

Terminal users have wildly different themes. Follow these strictly:

**NEVER use:** `color="gray"`, `color="white"`, `color="black"`, `borderColor="gray"`

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

---

## Design System Library

Consult the design system before building any UI.

| Resource | Path |
|----------|------|
| Design Systems DB | `packages/design-systems/` |
| TUI Theme Tokens | `apps/tui/src/theme/tokens.ts` |
| TUI Semantic Layer | `apps/tui/src/theme/semantic.ts` |
| TUI Primitives | `apps/tui/src/components/primitives/` |
| Lil Eight (Desktop) | `apps/lil-eight/` |
| Personality | `packages/personality/` |

---

## AI Judging Rule

**NEVER use string matching** (regex, `.includes()`, substring checks) to evaluate agent output. Always use the **Vercel AI SDK (`ai` package) as a judge** - call a model with a structured prompt to evaluate semantically.

---

## Code Style

- TypeScript strict mode
- Named exports (no default exports)
- Errors as values (`{ ok, error }` patterns)
- Path validation via `safePath()` for user-provided file paths
- Shell command validation via `sanitizeShellCommand()`
- Rate limiting on tool calls to prevent LLM loops
- Bun for all commands: `bun install`, `bun run`, `bun test`

---

## Writing Rules

- **No em dashes.** Use hyphens or rewrite.
- **NOW/NEXT/LATER** for timelines, not Q1/Q2/Q3/Q4.
- **Evidence over vibes.** Every claim needs a benchmark score, test count, or link.
- **No stat padding.** Say "specified" or "in progress" rather than "implemented" when unsure.

---

## Versioning & Release

1. **Version in 3 places** - keep in sync: `package.json` (source of truth), `bin/8gent.ts`, `README.md`
2. **CHANGELOG.md is mandatory** - every PR adds an entry. [Keep a Changelog](https://keepachangelog.com/) format.
3. **SemVer strictly:** PATCH = bug fixes, MINOR = new features, MAJOR = breaking changes
4. **Tag releases** with `git tag v1.x.0` after version bumps.

---

## Presentation & Artifact Rules

Every HTML presentation, landing page, or visual artifact MUST be:

1. **Mobile-first responsive** - 375px first, scale up. `clamp()` for font sizes.
2. **Touch-friendly** - swipe navigation, 44px minimum touch targets.
3. **Animated** - staggered entrance animations, smooth transitions.
4. **Tested** - verify at 375px, 393px, 768px, 1440px.

---

## Agent CLI Quick Reference

```bash
# Delegate a task to Eight
bun run packages/eight/index.ts --cli "implement rate limiting in packages/auth/"

# Run with explicit model
bun run packages/eight/index.ts --cli "refactor memory store" --model qwen2.5-coder:7b

# DJ
bun -e "import {DJ} from './packages/music/dj.ts'; const d=new DJ(); await d.play('lofi hip hop')"

# Memory
bun -e "import {MemoryStore} from './packages/memory/store.ts'; const s=new MemoryStore('.8gent/memory.db'); console.log(s.getStats())"

# Stop playback
pkill -f mpv; pkill -f afplay
```

---

## Self-Improvement Architecture

The autoresearch loop (`bun run benchmark:loop`) runs overnight:

1. Runs execution-graded benchmarks against `bun:test` suites
2. Mutates the system prompt with candidate improvements
3. Re-tests and scores the mutated version
4. Promotes improvements that pass a score threshold

```bash
CATEGORY=battle-test bun run benchmark:loop
```

Results accumulate in `benchmarks/autoresearch/`. They are yours.
