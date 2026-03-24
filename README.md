# 8gent Code

The kernel of the [8gent ecosystem](https://8gent.world). Open source autonomous coding agent powered by local LLMs (Ollama) or free cloud models (OpenRouter). No API keys, no usage caps, no cloud dependency.

Part of a 6-product ecosystem. See [8gent.world](https://8gent.world) for the full story, and the [8gent Constitution](https://8gent.world/constitution) for the founding document.

**v1.0.0** - Daemon stable. Eight kernel deployed as persistent daemon on Fly.io (Amsterdam).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.0.0-brightgreen)](https://8gent.dev)
[![8gent OS](https://img.shields.io/badge/8gent_OS-8gentos.com-orange)](https://8gentos.com)

## Ecosystem

6 products, 6 domains.

| Product | Domain | Role |
|---------|--------|------|
| **8gent OS** | [8gentos.com](https://8gentos.com) | Parent site. Paid product. Revenue engine. |
| **8gent Code** | [8gent.dev](https://8gent.dev) | Open source developer agent. Free on-ramp. (this repo) |
| **8gent** | [8gent.app](https://8gent.app) | Consumer GUI client for the OS. |
| **8gent World** | [8gent.world](https://8gent.world) | Ecosystem story, docs, media. 14 presentation decks at [8gent.world/media/decks](https://8gent.world/media/decks). |
| **8gent Games** | [8gent.games](https://8gent.games) | Agent simulation playground. |
| **8gent Jr** | [8gentjr.com](https://8gentjr.com) | AI assistant for kids. Accessibility first. Free. |

Additional resources:
- [8gent.world/constitution](https://8gent.world/constitution) - the founding document that governs all decisions
- [8gent.world/inspirations](https://8gent.world/inspirations) - architecture credits and influences

## Install

```bash
curl -fsSL https://ollama.ai/install.sh | sh && ollama pull qwen3.5
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/PodJamz/8gent-code.git && cd 8gent-code && bun install
```

Then run:

```bash
bun run tui
```

## What's different

- **Local-first, free by default.** Runs entirely on your machine. Cloud models (OpenRouter free tier) are opt-in. No telemetry, no API keys to start.
- **Model-agnostic.** Auto-selects from best free models on OpenRouter. Runs Qwen 3.5 via Ollama locally. Task router classifies prompts (code / reasoning / simple / creative) and picks the best model automatically.
- **Eight kernel.** Persistent daemon deployed on Fly.io Amsterdam ([eight-vessel.fly.dev](https://eight-vessel.fly.dev)). WebSocket protocol, 4-strategy retry loop, session persistence across reconnections.
- **8 Powers.** Memory, parallel worktrees, NemoClaw policy engine, self-evolution, self-healing, entrepreneurship, AST blast radius, and browser access. Not plugins. Built-in.
- **NemoClaw policy engine.** YAML-based, deny-by-default, rebuilt from scratch. 11 default rules with approval gates for secrets, destructive ops, network, git, and file access. Headless and infinite modes for autonomous operation.
- **HyperAgent meta-improvement.** Metacognitive self-modification spec ([docs/HYPERAGENT-SPEC.md](docs/HYPERAGENT-SPEC.md)). The agent can improve how it improves - meta-config is editable while the evaluation protocol stays human-controlled.
- **AutoResearch.** Overnight improvement loops (Karpathy-style). Runs benchmarks, mutates system prompts, re-tests. Meta-optimizer also tunes few-shots, model routing, and grading weights.
- **Voice chat.** `/voice chat` starts a half-duplex conversation loop. Speak, Eight transcribes, thinks, and speaks back. ESC to interrupt mid-speech.
- **AST-first code navigation.** Reads symbols, not files. The agent stays fast in large codebases.
- **Multi-agent orchestration.** Spawns sub-agents in isolated git worktrees, up to 4 concurrent, coordinates via filesystem messaging.
- **Telegram portal.** Bot with voice transcription, plus an iOS-style Telegram Mini App control panel.

## 8 Powers

Eight has 8 built-in abilities that define how he works:

| Power | Package | What it does |
|-------|---------|--------------|
| **Memory** | `packages/memory/` | Dual-layer episodic + semantic memory, SQLite + FTS5, Ollama embeddings, procedural memory, health monitoring, contradiction detection, consolidation, lease-based job queue |
| **Worktree** | `packages/orchestration/` | Multi-agent parallel execution via git worktrees, max 4 concurrent, filesystem messaging, macro-actions, delegation |
| **Policy** | `packages/permissions/` | NemoClaw YAML policy engine, 11 default rules, approval gates, headless mode, infinite mode, dangerous command detection |
| **Evolution** | `packages/self-autonomy/` | Post-session reflection, Bayesian skill confidence, HyperAgent meta-mutation, self-improvement DB |
| **Healing** | `packages/validation/` | Checkpoint-verify-revert loop, git-stash atomic snapshots, failure log |
| **Entrepreneurship** | `packages/proactive/` | GitHub bounty/help-wanted scanner, capability matcher, opportunity pipeline |
| **AST** | `packages/ast-index/` | Blast radius engine, import dependency graph, test file mapping, change impact estimation |
| **Browser** | `packages/tools/browser/` | Lightweight web access via fetch + DuckDuckGo HTML scraping, disk cache, no headless deps |

## Voice Chat

Half-duplex voice conversation with Eight. Requires sox and whisper.cpp:

```bash
brew install sox whisper-cpp
```

In the TUI, type `/voice chat` to start. Eight listens (sox with silence detection), transcribes (whisper.cpp local or OpenAI cloud fallback), thinks (agent loop), and speaks back (macOS `say`). Press ESC to interrupt mid-speech or exit voice mode.

Status bar shows: VOICE CHAT (listening) / SPEAKING / THINKING.

## How it works

```
User prompt
  -> BMAD planner (structured task decomposition)
  -> Multi-agent orchestration (sub-agents in worktrees)
  -> Toolshed (MCP, LSP, shell, AST, filesystem)
  -> Execution + validation (self-healing loop)
  -> Result
```

The agent decomposes work, delegates to sub-agents, validates output against test suites, and reports back. It uses the BMAD method for planning and AST-level symbol retrieval to keep token usage minimal.

## Benchmarks

Execution-graded tests across professional domains. All local inference via Ollama.

Code compiles and runs against `bun:test` suites, or it fails. No string matching, no vibes.

| ID | Domain | Task | Score |
|----|--------|------|-------|
| BT001 | Software Engineering | SaaS Auth: JWT, Roles, Rate Limiting | 94 |
| BT002 | Software Engineering | Event-Driven Architecture: Pub/Sub, DLQ, Retry | 92 |
| BT003 | Data Engineering | Stream Processing Pipeline | 100 |
| BT005 | Software Engineering | Typed State Machine: Guards, Actions | 92 |
| BT007 | Digital Marketing | SEO Audit Engine: Scoring, Core Web Vitals | 96 |
| BT011 | Video Production | Scene Graph, Timeline, FFmpeg CLI | 100 |
| BT012 | Music Technology | Notes, Chords, Scales, Progressions | 81 |
| BT014 | AI Consulting | Assessment Report Generator | 95 |

Additional categories: long-horizon (LH001-LH005), agentic (TC001-MR001), fullstack (FS001-FS003), UI design (UI001-UI008), ability showcase.

```bash
bun run benchmark:v2                    # single pass
CATEGORY=battle-test bun run benchmark:loop  # autoresearch loop
```

Full results: [benchmarks/README.md](benchmarks/README.md)

Model shootout (local 14B vs cloud 120B): [docs/MODEL-SHOOTOUT.md](docs/MODEL-SHOOTOUT.md)

## Project Structure

```
8gent-code/
  apps/
    tui/           Ink v6 terminal UI (main interface)
    clui/          Tauri 2.0 desktop overlay (scaffolded)
    dashboard/     Next.js admin panel
    debugger/      Session debugger
    demos/         Remotion video generation
    installer/     Interactive install wizard
  packages/
    eight/         Core agent engine (Vercel AI SDK)
    daemon/        Persistent vessel daemon (Fly.io Amsterdam)
    ai/            Provider abstraction (Ollama, OpenRouter, LM Studio)
    memory/        SQLite + FTS5 persistent memory with health monitoring
    orchestration/ WorktreePool, macro actions, throughput tracking
    permissions/   NemoClaw YAML policy engine
    self-autonomy/ Evolution, reflection, HyperAgent meta-mutation
    validation/    Self-healing executor + ability scorecards
    proactive/     Business agents, opportunity scanner
    ast-index/     Blast radius engine
    tools/         Tool implementations (browser, actuators, filesystem, shell)
    voice/         STT (whisper.cpp) + voice chat loop
    kernel/        RL fine-tuning pipeline (GRPO, off by default)
    personality/   Brand voice, "Infinite Gentleman"
    telegram/      Telegram bot portal
    auth/          Clerk auth + GitHub integration
    db/            Convex reactive database
    control-plane/ Multi-tenant management
  benchmarks/      Execution-graded benchmarks + autoresearch
  bin/             CLI entry points (8gent, debug)
  docs/            Architecture docs, methodology, guides
```

## Roadmap

### NOW
- Memory v1 enhancements: procedural memory and lease-based job queue landed. Contradiction detection, health introspection, and checkpointing in progress.
- Model shootout iteration: improving autonomous task completion rates after 0/5 in first round.
- Daemon reliability: 4-strategy retry loop landed.

### NEXT
- HyperAgent meta-improvement loop (specified in [docs/HYPERAGENT-SPEC.md](docs/HYPERAGENT-SPEC.md))
- Kernel fine-tuning pipeline activation (specified, off by default - [docs/KERNEL-FINETUNING.md](docs/KERNEL-FINETUNING.md))
- Personal LoRA from session training pairs

### LATER
- Desktop client (Tauri 2.0, scaffolded in `apps/clui/`)
- Multi-tenant control plane
- Full autonomous issue resolution

## Slash Commands

| Command | What it does |
|---------|--------------|
| `/voice chat` | Start voice conversation mode |
| `/voice start` | Push-to-talk recording |
| `/model <name>` | Switch LLM model |
| `/board` | Kanban task board |
| `/predict` | Confidence-scored step predictions |
| `/momentum` | Velocity stats |
| `/evidence` | Session evidence summary |
| `/history` | Browse past sessions |
| `/resume` | Resume a previous session |
| `/compact` | Compact current session |
| `/github` | GitHub integration |
| `/auth status` | Check auth state |
| `/debug` | Session inspector |
| `/deploy <target>` | Deploy to Vercel/Railway/Fly (via Telegram) |
| `/throughput` | Token throughput stats |
| `/scorecard` | Ability scorecard metrics |
| `/soul` | Current persona calibration |
| `/router` | Task router classification and model selection |
| `/music` | Toggle lofi music generation (ADHD mode) |
| `/rename` | Rename the current session |

## Docs

| Doc | What it covers |
|-----|----------------|
| [SOUL.md](SOUL.md) | Agent persona and principles |
| [CLAUDE.md](CLAUDE.md) | Dev conventions, design system, repo rules |
| [docs/HYPERAGENT-SPEC.md](docs/HYPERAGENT-SPEC.md) | HyperAgent metacognitive self-modification spec |
| [docs/MODEL-SHOOTOUT.md](docs/MODEL-SHOOTOUT.md) | Local vs cloud model comparison results |
| [docs/MEMORY-SPEC.md](docs/MEMORY-SPEC.md) | Memory layer architecture and API reference |
| [docs/KERNEL-FINETUNING.md](docs/KERNEL-FINETUNING.md) | RL fine-tuning pipeline |
| [docs/PERSONALIZATION.md](docs/PERSONALIZATION.md) | 5-layer personalization system |
| [docs/TOOLSHED.md](docs/TOOLSHED.md) | Capability discovery and skill registry |
| [docs/permissions.md](docs/permissions.md) | Policy engine and approval gates |
| [docs/BRANCH-DECISIONS.md](docs/BRANCH-DECISIONS.md) | Architecture decision log |
| [8gent.world/constitution](https://8gent.world/constitution) | 8gent Constitution |
| [8gent.world/media/decks](https://8gent.world/media/decks) | Presentation decks |
| [8gent.world/inspirations](https://8gent.world/inspirations) | Architecture inspirations |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |

## Inspirations

Architecture credits. These projects informed specific parts of 8gent's design. Full list at [8gent.world/inspirations](https://8gent.world/inspirations).

- [Hermes by ArcadeAI](https://github.com/ArcadeAI/hermes) - persistent memory and self-evolution patterns
- [CashClaw](https://github.com/nicepkg/CashClaw) - autonomous work discovery and value generation
- NemoClaw - policy-driven governance and approval gate architecture
- HyperAgents (Meta FAIR, March 2026) - metacognitive self-modification
- Hypothesis Loop - atomic commit-verify-revert development cycle
- Blast Radius Engine - AST-based change impact estimation
- Claude Code - worktree isolation pattern for parallel agent execution
- Karpathy's autoresearch methodology - iterative prompt mutation and meta-optimization
- [SoulSpec](https://github.com/OpenSoul-org/SoulSpec) - agent persona standard

## License

MIT - James Spalding

Follow: [X/Twitter](https://x.com/8gentapp) | [GitHub](https://github.com/PodJamz/8gent-code) | [8gent.dev](https://8gent.dev)
