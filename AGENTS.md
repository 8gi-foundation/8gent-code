# 8gent Code - Agent Instructions

> Canonical agent instruction set for this repo. This file is available under three
> names - `AGENTS.md`, `8GENT.md`, and `CLAUDE.md`. They are the same file:
> `8GENT.md` and `CLAUDE.md` are symlinks to `AGENTS.md`. Any agent harness picks up
> identical instructions regardless of which filename it looks for.
>
> 8gent is not married to any vendor. `AGENTS.md` is the vendor-neutral open standard
> and is the real file - edit it, never the symlinks. 8gent's instruction loader
> resolves `AGENTS.md > 8GENT.md > CLAUDE.md`, so the open standard always wins.

## Project

8gent Code - the kernel of the 8gent ecosystem. Open source autonomous coding agent TUI. "Free and local by default" (Principle 2) = adaptive provider routing across local runtimes (Ollama, LM Studio, 8gent localhost) with rate-limit failover to free cloud tiers (OpenRouter `:free`). The free on-ramp to 8gent OS.

- **Domain:** 8gent.dev
- **Runtime:** Bun (not Node - never use Node or npm in scripts)
- **TUI:** Ink v6 (React for CLI)
- **Stack:** Bun, Ink v6, SQLite + FTS5, TypeScript
- **Monorepo:** `apps/` (tui, clui, dashboard, debugger, demos, installer) + `packages/` (agent, providers, tools, etc.)
- **Provider model (CRITICAL - do not restate as "Ollama default"):** Out-of-box active provider = `8gent` (localhost, model `eight-1.0-q3:14b`); `ollama` is also enabled. Runtime clients exist for Ollama + LM Studio + OpenRouter (`packages/eight/clients/`). 11 providers wired in the registry (`packages/providers/index.ts`): `8gent`, `ollama`, `openrouter`, `groq`, `grok`, `openai`, `anthropic`, `mistral`, `together`, `fireworks`, `replicate`. Everything except `8gent`/`ollama` is opt-in via API key. Failover chain (`packages/providers/failover.ts`): local 8gent -> local Qwen -> OpenRouter `:free`. `auto:free` resolves to the best currently-available `:free` model on OpenRouter. Apple Foundation Model is NOT wired (James runs it externally). Cerebras / Chutes / Cohere are NOT wired (candidates to add).
- **Multi-agent orchestration:** First-class. `packages/daemon/agent-pool.ts` holds up to 10 concurrent sessions. `claude-code/src/tools/AgentTool/forkSubagent.ts` lets a parent spawn children that inherit full context. Sessions carry a `channel` field (`os`, `app`, `telegram`, `discord`, `api`) - extensible for third-party terminal hosts (cmux, etc.).
- **Deployment:** Eight kernel as persistent daemon on Fly.io Amsterdam ([eight-vessel.fly.dev](https://eight-vessel.fly.dev))

### Ecosystem

7 products, 7 domains.

| Product | Domain | Role |
|---------|--------|------|
| **8gent OS** | 8gentos.com | Parent site. Paid product. Revenue engine. |
| **8gent Code** | 8gent.dev | Open source developer agent. Free on-ramp. (this repo) |
| **8gent** | 8gent.app | The product - single pane of glass dashboard for all 8gent services. |
| **8gent World** | 8gent.world | Ecosystem story, docs, media. |
| **8gent Games** | 8gent.games | Agent simulation playground. |
| **8gent Jr** | 8gentjr.com | AI assistant for kids. Accessibility first. Free. |
| **8gent Telegram** | t.me/eaborobot | Telegram Mini App - mobile-first 8gent interface. |

### GitHub Organization

All repos live under **8gi-foundation** on GitHub. Apache 2.0 license unless otherwise noted.

| Repo | Role |
|------|------|
| `8gent-code` | Open source agent kernel (this repo) |
| `8gent-world` | Docs, story, marketing site (8gent.world) |
| `8gent-app` | Single pane of glass dashboard (8gent.app) |
| `8gent-telegram-app` | Telegram Mini App + bot |
| `control-plane` | Board Plane - multi-vessel orchestration |
| `board-vessel` | Board member vessel runtime |
| `lil-eight` | Swift dock pet companion |
| `8gent-games` | AI civilisation simulator |
| `8gentjr` | AI OS for neurodivergent children |

The [8gent Constitution](https://8gent.world/constitution) governs all decisions.

See [BRAND.md](BRAND.md) for all design, color, typography, and brand rules.

### Eight Kernel (Vessel Daemon)

The Eight kernel runs as a persistent daemon on **Fly.io** (Amsterdam region).

- **URL:** [eight-vessel.fly.dev](https://eight-vessel.fly.dev)
- **Protocol:** Daemon Protocol v1.0 (WebSocket, auth, sessions, streaming)
- **Package:** `packages/daemon/` - always-on process with `AgentPool`
- **Retry:** 4-strategy retry loop

## Mission

Democratize infinite general intelligence for everyone. Free, local-first, privacy-preserving.

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

## Commands

```bash
# Users
npm install -g @8gi-foundation/8gent-code       # install globally
8gent                                     # launch anywhere

# Contributors (from source)
bun install                              # install deps
bun run tui                              # launch TUI
bun run benchmark:v2                     # single benchmark pass
CATEGORY=battle-test bun run benchmark:loop  # autoresearch loop
bun run benchmarks/autoresearch/harness.ts   # run harness directly

# Autoresearch (overnight / category runs)
source ~/8gent-code/.env && export OPENROUTER_API_KEY
CATEGORY=battle-test MAX_ITERATIONS=3 bun benchmarks/autoresearch/autoresearch-loop.ts
bash benchmarks/autoresearch/overnight-runner.sh
```

Run `bun run tui` to test before any push. Never push untested code. Run `bun run benchmark:v2` for capability regression.

## Key Files

| File | What it does |
|------|--------------|
| `packages/eight/tools.ts` | Core tool definitions for the agent |
| `packages/eight/agent.ts` | Agent loop, abort, checkpoint restore |
| `packages/eight/prompts/system-prompt.ts` | System prompt with user context injection |
| `packages/eight/instruction-loader.ts` | Auto-discovers and merges AGENTS.md / 8GENT.md / CLAUDE.md |
| `packages/permissions/policy-engine.ts` | NemoClaw policy engine (YAML-based, deny-by-default) |
| `packages/memory/store.ts` | Memory store (SQLite + FTS5, episodic + semantic) |
| `packages/providers/failover.ts` | Failover chain |
| `packages/self-autonomy/` | Evolution, reflection, HyperAgent meta-mutation, persona mutation |
| `packages/daemon/` | Persistent vessel daemon |
| `packages/kernel/` | RL fine-tuning pipeline (GRPO, off by default) |
| `packages/orchestration/role-config.ts` | Role to provider+model assignment (loads/saves ~/.8gent/roles.json) |
| `apps/tui/` | Terminal UI entry point |
| `docs/HYPERAGENT-SPEC.md` | HyperAgent metacognitive self-modification spec |
| `docs/MODEL-SHOOTOUT.md` | Local vs cloud model comparison |
| `docs/KERNEL-FINETUNING.md` | RL fine-tuning architecture |

## Core Architecture

```
packages/eight/       <- The brain. Agent engine, REPL, tools, prompt system.
packages/ai/          <- AI SDK integration. Provider abstraction. Tool loop.
packages/harness-cli/ <- Headless CLI for testing 8gent sessions.
packages/specifications/ <- Session format spec (v2).
packages/dreams/      <- Creative output (scripts, video generation).
apps/tui/             <- Ink v6 terminal UI.
apps/debugger/        <- Next.js session inspector.
benchmarks/           <- Execution-graded benchmarks + autoresearch harness.
```

**packages/eight/ is sacred.** It is the core engine. Treat it with care. Read before you write. Understand before you modify.

## Absolute Prohibitions (NON-NEGOTIABLE)

### Code

1. **No em dashes.** Never. Use hyphens (-) or rewrite. No exceptions.
2. **No purple/pink/violet colors.** Hues 270-350 are banned. See BRAND.md for approved palette.
3. **No dollar values on benchmarks.** Describe what tasks test, not what they'd cost.
4. **No stat padding.** Never pad descriptions with arbitrary numbers (package counts, benchmark counts, commit counts). Only state what actually exists with evidence.
5. **No enthusiasm inflation.** Don't oversell. State what was done, what works, what doesn't.
6. **No secrets in chat. Ever.** Never ask the user to paste tokens, API keys, passwords, or any credentials in the chat. Never output secrets to chat logs. Read secrets from env files or secret managers directly. Use `flyctl secrets set`, env files, or similar tooling. This rule is non-negotiable and applies to all agents, sub-agents, and vessel processes.
7. **No AI tooling company traces in 8GI GitHub.** Never add "Co-Authored-By: Claude", "Anthropic", "Generated with Claude Code", "OpenAI", or any AI tool vendor attribution to commits, PRs, issues, or code comments. Work is signed by 8GI Foundation and/or the 8gent vessels (8EO, 8TO, etc.) when James is orchestrating. No third-party AI tool branding in any 8GI repo.
8. **No AI vendor names in any product surface.** No "Export for AI", "Send to Claude", etc. No customer-facing AI/tooling language.
9. **No direct push to main.** Always feature branch + PR.
10. **Bun, not Node**, for all 8GI runtimes. Test before pushing.

### Content / Copy

- No em dashes in any publication.
- No invented biography or statistics about James.
- No self-harm details about [REDACTED-CHILD] in any public content.
- No formal diagnosis claims (James is self-identified AuDHD, not formally diagnosed).
- aidhd.dev is stealth mode - do not mention publicly.

### Process

- Every change gets a GitHub issue first. Link PR to issue with `Closes #N`.
- All work tracked at: https://github.com/orgs/8gi-foundation/projects/1
- Multi-step setups: finish every step in order, do not jump ahead.
- Input needed from James: send as Telegram KittenTTS voice note (KittenTTS only, NO ElevenLabs ever).
- Blog posts ship with KittenTTS voiceover embedded.
- Post-push Vercel check mandatory for customer-facing repos: HTTP 200 + screenshot + Telegram. This is the definition of done.

## Work Sign-Off Protocol (8GI FOUNDATION STANDARD)

**Every agent working on ANY 8GI repo MUST end task responses with this sign-off. Non-negotiable.**

```
SIGN-OFF:
  VOICE:    say -v {Officer} "{summary}"
  VALIDATE: {production URL}
  VISUAL:   {screenshot confirmation or "Deploy pending"}
  COMMIT:   {message} - {hash} on {branch}
  PUSHED:   {org}/{repo} {branch}
  ISSUE:    {GH issue URL} ({status}) or "No linked issue"
  PR:       {PR URL} or "Direct push to {branch}"
```

This is the chain of custody. Voice for accessibility. URL for validation. Visual for regression. Git for traceability. GH for project management.

Individual contributors may add personal preferences (voice, formatting, review style) via their own `~/.claude/CLAUDE.md`. But the sign-off protocol is company-wide.

## GitHub Workflow (MANDATORY for ALL agents)

**Every agent MUST use GitHub issues and projects properly. No exceptions.**

1. **Before starting work:** Check for existing issues. Use `gh issue list --repo 8gi-foundation/{repo}`.
2. **Link work to issues:** Every PR references the issue it closes. Use `Closes #N` in PR body.
3. **Move project items:** When starting an issue, move it from Todo to In Progress. When done, move to Done. Use `gh project item-edit` or the web UI.
4. **Branch naming:** `feat/description`, `fix/description`, `docs/description`. Never push directly to main without PR.
5. **PR process:** Create branch, commit, push, open PR with summary + test plan. Merge via `gh pr merge --admin` only after review.
6. **Issue creation:** All new work gets an issue FIRST. Use labels: `P0` (critical), `P1` (high), `build` (board-approved), `vessel` (infra).
7. **Project board:** https://github.com/orgs/8gi-foundation/projects/1 - ALL work tracked here. Todo -> In Progress -> Done.
8. **Close issues with evidence:** Include commit hash, PR number, and validation URL when closing.

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

## Writing Rules

- **No em dashes.** Use hyphens or rewrite.
- **NOW/NEXT/LATER** for timelines, not Q1/Q2/Q3/Q4.
- **Evidence over vibes.** Every claim needs a benchmark score, test count, or link.
- **No stat padding.** If unsure about a feature's status, say "specified" or "in progress" rather than "implemented."

## Brand

- **Typography:** Fraunces (serif, weight 800) for brand wordmark. Inter (sans) for UI text. JetBrains Mono for code.
- **Accent color:** #E8610A (orange). No purple.
- **Full brand rules:** [BRAND.md](BRAND.md)

## Development Process

8gent is a **prodigy, not a product.** It's a system that learns from its own failures.

- We don't hand-tune prompts. We run benchmarks, analyze failures, derive mutations, and let the system teach itself.
- We don't pay for inference. Local Ollama models first, free OpenRouter fallback second. $0 cost ceiling.
- We don't trust vibes. Every capability is execution-graded - code compiles and tests pass, or the score is zero.

### The Autoresearch Loop

Based on [Karpathy's autoresearch](https://github.com/karpathy/autoresearch):

```
1. Run all benchmarks (temperature sweep: 0.3, 0.5, 0.7)
2. Grade each output (70% execution + 30% keyword coverage)
3. Analyze failures (execution errors, missing exports, wrong patterns)
4. Derive mutations (specific learnings per benchmark)
5. Inject mutations into system prompt (with dedup: exact + 70% word overlap)
6. Repeat until convergence or max iterations
```

### Experience-Based Model Router

Not a dumb fallback chain. The router (`benchmarks/autoresearch/model-router.ts`) tracks which model performs best on which domain and routes accordingly:

- Records every (model, domain, benchmarkId, score) after each run
- Routes future benchmarks to the proven best model for that domain
- Exploration bonus for untried model/domain combos
- Persists to `model-experience.json`

### Models

**Local first. Free always.**

| Model | Size | Strength |
|-------|------|----------|
| qwen3.5 | 6.6GB | Fast, sharp on structure |
| devstral | 14GB | Patient, code specialist |
| qwen3:14b | 9.3GB | General fallback |

OpenRouter `google/gemini-2.5-flash:free` as remote fallback only.

**NEVER use `openrouter/auto`** - it routes to paid models. This cost us $20 once. Never again.

### Benchmark Tiers

| Tier | Category | What It Tests |
|------|----------|---------------|
| 1 | Bug Fixing + Validation | Single-file fixes, input validation |
| 2 | Fullstack | Multi-file REST APIs, queues, state |
| 3 | Agentic | Config parsing, ETL, reverse engineering |
| 4 | UI Design | HTML/CSS structural verification |
| 5 | Battle Test | Real-world freelance contracts |

### Development Rules

1. **Benchmark before you ship.** If you change the system prompt, agent logic, or tool system - run the relevant benchmarks to check for regressions.
2. **Mutations are precious.** The accumulated learnings in `system-prompt.ts` represent hundreds of benchmark runs. Don't casually edit or clear them.
3. **Multi-file extraction is the bottleneck.** Most battle-test failures come from the LLM not producing clean multi-file output. Any improvement to code extraction in `execution-grader.ts` has outsized impact.
4. **Temperature matters.** TC001 went from 24 to 93 just by changing temp from 0.5 to 0.7. Always sweep.
5. **Mutation interference is real.** A learning that helps BT001 can regress TC001. The autoresearch loop handles this via per-category scoping, but be aware of it.
6. **Version everything.** See versioning rules below. Update CHANGELOG.md with every significant change.

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

### Agent CLI Quick Reference

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
| **Lil Eight (Desktop)** | `apps/lil-eight/` | Swift AppKit native macOS shell, dock pet + orchestrator surface |
| **Personality** | `packages/personality/` | Brand voice, "Infinite Gentleman" styling |

### Design Skills Available

These skills are installed and should be consulted for design decisions:

- **Billion Dollar Boardroom** - `.claude/skills/billiondollarboardroom`. Slash commands: `/billiondollarboardroom`, `/bdb`, `/billionboard`. Eight commercial advisors (offer, sales, positioning, content, funnels, etc.).
- **DesignExcellence** - design tokens, accessibility, modern UI patterns
- **ui-ux-pro-max** - styles, palettes, font pairings, UX guidelines
- **web-design-guidelines** - Web Interface Guidelines compliance (Vercel)
- **frontend-design** - production-grade frontend with high design quality
- **theme-factory** - pre-set themes for any artifact
- **brand-guidelines** - brand application for brand-adjacent work
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

---

# 8GI Ecosystem Context

> Auto-propagated to all 8GI repos. Canonical source maintained in `8gi-governance`.
> If the governance sync workflow overwrites this file, ecosystem content edits must
> be made in `8gi-governance`, not here.

## Architecture Decisions (binding across all repos)

### Infrastructure
- **Primary cloud**: Vercel (Next.js hosting) + Hetzner cax21 (self-hosted daemon/vessels)
- **Database**: Convex (multi-tenant via `tenantId` field on every table)
- **Auth**: Clerk (prod + dev)
- **Billing**: Stripe
- **Storage**: Hetzner Object Storage
- **Vessel runtime**: Fly.io Amsterdam (eight-vessel.fly.dev) - parallel to Hetzner, not replaced yet

### 8gent OS Tenant Model
- Each user gets `{username}.8gentos.com`
- Wildcard Vercel domain routes to Next.js `[username]` dynamic route
- Convex row-level multi-tenancy via `tenantId`
- Per-user: mini-apps, marketplace installs, skills, memory, voice

## The 8GI Board

| Code | Officer | Role |
|------|---------|------|
| 8EO | AI James | Executive Officer - strategic alignment |
| 8TO | Rishi | Technology Officer - architecture, feasibility |
| 8PO | Samantha | Product Officer - user value, UX |
| 8DO | Moira | Design Officer - experience quality, brand |
| 8SO | Karen | Security Officer - risk, compliance, COPPA/GDPR |
| 8CO | Luis | Community Officer - ecosystem, adoption |
| 8MO | Zara | Marketing Officer - narrative, positioning |
| 8GO | Solomon | Governance Officer - policy, constitution |

Boardroom minutes: `8gi-governance/docs/boardroom-minutes/`
Public render: 8gi.org/minutes (auth-gated)

## Agent Mail

Async messaging across sessions and agents.
- Store: `~/.claude/agent-mail.db`
- CLI: `~/.claude/bin/agent-mail`
- Check inbox: `~/.claude/bin/agent-mail inbox --as AIJames`
- Send: `~/.claude/bin/agent-mail send --from AIJames --to {Name} --subject "..." --body "..."`
- Recipients: officer first names (Rishi, Samantha, Moira, Karen, Luis, Zara, Solomon) or codes (8TO, etc)

## Key Contacts

- 8GI Foundation: [REDACTED-EMAIL] | Telegram: [REDACTED]
- AI James: [REDACTED-BOT]
- Artale (human 8SO): Discord handle Artale

## Entity Structure

- **Decided (2026-04-20 boardroom, 8-0):** Hybrid CLG+Charity parent + 8gent LTD subsidiary
- **Immediate action:** LTD incorporation first, IP assigned day 1
- **Trip ODell NDA:** re-executes on LTD once formed

---

# 8GI Ecosystem Status

> Auto-generated by CI on every push to main in any 8GI repo. Treat as a snapshot;
> see GitHub for live state.

## Build status by product

| Product | Domain | Repo | Stack | Status |
|---------|--------|------|-------|--------|
| 8gent OS | 8gentos.com / {user}.8gentos.com | 8gent-OS | Next.js 16, Convex, Clerk, Stripe | Active - Wave 4 |
| 8gent Code | 8gent.dev | 8gent-code | Bun, Ink v6 (React TUI) | Shipped v0.13.0 |
| 8gent Jr | 8gentjr.com | 8gentjr | Next.js, Convex, Clerk | Active - COPPA compliant |
| 8gent World | 8gent.world | 8gent-world | Astro/Next.js | Docs + ecosystem story |
| 8GI Foundation | 8gi.org | 8gi-governance | Next.js, Convex, Clerk | Auth-gated inner circle |
| 8gent App | 8gent.app | 8gent | TBD | Concept stage |

## 8gent Code (8gent.dev)

**Version:** 0.13.0 (shipped 2026-04-30)

### Shipped in v0.13.0
- TUI bottom-bar redesign (DjDeck, AgentInstrumentStrip, ModeFooter, HeaderBar, BottomBar)
- Capability tiers, sqlite-vec, app archive format, tmux backend
- Hotkey changes: Ctrl+Y cycles modes, Ctrl+T unambiguous new-tab
- SubscriptionControl skill ported from 8gent-OS

### In progress
- 8gent Computer voice-first design (epic #1847, 31 sub-issues)
- apfel (Apple Foundation local server) wired at #1848
- Wake word engine: livekit-wakeword (Apache 2.0, native Swift)
- Headless CLI parity non-negotiable

## 8gent OS (8gentos.com)

**Parity vs AI James OS prototype:** ~37% (as of 2026-04-30, after PR #141 merge)

### Shipped (Wave 4, 2026-04-30)
- 55-theme system + token inheritance from AI James OS (`feat/themes-port` #157)
- Mini-apps: per-user Convex table, dynamic `[username]/m/[slug]` route, build/fail states
- Marketplace: listings, installs, review queue, approve/reject, storefront, home-screen install
- iOS-style tap-to-zoom app open animation
- All "Coming Soon" stubs replaced with polished pages
- SubscriptionControl skill UI (Advisor/Copilot/Autopilot levels)
- Settings page: tabbed layout (general/models/voice/adhd/permissions/system-files/billing)
- Skills page: search, category filter, toggle grid

### Remaining gaps vs prototype
- Lock screen / per-tenant onboarding flow
- Design token enforcement (eslint + visual regression CI)
- Phase 0.5 security gates before provisioning friends

## 8gent Jr (8gentjr.com)

### Shipped (2026-04-30)
- VPC step 2: 24h delay default for COPPA email-plus verification (#162)
- CI lint blocking emotion/affect detection imports as EU AI Act guard (#163)

### Compliant with
- COPPA (children under 13)
- EU AI Act emotion/affect detection prohibition

## 8gent World (8gent.world)
- Documentation and ecosystem story site

## 8GI Foundation (8gi.org)
- Auth-gated inner circle site
- Agent-mail inbox live at /internal/inbox
- Boardroom minutes rendered at /minutes

## Infrastructure

| Component | State |
|-----------|-------|
| Vercel | All repos deployed, green |
| Hetzner cax21 (nbg1) | IP [REDACTED-IP] - greenfield, SSH key setup needed |
| Fly.io (eight-vessel.fly.dev) | Running, parallel to Hetzner |
| Convex | Multi-tenant, row-level via tenantId |
| Clerk | Auth on prod + dev |
| Stripe | Billing configured |

---

# 8gent Code Roadmap

> Maintained by Rishi (8TO).

## Shipped (v0.13.0, 2026-04-30)
- TUI bottom-bar redesign (DjDeck, AgentInstrumentStrip, ModeFooter, HeaderBar, BottomBar)
- Capability tiers, sqlite-vec, app archive format, tmux backend
- Hotkey: Ctrl+Y cycles modes, Ctrl+T new-tab
- SubscriptionControl skill
- apfel (Apple Foundation local server) wired

## In Progress
- 8gent Computer: full computer-use agent runtime, voice I/O (epic #1847, 31 sub-issues)
- Wake word engine: livekit-wakeword (Apache 2.0, native Swift, ANE/CoreML)
- Headless CLI parity

## Next
- Wake phrase selection (James to pick "Hey 8" vs "Hey 8gent")
- Electron/Tauri desktop shell (post Phase 6, after openwork FSL ruling out)
- Cerebras / Chutes / Cohere provider wiring

## Deferred
- RL fine-tuning pipeline (packages/kernel/ - off by default)
- Picovoice wake engine (NO native macOS Swift binding, rejected 2026-04-25)
- openwork fork (FSL-1.1-MIT Competing Use clause blocks commercial derivative)

---

## Contributors

| Who | Role |
|-----|------|
| 8GI Foundation | Creator, architect |
| AI James | Co-creator, benchmark engineer |
| Thomas Davis (@thomasdavis) | TUI, AI SDK, packages/eight refactor |
