# 8gent Code

Autonomous coding agent that runs on local LLMs via Ollama. No API keys, no usage caps, no cloud dependency.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-0.8.0-brightgreen)](https://github.com/PodJamz/8gent-code)

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

- **Local-first, free by default.** Runs entirely on your machine. Cloud models (OpenRouter) are opt-in. No telemetry, no API keys to start.
- **8 core abilities.** Memory, parallel worktrees, policy engine, self-evolution, self-healing, entrepreneurship, AST blast radius, and browser access. Not plugins. Built-in.
- **Voice chat.** `/voice chat` starts a half-duplex conversation loop. Speak, Eight transcribes, thinks, and speaks back. ESC to interrupt mid-speech.
- **AST-first code navigation.** Reads symbols, not files. 97% token reduction vs reading whole files. The agent stays fast in large codebases.
- **Self-improving prompts.** Autoresearch harness (Karpathy-style) runs benchmarks in a loop, mutates system prompts, re-tests. Meta-optimizer also tunes few-shots, model routing, and grading weights.
- **Multi-agent orchestration.** Spawns sub-agents in isolated git worktrees, up to 4 concurrent, coordinates via filesystem messaging. Macro action decomposer finds parallel groups automatically.
- **Ability scorecards.** Each of the 8 abilities has measurable metrics tracked per session with baseline comparison.
- **Actuator tools.** Deploy to Vercel/Railway/Fly, publish to npm/GitHub, notify via Telegram. Dry-run by default.
- **Telegram portal.** Single chat interface to all automation: `/status`, `/agents`, `/benchmark`, `/deploy`, `/throughput`, `/scorecard`.
- **Workspace tabs.** Chat, Notes, Ideas, BTW, Questions, and Music tabs in a neumorphic folder UI.
- **Task router.** Classifies prompts (code / reasoning / simple / creative) and routes to the best model automatically.
- **Activity monitor.** Real tool-call feed replaces the decorative spinner. See exactly what the agent is doing.

## Core Abilities

Eight has 8 built-in abilities that define how he works:

| Ability | Package | What it does |
|---------|---------|--------------|
| **Memory** | `packages/memory/` | SQLite + FTS5 persistent recall, Ollama embeddings, 30-day decay, frequency-based promotion |
| **Worktree** | `packages/orchestration/` | Multi-agent parallel execution via git worktrees, max 4 concurrent, filesystem messaging |
| **Policy** | `packages/permissions/` | YAML policy engine, 11 default rules, approval gates, privacy-aware model routing |
| **Evolution** | `packages/self-autonomy/` | Post-session reflection, Bayesian skill confidence, self-improvement DB |
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

39 execution-graded tests across 15 professional domains. All local inference via Ollama.

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

## Project Structure

```
8gent-code/
  apps/
    tui/           Ink v6 terminal UI (main interface)
    clui/          Tauri 2.0 desktop overlay
    dashboard/     Next.js admin panel
    debugger/      Session debugger
    demos/         Remotion video generation
    installer/     Interactive install wizard
  packages/
    eight/         Core agent engine (Vercel AI SDK)
    ai/            Provider abstraction (Ollama, OpenRouter, LM Studio)
    memory/        SQLite + FTS5 persistent memory
    orchestration/ WorktreePool, macro actions, throughput tracking
    permissions/   YAML policy engine
    self-autonomy/ Evolution, reflection, persona mutation
    validation/    Self-healing executor + ability scorecards
    proactive/     Entrepreneurship scanner
    ast-index/     Blast radius engine
    tools/         Tool implementations (browser, actuators, filesystem, shell)
    voice/         STT (whisper.cpp) + voice chat loop
    auth/          Clerk auth + GitHub integration
    db/            Convex reactive database
    kernel/        RL fine-tuning pipeline (GRPO)
    control-plane/ Multi-tenant management
  benchmarks/      39 execution-graded benchmarks + autoresearch
  bin/             CLI entry points (8gent, debug)
  docs/            Architecture docs, methodology, guides
```

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

## Docs

| Doc | What it covers |
|-----|----------------|
| [SOUL.md](SOUL.md) | Agent persona and principles |
| [CLAUDE.md](CLAUDE.md) | Dev conventions, design system, repo rules |
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md) | Full benchmark methodology |
| [docs/KERNEL-FINETUNING.md](docs/KERNEL-FINETUNING.md) | RL fine-tuning pipeline |
| [docs/PERSONALIZATION.md](docs/PERSONALIZATION.md) | 5-layer personalization system |
| [docs/TOOLSHED.md](docs/TOOLSHED.md) | Capability discovery and skill registry |
| [docs/permissions.md](docs/permissions.md) | Policy engine and approval gates |
| [docs/BRANCH-DECISIONS.md](docs/BRANCH-DECISIONS.md) | Architecture decision log |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |

## Inspirations

Architecture credits. These projects informed specific parts of 8gent's design.

- [Hermes by ArcadeAI](https://github.com/ArcadeAI/hermes) - persistent memory and self-evolution patterns
- [CashClaw](https://github.com/nicepkg/CashClaw) - autonomous work discovery and value generation
- NemoClaw - policy-driven governance and approval gate architecture
- Hypothesis Loop - atomic commit-verify-revert development cycle
- Blast Radius Engine - AST-based change impact estimation
- Claude Code - worktree isolation pattern for parallel agent execution
- [Nemotron-3-Nano WebGPU](https://huggingface.co/spaces/webml-community/Nemotron-3-Nano-WebGPU) - edge inference inspiration for lightweight local classification
- [SoulSpec](https://github.com/OpenSoul-org/SoulSpec) - agent persona standard
- [Voicebox](https://github.com/facebookresearch/voicebox) - local TTS patterns
- [Paperclip](https://github.com/paperclipai/paperclip) - autonomous agent work platform patterns
- Karpathy's autoresearch methodology - iterative prompt mutation, meta-optimization, token throughput maximization

## License

MIT - James Spalding

Follow: [X/Twitter](https://x.com/8gentapp) | [GitHub](https://github.com/PodJamz/8gent-code)
