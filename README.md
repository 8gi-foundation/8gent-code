# 8gent Code

Autonomous coding agent that runs on local LLMs via Ollama. No API keys, no usage caps, no cloud dependency.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-0.7.0-brightgreen)](https://github.com/PodJamz/8gent-code)

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
- **AST-first code navigation.** Reads symbols, not files. 97% token reduction vs reading whole files. The agent stays fast in large codebases.
- **Self-improving prompts.** Autoresearch harness (Karpathy-style) runs benchmarks in a loop, mutates system prompts, re-tests. Scores go up without manual tuning.

## How it works

```
User prompt
  -> BMAD planner (structured task decomposition)
  -> Multi-agent orchestration (subagents in worktrees)
  -> Toolshed (MCP, LSP, shell, AST, filesystem)
  -> Execution + validation
  -> Result
```

The agent decomposes work, delegates to subagents, validates output against test suites, and reports back. It uses the BMAD method for planning and AST-level symbol retrieval to keep token usage minimal.

## Benchmarks

39 execution-graded tests across 15 professional domains. All local inference via Ollama.

Code compiles and runs against `bun:test` suites, or it fails. No string matching, no vibes.

| ID | Domain | Task | Score |
|----|--------|------|-------|
| BT001 | Software Engineering | SaaS Auth - JWT, Roles, Rate Limiting | 94 |
| BT002 | Software Engineering | Event-Driven Architecture - Pub/Sub, DLQ, Retry | 92 |
| BT003 | Data Engineering | Stream Processing Pipeline | 100 |
| BT005 | Software Engineering | Typed State Machine - Guards, Actions | 92 |
| BT007 | Digital Marketing | SEO Audit Engine - Scoring, Core Web Vitals | 96 |
| BT011 | Video Production | Scene Graph, Timeline, FFmpeg CLI | 100 |
| BT012 | Music Technology | Notes, Chords, Scales, Progressions | 81 |
| BT014 | AI Consulting | Assessment Report Generator | 95 |

Iteration 1 average: 69 across all 15 domains, 8/15 passing. Iteration 2 in progress.

```bash
bun run benchmark:v2                    # single pass
CATEGORY=battle-test bun run benchmark:loop  # autoresearch loop
```

Full results: [benchmarks/README.md](benchmarks/README.md)

## Docs

| Doc | What it covers |
|-----|----------------|
| [SOUL.md](SOUL.md) | Agent persona and principles |
| [CLAUDE.md](CLAUDE.md) | Dev conventions, design system, repo rules |
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md) | Full benchmark methodology |
| [docs/KERNEL-FINETUNING.md](docs/KERNEL-FINETUNING.md) | RL fine-tuning pipeline |
| [docs/PERSONALIZATION.md](docs/PERSONALIZATION.md) | 5-layer personalization system |
| [docs/TOOLSHED.md](docs/TOOLSHED.md) | Capability discovery and skill registry |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |

## Inspirations

Architecture credits. These projects informed specific parts of 8gent's design.

- [OpenClaw](https://openclaw.ai) - agent framework patterns
- [Hermes Agent](https://github.com/NousResearch) (NousResearch) - self-evolution, persistent memory
- [codex-autoresearch](https://github.com/karpathy/autoresearch) - hypothesis-commit-verify loop
- [code-review-graph](https://github.com/nicepkg/code-review-graph) - blast-radius AST analysis
- [ClawTeam](https://github.com/AimingLab/ClawTeam) - worktree agent swarms
- [Voicebox](https://github.com/facebookresearch/voicebox) - local TTS patterns
- [SoulSpec](https://github.com/OpenSoul-org/SoulSpec) - agent persona standard
- [CashClaw](https://github.com/cashclaw) - autonomous work discovery and value generation patterns

## License

MIT - James Spalding
